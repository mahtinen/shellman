/**
 * Edits the variables of a linked folder. Each variable applies to every environment or one, and
 * is secret or not. Normal values go to the files the team shares (`.env`,
 * `environments/<env>.json`); secret ones to the git-ignored `.env.local` / `.env.<env>.local`,
 * except 1Password references, which hold no secret and are shared.
 */
import { api } from './api';
import { collections } from './collections';
import { choiceDialog, dialog, toast } from './dialogs';
import { h } from './dom';
import { icons } from './icons';
import { gitSync } from './gitSync';
import { openSettings } from './settingsDialog';
import { store } from './store';
import type { Group } from './types';
import { checkRows, editRow, isOpRef, looksSecretName, opRef, overriddenRows, rowScope, scopeFile, variableRows, variableWrites, varRow, type EditRow } from './variables';

/** The 1Password guide stays open once opened. */
let opHelpOpen = false;

/** Short steps for using 1Password references, and whether its CLI is installed here. */
function onePasswordHelp(): HTMLElement {
  const status = h('p', { class: 'hint' }, 'Looking for the 1Password CLI…');
  const settingsLink = () => h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), openSettings('Requests')) }, 'Settings → Requests');
  void Promise.all([api.opPath(store.settings.opPath), api.opAccounts(store.settings.opPath)]).then(([path, accounts]) =>
    status.replaceChildren(
      ...(path
        ? accounts.length > 1 && !store.settings.opAccount
          ? [
              h('span', { class: 'err-text' }, `There are ${accounts.length} 1Password accounts on this computer. Choose the one to use in `),
              settingsLink(),
              h('span', { class: 'err-text' }, ': Shellman runs op without a terminal, so op can\'t ask which one.'),
            ]
          : [`1Password CLI found: ${path}${store.settings.opAccount ? ` · account ${store.settings.opAccount}` : ''}`]
        : [
            'The 1Password CLI is not installed on this computer (step 1). ',
            settingsLink(),
            ' can point to op.exe if it is somewhere else.',
          ]),
    ),
  );
  const code = (t: string) => h('code', null, t);
  const box = h(
    'details',
    { class: 'advanced op-help', open: opHelpOpen, ontoggle: () => (opHelpOpen = box.open) },
    h('summary', null, 'Secrets from 1Password'),
    h(
      'ol',
      { class: 'hint' },
      h('li', null, 'Install the 1Password CLI (', code('winget install AgileBits.1Password.CLI'), ') and in the 1Password app turn on Settings → Developer → Integrate with 1Password CLI.'),
      h('li', null, 'In 1Password, right-click the field that holds the secret (e.g. the token) and choose Copy Secret Reference.'),
      h('li', null, 'Add a variable here and paste it as the value, e.g. ', code('op://Team API/Example API/credential'), '. It is a secret, but the reference itself holds none, so it is shared with the team: everyone with access to that vault gets the value.'),
      h('li', null, 'Use it in requests as ', code('{{API_TOKEN}}'), '. When you send, 1Password asks for Windows Hello once and gives the value straight to curl; Shellman never sees it.'),
      h('li', null, 'A different item per environment: add the variable for each environment with a reference to that one.'),
      h('li', null, 'Several 1Password accounts (e.g. work and personal)? Choose the one with these items in Settings → Requests → 1Password account.'),
    ),
    status,
  );
  return box;
}

