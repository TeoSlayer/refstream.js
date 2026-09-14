import { NativeTerminal, TerminalSession, getTerminalSession, terminalTranscript, replayRecording, type CommandRecord, type TerminalRecording } from "./index.js";
import { configureUi, ownUiCleanup, uiButton, uiText, uiTooltip, type TerminalUiOptions, type TerminalExploreTab, type TerminalUiContext } from "./ui-options.js";
import { bindAgentInvitation } from "./ui-agent.js";

/** Optional UI over a host-owned or locally owned terminal session. */
export function attachSessionTools(terminal: NativeTerminal, toolbar: HTMLElement, overlay: HTMLElement, ui: TerminalUiOptions = {}, suppliedSession?: TerminalSession) {
  const settings = ui.explore === false ? {} : ui.explore ?? {};
  const entries: readonly TerminalExploreTab[] = settings.tabs ?? ["commands", "read", "replay", "agent"];
  const entryId = (entry: TerminalExploreTab) => typeof entry === "string" ? entry : entry.id;
  const entryMap = new Map(entries.map(entry => [entryId(entry), entry]));
  if (entryMap.size !== entries.length) throw new TypeError("Explore view IDs must be unique");
  if (suppliedSession && suppliedSession.terminal !== terminal) throw new TypeError("The session belongs to another terminal");
  const session = suppliedSession ?? getTerminalSession(terminal);
  if (!session.recording && (entries.includes("replay") || settings.render)) session.startRecording();
  const document = overlay.ownerDocument;
  const abort = new AbortController(); const signal = abort.signal;
  const text = (id: string, fallback: string) => uiText(ui, id, fallback);
  const button = (id: string, label: string, hint: string | false = label, lifetime = signal) => uiButton(document, ui, id, label, hint, lifetime);
  const explore = button("explore", "Explore", "Explore terminal");
  const agentButton = button("agent", "Invite agent", "Invite agent");
  const agentCaption = document.createElement("span"); agentCaption.textContent = agentButton.textContent; agentButton.replaceChildren(agentCaption);
  agentButton.hidden = !entryMap.has("agent") && !settings.render;
  agentButton.setAttribute("aria-expanded", "false");
  const stopAgent = button("stopAgent", "Revoke access", "Revoke the agent’s access to this terminal"); stopAgent.hidden = true;
  const backdrop = document.createElement("div"); backdrop.className = "terminal-agent-backdrop"; backdrop.hidden = true; backdrop.setAttribute("aria-hidden", "true");
  const compact = document.defaultView?.matchMedia("(max-width: 760px)");
  const panel = document.createElement("section"); panel.className = "terminal-explorer"; panel.hidden = true; configureUi(panel, ui);
  panel.setAttribute("aria-label", text("exploreRegion", "Terminal explorer"));
  panel.innerHTML = `<header><strong data-ui-text="exploreTitle">Terminal</strong><button type="button" data-close data-ui-aria="closeExplore" aria-label="Close terminal explorer">×</button></header>
    <nav aria-label="Terminal views"></nav>
    <div class="terminal-explorer-content">
      <div data-view="commands"><div data-command-list></div></div>
      <div data-view="read" hidden><div class="terminal-explorer-actions"><label><input type="checkbox" data-pause><span data-ui-text="pauseUpdates">Pause updates</span></label><button type="button" data-save-state data-ui-text="saveState">Save state</button></div><p class="terminal-explorer-note" data-read-note hidden></p><pre class="terminal-reading" tabindex="0" data-ui-aria="readingOutput" aria-label="Readable terminal output"></pre></div>
      <div data-view="replay" hidden><div class="terminal-explorer-actions"><button type="button" data-play data-ui-text="play">Play</button><button type="button" data-recording-export data-ui-text="saveRecording">Save recording</button><output data-replay-time></output></div><input type="range" data-replay-position min="0" max="1" value="1" data-ui-aria="replayPosition" aria-label="Replay position"><div class="terminal-replay-host"></div><p class="terminal-explorer-note" data-replay-note hidden></p></div>
      <div data-view="agent" hidden>
        <p class="terminal-explorer-note" data-ui-text="agentInstructions">Paste the invitation into your agent’s chat with your request.</p>
        <div class="terminal-agent-settings"><label class="terminal-relay-field"><span data-ui-text="agentAccess">Access</span><select data-agent-permission><option value="read" data-ui-text="agentRead">Read only</option><option value="control" data-ui-text="agentControl">Read and run commands</option></select></label>
        <p class="terminal-explorer-note" data-agent-access-note></p></div>
        <details class="terminal-agent-advanced"><summary data-ui-text="connectionSettings">Connection settings</summary>
          <label class="terminal-relay-field"><span data-ui-text="relay">Relay</span><select data-agent-relay data-ui-aria="relay" aria-label="Relay"></select></label>
          <label class="terminal-relay-field" data-custom-relay-field hidden><span data-ui-text="customRelayUrl">Custom relay URL</span><input type="url" data-custom-relay data-ui-aria="customRelayUrl" aria-label="Custom relay URL" placeholder="https://relay.example.com" autocomplete="off" spellcheck="false"><span data-relay-error role="status" hidden></span></label>
          <p class="terminal-explorer-note" data-ui-text="agentRequirements">Your agent needs a command tool and Node.js 22 or newer. The invitation includes everything it needs to connect.</p>
        </details>
        <div class="terminal-pair-request"><button type="button" data-copy-invitation data-ui-text="copyInvitation">Copy invitation</button><span data-copy-status role="status"></span><textarea data-agent-message readonly hidden data-ui-aria="invitationMessage" aria-label="Message for your agent"></textarea></div>
        <div class="terminal-agent-connection"><div><p role="status" data-agent-status data-ui-text="agentDisconnected">No agent connected.</p><small data-agent-expiry hidden aria-live="off"></small></div><button type="button" data-panel-stop data-ui-text="stopAgent" hidden>Revoke access</button></div>
        <p class="terminal-explorer-note" data-agent-application role="status" hidden></p>
        <div data-agent-input-guard hidden><p class="terminal-explorer-note" data-agent-input-note role="status"></p><button type="button" data-agent-input-allow data-ui-text="agentInputConfirmEmpty">I've checked: input is empty</button></div>
        <div class="terminal-agent-task" data-agent-task hidden><p role="status" data-task-status></p><p class="terminal-explorer-note" data-task-note></p><details data-task-result hidden><summary data-task-result-label></summary><pre data-task-result-text></pre></details></div>
        <p class="terminal-explorer-note terminal-agent-privacy" data-ui-text="agentPrivacy">Only this terminal is shared. You can revoke access at any time.</p>
      </div>
    </div>`;
  for (const element of panel.querySelectorAll<HTMLElement>("[data-ui-text]")) element.textContent = text(element.dataset.uiText!, element.textContent ?? "");
  for (const control of panel.querySelectorAll<HTMLElement>("button")) {
    const id = control.dataset.uiText ?? control.dataset.uiAria ?? "closeExplore";
    control.dataset.uiAction = id; uiTooltip(control, ui, id, control.getAttribute("aria-label") || control.textContent || false, signal);
  }
  for (const element of panel.querySelectorAll<HTMLElement>("[data-ui-aria]")) element.setAttribute("aria-label", text(element.dataset.uiAria!, element.getAttribute("aria-label") ?? ""));
  if (settings.title !== undefined) panel.querySelector("header strong")!.textContent = settings.title;
  const navigation = panel.querySelector("nav")!; const tabButtons = new Map<string, HTMLButtonElement>();
  for (const entry of entries) {
    const id = entryId(entry); const label = typeof entry === "string" ? { commands: "Commands", read: "Output", replay: "Replay", agent: "Agent" }[entry] : entry.label;
    const item = button(id, label, typeof entry === "string" ? false : entry.tooltip ?? false); item.dataset.tab = id;
    tabButtons.set(id, item); navigation.append(item);
  }
  overlay.append(backdrop, panel);
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const list = query("[data-command-list]"); const reading = query(".terminal-reading");
  const pause = query<HTMLInputElement>("[data-pause]");
  const slider = query<HTMLInputElement>("[data-replay-position]");
  const play = query<HTMLButtonElement>("[data-play]");

  let tab = settings.initialTab && entryMap.has(settings.initialTab) ? settings.initialTab : entries.length ? entryId(entries[0]) : "";
  let customLifetime: AbortController | undefined;
  const cardLifetimes: AbortController[] = [];
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  let commandSignature = "";
  const expanded = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playback: ReturnType<typeof setInterval> | undefined;
  let replay: NativeTerminal | undefined;
  let recording: TerminalRecording | undefined;

  function closeReplay() { clearInterval(playback); playback = undefined; replay?.dispose(); replay = undefined; recording = undefined; play.textContent = text("play", "Play"); }
  function closeCustom() { customLifetime?.abort(); customLifetime = undefined; }
  let opener: HTMLElement | null = null;
  function presentation() {
    const modal = compact?.matches && tab === "agent";
    panel.setAttribute("role", modal ? "dialog" : "region");
    if (modal) panel.setAttribute("aria-modal", "true"); else panel.removeAttribute("aria-modal");
    backdrop.hidden = panel.hidden || tab !== "agent";
  }
  compact?.addEventListener("change", presentation, { signal });
  backdrop.addEventListener("click", () => close(), { signal });
  function close() { panel.hidden = backdrop.hidden = true; explore.setAttribute("aria-expanded", "false"); agentButton.setAttribute("aria-expanded", "false"); closeReplay(); closeCustom(); if (opener?.isConnected) opener.focus({ preventScroll: true }); else terminal.focus(); }
  function open(next = tab) {
    if (ui.explore === false || !settings.render && !entryMap.has(next)) return;
    if (panel.hidden) opener = document.activeElement instanceof HTMLElement ? document.activeElement : explore;
    closeCustom(); if (tab === "replay") closeReplay();
    tab = next; panel.hidden = false; explore.setAttribute("aria-expanded", "true");
    presentation();
    panel.dataset.activeView = tab; agentButton.setAttribute("aria-expanded", String(tab === "agent"));
    if (!settings.render) query("header strong").textContent = settings.title ?? (tab === "agent" ? text("agentTitle", "Agent connection") : text("exploreTitle", "Terminal"));
    const entry = entryMap.get(tab);
    const renderer = settings.render ?? (typeof entry === "object" ? entry.render : undefined);
    if (renderer) {
      const container = settings.render ? panel : query(".terminal-explorer-content");
      if (!settings.render) {
        for (const view of container.querySelectorAll<HTMLElement>("[data-view]")) view.hidden = true;
        container.querySelector("[data-custom-view]")?.remove();
      }
      const mount = document.createElement("div"); mount.dataset.customView = "";
      if (settings.render) container.replaceChildren(mount); else container.append(mount);
      customLifetime = new AbortController();
      ownUiCleanup(renderer({ terminal, session, container: mount, signal: customLifetime.signal, close }), customLifetime.signal);
      if (settings.render) { panel.tabIndex = -1; panel.focus(); }
      else { for (const [id, item] of tabButtons) item.setAttribute("aria-pressed", String(id === tab)); tabButtons.get(tab)?.focus(); }
      return;
    }
    panel.querySelector("[data-custom-view]")?.remove();
    for (const view of panel.querySelectorAll<HTMLElement>("[data-view]")) view.hidden = view.dataset.view !== tab;
    for (const [id, item] of tabButtons) item.setAttribute("aria-pressed", String(id === tab));
    if (tab === "replay" && session.recording) {
      recording = session.recording.export();
      replay = new NativeTerminal({ fontFamily: terminal.options.fontFamily, fontSize: Math.min(terminal.options.fontSize ?? 14, 14), lineHeight: terminal.options.lineHeight, theme: terminal.options.theme, disableStdin: true, cursorBlink: false });
      replay.open(query(".terminal-replay-host"));
      const end = recording.events[recording.events.length - 1]?.at ?? recording.checkpointAt;
      slider.max = String(Math.max(1, end - recording.checkpointAt)); slider.value = slider.max;
      const note = query("[data-replay-note]"); note.hidden = !recording.truncated; note.textContent = text("replayTruncated", "Earlier frames have expired from this recording."); seek();
    }
    render(); tabButtons.get(tab)?.focus();
  }
  function seek() {
    if (!replay || !recording) return;
    const elapsed = Number(slider.value);
    const model = replayRecording(recording, recording.checkpointAt + elapsed);
    replay.restore({ version: 1, model, viewportY: model.active === "normal" ? model.history.length : 0 });
    query("[data-replay-time]").textContent = `${(elapsed / 1000).toFixed(1)} / ${(Number(slider.max) / 1000).toFixed(1)} s`;
  }
  function render() {
    if (panel.hidden || settings.render || typeof entryMap.get(tab) === "object") return;
    if (tab === "commands") {
      const commands = session.commands.list().slice(-100);
      const signature = commands.map(item => `${item.id}:${item.status}:${item.output?.length ?? 0}`).join(",");
      if (signature === commandSignature && list.childElementCount) return;
      commandSignature = signature;
      const retained = new Set(commands.map(command => command.id));
      for (const id of expanded) if (!retained.has(id)) expanded.delete(id);
      for (const lifetime of cardLifetimes.splice(0)) lifetime.abort();
      list.replaceChildren();
      if (!commands.length) {
        const empty = document.createElement("p"); empty.className = "terminal-command-empty";
        empty.textContent = text("noCommands", "No command boundaries yet. Enable shell integration to track commands.");
        list.append(empty);
      }
      for (const command of commands.reverse()) list.append(commandCard(command));
    } else if (tab === "read" && !pause.checked) {
      const selection = reading.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && reading.contains(selection.anchorNode)) {
        query("[data-read-note]").hidden = false; query("[data-read-note]").textContent = text("readingPaused", "Updates paused while text is selected.");
        return;
      }
      const buffer = terminal.buffer.active;
      const start = Math.max(0, buffer.length - 300);
      const transcript = terminalTranscript({ ...buffer, length: buffer.length - start, getLine: row => buffer.getLine(start + row) }).slice(-64_000);
      const following = reading.scrollTop + reading.clientHeight >= reading.scrollHeight - 8;
      if (reading.textContent !== transcript) reading.textContent = transcript;
      if (following) reading.scrollTop = reading.scrollHeight;
      query("[data-read-note]").hidden = false; query("[data-read-note]").textContent = buffer.type === "alternate" ? text("readingAlternate", "Full-screen application active. Close this view to interact with it.") : text("readingLimit", "Latest 300 rows, up to 64 KB. Download output to save all retained text.");
    }
  }
  function commandCard(command: CommandRecord) {
    const lifetime = new AbortController(); cardLifetimes.push(lifetime);
    const details = document.createElement("details"); details.className = "terminal-command-card"; details.open = expanded.has(command.id);
    const summary = document.createElement("summary");
    const name = document.createElement("code"); name.textContent = command.command || text("commandUnknown", "Command text unavailable");
    const status = document.createElement("span"); status.className = "terminal-command-status";
    status.dataset.status = command.status === "completed" ? command.exitCode === 0 ? "success" : "failure" : command.status;
    status.textContent = command.status === "completed" ? command.exitCode === 0 ? text("commandSuccess", "Success") : text("commandExit", "Exit {code}").replace("{code}", String(command.exitCode)) : command.status === "running" ? text("commandRunning", "Running") : text("commandStatusUnknown", "Status unknown");
    summary.append(name, status); details.append(summary);
    const body = document.createElement("div"); body.className = "terminal-command-body"; details.append(body);
    let bodyLifetime: AbortController | undefined;
    lifetime.signal.addEventListener("abort", () => bodyLifetime?.abort(), { once: true });
    function show() {
      bodyLifetime?.abort(); bodyLifetime = new AbortController();
      if (!details.open) { expanded.delete(command.id); body.replaceChildren(); return; }
      expanded.add(command.id); body.replaceChildren();
      const meta = document.createElement("p"); meta.className = "terminal-explorer-note";
      meta.textContent = [command.directory || text("directoryUnknown", "Directory not reported"), command.durationMs === undefined ? "" : command.durationMs < 1000 ? `${command.durationMs} ms` : `${(command.durationMs / 1000).toFixed(2)} s`].filter(Boolean).join(" · ");
      const jump = button("jumpToCommand", "Jump to terminal", "Jump to this command in the live terminal", bodyLifetime.signal);
      const row = session.commands.rowFor(command.id); jump.disabled = row === undefined;
      jump.addEventListener("click", () => { close(); if (row !== undefined) terminal.scrollToLine(row); });
      const output = session.commands.output(command.id);
      const pre = document.createElement("pre"); pre.textContent = output.text || (output.alternateScreen ? text("commandAlternate", "Full-screen application active.") : text("commandEmpty", "No captured output."));
      body.append(meta, jump, pre);
      if (output.truncated) { const note = document.createElement("p"); note.className = "terminal-explorer-note"; note.textContent = text("commandTruncated", "Some output has expired."); body.append(note); }
    }
    // These listeners belong to replaceable cards. A long-lived AbortSignal
    // would retain every removed card until the entire terminal was disposed.
    details.addEventListener("toggle", show); if (details.open) show();
    return details;
  }
  explore.setAttribute("aria-expanded", "false"); explore.hidden = !entries.length && !settings.render;
  explore.addEventListener("click", () => {
    if (panel.hidden) { explore.focus({ preventScroll: true }); open(); }
    else close();
  }, { signal });
  query("[data-close]").addEventListener("click", close, { signal });
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"],summary')].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); panel.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, { signal });
  for (const [id, item] of tabButtons) item.addEventListener("click", () => open(id), { signal });
  pause.addEventListener("change", render, { signal });
  reading.ownerDocument.addEventListener("selectionchange", () => { if (tab === "read") render(); }, { signal });
  slider.addEventListener("input", () => { clearInterval(playback); playback = undefined; play.textContent = text("play", "Play"); seek(); }, { signal });
  play.addEventListener("click", () => {
    if (playback) { clearInterval(playback); playback = undefined; play.textContent = text("play", "Play"); return; }
    if (Number(slider.value) >= Number(slider.max)) slider.value = "0";
    play.textContent = text("pause", "Pause");
    playback = setInterval(() => {
      slider.value = String(Math.min(Number(slider.max), Number(slider.value) + 200)); seek();
      if (slider.value === slider.max) { clearInterval(playback); playback = undefined; play.textContent = text("play", "Play"); }
    }, 200);
  }, { signal });
  query("[data-save-state]").addEventListener("click", () => download("shell-terminal-state.json", session.snapshot()), { signal });
  query("[data-recording-export]").addEventListener("click", () => { if (recording) download("shell-terminal-recording.json", recording); }, { signal });
  bindAgentInvitation(session, panel, stopAgent, agentButton, ui, signal);
  const change = session.onChange(() => {
    if (!panel.hidden && timer === undefined) timer = setTimeout(() => { timer = undefined; render(); }, 250);
  });
  function download(name: string, data: unknown) {
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    if (ui.download) { void Promise.resolve(ui.download({ blob, name, signal })).catch(() => {}); return; }
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1000));
  }
  return { session, button: explore, agentButton, stopAgent, open, close, dispose() {
    abort.abort(); clearTimeout(timer); closeReplay(); closeCustom(); change.dispose();
    for (const lifetime of cardLifetimes.splice(0)) lifetime.abort();
    for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear();
    explore.remove(); agentButton.remove(); stopAgent.remove(); backdrop.remove(); panel.remove();
  } };
}
