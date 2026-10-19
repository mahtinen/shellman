const svg = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  chevronDown: svg('<path d="M4 6l4 4 4-4"/>'),
  chevronRight: svg('<path d="M6 4l4 4-4 4"/>'),
  folder: svg('<path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.5H13c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"/>'),
  globe: svg('<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c1.65 1.75 2.5 3.85 2.5 6.25S9.65 12.5 8 14.25C6.35 12.5 5.5 10.4 5.5 8S6.35 3.5 8 1.75z"/>'),
  folderPlus: svg('<path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.5H13c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"/><path d="M8 7v4M6 9h4"/>'),
  terminal: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3"/>'),
  splitRight: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M8 2.75v10.5"/>'),
  splitDown: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M1.75 8h12.5"/>'),
  edit: svg('<path d="M10.5 2.5l3 3L6 13H3v-3z"/>'),
  trash: svg('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.25"/><path d="M8 1.5v1.75M8 12.75v1.75M14.5 8h-1.75M3.25 8H1.5M12.6 3.4l-1.24 1.24M4.64 11.36L3.4 12.6M12.6 12.6l-1.24-1.24M4.64 4.64L3.4 3.4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.5 3.5"/>'),
  copy: svg('<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25"/><path d="M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25h-6c-.69 0-1.25.56-1.25 1.25v6c0 .69.56 1.25 1.25 1.25h1.75"/>'),
  paste: svg('<rect x="3" y="2.75" width="10" height="11.5" rx="1.25"/><path d="M6 2.75h4v2H6z"/>'),
  sidebar: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M6 2.75v10.5"/>'),
  maximize: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  popOut: svg('<rect x="1.75" y="5.75" width="8.5" height="8.5" rx="1.25"/><path d="M8.5 1.75h5.75V7.5M14.25 1.75L7.5 8.5"/>'),
  restore: svg('<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>'),
  bell: svg('<path d="M4 11V7a4 4 0 018 0v4l1.25 1.5H2.75zM6.5 14h3"/>'),
  play: svg('<path d="M5 3.5v9l7-4.5z"/>'),
  save: svg('<path d="M2.75 2.75h8.5l2 2v8.5H2.75z"/><path d="M5 2.75v3.5h5v-3.5M5 13.25V9.5h6v3.75"/>'),
  openExternal: svg('<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-7c0-.55.45-1 1-1h3"/>'),
  duplicate: svg('<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25"/><path d="M9.5 7.5v4M7.5 9.5h4M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25h-6c-.69 0-1.25.56-1.25 1.25v6c0 .69.56 1.25 1.25 1.25h1.75"/>'),
  keyboard: svg('<rect x="1.5" y="3.75" width="13" height="8.5" rx="1.25"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7"/>'),
  grip: svg('<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01"/>'),
};

export type IconName = keyof typeof icons;
