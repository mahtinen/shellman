import type { ITheme } from '@xterm/xterm';

export interface UiColors {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  ui: UiColors;
  term: ITheme;
}

export const THEMES: Theme[] = [
  {
    id: 'shellman-dark',
    name: 'Shellman Dark',
    dark: true,
    ui: { bg: '#16181d', surface: '#1c1f26', surface2: '#252a33', border: '#2c313c', text: '#d5d9e2', muted: '#7d8597', accent: '#7aa2f7', danger: '#f7768e' },
    term: {
      background: '#0f1115', foreground: '#c9d1e0', cursor: '#c0caf5', cursorAccent: '#0f1115',
      selectionBackground: '#33467c', selectionInactiveBackground: '#2a2f3d',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#545c7e', brightRed: '#ff899d', brightGreen: '#9fe044', brightYellow: '#faba4a', brightBlue: '#8db0ff', brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#c0caf5',
    },
  },
  {
    id: 'campbell',
    name: 'Campbell',
    dark: true,
    ui: { bg: '#1a1a1a', surface: '#202020', surface2: '#2b2b2b', border: '#333333', text: '#dddddd', muted: '#8a8a8a', accent: '#3b78ff', danger: '#e74856' },
    term: {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#0c0c0c',
      selectionBackground: '#3a3d41',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    dark: true,
    ui: { bg: '#1e2127', surface: '#23272e', surface2: '#2c313a', border: '#353b45', text: '#d7dae0', muted: '#7f848e', accent: '#61afef', danger: '#e06c75' },
    term: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    ui: { bg: '#1e1f29', surface: '#232530', surface2: '#2d2f3d', border: '#363948', text: '#f8f8f2', muted: '#8b8fa8', accent: '#bd93f9', danger: '#ff5555' },
    term: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    dark: true,
    ui: { bg: '#00212b', surface: '#002833', surface2: '#073642', border: '#0d4250', text: '#c8d3d5', muted: '#6c8a91', accent: '#268bd2', danger: '#dc322f' },
    term: {
      background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36',
      selectionBackground: '#0b4f5f',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'light',
    name: 'Light',
    dark: false,
    ui: { bg: '#eef0f3', surface: '#f6f7f9', surface2: '#e3e6eb', border: '#d3d7de', text: '#1f2328', muted: '#656d76', accent: '#0969da', danger: '#cf222e' },
    term: {
      background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff',
      selectionBackground: '#b6d6fd',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  },
];

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function applyUiTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.ui)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty('--term-bg', theme.term.background ?? '#000');
  // The terminal's colours also colour code in the Files pane, so it matches the theme.
  const t = theme.term;
  const ansi: Record<string, string | undefined> = {
    fg: t.foreground,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    comment: t.brightBlack,
  };
  for (const [k, v] of Object.entries(ansi)) if (v) root.style.setProperty(`--ansi-${k}`, v);
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
}

/** Colours offered for saved sessions in the sidebar. */
export const SESSION_COLORS = [
  '',
  '#7aa2f7', '#2e7de9', '#7dcfff', '#73daca', '#9ece6a', '#b9f27c', '#e0af68',
  '#ff9e64', '#f7768e', '#db4b4b', '#ff007c', '#f5a3c7', '#bb9af7', '#c0a36e', '#a9b1d6',
];
