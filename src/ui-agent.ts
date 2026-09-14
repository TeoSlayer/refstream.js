import type { TerminalSession } from "./session.js";
import { getTerminalAgentAccess } from "./agent-access.js";
import { defaultTerminalRelay, normalizeTerminalRelay } from "./relay.js";
import { uiText, uiTooltip, type TerminalUiOptions } from "./ui-options.js";

let relayFieldSequence = 0;

/** Views observe a session-owned grant. Closing or disposing a view cannot revoke it. */
export function bindAgentInvitation(session: TerminalSession, panel: HTMLElement, toolbarStop: HTMLButtonElement, toolbarInvite: HTMLButtonElement, ui: TerminalUiOptions, signal: AbortSignal): void {
  const document = panel.ownerDocument, view = document.defaultView, grant = getTerminalAgentAccess(session);
  const query = <T extends HTMLElement = HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const text = (id: string, fallback: string) => uiText(ui, id, fallback);
  const relaySelect = query<HTMLSelectElement>("[data-agent-relay]");
  const customRelay = query<HTMLInputElement>("[data-custom-relay]");
  const customField = query("[data-custom-relay-field]"), relayError = query("[data-relay-error]");
  relayError.id = `terminal-relay-error-${++relayFieldSequence}`;
  const access = query<HTMLSelectElement>("[data-agent-permission]");
  access.setAttribute("aria-label", text("agentAccess", "Access"));
  access.value = grant.state.permission ?? (ui.initialAgentPermission === "control" ? "control" : "read");
  const accessNote = query("[data-agent-access-note]");
  accessNote.id = `terminal-agent-access-${relayFieldSequence}`; access.setAttribute("aria-describedby", accessNote.id);
  const copy = query<HTMLButtonElement>("[data-copy-invitation]");
  const copyStatus = query("[data-copy-status]"), status = query("[data-agent-status]"), expiry = query("[data-agent-expiry]");
  status.tabIndex = -1;
  const messageField = query<HTMLTextAreaElement>("[data-agent-message]");
  const panelStop = query<HTMLButtonElement>("[data-panel-stop]");
  const taskContainer = query("[data-agent-task]"), taskCaption = query("[data-task-status]"), taskNote = query("[data-task-note]");
  const taskResult = query<HTMLDetailsElement>("[data-task-result]"), taskResultLabel = query("[data-task-result-label]"), taskResultText = query("[data-task-result-text]");
  const inputGuard = query("[data-agent-input-guard]"), inputNote = query("[data-agent-input-note]"), inputAllow = query<HTMLButtonElement>("[data-agent-input-allow]");
  const applicationStatus = query("[data-agent-application]");
  const relays = ui.relays ?? [{ id: "hosted", label: "Shell · hosted", url: defaultTerminalRelay }];
  if (new Set(relays.map(relay => relay.id)).size !== relays.length || relays.some(relay => relay.id === "custom")) throw new TypeError("Relay IDs must be unique; custom is reserved");
  for (const relay of relays) {
    normalizeTerminalRelay(relay.url);
    const option = document.createElement("option"); option.value = relay.id; option.textContent = text(`relay.${relay.id}`, relay.label); relaySelect.append(option);
  }
  if (ui.allowCustomRelay !== false) { const option = document.createElement("option"); option.value = "custom"; option.textContent = text("customRelay", "Custom relay…"); relaySelect.append(option); }
  if (ui.initialRelay && [...relaySelect.options].some(option => option.value === ui.initialRelay)) relaySelect.value = ui.initialRelay;
  if (grant.state.relayUrl) {
    const selected = relays.find(relay => normalizeTerminalRelay(relay.url) === grant.state.relayUrl);
    if (selected) relaySelect.value = selected.id;
    else {
      if (![...relaySelect.options].some(option => option.value === "custom")) {
        const option = document.createElement("option"); option.value = "custom"; option.textContent = text("currentRelay", "Current relay"); relaySelect.append(option);
      }
      relaySelect.value = "custom"; customRelay.value = grant.state.relayUrl;
    }
  }
  relaySelect.setAttribute("aria-label", text("relay", "Relay"));
  uiTooltip(relaySelect, ui, "relay", false, signal);

  let validRelay = false, copying = false, again = false, previousPhase = grant.state.phase;
  const phase = () => grant.state.phase;
  function selectedRelay() {
    const value = relaySelect.value === "custom" ? customRelay.value.trim() : relays.find(relay => relay.id === relaySelect.value)?.url;
    if (!value) throw new Error(text("missingRelay", "Enter your relay URL first."));
    return normalizeTerminalRelay(value);
  }
  function controls() {
    const current = phase(), focused = document.activeElement as HTMLElement | null;
    access.disabled = relaySelect.disabled = customRelay.disabled = current === "connected";
    copy.disabled = !validRelay || copying || current === "creating" || current === "connected";
    copy.textContent = current === "creating" ? text("creatingInvitationButton", "Creating…") : current === "connected" ? text("agentConnectedButton", "Agent connected") : again ? text("copyNewInvitation", "Copy new invitation") : text("copyInvitation", "Copy invitation");
    toolbarStop.hidden = current !== "connected"; panelStop.hidden = current === "idle";
    toolbarInvite.dataset.agentPhase = current;
    const caption = current === "creating" ? text("agentPreparing", "Preparing…") : current === "waiting" ? text("agentInvitationReady", "Invitation ready") : current === "connected" ? text("agentConnectedLabel", "Agent connected") : text("agent", "Invite agent");
    const captionNode = toolbarInvite.querySelector("span");
    if (captionNode) captionNode.textContent = caption; else toolbarInvite.textContent = caption;
    toolbarInvite.setAttribute("aria-label", caption);
    accessNote.textContent = access.value === "control" ? text("agentControlNote", "Can read output, type, and run commands.") : text("agentReadNote", "Can read output. Cannot type or run commands.");
    toolbarStop.dataset.control = String(current === "connected" && access.value === "control");
    panelStop.textContent = current === "connected" ? text("stopAgent", "Revoke access") : text("cancelInvitation", "Cancel invitation");
    if (!ui.renderTooltip) {
      const hint = ui.tooltips === false ? false : ui.tooltips?.[current === "connected" ? "stopAgent" : "cancelInvitation"] ?? panelStop.textContent;
      if (hint) panelStop.title = hint; else panelStop.removeAttribute("title");
    }
    status.dataset.status = current; panel.dataset.agentPhase = current;
    if (!signal.aborted && focused && (panel.contains(focused) || focused === toolbarStop)) {
      const unavailable = !focused.getClientRects().length || "disabled" in focused && focused.disabled;
      if (!panel.hidden && (unavailable || focused === panel && !copy.disabled)) {
        if (!copy.disabled) copy.focus({ preventScroll: true });
        else if (current === "connected") status.focus({ preventScroll: true });
        else { panel.tabIndex = -1; panel.focus({ preventScroll: true }); }
      } else if (panel.hidden && focused === toolbarStop && toolbarStop.hidden) session.terminal.focus();
    }
  }
  function updateExpiry() {
    const state = grant.state;
    expiry.hidden = state.phase !== "waiting" && state.phase !== "connected";
    if (state.phase === "waiting" && state.expiresAt) {
      const seconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
      expiry.textContent = text("invitationExpires", "Expires in {time}").replace("{time}", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
    } else if (state.phase === "connected") {
      expiry.textContent = state.sessionExpiresAt
        ? text("agentSessionExpires", "Reusable session · access ends at {time}").replace("{time}", new Date(state.sessionExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
        : text("agentSessionPersistent", "Reusable session · stays connected until revoked, disconnected or expired.");
    }
  }
  function sync() {
    const state = grant.state;
    if (state.phase === "idle" && previousPhase !== "idle") again = true;
    if (state.phase !== "waiting") { messageField.value = ""; messageField.hidden = true; copyStatus.textContent = ""; }
    status.textContent = state.phase === "connected"
      ? state.permission === "control" ? text("agentConnectedControl", "Connected · read and command access") : text("agentConnectedRead", "Connected · read access")
      : state.phase === "waiting" ? text("agentWaiting", "Waiting for your agent…")
      : state.phase === "creating" ? text("creatingInvitation", "Creating invitation…")
      : state.detail ? text("agentDisconnectedDetail", state.detail) : text("agentDisconnected", "No agent connected.");
    previousPhase = state.phase; updateExpiry(); controls(); inputStatus();
  }
  function settingsChanged(cancel = true) {
    if (cancel && phase() !== "idle") grant.revoke(text("invitationChanged", "Invitation cancelled. Copy a new one with these settings."));
    if (cancel) { messageField.hidden = true; messageField.value = ""; copyStatus.textContent = ""; }
    customField.hidden = relaySelect.value !== "custom"; relayError.hidden = true; relayError.textContent = ""; customRelay.removeAttribute("aria-invalid"); customRelay.removeAttribute("aria-describedby");
    try { selectedRelay(); validRelay = true; }
    catch (error) {
      validRelay = false;
      if (relaySelect.value !== "custom" || customRelay.value.trim()) {
        customRelay.setAttribute("aria-invalid", "true"); relayError.hidden = false; customRelay.setAttribute("aria-describedby", relayError.id);
        relayError.textContent = text("invalidRelay", error instanceof Error ? error.message : "Enter a valid HTTPS relay URL.");
      }
    }
    controls();
  }
  copy.addEventListener("click", () => {
    if (copy.disabled || signal.aborted) return;
    copy.focus({ preventScroll: true }); copying = true; copyStatus.textContent = ""; controls();
    const prepared = grant.create({ relayUrl: selectedRelay(), permission: access.value === "control" ? "control" : "read", client: ui.agentClient, title: session.terminal.core.title || document.title });
    const message = prepared.then(result => result.message); void message.catch(() => {});
    const clipboard = view?.navigator.clipboard;
    let written: Promise<void>;
    try {
      written = clipboard?.write && view?.ClipboardItem
        ? clipboard.write([new view.ClipboardItem({ "text/plain": message.then(value => new Blob([value], { type: "text/plain" })) })])
        : clipboard?.writeText ? message.then(value => clipboard.writeText(value)) : Promise.reject(new Error("Clipboard unavailable"));
    } catch { written = Promise.reject(new Error("Clipboard unavailable")); }
    void written.then(async () => {
      const result = await prepared;
      if (!signal.aborted && grant.invitation === result) { messageField.hidden = true; messageField.value = ""; copyStatus.textContent = text("invitationCopied", "Copied. Paste it into your agent’s chat."); }
    }, async () => {
      const result = await prepared;
      if (!signal.aborted && grant.invitation === result) {
        messageField.value = result.message; messageField.hidden = false; messageField.focus(); messageField.select();
        copyStatus.textContent = text("copyInvitationFailed", "Select and copy this invitation, then paste it into your agent’s chat.");
      }
    }).catch(() => {}).finally(() => { if (!signal.aborted) { copying = false; controls(); } });
  }, { signal });
  for (const [element, event] of [[relaySelect, "change"], [customRelay, "input"], [access, "change"]] as const) element.addEventListener(event, () => settingsChanged(), { signal });
  const stop = (event: Event) => {
    (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true });
    grant.revoke(phase() === "connected" ? text("agentStopped", "Access revoked. Your shell is still running; tasks and answers are retained.") : text("invitationCancelled", "Invitation cancelled."));
  };
  toolbarStop.addEventListener("click", stop, { signal }); panelStop.addEventListener("click", stop, { signal });
  let lastInputView = "", lastTaskView = "";
  function inputStatus() {
    const input = session.input, app = session.application;
    const sharing = phase() === "connected" && grant.state.permission === "control";
    const key = JSON.stringify([sharing, input.state, input.content, input.protected, input.composing, app.status]);
    if (key === lastInputView) return;
    lastInputView = key;
    const blocked = sharing && input.protected && !["authentication_required", "working", "input_required"].includes(app.status);
    inputGuard.hidden = !blocked;
    if (!blocked) return;
    inputAllow.hidden = input.composing || input.content === "draft";
    inputNote.textContent = input.composing ? text("agentInputComposing", "Your keyboard is still composing text. Agent input is paused.")
      : input.content === "draft" ? text("agentInputProtected", "Draft in progress. Agent input is paused.")
      : text("agentInputUnverified", "Input changed. Check the composer before the agent continues. Suggested prompts do not need clearing.");
  }
  inputAllow.addEventListener("click", () => {
    try { session.confirmInputEmpty(session.input.revision); inputGuard.hidden = true; status.focus({ preventScroll: true }); }
    catch { inputNote.textContent = text("agentInputNotEmpty", "The composer changed or still contains a draft. Check the application's input again."); }
  }, { signal });
  function taskStatus() {
    const tasks = session.tasks.summary(), task = tasks[tasks.length - 1], app = session.application;
    const key = JSON.stringify([task?.id, task?.revision, app.status, app.taskId, phase()]);
    if (key === lastTaskView) return;
    lastTaskView = key;
    const active = task && ["waiting", "needs_attention"].includes(task.status);
    const appLabels = { unknown: "State unavailable", ready: "Ready", authentication_required: "Authentication required", input_required: "Needs your response", working: "Working", answer_ready: "Answer ready" };
    const progress = active && (app.status === "authentication_required" || app.status === "input_required" || app.taskId === task.id && task.status !== "needs_attention" && ["working", "answer_ready"].includes(app.status)) ? app.status : undefined;
    applicationStatus.hidden = app.status === "unknown" || Boolean(progress) || Boolean(task && app.taskId === task.id);
    applicationStatus.textContent = text(`agentApplication.${app.status}`, appLabels[app.status]);
    taskContainer.hidden = !task;
    if (!task) return;
    taskContainer.dataset.handoffStatus = task.status;
    taskContainer.dataset.applicationStatus = progress ?? "";
    const labels = { waiting: "Waiting for answer", needs_attention: "Needs attention", completed: "Answer ready to collect", collected: "Answer collected", cancelled: "Task abandoned" };
    taskCaption.textContent = progress ? text(`agentApplication.${progress}`, appLabels[progress]) : text(`agentTask.${task.status}`, labels[task.status]);
    const progressNote = progress === "authentication_required" ? phase() === "connected" ? text("agentAuthenticationRequired", "Sign in in the terminal. The session stays connected.") : text("agentAuthenticationDisconnected", "Sign in in the terminal. This task is retained.")
      : progress === "working" ? phase() === "connected" ? text("agentApplicationWorking", "The application is working on this request. The connection stays open.") : text("agentApplicationWorkingDisconnected", "The application is working. Reconnect to retrieve further output.")
      : progress === "answer_ready" ? text("agentApplicationAnswerReady", "The application has a response to retrieve. The agent still needs to collect the answer.")
      : progress === "input_required" ? text("agentApplicationInputRequired", "Respond to the application's current dialog to continue.") : undefined;
    taskNote.textContent = progressNote ?? text(`agentTaskNote.${task.status}`, task.note ?? (task.completion === "agent_observed" ? text("agentObservedCompletion", "Completion reported by the visiting agent.") : task.status === "waiting" ? phase() === "connected" ? text("agentTaskWaiting", "Output alone does not confirm completion. The connection stays open.") : text("agentTaskDisconnected", "Task retained. Reconnect to retrieve further output.") : ""));
    const result = task.resultAvailable ? session.tasks.get(task.id).result : undefined;
    taskResult.hidden = !result;
    taskResultLabel.textContent = result?.completion ? text("agentTaskAnswer", "Answer") : text("agentTaskPartial", "Output so far · completion unconfirmed");
    taskResultText.textContent = result?.text ?? "";
  }
  const connectionSubscription = grant.onChange(() => { sync(); taskStatus(); }), taskSubscription = session.tasks.onChange(taskStatus), inputSubscription = session.onChange(() => { inputStatus(); taskStatus(); });
  const timer = setInterval(updateExpiry, 1000);
  signal.addEventListener("abort", () => { connectionSubscription.dispose(); taskSubscription.dispose(); inputSubscription.dispose(); clearInterval(timer); }, { once: true });
  settingsChanged(false); sync(); taskStatus();
}
