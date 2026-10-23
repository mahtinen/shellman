/**
 * Draws parsed Markdown (markdown.ts) for the Files pane's preview. Every element is made here one by
 * one; nothing from the file is ever inserted as markup. HTML in the file (`<img>`, `<details>`,
 * `<p align="center">` …) is read by an inert DOMParser and rebuilt from an allowlist of tags and
 * attributes, without scripts, styles, event handlers or links that navigate the page: a README
 * can't run code in Shellman. Links go to `openLink`, images in the folder come from `image`.
 */
import { h } from './dom';
import { icons } from './icons';
import type { Block, Inline } from './markdown';

export interface MarkdownContext {
  /** A link was clicked (its target as written). */
  openLink(href: string): void;
  /** An image of the folder (a relative path) as a data URL, or null when it can't be shown. */
  image(src: string): Promise<string | null>;
  /** A code block's text with syntax colours. */
  code(text: string, lang: string): Node[];
  copy(text: string): void;
}

/** Anchors of headings get this in front, so they can't clash with ids of the app. */
export const ANCHOR_PREFIX = 'md-';

const isRemote = (src: string) => /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^data:image\//i.test(src);

function link(href: string, title: string, ctx: MarkdownContext, children: (Node | string)[]): HTMLElement {
  const el = h('a', { class: 'md-link', title: title || href, tabindex: 0, role: 'link' }, ...children);
  const go = (e: Event) => {
    e.preventDefault();
    ctx.openLink(href);
  };
  el.addEventListener('click', go);
  el.addEventListener('keydown', (e) => e.key === 'Enter' && go(e));
  return el;
}

