/**
 * A request pane: one request file of a linked folder, with its response. It sits in tabs and
 * splits like a terminal. Requests are sent by Windows' curl (see http.rs and variables.ts for how
 * secrets reach it); the response of the last send stays in memory only.
 */
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, type HttpRequest, type HttpResult } from './api';
import { codeEditor } from './codeEditor';
import { collections } from './collections';
import { groupColor, uid } from './config';
import { curlCommand } from './curl';
import { choiceDialog, confirmDialog, toast } from './dialogs';
import { h, setChildren } from './dom';
import { isLocalEnvFile } from './dotenv';
import { icons } from './icons';
import { jsonLines, lineText, type JsonLine } from './jsonView';
import { matchRequestKey } from './keys';
import { showMenu, showMenuBelow } from './menu';
import { paneHeader, type PaneEvents, type WorkspacePane } from './panes';
import {
  emptyBody,
  joinUrl,
  METHODS,
  newRequest,
  readRequest,
  requestFolder,
  requestName,
  serializeRequest,
  splitUrl,
  type BodyType,
  type KeyValue,
  type RequestDoc,
} from './requestFile';
import { choiceEntries, environmentEntries } from './requestActions';
import type { RequestRef, SnapshotLeaf } from './snapshot';
import { store } from './store';
import type { Group, Settings } from './types';
import { choiceLabel, currentChoice, displayValue, filesOutside, findSecretLiterals, isOpRef, opRef, prepareRequest, segments, usedVariables, type Variable } from './variables';
import { editVariables } from './variablesDialog';
import { onRepaint, repaintVarFields, varField, type VarContext } from './varField';
import { gitSync } from './gitSync';

export interface RequestHost extends PaneEvents {
  /** The request was edited: a preview tab becomes an ordinary one. */
  onEdited(pane: RequestPane): void;
}

type Section = 'params' | 'headers' | 'body' | 'auth' | 'options' | 'notes';
type ResponseTab = 'body' | 'headers' | 'timing' | 'cookies' | 'console';

interface LastResponse {
  /** The id the body file is kept under (for saving it). */
  id: number;
  result: HttpResult | null;
  error: string | null;
  env: string;
  at: Date;
}

/** Files from outside a request's folder that the person agreed to send (while Shellman runs). */
const agreedFiles = new Set<string>();

/** The pane whose search the response highlights show. */
let findOwner: RequestPane | null = null;

/** The last response of each request (`groupId/path`), for as long as Shellman runs. */
const lastResponses = new Map<string, LastResponse>();
let nextSendId = 1;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const BODY_TYPES: [BodyType, string][] = [
  ['none', 'No body'],
  ['json', 'JSON'],
  ['text', 'Text'],
  ['xml', 'XML'],
  ['form', 'Form (urlencoded)'],
  ['multipart', 'Multipart (files)'],
  ['file', 'File'],
];

