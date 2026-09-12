import type { TerminalTheme } from "./types.js";

const darkAnsi = ["#4c5667", "#ed8796", "#a6da95", "#eed49f", "#8aadf4", "#c6a0f6", "#8bd5ca", "#cad3f5", "#8896aa", "#ffacb6", "#c7edba", "#ffe5b5", "#b5cdff", "#ddc2ff", "#b5efe6", "#ffffff"];
const lightAnsi = ["#354052", "#ac2639", "#286c3a", "#805800", "#255cac", "#7a3e9d", "#007074", "#657184", "#59667b", "#c5374c", "#3c8150", "#926a16", "#3777c7", "#9552b4", "#16878a", "#17202d"];
const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

function preset(label: string, background: string, foreground: string, cursor: string, selection: string, colorScheme: "dark" | "light" = "dark") {
  const palette = colorScheme === "light" ? lightAnsi : darkAnsi;
  const theme: TerminalTheme = { background, foreground, cursor, cursorAccent: background, selectionBackground: selection, selectionInactiveBackground: selection, colorScheme };
  names.forEach((name, index) => { theme[name] = palette[index]; });
  return Object.freeze({ label, theme: Object.freeze(theme) });
}

/** Complete, dependency-free palettes. Hosts can supply their own TerminalTheme objects too. */
export const terminalThemes = Object.freeze({
  shell: preset("Shell", "#15191c", "#d6dfd2", "#c1de9e", "#3b5032"),
  midnight: preset("Midnight", "#10141e", "#dce5f5", "#91b8ff", "#293d65"),
  ocean: preset("Ocean", "#09202b", "#d1eaf0", "#69d8d5", "#164c59"),
  amethyst: preset("Amethyst", "#21192c", "#e6d9f0", "#d4abff", "#4d345f"),
  ember: preset("Ember", "#241a16", "#eddfd2", "#f3b680", "#65402a"),
  arctic: preset("Arctic", "#242e3c", "#e0e8ef", "#91ccdc", "#42566b"),
  paper: preset("Paper", "#f6f8fb", "#273246", "#3269aa", "#cadcf3", "light"),
  sand: preset("Sand", "#f6efdf", "#423a30", "#8e5a26", "#e4d3ae", "light"),
});
export type TerminalThemeName = keyof typeof terminalThemes;
export interface TerminalThemeChoice { id: string; label: string; theme: TerminalTheme | TerminalThemeName }

export function resolveTerminalTheme(theme?: TerminalTheme | TerminalThemeName): TerminalTheme {
  if (typeof theme !== "string") return theme ?? {};
  if (!Object.prototype.hasOwnProperty.call(terminalThemes, theme)) throw new TypeError(`Unknown terminal theme: ${theme}`);
  return terminalThemes[theme].theme;
}

export const terminalUiThemeVariables = ["--terminal-ui-bg", "--terminal-ui-surface", "--terminal-ui-fg", "--terminal-ui-muted", "--terminal-ui-line", "--terminal-ui-accent", "--terminal-ui-hover", "--terminal-ui-selection"] as const;

export function applyTerminalUiTheme(element: HTMLElement, theme: TerminalTheme): void {
  const bg = theme.background ?? "#11151b"; const fg = theme.foreground ?? "#dfe4ed";
  const values = [bg, `color-mix(in srgb, ${bg} 95%, ${fg})`, fg, `color-mix(in srgb, ${fg} 76%, ${bg})`,
    `color-mix(in srgb, ${fg} 22%, ${bg})`, theme.cursor ?? "#c8f28d", `color-mix(in srgb, ${fg} 10%, ${bg})`, theme.selectionBackground ?? "#39577d"];
  terminalUiThemeVariables.forEach((name, index) => element.style.setProperty(name, values[index]));
  element.style.colorScheme = theme.colorScheme ?? "dark";
}
