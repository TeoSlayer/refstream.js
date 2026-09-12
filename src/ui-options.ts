import type { TerminalSurface, Disposable } from "./types.js";
import type { TerminalSession } from "./session.js";
import type { TerminalThemeChoice, TerminalThemeName } from "./themes.js";
import type { TerminalAgentClientSource } from "./invitation.js";

export type TerminalEngine = "native" | "xterm";
export type TerminalTool = "search" | "export" | "engine" | "explore" | "agent" | "theme" | "fontSize" | "menu";
export type TerminalExploreView = "commands" | "read" | "replay" | "agent";
export type TerminalUiCleanup = void | Disposable;
export interface TerminalRelayChoice { id: string; label: string; url: string }

export interface TerminalUiContext {
  terminal: TerminalSurface;
  container: HTMLElement;
  signal: AbortSignal;
  session?: TerminalSession;
  close(): void;
}
export interface TerminalToolbarContext extends TerminalUiContext {
  openSearch(): void;
  openExplore(view?: string): void;
}
export interface TerminalUiAction {
  id: string;
  label: string;
  tooltip?: string | false;
  icon?(document: Document): Node;
  run(context: TerminalToolbarContext): void | Promise<void>;
}
export type TerminalExploreTab = TerminalExploreView | {
  id: string;
  label: string;
  tooltip?: string | false;
  render(context: TerminalUiContext & { session: TerminalSession }): TerminalUiCleanup;
};

export interface TerminalUiOptions {
  /** Omit to use the defaults. An empty array or false mounts no toolbar. */
  toolbar?: false | readonly (TerminalTool | TerminalUiAction)[];
  menu?: false | readonly (Exclude<TerminalTool, "menu"> | TerminalUiAction)[];
  themes?: false | readonly (TerminalThemeName | TerminalThemeChoice)[];
  /** Compatible HTTPS relay origins (HTTP loopback in development). Defaults to the hosted relay. */
  relays?: readonly TerminalRelayChoice[];
  initialRelay?: string;
  /** Default access for a new invitation. Sharing still requires an explicit user action. */
  initialAgentPermission?: "read" | "control";
  /** Override the downloadable connector URL and its trusted SHA-256. No browser-side download. */
  agentClient?: TerminalAgentClientSource;
  /** Custom relay URLs are entered explicitly; terminal output can never change this setting. */
  allowCustomRelay?: boolean;
  /** Hide, reorder, replace or add views. A renderer can replace the entire panel. */
  explore?: false | {
    tabs?: readonly TerminalExploreTab[];
    initialTab?: string;
    title?: string;
    render?(context: TerminalUiContext & { session: TerminalSession }): TerminalUiCleanup;
  };
  search?: boolean;
  backToLive?: boolean;
  /** Stable text IDs, e.g. search, export, explore, read, closeExplore, noMatches. */
  labels?: Readonly<Record<string, string>>;
  /** Action IDs, e.g. search, export, explore or a custom action ID. false disables tooltips. */
  tooltips?: false | Readonly<Record<string, string | false>>;
  className?: string;
  cssVariables?: Readonly<Record<`--${string}`, string>>;
  exportFilename?: string;
  /** Host save bridge for retained output, snapshots and recordings. It receives local bytes only. */
  download?(request: { blob: Blob; name: string; signal: AbortSignal }): void | Promise<void>;
  engineOptions?: readonly { value: TerminalEngine; label: string }[];
  /** Install the host's tooltip system. Listeners and mounts must use this lifetime. */
  renderTooltip?(context: { anchor: HTMLElement; text: string; signal: AbortSignal }): TerminalUiCleanup;
  /** Reuse the supplied live controls in any layout; return cleanup for a framework mount. */
  renderToolbar?(context: TerminalToolbarContext & { controls: Readonly<Record<string, HTMLElement>> }): TerminalUiCleanup;
  renderSearch?(context: TerminalUiContext & { controls: Readonly<Record<string, HTMLElement>> }): TerminalUiCleanup;
}

export function uiText(ui: TerminalUiOptions, id: string, fallback: string): string {
  return ui.labels?.[id] ?? fallback;
}
export function configureUi(element: HTMLElement, ui: Pick<TerminalUiOptions, "className" | "cssVariables">): void {
  element.dataset.terminalUi = "";
  for (const name of ui.className?.split(/\s+/u).filter(Boolean) ?? []) element.classList.add(name);
  for (const [name, value] of Object.entries(ui.cssVariables ?? {})) if (name.startsWith("--")) element.style.setProperty(name, value);
}
export function ownUiCleanup(cleanup: TerminalUiCleanup, signal: AbortSignal): void {
  if (!cleanup) return;
  if (signal.aborted) cleanup.dispose();
  else signal.addEventListener("abort", () => cleanup.dispose(), { once: true });
}
export function uiButton(document: Document, ui: TerminalUiOptions, id: string, label: string, tooltip: string | false, signal: AbortSignal, icon?: Node): HTMLButtonElement {
  const element = document.createElement("button"); element.type = "button"; element.dataset.uiAction = id;
  const text = uiText(ui, id, label);
  const hint = ui.tooltips === false ? false : ui.tooltips?.[id] ?? tooltip;
  element.setAttribute("aria-label", ui.labels?.[id] ?? (hint || text));
  if (icon) { element.append(icon); const caption = document.createElement("span"); caption.textContent = text; element.append(caption); }
  else element.textContent = text;
  uiTooltip(element, ui, id, tooltip, signal);
  return element;
}
export function uiTooltip(element: HTMLElement, ui: TerminalUiOptions, id: string, tooltip: string | false, signal: AbortSignal): void {
  const hint = ui.tooltips === false ? false : ui.tooltips?.[id] ?? tooltip;
  if (hint && ui.renderTooltip) ownUiCleanup(ui.renderTooltip({ anchor: element, text: hint, signal }), signal);
  else if (hint) element.title = hint;
}