const isJsonish = (text: string) => {
  try {
    // Variables may stand where values go ({"id": {{userId}}}).
    JSON.parse(text.replace(/\{\{[^}]*\}\}/g, '1'));
    return true;
  } catch {
    return false;
  }
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A triple-click selects just this element's text, not the whole line it is on. */
function selectOnTripleClick(e: MouseEvent): void {
  if (e.detail !== 3) return;
  e.preventDefault();
  const range = document.createRange();
  range.selectNodeContents(e.currentTarget as Node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Copies a request as a curl command for the shell chosen in Settings. */
export async function copyRequestAsCurl(group: Group, doc: RequestDoc): Promise<void> {
  const c = collections.get(group.id);
  if (!c) return;
  const s = store.settings;
  const vars = collections.variables(group);
  const { request, missing } = prepareRequest(doc, vars, { folder: c.folder, followRedirects: s.requestFollowRedirects, timeoutSeconds: s.requestTimeout });
  const refs: Record<string, string> = {};
  const plain: string[] = [];
  for (const sec of request.secrets ?? []) {
    const ref = opRef(sec.value);
    if (ref) refs[sec.name] = ref;
    else plain.push(sec.name);
  }
  const shell = s.copyCurlShell;
  let command: string;
  try {
    command = curlCommand(request, shell, refs, s.opAccount);
  } catch (e) {
    return toast(e instanceof Error ? e.message : String(e), 'error', 8000);
  }
  await api.clipboardWrite(command).then(
    () => {
      const label = shell === 'powershell' ? 'PowerShell 7' : shell;
      const notes = [missing.length ? `not defined: ${missing.join(', ')}` : '', plain.length ? `set ${plain.join(', ')} in your environment first` : ''].filter(Boolean);
      toast(`curl command copied for ${label}${notes.length ? ` (${notes.join('; ')})` : ''}`, 'info', notes.length ? 8000 : 4000);
    },
    (e) => toast(String(e), 'error'),
  );
}

export class RequestPane implements WorkspacePane {
  readonly id = uid('p-');
  readonly kind = 'request';
  readonly el: HTMLDivElement;
  readonly title = '';
  readonly progress = null;
  readonly ended = false;
  readonly hasGpu = false;
  lastOutput = 0;
  ref: RequestRef;
  /** The text selected in the pane when its menu opened, for the menu's Copy. */
  menuSelection = '';
  /** What was last sent or received, for the status bar. */
  status = '';

  private doc: RequestDoc;
  /** The file as last read or written, in its saved form: what `dirty` compares with. */
  private saved: string;
  /** The file's text exactly as on disk ('' = no file yet), to notice when it changes. */
  private disk = '';
  /** The file isn't valid JSON (e.g. a merge conflict): shown, but never saved over. */
  private unreadable = false;
  /** The file changed on disk while this pane had unsaved changes. */
  private changedOnDisk = false;
  private section: Section;
  /** The body shows with its variables filled in (read-only). */
  private bodyPreview = false;
  private responseTab: ResponseTab = 'body';
  private sending: { id: number; started: number } | null = null;
  private readonly folded = new Set<number>();
  /** null = not decided yet (or the setting changed): the next fit sets it. */
  private layout: 'below' | 'right' | null = null;

  private readonly header: ReturnType<typeof paneHeader>;
  /** The request's folder and name above the URL; tabs cut long names short. */
  private readonly titleEl = h('div', { class: 'rq-title' });
  private readonly methodEl: HTMLSelectElement;
  private readonly urlEl: HTMLInputElement;
  private readonly urlField: HTMLElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly envBtn: HTMLButtonElement;
  private readonly resolvedEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly sectionTabs: HTMLElement;
  private readonly sectionEl: HTMLElement;
  /** The variables the current section uses, under it. */
  private readonly sourcesEl = h('div', { class: 'rq-sources-wrap' });
  /** How the fields show their variables and open them for editing. */
  private readonly varCtx: VarContext = {
    vars: () => {
      const group = this.group;
      return group ? collections.variables(group) : new Map<string, Variable>();
    },
    edit: (name, missing, at) => {
      const group = this.group;
      const choices = group && !missing ? choiceEntries(group, name) : [];
      if (!choices.length || !at) return this.editVariables(missing ? [name] : [], name);
      showMenu(at.x, at.y, [...choices, 'separator', { label: 'Edit variables…', icon: 'edit', action: () => this.editVariables([], name) }]);
    },
  };
  private readonly mainEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly responseTabs: HTMLElement;
  private readonly responseEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly unsubscribe: () => void;
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(
    ref: RequestRef,
    private readonly host: RequestHost,
  ) {
    this.ref = { ...ref };
    const entry = collections.request(ref.groupId, ref.path);
    this.doc = newRequest();
    this.saved = '';
    if (entry) this.load(entry.text);
    this.section = this.doc.body.type !== 'none' ? 'body' : 'params';

    this.header = paneHeader((action) => host.onHeaderAction(this, action));
    this.methodEl = h('select', { class: 'rq-method', title: 'Method' }, ...METHODS.map((m) => h('option', { value: m }, m)));
    this.methodEl.addEventListener('change', () => this.edit(() => (this.doc.method = this.methodEl.value)));
    this.urlEl = h('input', { class: 'rq-url', spellcheck: false, placeholder: '{{baseUrl}}/path', autocomplete: 'off' });
    this.urlEl.addEventListener('input', () => this.edit(() => (this.doc.url = this.urlEl.value), false));
    this.urlEl.addEventListener('change', () => this.renderSection());
    this.urlField = varField(this.urlEl, this.varCtx);
    this.urlField.classList.add('rq-url-field');
    this.sendBtn = h('button', { class: 'btn primary rq-send', title: 'Send (Ctrl+Enter)', onclick: () => void this.send() }, 'Send');
    this.envBtn = h('button', {
      class: 'rq-env',
      title: 'Environment: click to change',
      onclick: () => {
        const group = this.group;
        if (group) showMenuBelow(this.envBtn, environmentEntries(group));
      },
    });
    this.resolvedEl = h('span', { class: 'rq-resolved mono', title: 'The URL with its variables filled in' });
    this.bannerEl = h('div', { class: 'rq-banners' });
    this.sectionTabs = h('div', { class: 'rq-tabs', role: 'tablist' });
    this.sectionEl = h('div', { class: 'rq-section' });
    this.statusEl = h('div', { class: 'rq-status' });
    this.responseTabs = h('div', { class: 'rq-tabs', role: 'tablist' });
    this.responseEl = h('div', { class: 'rq-response-body' });
    this.searchInput = h('input', { class: 'input small rq-find', placeholder: 'Find', spellcheck: false });
    this.searchInput.addEventListener('input', () => this.find(false));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.find(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.searchInput.value = '';
        this.find(false);
        this.urlEl.focus();
      }
    });

    const tool = (icon: keyof typeof icons, label: string, title: string, fn: (e: MouseEvent) => void) =>
      h('button', { class: 'rq-tool', title, onclick: fn }, h('span', { html: icons[icon] }), label);

    this.mainEl = h(
      'div',
      { class: 'rq-main below' },
      h('div', { class: 'rq-editor' }, this.sectionTabs, this.sectionEl),
      h(
        'div',
        { class: 'rq-response' },
        h('div', { class: 'rq-response-head' }, this.statusEl, h('span', { class: 'spacer' }), this.responseTabs),
        this.responseEl,
      ),
    );
    this.el = h(
      'div',
      { class: 'pane request-pane', dataset: { pane: this.id } },
      this.header.el,
      h(
        'div',
        { class: 'rq' },
        this.titleEl,
        h('div', { class: 'rq-urlbar' }, this.methodEl, this.urlField, this.envBtn, this.sendBtn),
        h(
          'div',
          { class: 'rq-urlinfo' },
          this.resolvedEl,
          h('span', { class: 'spacer' }),
          tool('edit', 'Variables', 'See and edit the variables, and where they are kept', () => this.editVariables()),
          tool('copy', 'Copy as curl', 'Copy the request as a curl command', () => void this.copyAsCurl()),
          tool('save', 'Save', 'Save the request file (Ctrl+S)', () => void this.save()),
        ),
        this.bannerEl,
        this.mainEl,
      ),
    );
    this.el.addEventListener('mousedown', () => host.onFocus(this));
    this.el.addEventListener('focusin', () => host.onFocus(this));
    this.el.addEventListener('keydown', (e) => {
      const action = matchRequestKey(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'send') void this.send();
      else void this.save();
    });
    this.el.addEventListener('contextmenu', (e) => {
      // Text fields keep their own menu (cut, copy, paste).
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      e.preventDefault();
      // Opening the menu focuses the pane (its URL field), which ends a selection: keep it for Copy and
      // show it again.
      const sel = window.getSelection();
      const range = sel && !sel.isCollapsed && this.el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
      this.menuSelection = range?.toString() ?? '';
      host.onContextMenu(this, e);
      if (range) {
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.queueFit());
    const offFolder = collections.on((groupId) => groupId === this.ref.groupId && this.onFolderChange());
    // The group's environment (or its name, colour) may change.
    const offConfig = store.on(() => {
      this.renderHeader();
      this.renderUrlInfo();
      this.renderSources();
      repaintVarFields(this.el);
    });
    this.unsubscribe = () => {
      offFolder();
      offConfig();
    };
    this.renderAll();
  }

  // ---- WorkspacePane ----------------------------------------------------

  get name(): string {
    return requestName(this.ref.path);
  }

  get group(): Group | undefined {
    return store.config.groups.find((g) => g.id === this.ref.groupId);
  }

  get location(): string {
    return `${this.group?.name ?? ''} · ${this.ref.path}`;
  }

  get color(): string {
    return groupColor(store.config.groups, this.ref.groupId);
  }

  get dirty(): boolean {
    return !this.unreadable && serializeRequest(this.doc) !== this.saved;
  }

  /** A request is on its way (closing or replacing the pane would cancel it). */
  get isSending(): boolean {
    return !!this.sending;
  }

  /** Takes the file's text as the current version. Git may check it out with CRLF, and a hand
   * edit may order the keys differently: what counts is what it says, not how it is written. */
  private load(text: string): void {
    const doc = readRequest(text);
    this.disk = text;
    this.unreadable = !doc;
    if (doc) this.doc = doc;
    this.saved = serializeRequest(this.doc);
  }

  /** The method, for the tab and the sidebar. */
  get method(): string {
    return this.doc.method;
  }

  private get key(): string {
    return `${this.ref.groupId}/${this.ref.path}`;
  }

  mount(): void {
    this.resizeObserver.observe(this.el);
  }

  async start(): Promise<void> {}

  setActive(active: boolean): void {
    this.el.classList.toggle('active', active);
  }

  setZoomed(zoomed: boolean): void {
    this.header.setZoomed(zoomed);
  }

  queueFit(): void {
    const s = store.settings.responseLayout;
    const wide = this.el.clientWidth > 900 && this.el.clientWidth > this.el.clientHeight * 1.4;
    const layout = s === 'right' || (s === 'auto' && wide) ? 'right' : 'below';
    if (layout === this.layout) return;
    this.layout = layout;
    this.mainEl.classList.toggle('right', layout === 'right');
    this.mainEl.classList.toggle('below', layout === 'below');
  }

  focus(): void {
    if (!this.el.contains(document.activeElement)) this.urlEl.focus();
  }

  enableGpu(): void {}
  disableGpu(): void {}

  applySettings(_s: Settings): void {
    this.layout = null;
    this.queueFit();
    this.renderResponse();
    this.renderUrlInfo();
  }

  async hasRunningProgram(): Promise<boolean> {
    return !!this.sending;
  }

  snapshot(): SnapshotLeaf {
    return { request: { ...this.ref } };
  }

  openSearch(): void {
    this.responseTab = 'body';
    this.renderResponse();
    this.searchInput.focus();
    this.searchInput.select();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sending) void api.httpCancel(this.sending.id);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    if (findOwner === this) {
      CSS.highlights?.delete('rq-find');
      CSS.highlights?.delete('rq-find-current');
      findOwner = null;
    }
    this.el.remove();
  }

  // ---- editing ----------------------------------------------------------

  /** Applies an edit; `rerender` redraws the section (not while typing in a field of it). */
  private edit(change: () => void, rerender = false): void {
    change();
    if (rerender) this.renderSection();
    else this.renderSources();
    this.renderUrlInfo();
    this.renderHeader();
    this.host.onEdited(this);
    this.host.onInfoChange(this);
  }

  /** The file was renamed or moved (in the sidebar). */
  moveTo(path: string): void {
    lastResponses.set(`${this.ref.groupId}/${path}`, lastResponses.get(this.key)!);
    lastResponses.delete(this.key);
    this.ref = { ...this.ref, path };
    this.renderHeader();
    this.host.onInfoChange(this);
  }

  private onFolderChange(): void {
    if (this.disposed) return;
    const entry = collections.request(this.ref.groupId, this.ref.path);
    if (entry && entry.text !== this.disk) {
      const doc = readRequest(entry.text);
      if (doc && serializeRequest(doc) === this.saved) {
        // Written differently, says the same (line endings, key order).
        this.disk = entry.text;
      } else if (!this.dirty) {
        // Changed by someone else (another program, a git pull) and not edited here: follow it.
        this.load(entry.text);
        this.renderAll();
      } else {
        this.changedOnDisk = true;
      }
    }
    this.renderBanners();
    this.renderUrlInfo();
    this.renderSources();
    repaintVarFields(this.el);
  }

  /** Writes the request file. A typed-in token or password may first move to `.env.local`. */
  async save(): Promise<boolean> {
    const group = this.group;
    const c = collections.get(this.ref.groupId);
    if (!group || !c) {
      toast('The group of this request is no longer linked to a folder.', 'error');
      return false;
    }
    if (this.unreadable) {
      toast("This request file isn't valid JSON, so it isn't saved over. Fix it in an editor first.", 'error', 8000);
      return false;
    }
    if (store.settings.warnSecretsOnSave) {
      const found = findSecretLiterals(this.doc);
      if (found.length) {
        const answer = await choiceDialog(
          'Save a secret in a shared file?',
          `${found.map((f) => f.where).join(', ')} looks like a real token or password. Request files are shared with everyone who has the folder (through git). Move it to your own .env.local and use a variable instead?`,
          [
            { label: 'Cancel', value: 'cancel' as const },
            { label: 'Save as it is', value: 'keep' as const },
            { label: 'Move to .env.local', value: 'move' as const, kind: 'primary' },
          ],
        );
        if (answer === null || answer === 'cancel') return false;
        if (answer === 'move' && !(await this.moveSecrets(group, found.map((f) => f.value)))) return false;
      }
    }
    const text = serializeRequest(this.doc);
    try {
      await api.collectionWrite(c.folder, this.ref.path, 'request', text);
    } catch (e) {
      toast(`Could not save: ${e}`, 'error', 8000);
      return false;
    }
    this.saved = text;
    this.disk = text;
    this.changedOnDisk = false;
    this.renderHeader();
    this.renderBanners();
    this.host.onInfoChange(this);
    void gitSync.changed(this.ref.groupId, [this.ref.path]);
    return true;
  }

  /** Replaces typed-in secrets with `{{NAME}}` and keeps their values in `.env.local`; false = not moved. */
  private async moveSecrets(group: Group, values: string[]): Promise<boolean> {
    const vars = collections.variables(group);
    const entries: { name: string; value: string }[] = [];
    const nameFor = (value: string, base: string) => {
      const known = [...vars.values()].find((v) => v.value === value) ?? entries.find((e) => e.value === value);
      if (known) return known.name;
      let name = base;
      for (let n = 2; vars.has(name) || entries.some((e) => e.name === name); n++) name = `${base}_${n}`;
      entries.push({ name, value });
      return name;
    };
    const replace = (s: string, base: string) => {
      for (const v of values) if (s.includes(v)) s = s.replace(v, `{{${nameFor(v, base)}}}`);
      return s;
    };
    const upper = (name: string, fallback: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
    // A copy: the request changes only once the values are safely in the personal file.
    const d: RequestDoc = structuredClone(this.doc);
    for (const hd of d.headers) hd.value = replace(hd.value, upper(hd.name, 'TOKEN'));
    if (d.auth.type === 'bearer') d.auth.token = replace(d.auth.token, 'TOKEN');
    if (d.auth.type === 'basic') d.auth.password = replace(d.auth.password, 'PASSWORD');
    if (d.auth.type === 'apikey') d.auth.value = replace(d.auth.value, 'API_KEY');
    for (const f of d.body.fields) if (!f.file) f.value = replace(f.value, upper(f.name, 'SECRET'));
    d.url = replace(d.url, 'TOKEN');
    d.body.text = replace(d.body.text, 'TOKEN');
    if (entries.length) {
      try {
        const file = await collections.setPersonal(group, entries);
        toast(`Moved to ${file}: ${entries.map((e) => e.name).join(', ')}`);
      } catch (e) {
        toast(`Could not write .env.local, so the request isn't saved: ${e}`, 'error', 8000);
        return false;
      }
    }
    this.doc = d;
    this.renderAll();
    return true;
  }

  // ---- sending ----------------------------------------------------------

  async send(): Promise<void> {
    if (this.sending) {
      void api.httpCancel(this.sending.id);
      return;
    }
    const group = this.group;
    const c = collections.get(this.ref.groupId);
    if (!group || !c) return;
    const s = store.settings;
    const vars = collections.variables(group);
    const prepared = prepareRequest(this.doc, vars, { folder: c.folder, followRedirects: s.requestFollowRedirects, timeoutSeconds: s.requestTimeout });
    if (!prepared.request.url) return this.urlEl.focus();
    if (prepared.missing.length) {
      this.renderBanners(prepared.missing);
      return;
    }
    const env = collections.env(group);
    const protectedEnv = collections.environment(group)?.protected;
    if (protectedEnv && s.confirmProtectedSend && this.doc.method !== 'GET' && this.doc.method !== 'HEAD') {
      const ok = await confirmDialog(`Send ${this.doc.method} to ${env}?`, `"${env}" is a protected environment. Send ${this.name} there?`, `Send to ${env}`, true);
      if (!ok) return;
    }
    const outside = filesOutside(prepared.request, c.folder).filter((f) => !agreedFiles.has(f.toLowerCase()));
    if (outside.length) {
      const ok = await confirmDialog(
        'Send a file from outside the folder?',
        `This request sends ${outside.join(', ')}, which isn't in its linked folder. Request files are shared, so check it is a file you mean to send.`,
        'Send',
        true,
      );
      if (!ok) return;
      for (const f of outside) agreedFiles.add(f.toLowerCase());
    }
    if (s.saveOnSend && this.dirty && !(await this.save())) return;

    const request: HttpRequest = {
      ...prepared.request,
      cookieJar: `${group.id}/${env}`,
      curlPath: s.curlPath,
      opPath: s.opPath,
      opAccount: s.opAccount,
      proxy: s.proxyMode === 'custom' ? { mode: 'custom', url: s.proxyUrl } : { mode: s.proxyMode },
      maxBodyBytes: s.responseMaxMb * 1024 * 1024,
    };
    const id = nextSendId++;
    this.sending = { id, started: performance.now() };
    this.renderBanners();
    this.renderSending();
    let result: HttpResult | null = null;
    let error: string | null = null;
    try {
      result = await api.httpSend(id, request);
    } catch (e) {
      error = String(e);
    }
    this.sending = null;
    const previous = lastResponses.get(this.key);
    if (previous) void api.httpDiscard(previous.id);
    lastResponses.set(this.key, { id, result, error, env, at: new Date() });
    this.lastOutput = performance.now();
    this.folded.clear();
    this.renderAll();
    this.host.onInfoChange(this);
  }

  copyAsCurl(): Promise<void> {
    const group = this.group;
    return group ? copyRequestAsCurl(group, this.doc) : Promise.resolve();
  }

  // ---- rendering --------------------------------------------------------

  private renderAll(): void {
    this.methodEl.value = METHODS.includes(this.doc.method as (typeof METHODS)[number]) ? this.doc.method : 'GET';
    if (this.urlEl.value !== this.doc.url) {
      this.urlEl.value = this.doc.url;
      repaintVarFields(this.urlField);
    }
    this.renderHeader();
    this.renderUrlInfo();
    this.renderBanners();
    this.renderSection();
    this.renderResponse();
  }

  private renderHeader(): void {
    this.header.name.textContent = this.name;
    this.header.title.textContent = this.dirty ? '● unsaved' : this.doc.method;
    // Only the nearest folder: the full path is in the tooltip and the status bar.
    const folder = requestFolder(this.ref.path).split('/').pop();
    this.titleEl.replaceChildren(folder ? h('span', { class: 'muted' }, `${folder}/`) : '', this.name);
    this.titleEl.title = this.ref.path;
    this.el.style.setProperty('--session-color', this.color || 'transparent');
    const group = this.group;
    const env = group ? collections.environment(group) : undefined;
    const envName = group ? collections.env(group) : '';
    this.sendBtn.classList.toggle('danger', !!env?.protected && !this.sending);
    this.envBtn.textContent = envName || 'No environment';
    this.envBtn.classList.toggle('protected', !!env?.protected);
    this.envBtn.title = `Environment: ${envName || 'none'}${env?.protected ? ' (protected: asks before anything but GET)' : ''}. Click to change.`;
    this.methodEl.dataset.method = this.doc.method;
  }

  private renderUrlInfo(): void {
    this.resolvedEl.replaceChildren(h('span', { class: 'muted' }, '→ '), ...this.filledIn(this.doc.url));
  }

  /** `text` with its variables' values, each one a click away from editing (or switching) it. */
  private filledIn(text: string): HTMLElement[] {
    const vars = this.varCtx.vars();
    const title = (name: string, kind: string) => (kind === 'missing' ? `{{${name}}} isn't defined: click to add it` : `{{${name}}}: click to ${vars.get(name)?.choices ? 'switch' : 'edit'}`);
    return segments(text, vars, store.settings.hideSecrets).map((p) =>
      h(
        'span',
        {
          class: `seg-${p.kind}`,
          title: p.name ? title(p.name, p.kind) : undefined,
          onclick: p.name
            ? (e: MouseEvent) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                this.varCtx.edit(p.name!, p.kind === 'missing', { x: r.left, y: r.bottom + 2 });
              }
            : undefined,
        },
        p.text,
      ),
    );
  }

  private renderBanners(missing: string[] = []): void {
    const group = this.group;
    const c = collections.get(this.ref.groupId);
    const items: HTMLElement[] = [];
    if (!c) items.push(h('div', { class: 'rq-banner error' }, 'The group of this request is no longer linked to a folder.'));
    else if (c.error) items.push(h('div', { class: 'rq-banner error' }, c.error));
    else if (!collections.request(this.ref.groupId, this.ref.path) && this.disk)
      items.push(h('div', { class: 'rq-banner' }, 'This request file was deleted or renamed outside Shellman. Save to write it again.'));
    if (this.unreadable)
      items.push(
        h('div', { class: 'rq-banner error' }, "This file isn't valid JSON (a merge conflict, or a typo?). Fix it in an editor; until then it isn't saved over and shows as it was."),
      );
    if (this.changedOnDisk)
      items.push(
        h(
          'div',
          { class: 'rq-banner' },
          h('span', null, 'The file changed on disk (someone else saved it, or a git pull).'),
          h('button', {
            class: 'btn small',
            onclick: () => {
              const entry = collections.request(this.ref.groupId, this.ref.path);
              if (entry) this.load(entry.text);
              this.changedOnDisk = false;
              this.renderAll();
              this.host.onInfoChange(this);
            },
          }, 'Reload'),
          h('button', {
            class: 'btn small',
            onclick: () => {
              // The disk version becomes the one mine is compared with, so it isn't asked again.
              const entry = collections.request(this.ref.groupId, this.ref.path);
              const doc = entry && readRequest(entry.text);
              if (entry && doc) {
                this.disk = entry.text;
                this.saved = serializeRequest(doc);
              }
              this.changedOnDisk = false;
              this.renderBanners();
              this.renderHeader();
              this.host.onInfoChange(this);
            },
          }, 'Keep mine'),
        ),
      );
    if (missing.length) {
      const env = group ? collections.env(group) : '';
      items.push(
        h(
          'div',
          { class: 'rq-banner error' },
          h('span', null, `Not defined: ${missing.map((m) => `{{${m}}}`).join(', ')}${env ? ` (environment ${env})` : ''}.`),
          h('button', { class: 'btn small', onclick: () => this.editVariables(missing) }, `Add ${missing.length > 1 ? 'them' : 'it'}…`),
        ),
      );
    }
    if (c?.notIgnored.length)
      items.push(
        h(
          'div',
          { class: 'rq-banner error' },
          h('span', null, `${c.notIgnored.join(', ')} ${c.notIgnored.length > 1 ? 'are' : 'is'} not ignored by git, so your secrets could be committed.`),
          h('button', { class: 'btn small', onclick: () => void collections.ignoreLocalFiles(this.ref.groupId).then(() => gitSync.changed(this.ref.groupId, ['.gitignore'])) }, 'Add to .gitignore'),
        ),
      );
    this.bannerEl.replaceChildren(...items);
  }

  private renderSection(): void {
    const sections: [Section, string, string][] = [
      ['params', 'Params', String(splitUrl(this.doc.url).params.length || '')],
      ['headers', 'Headers', String(this.doc.headers.filter((x) => x.enabled).length || '')],
      ['body', 'Body', this.doc.body.type === 'none' ? '' : BODY_TYPES.find(([t]) => t === this.doc.body.type)![1].split(' ')[0]],
      ['auth', 'Auth', this.doc.auth.type === 'none' ? '' : this.doc.auth.type === 'apikey' ? 'API key' : this.doc.auth.type === 'basic' ? 'Basic' : 'Bearer'],
      ['options', 'Options', Object.keys(this.doc.options).length ? '•' : ''],
      ['notes', 'Notes', this.doc.notes ? '•' : ''],
    ];
    this.sectionTabs.replaceChildren(
      ...sections.map(([id, label, badge]) =>
        h(
          'button',
          {
            class: `rq-tab${this.section === id ? ' sel' : ''}`,
            role: 'tab',
            onclick: () => {
              this.section = id;
              this.renderSection();
            },
          },
          label,
          badge ? h('span', { class: 'rq-badge' }, badge) : null,
        ),
      ),
    );
    this.sectionEl.replaceChildren(this.sectionContent(), this.sourcesEl);
    this.renderSources();
  }

  /** The text of the current section, for the variables it uses. */
  private sectionText(): string {
    const d = this.doc;
    switch (this.section) {
      case 'params':
        return d.url;
      case 'headers':
        return JSON.stringify(d.headers.filter((x) => x.enabled));
      case 'body':
        return d.body.type === 'none' ? '' : JSON.stringify(d.body);
      case 'auth':
        return JSON.stringify(d.auth);
      default:
        return '';
    }
  }

  private renderSources(): void {
    this.sourcesEl.replaceChildren(...[this.sources(this.sectionText())].filter((x): x is HTMLElement => !!x));
  }

  private sectionContent(): HTMLElement {
    const d = this.doc;
    switch (this.section) {
      case 'params': {
        const u = splitUrl(d.url);
        return h(
          'div',
          null,
          this.kvTable(u.params, () => {
            d.url = joinUrl(u.base, u.params, u.hash);
            this.urlEl.value = d.url;
            repaintVarFields(this.urlField);
          }, { names: ['Parameter', 'Value'], toggle: false }),
          h('p', { class: 'hint' }, 'The query of the URL; editing either one changes the other.'),
        );
      }
      case 'headers': {
        const auto: string[] = [];
        const has = (n: string) => d.headers.some((x) => x.enabled && x.name.toLowerCase() === n);
        if (d.auth.type === 'bearer' && !has('authorization')) auto.push('Authorization: Bearer … (from Auth)');
        if (d.auth.type === 'basic') auto.push('Authorization: Basic … (from Auth)');
        if (d.auth.type === 'apikey' && d.auth.in === 'header' && d.auth.name) auto.push(`${d.auth.name}: … (from Auth)`);
        const ct = { json: 'application/json', xml: 'application/xml', text: 'text/plain' }[d.body.type as string];
        if (ct && !has('content-type')) auto.push(`Content-Type: ${ct} (from Body)`);
        return h('div', null, this.kvTable(d.headers, () => undefined, { names: ['Header', 'Value'], toggle: true }), ...auto.map((a) => h('div', { class: 'rq-auto mono' }, a)));
      }
      case 'body':
        return this.bodyEditor();
      case 'auth':
        return this.authEditor();
      case 'options':
        return this.optionsEditor();
      case 'notes': {
        const ta = h('textarea', { class: 'input rq-notes', placeholder: 'Notes for the team (saved in the request file)', spellcheck: true });
        ta.value = d.notes;
        ta.addEventListener('input', () => this.edit(() => (d.notes = ta.value)));
        return ta;
      }
    }
  }

  /** Rows of name/value fields; editing changes `rows` in place. */
  private kvTable(rows: (KeyValue & { file?: boolean })[], changed: () => void, opts: { names: [string, string]; toggle: boolean; files?: boolean }): HTMLElement {
    const box = h('div', { class: 'rq-kv' });
    const draw = (focusLast = false) => {
      box.replaceChildren(
        ...rows.map((r, i) => {
          const name = h('input', { class: 'input small mono', value: r.name, placeholder: opts.names[0], spellcheck: false });
          const value = h('input', { class: 'input small mono', value: r.value, placeholder: r.file ? 'File path' : opts.names[1], spellcheck: false });
          name.addEventListener('input', () => this.edit(() => ((r.name = name.value), changed())));
          value.addEventListener('input', () => this.edit(() => ((r.value = value.value), changed())));
          const on = opts.toggle
            ? h('input', {
                type: 'checkbox',
                checked: r.enabled,
                title: 'Send this one',
                onchange: (e: Event) => this.edit(() => ((r.enabled = (e.target as HTMLInputElement).checked), changed())),
              })
            : null;
          const file = opts.files
            ? h('button', {
                class: `icon-btn small${r.file ? ' on' : ''}`,
                title: r.file ? 'A file (click for text)' : 'Text (click for a file)',
                html: icons.folder,
                onclick: async () => {
                  if (!r.file) {
                    const picked = await openDialog({ multiple: false, directory: false });
                    if (typeof picked !== 'string') return;
                    this.edit(() => ((r.file = true), (r.value = this.relativePath(picked)), changed()));
                  } else this.edit(() => ((r.file = false), (r.value = ''), changed()));
                  draw();
                },
              })
            : null;
          const remove = h('button', {
            class: 'icon-btn small',
            title: 'Remove',
            html: icons.x,
            onclick: () => {
              this.edit(() => (rows.splice(i, 1), changed()));
              draw();
              this.renderSection();
            },
          });
          return h('div', { class: 'rq-kv-row' }, on ?? h('span'), varField(name, this.varCtx), varField(value, this.varCtx), file, remove);
        }),
        h(
          'button',
          {
            class: 'btn small rq-add',
            onclick: () => {
              this.edit(() => rows.push({ name: '', value: '', enabled: true }));
              draw(true);
            },
          },
          `Add ${opts.names[0].toLowerCase()}`,
        ),
      );
      if (focusLast) box.querySelectorAll<HTMLInputElement>('.rq-kv-row input.mono')[(rows.length - 1) * 2]?.focus();
    };
    draw();
    return box;
  }

  /** Inside the folder: relative to it, so the path works for the whole team. */
  private relativePath(path: string): string {
    const folder = collections.get(this.ref.groupId)?.folder.replace(/[\\/]+$/, '');
    if (folder && path.toLowerCase().startsWith(`${folder.toLowerCase()}\\`)) return path.slice(folder.length + 1).replace(/\\/g, '/');
    return path;
  }

  private bodyEditor(): HTMLElement {
    const b = this.doc.body;
    const type = h('select', { class: 'input small' }, ...BODY_TYPES.map(([t, label]) => h('option', { value: t, selected: t === b.type }, label)));
    type.addEventListener('change', () =>
      this.edit(() => {
        const t = type.value as BodyType;
        const keepText = ['json', 'text', 'xml'].includes(t) && ['json', 'text', 'xml'].includes(b.type);
        const keepFields = ['form', 'multipart'].includes(t) && ['form', 'multipart'].includes(b.type);
        this.doc.body = { ...emptyBody(t), text: keepText ? b.text : '', fields: keepFields ? b.fields : [] };
        if (this.doc.method === 'GET' && t !== 'none') {
          this.doc.method = 'POST';
          this.methodEl.value = 'POST';
        }
      }, true),
    );
    const bar = h('div', { class: 'rq-bodybar' }, type);
    if (b.type === 'none') return h('div', null, bar, h('p', { class: 'hint' }, 'This request has no body.'));
    if (b.type === 'json' || b.type === 'text' || b.type === 'xml') {
      const preview = h('button', {
        class: `btn small${this.bodyPreview ? ' on' : ''}`,
        title: this.bodyPreview ? 'Back to editing the body' : 'Show the body with its variables filled in',
        'aria-pressed': String(this.bodyPreview),
        onclick: () => {
          this.bodyPreview = !this.bodyPreview;
          this.renderSection();
        },
      }, 'Preview');
      if (this.bodyPreview) {
        const view = h('pre', { class: 'rq-code-preview mono' });
        const paint = () => view.replaceChildren(...this.filledIn(b.text));
        const box = h('div', { class: 'rq-code' }, view);
        onRepaint(box, paint);
        paint();
        bar.append(preview, h('span', { class: 'hint' }, 'Read-only: click a value to edit its variable.'));
        return h('div', { class: 'rq-bodywrap' }, bar, box);
      }
      const editor = codeEditor(b.text, b.type === 'json', b.type === 'json' ? '{ "name": "{{userName}}" }' : '', this.varCtx);
      const check = h('span', { class: 'hint' });
      const validate = () => {
        check.textContent = b.type === 'json' && b.text.trim() && !isJsonish(b.text) ? 'Not valid JSON' : '';
      };
      editor.input.addEventListener('input', () => this.edit(() => ((b.text = editor.input.value), validate())));
      validate();
      if (b.type === 'json')
        bar.append(
          h('button', {
            class: 'btn small',
            title: 'Indent the JSON',
            onclick: () => {
              const lines = jsonLines(b.text);
              if (!lines) return toast('The body is not valid JSON (variables can only stand where values go).', 'error');
              editor.replace(lines.map(lineText).join('\n'));
            },
          }, 'Format'),
        );
      bar.append(preview, check);
      return h('div', { class: 'rq-bodywrap' }, bar, editor.el);
    }
    if (b.type === 'form' || b.type === 'multipart') {
      return h('div', null, bar, this.kvTable(b.fields, () => undefined, { names: ['Field', 'Value'], toggle: true, files: b.type === 'multipart' }));
    }
    const path = h('input', { class: 'input small mono', value: b.path, placeholder: 'File to send (relative to the folder, or a full path)', spellcheck: false });
    path.addEventListener('input', () => this.edit(() => (b.path = path.value)));
    return h(
      'div',
      null,
      bar,
      h(
        'div',
        { class: 'row' },
        varField(path, this.varCtx),
        h('button', {
          class: 'btn small',
          onclick: async () => {
            const picked = await openDialog({ multiple: false, directory: false });
            if (typeof picked === 'string') this.edit(() => (b.path = this.relativePath(picked)), true);
          },
        }, 'Browse…'),
      ),
    );
  }

  private authEditor(): HTMLElement {
    const d = this.doc;
    const type = h(
      'select',
      { class: 'input small' },
      ...(
        [
          ['none', 'No authentication'],
          ['bearer', 'Bearer token'],
          ['basic', 'Basic (user name and password)'],
          ['apikey', 'API key'],
        ] as const
      ).map(([t, label]) => h('option', { value: t, selected: t === d.auth.type }, label)),
    );
    type.addEventListener('change', () =>
      this.edit(() => {
        const t = type.value;
        d.auth =
          t === 'bearer'
            ? { type: 'bearer', token: '{{TOKEN}}' }
            : t === 'basic'
              ? { type: 'basic', username: '', password: '{{PASSWORD}}' }
              : t === 'apikey'
                ? { type: 'apikey', name: 'X-Api-Key', value: '{{API_KEY}}', in: 'header' }
                : { type: 'none' };
      }, true),
    );
    const field = (label: string, value: string, set: (v: string) => void) => {
      const input = h('input', { class: 'input small mono', value, spellcheck: false });
      input.addEventListener('input', () => this.edit(() => set(input.value)));
      input.addEventListener('change', () => this.renderSection());
      return h('label', { class: 'field' }, h('span', null, label), varField(input, this.varCtx));
    };
    const a = d.auth;
    const fields: HTMLElement[] = [];
    if (a.type === 'bearer') fields.push(field('Token', a.token, (v) => (a.token = v)));
    if (a.type === 'basic') fields.push(field('User name', a.username, (v) => (a.username = v)), field('Password', a.password, (v) => (a.password = v)));
    if (a.type === 'apikey') {
      const where = h('select', { class: 'input small' }, h('option', { value: 'header', selected: a.in === 'header' }, 'Header'), h('option', { value: 'query', selected: a.in === 'query' }, 'Query parameter'));
      where.addEventListener('change', () => this.edit(() => (a.in = where.value as 'header' | 'query')));
      fields.push(field('Name', a.name, (v) => (a.name = v)), field('Value', a.value, (v) => (a.value = v)), h('label', { class: 'field' }, h('span', null, 'Sent as'), where));
    }
    return h(
      'div',
      { class: 'rq-auth' },
      h('label', { class: 'field' }, h('span', null, 'Type'), type),
      ...fields,
      a.type !== 'none' ? h('p', { class: 'hint' }, 'Use a {{variable}} for the secret: its value then stays in your .env.local or in 1Password (op://…), not in the file the team shares.') : null,
    );
  }

  /** Where each variable used in `text` comes from; a click edits it (or adds an undefined one). */
  private sources(text: string): HTMLElement | null {
    const group = this.group;
    const names = [...new Set(usedVariables(text))];
    if (!group || !names.length) return null;
    const vars = collections.variables(group);
    return h(
      'div',
      { class: 'rq-sources' },
      h('div', { class: 'rq-sources-title' }, 'Variables used'),
      ...names.map((n) => {
        const v = vars.get(n);
        return h(
          'div',
          { class: 'rq-source' },
          h(
            'button',
            { class: `rq-var-link mono ${v ? 'seg-var' : 'seg-missing'}`, title: v ? 'Edit this variable' : 'Not defined: click to add it', onclick: () => this.editVariables(v ? [] : [n], n) },
            `{{${n}}}`,
          ),
          v
            ? h(
                'span',
                null,
                h('span', { class: 'muted' }, `${v.source} → `),
                v.choices ? this.choiceSelect(group, v) : h('span', { class: 'mono', onmousedown: selectOnTripleClick }, displayValue(v, store.settings.hideSecrets)),
                isOpRef(v.value) ? h('span', { class: 'muted' }, ' (1Password, filled in when sending)') : null,
              )
            : h('span', { class: 'seg-missing' }, 'not defined'),
        );
      }),
    );
  }

  /** A dropdown of a variable's choices, to switch it. */
  private choiceSelect(group: Group, v: Variable): HTMLSelectElement {
    const secret = isLocalEnvFile(v.source);
    const select = h(
      'select',
      { class: 'input small rq-choice', title: `Switch {{${v.name}}}` },
      // A value that isn't one of them (the file was edited by hand) shows as it is.
      currentChoice(v) ? null : h('option', { value: '', selected: true, disabled: true }, displayValue(v, store.settings.hideSecrets)),
      ...v.choices!.map((c) => h('option', { value: c.value, selected: c.value === v.value }, choiceLabel(c, secret, store.settings.hideSecrets))),
    );
    select.addEventListener('change', () => void collections.choose(group, v.name, select.value).catch((e) => toast(String(e), 'error')));
    return select;
  }

  private optionsEditor(): HTMLElement {
    const o = this.doc.options;
    const s = store.settings;
    const redirects = h(
      'select',
      { class: 'input small' },
      h('option', { value: '', selected: o.followRedirects === undefined }, `Default (${s.requestFollowRedirects ? 'follow' : "don't follow"})`),
      h('option', { value: 'yes', selected: o.followRedirects === true }, 'Follow'),
      h('option', { value: 'no', selected: o.followRedirects === false }, "Don't follow"),
    );
    redirects.addEventListener('change', () =>
      this.edit(() => {
        if (redirects.value) o.followRedirects = redirects.value === 'yes';
        else delete o.followRedirects;
      }),
    );
    const timeout = h('input', { class: 'input small', type: 'number', min: 1, max: 3600, value: o.timeoutSeconds ?? '', placeholder: `Default (${s.requestTimeout})` });
    timeout.addEventListener('input', () =>
      this.edit(() => {
        const n = Math.round(Number(timeout.value));
        if (timeout.value && n > 0) o.timeoutSeconds = Math.min(3600, n);
        else delete o.timeoutSeconds;
      }),
    );
    const insecure = h('input', { type: 'checkbox', checked: !!o.insecure });
    insecure.addEventListener('change', () =>
      this.edit(() => {
        if (insecure.checked) o.insecure = true;
        else delete o.insecure;
      }),
    );
    return h(
      'div',
      { class: 'rq-options' },
      h('label', { class: 'field' }, h('span', null, 'Redirects'), redirects),
      h('label', { class: 'field' }, h('span', null, 'Timeout (seconds)'), timeout),
      h('label', { class: 'check' }, insecure, 'Ignore certificate errors (self-signed test servers)'),
      h('p', { class: 'hint' }, 'Saved in the request file, so they apply for the whole team.'),
    );
  }

  // ---- response ---------------------------------------------------------

  private renderSending(): void {
    this.sendBtn.textContent = 'Cancel';
    this.sendBtn.classList.remove('danger');
    this.statusEl.replaceChildren(h('span', { class: 'spinner' }), h('span', { class: 'muted' }, 'Sending with curl…'));
    this.responseTabs.replaceChildren();
    this.responseEl.replaceChildren();
    this.status = 'sending…';
    this.host.onInfoChange(this);
  }

  private renderResponse(): void {
    this.sendBtn.textContent = this.sending ? 'Cancel' : 'Send';
    if (this.sending) return this.renderSending();
    const last = lastResponses.get(this.key);
    if (!last) {
      this.status = '';
      this.statusEl.replaceChildren(h('span', { class: 'muted' }, 'Response'));
      this.responseTabs.replaceChildren();
      this.responseEl.replaceChildren(h('div', { class: 'rq-empty' }, h('div', null, 'Send the request to see the response here.'), h('div', null, h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Enter'))));
      return;
    }
    const r = last.result;
    const at = h('span', { class: 'muted' }, `${last.env ? `${last.env} · ` : ''}${time(last.at)}`);
    if (!r || r.curlExit !== 0) {
      const message = last.error ?? r?.error ?? `curl stopped with exit code ${r?.curlExit}`;
      if (this.responseTab !== 'console' || !r) this.responseTab = 'body';
      const what = last.error === 'Cancelled' ? 'Cancelled' : r?.curlExit === 28 ? 'Timed out' : r?.curlExit === 6 ? "Host not found" : r?.curlExit === 7 ? "Couldn't connect" : r?.curlExit === 60 || r?.curlExit === 35 ? 'Certificate problem' : 'Failed';
      this.status = what;
      this.statusEl.replaceChildren(h('span', { class: 'chip err' }, what), at);
      this.responseTabs.replaceChildren(...(r ? this.tabButtons([['body', 'Error'], ['console', 'Console']]) : []));
      if (r && this.responseTab === 'console') {
        this.responseEl.replaceChildren(this.consoleView(r));
        return;
      }
      const hint =
        r?.curlExit === 60 || r?.curlExit === 35
          ? 'The server\'s certificate isn\'t trusted. For a test server with a self-signed certificate, turn on "Ignore certificate errors" under Options.'
          : r?.curlExit === 7
            ? 'Nothing answered at that address. Is the server running, and is the right environment chosen?'
            : '';
      this.responseEl.replaceChildren(h('div', { class: 'rq-error' }, h('div', { class: 'mono err-text' }, message), hint ? h('p', { class: 'hint' }, hint) : null));
      return;
    }
    const ok = r.status < 400;
    const text = STATUS_TEXT[r.status] ?? '';
    this.status = `${r.status}${text ? ` ${text}` : ''} · ${Math.round(r.timing.total)} ms`;
    this.statusEl.replaceChildren(
      h('span', { class: `chip ${ok ? 'ok' : 'err'}` }, `${r.status} ${text}`.trim()),
      h('span', null, `${Math.round(r.timing.total)} ms`),
      h('span', { class: 'muted' }, '·'),
      h('span', null, formatSize(r.bodySize)),
      h('span', { class: 'muted' }, '·'),
      at,
    );
    this.responseTabs.replaceChildren(
      ...this.tabButtons([
        ['body', 'Body'],
        ['headers', `Headers ${r.headers.length}`],
        ['timing', 'Timing'],
        ['cookies', 'Cookies'],
        ['console', 'Console'],
      ]),
    );
    switch (this.responseTab) {
      case 'body':
        this.responseEl.replaceChildren(this.bodyView(r, last.id));
        this.find(false);
        break;
      case 'headers':
        setChildren(
          this.responseEl,
          h('table', { class: 'rq-table' }, h('tbody', null, ...r.headers.map((x) => h('tr', null, h('td', { class: 'mono muted' }, x.name), h('td', { class: 'mono' }, x.value))))),
          r.url ? h('p', { class: 'hint' }, `${r.redirects ? `After ${r.redirects} redirect${r.redirects > 1 ? 's' : ''}: ` : ''}${r.url} (${r.remoteIp}, HTTP/${r.httpVersion})`) : null,
        );
        break;
      case 'timing':
        this.responseEl.replaceChildren(this.timingView(r));
        break;
      case 'console':
        this.responseEl.replaceChildren(this.consoleView(r));
        break;
      case 'cookies':
        this.responseEl.replaceChildren(h('p', { class: 'hint' }, 'Loading…'));
        void this.cookiesView(last.env).then((el) => this.responseTab === 'cookies' && this.responseEl.replaceChildren(el));
        break;
    }
  }

  private tabButtons(tabs: [ResponseTab, string][]): HTMLElement[] {
    return tabs.map(([id, label]) =>
      h('button', {
        class: `rq-tab${this.responseTab === id ? ' sel' : ''}`,
        role: 'tab',
        onclick: () => {
          this.responseTab = id;
          this.renderResponse();
        },
      }, label),
    );
  }

  /** What ran: the command, the options curl read on stdin and curl's own log of the exchange. */
  private consoleView(r: HttpResult): HTMLElement {
    const c = r.console;
    const all = `> ${c.command}\n\n${c.config}\n${c.log}`;
    const log = c.log
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => h('div', { class: line.startsWith('>') ? 'cl-out' : line.startsWith('<') ? 'cl-in' : line.startsWith('*') ? 'cl-info' : '' }, line || ' '));
    return h(
      'div',
      { class: 'rq-console' },
      h(
        'div',
        { class: 'rq-bodytools' },
        h('span', { class: 'hint' }, 'Secret values show as ••••••, or as {{NAME}} where curl fills them in.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => void api.clipboardWrite(all).then(() => toast('Console copied')) }, 'Copy'),
      ),
      h('div', { class: 'cl-title' }, 'Command'),
      h('pre', { class: 'rq-text wrap' }, `> ${c.command}`),
      h('div', { class: 'cl-title' }, 'Options curl read (on stdin)'),
      h('pre', { class: 'rq-text wrap' }, c.config),
      h('div', { class: 'cl-title' }, "curl's log (> sent, < received)"),
      h('div', { class: 'rq-text wrap cl-log' }, ...log),
    );
  }

  private bodyView(r: HttpResult, id: number): HTMLElement {
    const saveBtn = h('button', {
      class: 'btn small',
      onclick: async () => {
        const dest = await saveDialog({ defaultPath: `${this.name}${r.headers.some((x) => /json/i.test(x.value) && x.name === 'content-type') ? '.json' : ''}` });
        if (dest) await api.httpSaveBody(id, dest).then(() => toast('Response saved'), (e) => toast(String(e), 'error'));
      },
    }, 'Save to file…');
    if (r.bodyKind === 'none') return h('div', { class: 'rq-empty' }, `No body (${r.status}).`);
    if (r.bodyKind !== 'text' || r.body === null) {
      return h('div', { class: 'rq-empty' }, h('div', null, r.bodyKind === 'tooLarge' ? `The response is ${formatSize(r.bodySize)}, more than the ${store.settings.responseMaxMb} MB shown here.` : `Binary response (${formatSize(r.bodySize)}).`), saveBtn);
    }
    const wrap = store.settings.responseWrap;
    const tools = h(
      'div',
      { class: 'rq-bodytools' },
      this.searchInput,
      h('span', { class: 'spacer' }),
      h('button', { class: `btn small${wrap ? ' on' : ''}`, title: 'Wrap long lines', onclick: () => store.update((c) => (c.settings.responseWrap = !c.settings.responseWrap)) }, 'Wrap'),
      h('button', { class: 'btn small', onclick: () => void api.clipboardWrite(r.body ?? '').then(() => toast('Response copied')) }, 'Copy'),
      saveBtn,
    );
    const lines = r.body.length < 5_000_000 ? jsonLines(r.body) : null;
    if (!lines || lines.length > 50_000) return h('div', { class: 'rq-bodyview' }, tools, h('pre', { class: `rq-text${wrap ? ' wrap' : ''}` }, r.body));
    return h('div', { class: 'rq-bodyview' }, tools, this.jsonView(lines, wrap));
  }

  private jsonView(lines: JsonLine[], wrap: boolean): HTMLElement {
    const box = h('div', { class: `rq-json${wrap ? ' wrap' : ''}` });
    const draw = () => {
      const rows: HTMLElement[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const folded = l.closes !== undefined && this.folded.has(i);
        const toggle =
          l.closes !== undefined
            ? h('span', {
                class: 'rq-fold',
                html: folded ? icons.chevronRight : icons.chevronDown,
                onclick: () => {
                  if (this.folded.has(i)) this.folded.delete(i);
                  else this.folded.add(i);
                  draw();
                },
              })
            : h('span', { class: 'rq-fold' });
        const tokens = l.tokens.map((t) => h('span', { class: `j-${t.kind}` }, t.text));
        if (folded) {
          const end = lines[l.closes!];
          tokens.push(h('span', { class: 'rq-folded', onclick: () => (this.folded.delete(i), draw()) }, ' … '), ...end.tokens.map((t) => h('span', { class: `j-${t.kind}` }, t.text)));
          i = l.closes!;
        }
        rows.push(h('div', { class: 'jl', style: `--depth:${l.depth}` }, h('span', { class: 'ln' }, String(i + 1)), toggle, h('span', { class: 'jt' }, ...tokens)));
      }
      box.replaceChildren(...rows);
      this.find(false);
    };
    draw();
    return box;
  }

  private timingView(r: HttpResult): HTMLElement {
    const t = r.timing;
    const total = Math.max(t.total, 0.001);
    const tls = t.tls > 0 ? t.tls : t.connect;
    const phases: [string, number, number][] = [
      ['DNS lookup', 0, t.dns],
      ['Connect', t.dns, t.connect],
      ['TLS handshake', t.connect, tls],
      ['Waiting (server)', tls, t.firstByte],
      ['Download', t.firstByte, t.total],
    ];
    return h(
      'div',
      { class: 'rq-timing' },
      ...phases.map(([label, from, to]) =>
        h(
          'div',
          { class: 'rq-timing-row' },
          h('span', { class: 'muted' }, label),
          h('div', { class: 'rq-bar-track' }, h('div', { class: 'rq-bar', style: `margin-left:${(from / total) * 100}%;width:${Math.max(((to - from) / total) * 100, 0.5)}%` })),
          h('span', { class: 'mono' }, `${Math.max(0, to - from).toFixed(1)} ms`),
        ),
      ),
      h('div', { class: 'rq-timing-row total' }, h('span', null, 'Total'), h('span'), h('span', { class: 'mono' }, `${t.total.toFixed(1)} ms`)),
      h('p', { class: 'hint' }, "Measured by curl. Each phase starts when the one before it ends."),
    );
  }

  private async cookiesView(env: string): Promise<HTMLElement> {
    const jar = `${this.ref.groupId}/${env}`;
    const cookies = await api.httpCookies(jar).catch(() => []);
    const hide = store.settings.hideSecrets;
    if (!cookies.length) return h('div', { class: 'rq-empty' }, 'No cookies yet. Cookies the server sets (a login, for example) are kept here and sent with the next requests of this group and environment, until Shellman closes.');
    return h(
      'div',
      null,
      h(
        'table',
        { class: 'rq-table' },
        h('tbody', null, ...cookies.map((c) => {
          const value = h('td', { class: 'mono', title: hide ? 'Click to show' : '' }, hide ? '••••••••' : c.value);
          if (hide) value.addEventListener('click', () => (value.textContent = c.value));
          return h('tr', null, h('td', { class: 'mono' }, c.name), value, h('td', { class: 'muted' }, `${c.domain}${c.path}`), h('td', { class: 'muted' }, [c.httpOnly ? 'HttpOnly' : '', c.secure ? 'Secure' : '', c.expires ? `until ${new Date(c.expires * 1000).toLocaleString()}` : 'session'].filter(Boolean).join(' · ')));
        })),
      ),
      h('button', {
        class: 'btn small',
        onclick: async () => {
          await api.httpClearCookies(jar);
          this.renderResponse();
        },
      }, `Clear cookies (${env || 'this group'})`),
    );
  }

  /** Marks matches of the search box in the response body (CSS highlights; nothing is re-rendered). */
  private find(next: boolean): void {
    const q = this.searchInput.value.toLowerCase();
    const reg = CSS.highlights;
    if (!reg) return;
    // One set of highlights for all panes: the pane searching last owns it.
    if (!q || this.responseTab !== 'body') {
      if (findOwner === this) {
        reg.delete('rq-find');
        reg.delete('rq-find-current');
        findOwner = null;
      }
      return;
    }
    findOwner = this;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(this.responseEl.querySelector('.rq-json, .rq-text') ?? this.responseEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.parentElement as HTMLElement).classList.contains('ln')) continue;
      const text = (n.textContent ?? '').toLowerCase();
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const range = new Range();
        range.setStart(n, i);
        range.setEnd(n, i + q.length);
        ranges.push(range);
      }
    }
    reg.set('rq-find', new Highlight(...ranges));
    if (!ranges.length) {
      reg.delete('rq-find-current');
      return;
    }
    const index = next ? (this.findIndex + 1) % ranges.length : Math.min(this.findIndex, ranges.length - 1);
    this.findIndex = index;
    reg.set('rq-find-current', new Highlight(ranges[index]));
    ranges[index].startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
  }

  private findIndex = 0;

  // ---- variables ---------------------------------------------------------

  /** Opens the variables editor; `add` starts rows for undefined names, `focus` goes to one. */
  private editVariables(add: string[] = [], focus?: string): void {
    const group = this.group;
    if (group) editVariables(group, add, focus);
  }
}