/** Opens the editor; `add` puts rows for these (undefined) names in to start with, `focus` goes to one. */
export function editVariables(group: Group, add: string[] = [], focus?: string): void {
  const c = collections.get(group.id);
  if (!c) return;
  let env = collections.env(group);
  // The folder as now: a pull or another editor may have changed it while the dialog was open.
  const now = () => collections.get(group.id) ?? c;
  const files = () => ({ env, environment: now().environments.get(env)?.variables ?? {}, dotenv: now().dotenv });
  let before = variableRows(files());
  let rows: EditRow[] = before.map(editRow);
  for (const name of add) if (!rows.some((r) => r.name === name)) rows.push({ name, value: '', perEnv: !!env, secret: looksSecretName(name) });

  const table = h('div', { class: 'var-table' });
  const error = h('div', { class: 'field-error' });
  const changed = () => JSON.stringify(rows.map(varRow)) !== JSON.stringify(before);
  const where = (r: EditRow) => `${r.perEnv ? env : 'every environment'}${r.secret && !isOpRef(r.value) ? ', secret' : ''}`;

  /** The row of `focus` that counts (a secret, and one for this environment, wins), to start on. */
  let start: EditRow | undefined;

  const draw = (focusLast = false) => {
    const vrows = rows.map(varRow);
    const overridden = overriddenRows(vrows);
    table.replaceChildren(
      h('div', { class: 'var-row var-head' }, h('span', null, 'Name'), h('span', null, 'Value'), h('span', null, 'Applies to'), h('span', { title: 'Secret values stay on this computer (git ignores them) and are hidden' }, 'Secret'), h('span')),
      ...rows.map((r, i) => {
        const op = isOpRef(r.value);
        const name = h('input', { class: 'input small mono', value: r.name, placeholder: 'name', spellcheck: false });
        const hidden = store.settings.hideSecrets && r.secret && !op;
        const value = h('input', { class: 'input small mono', value: r.value, placeholder: 'value, or op://Vault/Item/field', spellcheck: false, type: hidden ? 'password' : 'text' });
        name.addEventListener('input', () => (r.name = name.value.trim()));
        name.addEventListener('change', () => draw());
        value.addEventListener('input', () => (r.value = value.value));
        // A 1Password reference is always secret; it is kept without quotes or spaces around it.
        value.addEventListener('change', () => {
          const ref = opRef(r.value);
          if (ref) {
            r.value = ref;
            r.secret = true;
          }
          draw();
        });
        const reveal = hidden
          ? h('button', {
              class: 'icon-btn small',
              title: 'Show the value',
              html: icons.eye,
              onclick: (e: MouseEvent) => {
                const show = value.type === 'password';
                value.type = show ? 'text' : 'password';
                const btn = e.currentTarget as HTMLButtonElement;
                btn.innerHTML = show ? icons.eyeOff : icons.eye;
                btn.title = show ? 'Hide the value' : 'Show the value';
              },
            })
          : null;
        const applies = h(
          'select',
          { class: 'input small' },
          h('option', { value: 'all', selected: !r.perEnv }, 'Every environment'),
          h('option', { value: 'env', selected: r.perEnv, disabled: !env }, env ? `${env} only` : '(no environment)'),
        );
        applies.addEventListener('change', () => {
          r.perEnv = applies.value === 'env';
          draw();
        });
        const secret = h('input', {
          type: 'checkbox',
          checked: r.secret,
          disabled: op,
          title: op ? 'A 1Password reference is always secret, and safe to share' : 'Secret: kept on this computer only (git ignores it) and hidden',
        });
        secret.addEventListener('change', () => {
          r.secret = secret.checked;
          draw();
        });
        const winner = overridden.has(vrows[i]) ? rows.filter((o, j) => o.name === r.name && j !== i && !overridden.has(vrows[j])).pop() : undefined;
        return h(
          'div',
          {
            class: `var-row${overridden.has(vrows[i]) ? ' overridden' : ''}${r.secret ? ' secret' : ''}${r === start ? ' focus' : ''}`,
            title: winner ? `Not used: "${r.name}" is also set for ${where(winner)}, which wins.` : `Kept in ${scopeFile(rowScope(r), env)}`,
          },
          name,
          h('div', { class: 'var-value' }, value, reveal),
          applies,
          h('label', { class: 'var-secret' }, secret),
          h('button', {
            class: 'icon-btn small',
            title: 'Delete',
            html: icons.trash,
            onclick: () => {
              rows.splice(i, 1);
              draw();
            },
          }),
        );
      }),
      h(
        'button',
        {
          class: 'btn small rq-add',
          onclick: () => {
            rows.push({ name: '', value: '', perEnv: false, secret: false });
            draw(true);
          },
        },
        '+ Add variable',
      ),
    );
    if (focusLast) table.querySelectorAll<HTMLInputElement>('.var-row:not(.var-head) input.mono')[(rows.length - 1) * 2]?.focus();
  };

  const envSelect = h('select', { class: 'input small' }, ...[...c.environments.keys()].map((e) => h('option', { value: e, selected: e === env }, e)));
  envSelect.addEventListener('change', async () => {
    if (changed()) {
      const go = await choiceDialog('Discard the changes?', `Changes to the variables of "${env}" aren't saved yet.`, [
        { label: 'Cancel', value: false },
        { label: 'Discard', value: true, kind: 'danger' },
      ]);
      if (!go) {
        envSelect.value = env;
        return;
      }
    }
    env = envSelect.value;
    before = variableRows(files());
    rows = before.map(editRow);
    draw();
  });

  if (focus) {
    const vrows = rows.map(varRow);
    const overridden = overriddenRows(vrows);
    start = rows.find((r, i) => r.name === focus && !overridden.has(vrows[i]));
  }
  draw(add.length > 0 && !start);
  if (start) {
    requestAnimationFrame(() => {
      const row = table.querySelector<HTMLElement>('.var-row.focus');
      row?.scrollIntoView({ block: 'nearest' });
      const value = row?.querySelectorAll<HTMLInputElement>('input.mono')[1];
      value?.focus();
      value?.select();
    });
  }
  dialog({
    title: `Variables · ${group.name}`,
    width: 840,
    className: 'variables-dialog',
    body: [
      c.environments.size ? h('label', { class: 'field row-field' }, h('span', null, 'Environment'), envSelect) : h('p', { class: 'hint' }, 'No environments yet: add one (dev, staging, prod…) from the environment menu to keep values per environment.'),
      table,
      error,
      h(
        'p',
        { class: 'hint' },
        'Normal values are shared with the team through git: .env for every environment, environments/<env>.json for one. Secret values stay on this computer in .env.local / .env.<env>.local, which git ignores, so each person keeps their own. A 1Password reference (op://Vault/Item/field) is secret but holds no secret, so it is shared. For the same name, a secret wins over a normal value, and one for an environment wins over one for every environment.',
      ),
      onePasswordHelp(),
      c.notIgnored.length ? h('p', { class: 'hint err-text' }, `${c.notIgnored.join(', ')} isn't ignored by git: add it to .gitignore before putting secrets in it.`) : null,
    ],
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: async () => {
          rows = rows.filter((r) => r.name || r.value);
          const problem = checkRows(rows.map(varRow), env);
          if (problem) {
            error.textContent = problem;
            draw();
            return false;
          }
          // A secret-looking value that isn't marked secret would be shared through git.
          const exposed = rows.filter((r) => !r.secret && looksSecretName(r.name) && r.value && !before.some((b) => b.name === r.name && b.value === r.value && editRow(b).perEnv === r.perEnv && !editRow(b).secret));
          if (exposed.length) {
            const answer = await choiceDialog(
              'Share it with the team?',
              `${exposed.map((r) => r.name).join(', ')} look${exposed.length > 1 ? '' : 's'} like a secret, but ${exposed.length > 1 ? "aren't" : "isn't"} marked secret, so ${exposed.length > 1 ? 'they go' : 'it goes'} to the files the team shares through git.`,
              [
                { label: 'Cancel', value: 'cancel' as const },
                { label: 'Share it', value: 'share' as const },
                { label: 'Mark as secret', value: 'secret' as const, kind: 'primary' },
              ],
            );
            if (answer === null || answer === 'cancel') return false;
            if (answer === 'secret') for (const r of exposed) r.secret = true;
          }
          // Only what was changed here is written over: other names in the files stay as they are now.
          await collections.reload(group.id);
          const writes = variableWrites(before, rows.map(varRow), files(), now().environments.get(env));
          try {
            for (const w of writes) await api.collectionWrite(c.folder, w.path, w.kind, w.text);
          } catch (e) {
            error.textContent = String(e);
            return false;
          }
          await collections.reload(group.id);
          // Secret files are git-ignored; gitSync leaves them out anyway.
          void gitSync.changed(group.id, writes.map((w) => w.path));
          toast('Variables saved');
        },
      },
    ],
  });
}
