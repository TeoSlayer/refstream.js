import { findInTerminal, terminalTranscript, type TerminalMatch } from "./search.js";
import type { NativeTerminal } from "./native.js";
import type { TerminalSession } from "./session.js";
import type { Disposable, TerminalSurface, TerminalOptions } from "./types.js";
import { configureUi, ownUiCleanup, uiButton, uiText, uiTooltip, type TerminalUiOptions, type TerminalEngine, type TerminalToolbarContext, type TerminalTool, type TerminalUiAction } from "./ui-options.js";
import { applyTerminalUiTheme, resolveTerminalTheme, terminalThemes, type TerminalThemeChoice, type TerminalThemeName } from "./themes.js";
export type { TerminalUiOptions, TerminalUiAction, TerminalUiContext, TerminalExploreTab, TerminalExploreView, TerminalTool, TerminalToolbarContext, TerminalRelayChoice } from "./ui-options.js";

export interface TerminalToolsOptions {
  terminal: TerminalSurface;
  engine?: TerminalEngine;
  toolbar: HTMLElement;
  overlay: HTMLElement;
  /** The complete terminal frame, including host chrome, to theme with the terminal. */
  frame?: HTMLElement;
  session?: TerminalSession;
  ui?: TerminalUiOptions;
  onEngineChange?: (engine: TerminalEngine) => void;
  onThemeChange?: (theme: TerminalOptions["theme"]) => void;
  onFontSizeChange?: (size: number) => void;
  isActive?: () => boolean;
  persistEngine?: boolean;
}

