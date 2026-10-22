/**
 * The request body editor: a textarea over a (for JSON, coloured) copy of its text. The textarea's text
 * is transparent, so the caret, selection, undo and IME stay the browser's.
 */
import { backspaceEdit, charEdit, enterEdit, jsonSpans, tabEdit, type TextEdit } from './codeEdit';
import { h } from './dom';

/** Above this the colours would cost more than they help while typing. */
const MAX_HIGHLIGHT = 200_000;

export interface CodeEditor {
  el: HTMLElement;
  input: HTMLTextAreaElement;
  /** Replaces the whole text as one undoable edit. */
  replace(text: string): void;
}

export function codeEditor(text: string, json: boolean, placeholder: string): CodeEditor {
  const input = h('textarea', { class: 'rq-code-input', spellcheck: false, placeholder, wrap: 'off', autocomplete: 'off' });
  input.value = text;
  const view = h('pre', { class: 'rq-code-view', 'aria-hidden': 'true' });
  const el = h('div', { class: 'rq-code' }, view, input);

  const paint = () => {
    const value = input.value;
    const nodes: (Node | string)[] = [];
    if (json && value.length <= MAX_HIGHLIGHT) {
      for (const s of jsonSpans(value)) nodes.push(s.kind ? h('span', { class: `j-${s.kind}` }, s.text) : s.text);
    } else nodes.push(value);
    // A final newline needs a line after it, as in the textarea.
    nodes.push('\n');
    view.replaceChildren(...nodes);
    sync();
  };
  const sync = () => {
    view.scrollTop = input.scrollTop;
    view.scrollLeft = input.scrollLeft;
  };

  const apply = (e: TextEdit) => {
    input.setSelectionRange(e.from, e.to);
    // execCommand keeps the edit in the textarea's undo history (setRangeText doesn't).
    const done = e.insert ? document.execCommand('insertText', false, e.insert) : e.from === e.to || document.execCommand('delete');
    if (!done) {
      input.setRangeText(e.insert, e.from, e.to);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.setSelectionRange(e.selStart, e.selEnd);
  };

  input.addEventListener('input', paint);
  input.addEventListener('scroll', sync);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    const { value, selectionStart: start, selectionEnd: end } = input;
    let edit: TextEdit | null = null;
    // Tab indents instead of leaving the field.
    if (e.key === 'Tab') edit = tabEdit(value, start, end, e.shiftKey);
    else if (e.key === 'Enter') edit = enterEdit(value, start, end, json);
    else if (e.key === 'Backspace' && !e.shiftKey) edit = backspaceEdit(value, start, end, json);
    else if (json && e.key.length === 1) edit = charEdit(value, start, end, e.key);
    if (e.key === 'Tab') e.preventDefault();
    if (!edit) return;
    e.preventDefault();
    apply(edit);
  });
  paint();

  return {
    el,
    input,
    replace: (next) => apply({ from: 0, to: input.value.length, insert: next, selStart: 0, selEnd: 0 }),
  };
}
