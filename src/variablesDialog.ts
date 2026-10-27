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
import type { Choice } from './dotenv';
import { icons } from './icons';
import { gitSync } from './gitSync';
import { openSettings } from './settingsDialog';
import { store } from './store';
import type { Group } from './types';
import { checkRows, choiceLabel, editRow, isOpRef, looksSecretName, onlyOpRefs, opRef, overriddenRows, rowPicks, rowScope, rowValues, scopeFile, variableRows, variableWrites, varRow, type EditRow } from './variables';

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
  const files = () => {
    const doc = now().environments.get(env);
    return { env, environment: doc?.variables ?? {}, choices: doc?.choices, dotenv: now().dotenv };
  };
  // What this person has chosen, as now (a request may switch a variable while the dialog is open).
  const picks = () => store.config.groups.find((g) => g.id === group.id)?.picks ?? group.picks;
  let before = variableRows(files());
  let rows: EditRow[] = before.map((r) => editRow(r, picks()));
  let beforePicks = rowPicks(rows);
  for (const name of add) if (!rows.some((r) => r.name === name)) rows.push({ name, value: '', perEnv: !!env, secret: looksSecretName(name) });

  const table = h('div', { class: 'var-table' });
  const error = h('div', { class: 'field-error' });
  const changed = () => JSON.stringify([rows.map(varRow), rowPicks(rows)]) !== JSON.stringify([before, beforePicks]);
  const where = (r: EditRow) => `${r.perEnv ? env : 'every environment'}${r.secret && !isOpRef(r.value) ? ', secret' : ''}`;

  /** The row of `focus` that counts (a secret, and one for this environment, wins), to start on. */
  let start: EditRow | undefined;

  /**
   * A draw for a field that was changed. A change comes as the field loses focus, before the click
   * or Tab that moves it lands: drawing right then would replace the field it is going to. So the
   * draw waits for focus to move, and then puts it back in the same field (see `draw`).
   */
  let redrawTimer = 0;
  const redrawSoon = () => {
    clearTimeout(redrawTimer);
    redrawTimer = window.setTimeout(() => draw());
  };

  /** Puts the caret in a row's choice (after a draw). */
  const focusChoice = (r: EditRow, index: number) =>
    table.querySelectorAll<HTMLInputElement>(`.var-choices[data-row="${rows.indexOf(r)}"] .var-choice input.mono`)[index]?.focus();

  /** A row's choices, to edit: each a value and a note on when to use it (only shown, never sent). */
  const choicesEditor = (r: EditRow, list: Choice[]) => {
    const personal = rowScope(r) === 'mine' || rowScope(r) === 'mineEnv';
    return h(
      'div',
      { class: 'var-choices', dataset: { row: String(rows.indexOf(r)) } },
      ...list.map((ch, i) => {
        const hidden = store.settings.hideSecrets && r.secret && !isOpRef(ch.value);
        const key = `${rows.indexOf(r)}.${i}`;
        const value = h('input', { class: 'input small mono', value: ch.value, placeholder: 'value', spellcheck: false, type: hidden ? 'password' : 'text', dataset: { key: `cv${key}` } });
        const about = h('input', { class: 'input small', value: ch.description, placeholder: 'When to use it (only shown, never sent)', dataset: { key: `cd${key}` } });
        // The one in use follows its value as it is edited.
        value.addEventListener('input', () => {
          if (r.value === ch.value) r.value = value.value;
          ch.value = value.value;
        });
        value.addEventListener('change', () => {
          const ref = opRef(ch.value);
          if (ref) {
            if (r.value === ch.value) r.value = ref;
            ch.value = ref;
            if (onlyOpRefs(r)) r.secret = true;
          }
          redrawSoon();
        });
        about.addEventListener('input', () => (ch.description = about.value));
        about.addEventListener('change', redrawSoon);
        return h(
          'div',
          { class: 'var-choice' },
          value,
          about,
          h('button', {
            class: 'icon-btn small',
            title: 'Delete this choice',
            html: icons.trash,
            dataset: { key: `cx${key}` },
            onclick: () => {
              list.splice(i, 1);
              if (!list.length) r.choices = undefined;
              else if (!list.some((o) => o.value === r.value)) r.value = list[0].value;
              draw();
            },
          }),
        );
      }),
      h(
        'div',
        { class: 'var-choice-foot' },
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              list.push({ value: '', description: '' });
              draw();
              focusChoice(r, list.length - 1);
            },
          },
          '+ Add choice',
        ),
        h('span', { class: 'hint' }, personal ? 'Kept in your own file, with the one you use as its value.' : 'Shared with the team; each person picks their own. The first is the default.'),
      ),
    );
  };

  const draw = (focusLast = false) => {
    clearTimeout(redrawTimer);
    // The field with focus (and its caret) is the same one after the table is built again.
    const was = table.contains(document.activeElement) ? (document.activeElement as HTMLInputElement) : null;
    const caret = was && typeof was.selectionStart === 'number' ? [was.selectionStart, was.selectionEnd ?? was.selectionStart] : null;
    const vrows = rows.map(varRow);
    const overridden = overriddenRows(vrows);
    table.replaceChildren(
      h('div', { class: 'var-row var-head' }, h('span', null, 'Name'), h('span', null, 'Value'), h('span', null, 'Applies to'), h('span', { title: 'Secret values stay on this computer (git ignores them) and are hidden' }, 'Secret'), h('span')),
      ...rows.flatMap((r, i) => {
        const op = onlyOpRefs(r);
        const name = h('input', { class: 'input small mono var-name', value: r.name, placeholder: 'name', spellcheck: false, dataset: { key: `n${i}` } });
        const hidden = store.settings.hideSecrets && r.secret && !op;
        const value = h('input', { class: 'input small mono var-val', value: r.value, placeholder: 'value, or op://Vault/Item/field', spellcheck: false, type: hidden ? 'password' : 'text', dataset: { key: `v${i}` } });
        name.addEventListener('input', () => (r.name = name.value.trim()));
        name.addEventListener('change', redrawSoon);
        value.addEventListener('input', () => (r.value = value.value));
        // A 1Password reference is always secret; it is kept without quotes or spaces around it.
        value.addEventListener('change', () => {
          const ref = opRef(r.value);
          if (ref) {
            r.value = ref;
            r.secret = true;
          }
          redrawSoon();
        });
        // With choices, the value is the one in use, picked from them.
        const pick = r.choices
          ? h(
              'select',
              { class: 'input small mono var-val', title: 'The one in use now', dataset: { key: `v${i}` } },
              ...r.choices.map((ch) => h('option', { value: ch.value, selected: ch.value === r.value }, choiceLabel(ch, r.secret, store.settings.hideSecrets))),
            )
          : null;
        pick?.addEventListener('change', () => (r.value = pick.value));
        const reveal = hidden && !pick
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
          { class: 'input small', dataset: { key: `a${i}` } },
          h('option', { value: 'all', selected: !r.perEnv }, 'Every environment'),
          h('option', { value: 'env', selected: r.perEnv, disabled: !env }, env ? `${env} only` : '(no environment)'),
        );
        applies.addEventListener('change', () => {
          r.perEnv = applies.value === 'env';
          redrawSoon();
        });
        const secret = h('input', {
          type: 'checkbox',
          checked: r.secret,
          disabled: op,
          title: op ? 'A 1Password reference is always secret, and safe to share' : 'Secret: kept on this computer only (git ignores it) and hidden',
          dataset: { key: `s${i}` },
        });
        secret.addEventListener('change', () => {
          r.secret = secret.checked;
          redrawSoon();
        });
        const winner = overridden.has(vrows[i]) ? rows.filter((o, j) => o.name === r.name && j !== i && !overridden.has(vrows[j])).pop() : undefined;
        const row = h(
          'div',
          {
            class: `var-row${overridden.has(vrows[i]) ? ' overridden' : ''}${r.secret ? ' secret' : ''}${r === start ? ' focus' : ''}`,
            title: winner ? `Not used: "${r.name}" is also set for ${where(winner)}, which wins.` : `Kept in ${scopeFile(rowScope(r), env)}`,
          },
          name,
          h('div', { class: 'var-value' }, pick ?? value, reveal),
          applies,
          h('label', { class: 'var-secret' }, secret),
          h(
            'div',
            { class: 'var-actions' },
            h('button', {
              class: `icon-btn small${r.choices ? ' active' : ''}`,
              title: r.choices ? 'Remove the choices (the one in use stays as the value)' : 'Choices: several values to switch between, each with a note on when to use it',
              html: icons.list,
              dataset: { key: `c${i}` },
              onclick: () => {
                r.choices = r.choices ? undefined : [{ value: r.value, description: '' }, ...(r.value ? [{ value: '', description: '' }] : [])];
                draw();
                if (r.choices) focusChoice(r, r.choices.length - 1);
              },
            }),
            h('button', {
              class: 'icon-btn small',
              title: 'Delete',
              html: icons.trash,
              dataset: { key: `d${i}` },
              onclick: () => {
                rows.splice(i, 1);
                draw();
              },
            }),
          ),
        );
        return r.choices ? [row, choicesEditor(r, r.choices)] : [row];
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
    if (focusLast) return table.querySelectorAll<HTMLInputElement>('.var-name')[rows.length - 1]?.focus();
    const again = was?.dataset.key ? table.querySelector<HTMLInputElement>(`[data-key="${was.dataset.key}"]`) : null;
    if (!again) return;
    again.focus();
    if (caret && typeof again.selectionStart === 'number') again.setSelectionRange(caret[0], caret[1]);
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
    rows = before.map((r) => editRow(r, picks()));
    beforePicks = rowPicks(rows);
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
      const value = row?.querySelector<HTMLInputElement | HTMLSelectElement>('.var-val');
      value?.focus();
      if (value instanceof HTMLInputElement) value.select();
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
        'Normal values are shared with the team through git: .env for every environment, environments/<env>.json for one. Secret values stay on this computer in .env.local / .env.<env>.local, which git ignores, so each person keeps their own. A 1Password reference (op://Vault/Item/field) is secret but holds no secret, so it is shared. For the same name, a secret wins over a normal value, and one for an environment wins over one for every environment. A variable with choices (the list button) has several values, each with a note on when to use it: switch between them from the environment menu, or Ctrl+click the variable in a request.',
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
          // Empty choices are left out; the one in use must be one of those left.
          for (const r of rows) {
            r.choices = r.choices?.filter((ch) => ch.value || ch.description);
            if (!r.choices?.length) r.choices = undefined;
            else if (!r.choices.some((ch) => ch.value === r.value)) r.value = r.choices[0].value;
          }
          rows = rows.filter((r) => r.name || r.value || r.choices);
          const problem = checkRows(rows.map(varRow), env);
          if (problem) {
            error.textContent = problem;
            draw();
            return false;
          }
          // A secret-looking value that isn't marked secret would be shared through git.
          const exposed = rows.filter((r) => !r.secret && looksSecretName(r.name) && rowValues(r).some(Boolean) && !before.some((b) => JSON.stringify(b) === JSON.stringify(varRow(r))));
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
          // The ones chosen here are this person's, kept with the group (not in the shared files).
          const chosen = rowPicks(rows);
          if (JSON.stringify(chosen) !== JSON.stringify(beforePicks))
            store.update((cfg) => {
              const g = cfg.groups.find((x) => x.id === group.id);
              if (g) g.picks = { ...g.picks, ...chosen };
            });
          await collections.reload(group.id);
          // Secret files are git-ignored; gitSync leaves them out anyway.
          void gitSync.changed(group.id, writes.map((w) => w.path));
          toast('Variables saved');
        },
      },
    ],
  });
}