/** Optional, framework-free UI. The terminal engine works without this module or stylesheet. */
export async function attachTerminalTools(options: TerminalToolsOptions) {
  const ui = options.ui ?? {}; const engine = options.engine ?? "native";
  const attachSession = engine === "native" && ui.explore !== false ? (await import("./ui-session.js")).attachSessionTools : undefined;
  const { terminal, toolbar, overlay } = options; const document = toolbar.ownerDocument;
  const abort = new AbortController(); const signal = abort.signal;
  const text = (id: string, fallback: string) => uiText(ui, id, fallback);
  const button = (id: string, label: string, tooltip: string | false = label, icon?: Node) => uiButton(document, ui, id, label, tooltip, signal, icon);
  const tools = document.createElement("div"); tools.className = "terminal-tools"; configureUi(tools, ui);
  toolbar.append(tools);
  const sessionTools = attachSession?.(terminal as NativeTerminal, tools, overlay, ui, options.session);
  const findButton = button("search", "Find", "Find in terminal output (Ctrl/Cmd F)", icon(document, "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"));
  const exportButton = button("export", "Download output", "Download retained output as a text file");
  const agentButton = sessionTools?.agentButton;
  const menuButton = button("menu", "⋯", "Terminal options"); menuButton.setAttribute("aria-haspopup", "dialog"); menuButton.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div"); menu.className = "terminal-menu"; menu.hidden = true; menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", text("menuTitle", "Terminal options")); configureUi(menu, ui);
  const select = document.createElement("select"); select.className = "terminal-engine-select"; select.setAttribute("aria-label", text("engine", "Terminal engine"));
  for (const choice of ui.engineOptions ?? [{ value: "native", label: "Refstream.js" }, { value: "xterm", label: "xterm.js" }]) {
    const option = document.createElement("option"); option.value = choice.value; option.textContent = text(`engine.${choice.value}`, choice.label); select.append(option);
  }
  select.value = engine; select.disabled = !options.onEngineChange;
  const themeSelect = document.createElement("select"); themeSelect.className = "terminal-theme-select"; themeSelect.setAttribute("aria-label", text("theme", "Color theme"));
  const themes: TerminalThemeChoice[] = (ui.themes === false ? [] : ui.themes ?? Object.keys(terminalThemes) as TerminalThemeName[]).map(choice => typeof choice === "string" ? { id: choice, label: terminalThemes[choice].label, theme: choice } : choice);
  for (const choice of themes) { const option = document.createElement("option"); option.value = choice.id; option.textContent = text(`theme.${choice.id}`, choice.label); themeSelect.append(option); }
  const customTheme = document.createElement("option"); customTheme.value = ""; customTheme.textContent = text("customTheme", "Custom"); themeSelect.prepend(customTheme);
  const fontSelect = document.createElement("select"); fontSelect.className = "terminal-font-select"; fontSelect.setAttribute("aria-label", text("fontSize", "Text size"));
  for (const size of [10, 12, 14, 16, 18, 20, 24]) { const option = document.createElement("option"); option.value = String(size); option.textContent = `${size} px`; fontSelect.append(option); }
  function syncFontSize() {
    const value = String(terminal.options.fontSize ?? 14);
    if (![...fontSelect.options].some(option => option.value === value)) {
      const option = document.createElement("option"); option.value = value; option.textContent = `${value} px`; fontSelect.append(option);
    }
    fontSelect.value = value;
  }
  syncFontSize();
  for (const [id, control] of [["engine", select], ["theme", themeSelect], ["fontSize", fontSelect]] as const) uiTooltip(control, ui, id, false, signal);
  const search = document.createElement("form"); search.className = "terminal-search"; search.hidden = true; search.setAttribute("role", "search"); search.setAttribute("aria-label", text("searchRegion", "Search terminal output")); configureUi(search, ui);
  const input = document.createElement("input"); input.type = "search"; input.placeholder = text("searchPlaceholder", "Find in output…"); input.maxLength = 512;
  input.setAttribute("aria-label", text("searchInput", "Find in terminal output")); input.autocomplete = "off"; input.spellcheck = false;
  const count = document.createElement("output"); count.className = "terminal-search-count"; count.setAttribute("aria-live", "polite");
  const sensitive = button("matchCase", "Aa", "Match case"); sensitive.setAttribute("aria-pressed", "false");
  const previous = button("previousMatch", "↑", "Previous match (Shift Enter)"); const next = button("nextMatch", "↓", "Next match (Enter)"); const close = button("closeSearch", "×", "Close search (Escape)");
  search.append(input, count, sensitive, previous, next, close);
  const live = button("backToLive", "↓ Back to live", "Return to live output"); live.className = "terminal-return-live"; live.hidden = true; configureUi(live, ui);
  const notice = document.createElement("div"); notice.className = "terminal-tool-notice"; notice.setAttribute("role", "status"); notice.hidden = true; configureUi(notice, ui);
  overlay.append(search, live, notice, menu);
  let matches: TerminalMatch[] = []; let selected = -1; let caseSensitive = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined; let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  function closeMenu() { menu.hidden = true; menuButton.setAttribute("aria-expanded", "false"); }
  function openMenu() { menu.hidden = false; menuButton.setAttribute("aria-expanded", "true"); menu.querySelector<HTMLElement>("select,button")?.focus(); }
  function showCount() { count.textContent = !input.value ? "" : matches.length ? `${selected + 1} / ${matches.length}${matches.length === 1000 ? "+" : ""}` : text("noMatches", "No matches"); previous.disabled = next.disabled = !matches.length; }
  function showMatch() {
    showCount(); const match = matches[selected]; if (!match) { terminal.clearSelection(); return; }
    terminal.select(match.column, match.row, match.length); terminal.scrollToLine(Math.max(0, match.row - Math.floor(terminal.rows / 3)));
  }
  function runSearch(navigate: boolean) {
    searchTimer = undefined; const current = matches[selected]; matches = findInTerminal(terminal.buffer.active, terminal.cols, input.value, caseSensitive);
    selected = Math.min(Math.max(0, selected), matches.length - 1);
    if (current) { const preserved = matches.findIndex(match => match.row === current.row && match.column === current.column); if (preserved >= 0) selected = preserved; }
    if (navigate) showMatch(); else showCount();
  }
  function openSearch() { if (ui.search === false) return; closeMenu(); search.hidden = false; input.focus(); input.select(); runSearch(false); }
  function closeSearch() { clearTimeout(searchTimer); searchTimer = undefined; search.hidden = true; terminal.clearSelection(); terminal.focus(); }
  function openExplore(view?: string) { closeMenu(); if (menu.contains(document.activeElement)) menuButton.focus(); sessionTools?.open(view); }
  function move(delta: number) { if (searchTimer !== undefined) { clearTimeout(searchTimer); runSearch(false); } if (matches.length) { selected = (selected + delta + matches.length) % matches.length; showMatch(); } }
  function showNotice(value: string) { notice.textContent = value; notice.hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000); }
  const context: TerminalToolbarContext = { terminal, container: tools, signal, session: sessionTools?.session, openSearch, openExplore, close: closeMenu };
  const controls: Record<string, HTMLElement> = { search: findButton, export: exportButton, engine: select, theme: themeSelect, fontSize: fontSelect, menu: menuButton, ...(sessionTools ? { explore: sessionTools.button, agent: sessionTools.agentButton } : {}) };
  const placed = new Set<string>();
  function add(items: readonly (TerminalTool | TerminalUiAction)[], parent: HTMLElement) {
    for (const item of items) {
      const id = typeof item === "string" ? item : item.id;
      if (placed.has(id) || id === "search" && ui.search === false || id === "theme" && ui.themes === false || id === "menu" && ui.menu === false) continue;
      let control = typeof item === "string" ? controls[id] : undefined;
      if (typeof item !== "string") {
        control = button(id, item.label, item.tooltip ?? item.label, item.icon?.(document)); controls[id] = control;
        control.addEventListener("click", () => {
          try { void Promise.resolve(item.run({ ...context, container: parent })).catch(() => { if (!signal.aborted) showNotice(text("actionFailed", "Action unavailable.")); }); }
          catch { showNotice(text("actionFailed", "Action unavailable.")); }
        }, { signal });
      }
      if (!control) continue; placed.add(id);
      if (parent === menu && control.tagName === "SELECT") {
        const label = document.createElement("label"); label.className = "terminal-menu-field";
        const caption = document.createElement("span"); caption.textContent = text(id, id === "theme" ? "Color theme" : id === "fontSize" ? "Text size" : "Terminal engine"); label.append(caption, control); parent.append(label);
      } else parent.append(control);
    }
  }
  add(ui.toolbar === false ? [] : ui.toolbar ?? ["search", "agent", "menu"], tools);
  add(ui.menu === false ? [] : ui.menu ?? ["theme", "fontSize", "agent", "export", ...(options.onEngineChange ? ["engine" as const] : [])], menu);
  if (sessionTools) tools.append(sessionTools.stopAgent);
  if (!menu.childElementCount) menuButton.remove();
  findButton.addEventListener("click", openSearch, { signal }); close.addEventListener("click", closeSearch, { signal });
  agentButton?.addEventListener("click", () => { agentButton.focus({ preventScroll: true }); openExplore("agent"); }, { signal });
  fontSelect.addEventListener("change", () => { const size = Number(fontSelect.value); if (!Number.isFinite(size)) return; terminal.options.fontSize = size; options.onFontSizeChange?.(size); }, { signal });
  input.addEventListener("input", () => { selected = 0; clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(true), 120); }, { signal });
  search.addEventListener("submit", event => { event.preventDefault(); move(1); }, { signal });
  search.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }, { signal });
  previous.addEventListener("click", () => move(-1), { signal }); next.addEventListener("click", () => move(1), { signal });
  sensitive.addEventListener("click", () => { caseSensitive = !caseSensitive; sensitive.setAttribute("aria-pressed", String(caseSensitive)); runSearch(true); }, { signal });
  live.addEventListener("click", () => { terminal.clearSelection(); terminal.scrollToBottom(); terminal.focus(); }, { signal });
  overlay.addEventListener("keydown", event => {
    if (options.isActive?.() === false || ui.search === false) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); openSearch(); }
  }, { signal, capture: true });
  menuButton.addEventListener("click", () => menu.hidden ? openMenu() : closeMenu(), { signal });
  menu.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); menuButton.focus(); } }, { signal });
  menu.addEventListener("focusout", event => {
    // Focusout runs before the next control receives focus. Inspect its
    // destination so a menu button stays mounted through its click.
    const next = event.relatedTarget as Node | null;
    // Safari may leave focus on the body when a button is tapped. A null
    // destination is not evidence that the pointer left this menu.
    if (next && !menu.contains(next) && !menuButton.contains(next)) closeMenu();
  }, { signal });
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target as Node) && !menuButton.contains(event.target as Node)) closeMenu(); }, { signal, capture: true });
  exportButton.addEventListener("click", () => {
    closeMenu(); const output = terminalTranscript(terminal.buffer.active);
    if (!output) { showNotice(text("nothingToExport", "No output to download yet.")); return; }
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    if (ui.download) { try { void Promise.resolve(ui.download({ blob, name: ui.exportFilename ?? "terminal-output.txt", signal })).catch(() => showNotice(text("downloadFailed", "Download unavailable."))); } catch { showNotice(text("downloadFailed", "Download unavailable.")); } return; }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = ui.exportFilename ?? "terminal-output.txt";
    document.body.append(anchor); anchor.click(); anchor.remove();
    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1000));
  }, { signal });
  select.addEventListener("change", () => {
    const value = select.value === "native" ? "native" : "xterm";
    if (options.persistEngine === true) { try { document.defaultView?.localStorage.setItem("shell-online-terminal-engine", value); } catch { /* Optional preference only. */ } }
    options.onEngineChange?.(value);
  }, { signal });
  themeSelect.addEventListener("change", () => {
    const choice = themes.find(theme => theme.id === themeSelect.value); if (!choice) return;
    terminal.options.theme = engine === "native" ? choice.theme : resolveTerminalTheme(choice.theme); syncTheme(); options.onThemeChange?.(choice.theme);
  }, { signal });
  let lastTheme: TerminalOptions["theme"] | null = null;
  function syncTheme() {
    if (lastTheme === terminal.options.theme) return; lastTheme = terminal.options.theme;
    const theme = resolveTerminalTheme(lastTheme);
    for (const element of [tools, menu, search, live, notice, overlay, options.frame].filter((value): value is HTMLElement => Boolean(value))) { applyTerminalUiTheme(element, theme); configureUi(element, ui); }
    const selected = themes.find(choice => { const candidate = resolveTerminalTheme(choice.theme); return Object.entries(candidate).every(([key, value]) => theme[key as keyof typeof theme] === value); });
    themeSelect.value = selected?.id ?? ""; customTheme.hidden = Boolean(selected);
  }
  syncTheme();
  let lastRevisionSearch = 0;
  const scrolled = terminal.onScroll(() => { live.hidden = ui.backToLive === false || terminal.buffer.active.viewportY >= terminal.buffer.active.baseY; });
  const rendered = terminal.onRender(() => {
    syncTheme(); syncFontSize(); if (search.hidden || !input.value || searchTimer !== undefined || performance.now() - lastRevisionSearch < 250) return;
    lastRevisionSearch = performance.now(); runSearch(false);
  });
  ownUiCleanup(ui.renderToolbar?.({ ...context, controls }), signal);
  ownUiCleanup(ui.renderSearch?.({ terminal, container: search, signal, close: closeSearch, controls: { input, count, sensitive, previous, next, close } }), signal);
  return { openSearch, openExplore, openMenu, session: sessionTools?.session,
    /** Close optional panels while retaining the live session and any agent connection. */
    close() { closeMenu(); clearTimeout(searchTimer); searchTimer = undefined; search.hidden = true; sessionTools?.close(); },
    dispose() {
    abort.abort(); scrolled.dispose(); rendered.dispose(); sessionTools?.dispose(); clearTimeout(searchTimer); clearTimeout(noticeTimer);
    for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear();
    tools.remove(); menu.remove(); search.remove(); live.remove(); notice.remove();
  } };
}

function icon(document: Document, path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const element = document.createElementNS(svg.namespaceURI, "path"); element.setAttribute("d", path); svg.append(element); return svg;
}
