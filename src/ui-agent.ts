import type { TerminalSession } from "./session.js";
import { createTerminalAgentInvitation, type TerminalAgentInvitation } from "./invitation.js";
import { defaultTerminalRelay, normalizeTerminalRelay } from "./relay.js";
import { uiText, uiTooltip, type TerminalUiOptions } from "./ui-options.js";

let relayFieldSequence = 0;

/** An invitation belongs to the session, so closing Explore never disconnects it. */
export function bindAgentInvitation(session: TerminalSession, panel: HTMLElement, toolbarStop: HTMLButtonElement, toolbarInvite: HTMLButtonElement, ui: TerminalUiOptions, signal: AbortSignal): void {
  const document = panel.ownerDocument, view = document.defaultView;
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const text = (id: string, fallback: string) => uiText(ui, id, fallback);
  const relaySelect = query<HTMLSelectElement>("[data-agent-relay]");
  const customRelay = query<HTMLInputElement>("[data-custom-relay]");
  const customField = query("[data-custom-relay-field]"), relayError = query("[data-relay-error]");
  relayError.id = `terminal-relay-error-${++relayFieldSequence}`;
  const access = query<HTMLSelectElement>("[data-agent-permission]");
  access.setAttribute("aria-label", text("agentAccess", "Access"));
  access.value = ui.initialAgentPermission === "control" ? "control" : "read";
  const accessNote = query("[data-agent-access-note]");
  accessNote.id = `terminal-agent-access-${relayFieldSequence}`; access.setAttribute("aria-describedby", accessNote.id);
  const copy = query<HTMLButtonElement>("[data-copy-invitation]");
  const copyStatus = query("[data-copy-status]"), status = query("[data-agent-status]"), expiry = query("[data-agent-expiry]");
  const messageField = query<HTMLTextAreaElement>("[data-agent-message]");
  const panelStop = query<HTMLButtonElement>("[data-panel-stop]");
  const relays = ui.relays ?? [{ id: "hosted", label: "Shell · hosted", url: defaultTerminalRelay }];
  if (new Set(relays.map(relay => relay.id)).size !== relays.length || relays.some(relay => relay.id === "custom")) throw new TypeError("Relay IDs must be unique; custom is reserved");
  for (const relay of relays) {
    normalizeTerminalRelay(relay.url);
    const option = document.createElement("option"); option.value = relay.id; option.textContent = text(`relay.${relay.id}`, relay.label); relaySelect.append(option);
  }
  if (ui.allowCustomRelay !== false) { const option = document.createElement("option"); option.value = "custom"; option.textContent = text("customRelay", "Custom relay…"); relaySelect.append(option); }
  if (ui.initialRelay && [...relaySelect.options].some(option => option.value === ui.initialRelay)) relaySelect.value = ui.initialRelay;
  relaySelect.setAttribute("aria-label", text("relay", "Relay"));
  uiTooltip(relaySelect, ui, "relay", false, signal);

  let phase: "idle" | "creating" | "waiting" | "connected" = "idle";
  let invitation: TerminalAgentInvitation | undefined, creation: AbortController | undefined;
  let version = 0, validRelay = false, copying = false, again = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  function selectedRelay() {
    const value = relaySelect.value === "custom" ? customRelay.value.trim() : relays.find(relay => relay.id === relaySelect.value)?.url;
    if (!value) throw new Error(text("missingRelay", "Enter your relay URL first."));
    return normalizeTerminalRelay(value);
  }
  function controls() {
    const focused = document.activeElement as HTMLElement | null;
    access.disabled = relaySelect.disabled = customRelay.disabled = phase === "connected";
    copy.disabled = !validRelay || copying || phase === "creating" || phase === "connected";
    copy.textContent = phase === "creating" ? text("creatingInvitationButton", "Creating…") : phase === "connected" ? text("agentConnectedButton", "Agent connected") : again ? text("copyNewInvitation", "Copy new invitation") : text("copyInvitation", "Copy invitation");
    toolbarStop.hidden = phase !== "connected"; panelStop.hidden = phase === "idle";
    toolbarInvite.dataset.agentPhase = phase;
    const caption = phase === "creating" ? text("agentPreparing", "Preparing…") : phase === "waiting" ? text("agentInvitationReady", "Invitation ready") : phase === "connected" ? text("agentConnectedLabel", "Agent connected") : text("agent", "Invite agent");
    toolbarInvite.querySelector("span")!.textContent = caption;
    toolbarInvite.setAttribute("aria-label", caption);
    accessNote.textContent = access.value === "control" ? text("agentControlNote", "Can read output, type, and run commands.") : text("agentReadNote", "Can read output. Cannot type or run commands.");
    toolbarStop.dataset.control = String(phase === "connected" && access.value === "control");
    panelStop.textContent = phase === "connected" ? text("stopAgent", "Stop agent") : text("cancelInvitation", "Cancel invitation");
    if (!ui.renderTooltip) {
      const hint = ui.tooltips === false ? false : ui.tooltips?.[phase === "connected" ? "stopAgent" : "cancelInvitation"] ?? panelStop.textContent;
      if (hint) panelStop.title = hint; else panelStop.removeAttribute("title");
    }
    expiry.hidden = phase !== "waiting";
    status.dataset.status = phase;
    panel.dataset.agentPhase = phase;
    // Disabling Copy or hiding Cancel must not drop focus into the page behind
    // Explore. Keep keyboard users inside the panel until they close it.
    if (!signal.aborted && focused && (panel.contains(focused) || focused === toolbarStop)) {
      const unavailable = !focused.getClientRects().length || "disabled" in focused && focused.disabled;
      if (!panel.hidden && (unavailable || focused === panel && !copy.disabled)) {
        if (!copy.disabled) copy.focus({ preventScroll: true });
        else if (phase === "connected") panelStop.focus({ preventScroll: true });
        else { panel.tabIndex = -1; panel.focus({ preventScroll: true }); }
      } else if (panel.hidden && focused === toolbarStop && toolbarStop.hidden) session.terminal.focus();
    }
  }
  function release(detail?: string) {
    version++; clearInterval(timer); timer = undefined;
    const previous = invitation; invitation = undefined;
    creation?.abort(); creation = undefined; previous?.dispose();
    phase = "idle"; copying = false; messageField.value = ""; messageField.hidden = true; copyStatus.textContent = "";
    if (detail) status.textContent = detail;
    controls();
  }
  function updateExpiry() {
    if (!invitation || phase !== "waiting") return;
    const seconds = Math.max(0, Math.ceil((invitation.expiresAt - Date.now()) / 1000));
    if (!seconds) { again = true; release(text("invitationExpired", "Invitation expired. Copy a new invitation.")); return; }
    expiry.textContent = text("invitationExpires", "Expires in {time}").replace("{time}", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
  }
  function settingsChanged() {
    if (phase !== "idle") release(text("invitationChanged", "Invitation cancelled. Copy a new one with these settings."));
    else { messageField.hidden = true; messageField.value = ""; copyStatus.textContent = ""; }
    customField.hidden = relaySelect.value !== "custom"; relayError.hidden = true; relayError.textContent = ""; customRelay.removeAttribute("aria-invalid"); customRelay.removeAttribute("aria-describedby");
    try { selectedRelay(); validRelay = true; }
    catch (error) {
      validRelay = false;
      if (relaySelect.value !== "custom" || customRelay.value.trim()) {
        customRelay.setAttribute("aria-invalid", "true"); relayError.hidden = false;
        customRelay.setAttribute("aria-describedby", relayError.id);
        relayError.textContent = text("invalidRelay", error instanceof Error ? error.message : "Enter a valid HTTPS relay URL.");
      }
    }
    controls();
  }
  async function prepare(): Promise<TerminalAgentInvitation> {
    if (invitation && phase === "waiting" && invitation.expiresAt > Date.now()) return invitation;
    release(); const current = version;
    creation = new AbortController(); phase = "creating"; copying = true; again = false;
    status.textContent = text("creatingInvitation", "Creating invitation…"); controls();
    const permission = access.value === "control" ? "control" : "read"; let joined = false;
    try {
      const result = await createTerminalAgentInvitation(session, {
        relayUrl: selectedRelay(), permission, client: ui.agentClient, signal: creation.signal,
        title: session.terminal.core.title || document.title,
        onStatus(next, detail) {
          if (signal.aborted || current !== version) return;
          if (next === "connected") {
            joined = true;
            phase = "connected"; clearInterval(timer); timer = undefined; messageField.value = ""; messageField.hidden = true; copyStatus.textContent = "";
            status.textContent = permission === "control" ? text("agentConnectedControl", "Connected · read and command access") : text("agentConnectedRead", "Connected · read access"); controls();
          } else if (next === "disconnected") {
            again = true; release(text("agentDisconnectedDetail", detail ?? "Agent disconnected. Your shell is still running."));
          }
        },
      });
      if (signal.aborted || current !== version) { result.dispose(); throw new Error("Invitation cancelled."); }
      invitation = result;
      if (!joined) {
        phase = "waiting"; status.textContent = text("agentWaiting", "Waiting for your agent…");
        updateExpiry(); timer = setInterval(updateExpiry, 1000);
      }
      controls(); return result;
    } catch (error) {
      if (!signal.aborted && current === version) { again = true; release(text("invitationFailed", error instanceof TypeError ? "Cannot reach this relay. Check the URL or choose another relay, then copy again." : error instanceof Error ? error.message : "Cannot create an invitation. Try copying again.")); }
      throw error;
    }
  }
  copy.addEventListener("click", () => {
    if (copy.disabled || signal.aborted) return;
    copy.focus({ preventScroll: true });
    copying = true; copyStatus.textContent = ""; controls();
    const prepared = prepare(), current = version;
    const message = prepared.then(result => result.message); void message.catch(() => {});
    const clipboard = view?.navigator.clipboard;
    // Start clipboard.write during the click. Safari retains activation for a
    // promised ClipboardItem while the relay creates the invitation asynchronously.
    let written: Promise<void>;
    try {
      written = clipboard?.write && view?.ClipboardItem
        ? clipboard.write([new view.ClipboardItem({ "text/plain": message.then(value => new Blob([value], { type: "text/plain" })) })])
        : clipboard?.writeText ? message.then(value => clipboard.writeText(value)) : Promise.reject(new Error("Clipboard unavailable"));
    } catch { written = Promise.reject(new Error("Clipboard unavailable")); }
    void written.then(async () => {
      await prepared;
      if (!signal.aborted && current === version && phase === "waiting") { messageField.hidden = true; messageField.value = ""; copyStatus.textContent = text("invitationCopied", "Copied. Paste it into your agent’s chat."); }
    }, async () => {
      const result = await prepared;
      if (!signal.aborted && current === version && phase === "waiting") {
        messageField.value = result.message; messageField.hidden = false; messageField.focus(); messageField.select();
        copyStatus.textContent = text("copyInvitationFailed", "Select and copy this invitation, then paste it into your agent’s chat.");
      }
    }).catch(() => {}).finally(() => { if (current === version) { copying = false; controls(); } });
  }, { signal });
  for (const [element, event] of [[relaySelect, "change"], [customRelay, "input"], [access, "change"]] as const) element.addEventListener(event, settingsChanged, { signal });
  const stop = (event: Event) => {
    (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true });
    again = true; release(phase === "connected" ? text("agentStopped", "Agent disconnected. Your shell is still running.") : text("invitationCancelled", "Invitation cancelled."));
  };
  toolbarStop.addEventListener("click", stop, { signal }); panelStop.addEventListener("click", stop, { signal });
  signal.addEventListener("abort", () => release(), { once: true });
  settingsChanged();
}