/** An image: from the folder, an inline data image, or (from the internet, not loaded) a link to it. */
function image(src: string, alt: string, title: string, ctx: MarkdownContext, size?: { width?: string; height?: string }): HTMLElement {
  if (isRemote(src)) return link(src, `${alt || 'Image'} (from the internet, not loaded): ${src}`, ctx, [h('span', { class: 'md-noimg', html: icons.openExternal }), alt || 'image']);
  const img = h('img', { alt, title, class: 'md-img' });
  if (size?.width) img.setAttribute('width', size.width);
  if (size?.height) img.setAttribute('height', size.height);
  if (/^data:image\//i.test(src)) img.src = src;
  else
    void ctx.image(src).then((url) => {
      if (url) img.src = url;
      else img.replaceWith(h('span', { class: 'md-noimg-text', title: src }, `[${alt || src}]`));
    });
  return img;
}

function inlines(nodes: Inline[], ctx: MarkdownContext): Node[] {
  return nodes.map((n): Node => {
    switch (n.t) {
      case 'text':
        return document.createTextNode(n.v);
      case 'code':
        return h('code', null, n.v);
      case 'br':
        return h('br');
      case 'link':
        return link(n.href, n.title, ctx, inlines(n.c, ctx));
      case 'img':
        return image(n.src, n.alt, n.title, ctx);
      case 'strong':
      case 'em':
      case 'del':
      case 'kbd':
      case 'sup':
      case 'sub':
      case 'u':
      case 'mark':
        return h(n.t === 'del' ? 's' : n.t, null, ...inlines(n.c, ctx));
    }
  });
}

/** Tags kept from HTML in a file; the others are left out with their content kept. */
const ALLOWED = new Set(
  'p div span br img a b i em strong code pre details summary sub sup kbd h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr th td blockquote hr center s del ins u mark small dl dt dd picture'.split(' '),
);
/** Tags left out with everything in them. */
const DROPPED = new Set('script style iframe object embed template noscript svg math form input button textarea select option link meta base frame frameset audio video canvas source track'.split(' '));

/** Attributes kept, with what their values may be. */
function safeAttr(tag: string, name: string, value: string): boolean {
  switch (name) {
    case 'align':
      return /^(left|right|center|justify)$/i.test(value);
    case 'width':
    case 'height':
      return /^\d{1,4}(px|%)?$/.test(value);
    case 'alt':
    case 'title':
      return true;
    case 'colspan':
    case 'rowspan':
      return (tag === 'td' || tag === 'th') && /^\d{1,3}$/.test(value);
    case 'open':
      return tag === 'details';
    case 'start':
      return tag === 'ol' && /^\d{1,9}$/.test(value);
    default:
      return false;
  }
}

function rebuild(node: Node, ctx: MarkdownContext): Node[] {
  if (node.nodeType === Node.TEXT_NODE) return [document.createTextNode(node.textContent ?? '')];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const src = node as Element;
  const tag = src.tagName.toLowerCase();
  if (DROPPED.has(tag)) return [];
  const children = () => Array.from(src.childNodes).flatMap((c) => rebuild(c, ctx));
  if (!ALLOWED.has(tag)) return children();
  if (tag === 'img') {
    const s = src.getAttribute('src') ?? '';
    if (!s) return [];
    return [image(s, src.getAttribute('alt') ?? '', src.getAttribute('title') ?? '', ctx, { width: attr(src, 'width'), height: attr(src, 'height') })];
  }
  if (tag === 'a') {
    const href = src.getAttribute('href');
    return href ? [link(href, src.getAttribute('title') ?? '', ctx, children())] : children();
  }
  // <picture>: its <img> is the image.
  if (tag === 'picture') return Array.from(src.querySelectorAll('img')).slice(0, 1).flatMap((i) => rebuild(i, ctx));
  const el = document.createElement(tag === 'center' ? 'div' : tag);
  if (tag === 'center') el.setAttribute('align', 'center');
  for (const a of Array.from(src.attributes)) if (safeAttr(tag, a.name.toLowerCase(), a.value)) el.setAttribute(a.name.toLowerCase(), a.value);
  el.append(...children());
  return [el];
}

const attr = (el: Element, name: string) => {
  const v = el.getAttribute(name);
  return v && /^\d{1,4}(px|%)?$/.test(v) ? v : undefined;
};

function html(text: string, ctx: MarkdownContext): Node[] {
  // An inert document: nothing in it runs or loads.
  const doc = new DOMParser().parseFromString(`<body>${text}</body>`, 'text/html');
  return Array.from(doc.body.childNodes).flatMap((n) => rebuild(n, ctx));
}

function codeBlock(text: string, lang: string, ctx: MarkdownContext): HTMLElement {
  const copy = h('button', { class: 'md-copy icon-btn small', title: 'Copy', html: icons.copy, onclick: () => ctx.copy(text) });
  return h('div', { class: 'md-pre' }, copy, h('pre', null, h('code', null, ...ctx.code(text, lang))));
}

function block(b: Block, ctx: MarkdownContext, tight = false): Node[] {
  switch (b.t) {
    case 'h':
      return [h(`h${Math.min(6, b.level)}` as 'h1', { id: `${ANCHOR_PREFIX}${b.id}` }, ...inlines(b.c, ctx))];
    case 'p':
      return tight ? inlines(b.c, ctx) : [h('p', null, ...inlines(b.c, ctx))];
    case 'code':
      return [codeBlock(b.v, b.lang, ctx)];
    case 'quote':
      return [h('blockquote', null, ...blocks(b.c, ctx))];
    case 'hr':
      return [h('hr')];
    case 'html':
      return html(b.v, ctx);
    case 'table':
      return [
        h(
          'div',
          { class: 'md-table' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, ...b.head.map((c, i) => h('th', { style: b.align[i] ? `text-align:${b.align[i]}` : '' }, ...inlines(c, ctx))))),
            h('tbody', null, ...b.rows.map((r) => h('tr', null, ...r.map((c, i) => h('td', { style: b.align[i] ? `text-align:${b.align[i]}` : '' }, ...inlines(c, ctx)))))),
          ),
        ),
      ];
    case 'list': {
      const items = b.items.map((it) =>
        h(
          'li',
          { class: it.task === null ? '' : 'md-task' },
          it.task === null ? null : h('input', { type: 'checkbox', checked: it.task, disabled: true }),
          ...it.c.flatMap((c) => block(c, ctx, b.tight)),
        ),
      );
      return [b.ordered ? h('ol', { start: b.start !== 1 ? String(b.start) : null }, ...items) : h('ul', null, ...items)];
    }
  }
}

/** Opening and closing tags that wrap the Markdown after them (`<details>` … `</details>`). */
const OPENS = /<(details|div)\b[^>]*>/gi;
const CLOSES = /<\/(details|div)\s*>/gi;

function blocks(list: Block[], ctx: MarkdownContext): Node[] {
  // GitHub lets Markdown sit inside <details> or <div> opened in one HTML block and closed in a later one.
  const root = h('div');
  const stack: HTMLElement[] = [root];
  for (const b of list) {
    const top = stack[stack.length - 1];
    if (b.t === 'html') {
      const opens = (b.v.match(OPENS) ?? []).length;
      const closes = (b.v.match(CLOSES) ?? []).length;
      if (closes > opens && !b.v.replace(CLOSES, '').trim()) {
        for (let k = 0; k < closes - opens && stack.length > 1; k++) stack.pop();
        continue;
      }
      const nodes = html(b.v, ctx);
      top.append(...nodes);
      if (opens > closes) {
        const last = nodes[nodes.length - 1];
        if (last instanceof HTMLElement && (last.tagName === 'DETAILS' || last.tagName === 'DIV')) stack.push(last);
      }
      continue;
    }
    top.append(...block(b, ctx));
  }
  return Array.from(root.childNodes);
}

export function renderMarkdown(list: Block[], ctx: MarkdownContext): HTMLElement {
  return h('div', { class: 'md' }, ...blocks(list, ctx));
}
