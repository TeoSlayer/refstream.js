import { createTerminalAgentInvitation, type TerminalAgentInvitation, type TerminalAgentInvitationOptions } from "./invitation.js";
import type { TerminalSession } from "./session.js";
import { Signal } from "./types.js";
import { normalizeTerminalRelay } from "./relay.js";

export interface TerminalAgentAccessState {
  phase: "idle" | "creating" | "waiting" | "connected";
  permission?: "read" | "control";
  relayUrl?: string;
  detail?: string;
  expiresAt?: number;
  sessionExpiresAt?: number;
}
const accessBySession = new WeakMap<TerminalSession, TerminalAgentAccess>();

/** One grant per logical session. Disposing a view does not revoke the grant. */
export class TerminalAgentAccess {
  private value: TerminalAgentAccessState = { phase: "idle" };
  private current?: TerminalAgentInvitation;
  private creation?: AbortController;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private changes = new Signal<TerminalAgentAccessState>();
  readonly onChange = this.changes.event;
  constructor(private session: TerminalSession) {
    session.signal.addEventListener("abort", () => { this.revoke(); this.changes.dispose(); }, { once: true });
  }
  get state(): TerminalAgentAccessState { return { ...this.value }; }
  get invitation(): TerminalAgentInvitation | undefined { return this.value.phase === "waiting" ? this.current : undefined; }
  async create(options: Omit<TerminalAgentInvitationOptions, "signal" | "onStatus">): Promise<TerminalAgentInvitation> {
    options = { ...options, relayUrl: normalizeTerminalRelay(options.relayUrl) };
    if (this.session.signal.aborted) throw new Error("Session has ended");
    if (this.value.phase === "connected") throw new Error("An agent is already connected. Reuse the current connection.");
    if (this.invitation && this.value.relayUrl === options.relayUrl && this.value.permission === options.permission && this.invitation.expiresAt > Date.now()) return this.invitation;
    this.revoke(); const generation = this.generation;
    const creation = this.creation = new AbortController();
    this.set({ phase: "creating", relayUrl: options.relayUrl, permission: options.permission });
    try {
      const invitation = await createTerminalAgentInvitation(this.session, {
        ...options, signal: creation.signal,
        onStatus: (status, detail) => {
          if (generation !== this.generation) return;
          if (status === "connected") { clearTimeout(this.timer); this.set({ ...this.value, phase: "connected", detail: undefined }); }
          else if (status === "disconnected") this.revoke(detail || "Agent disconnected. Tasks and collected answers are retained in this terminal session.");
        },
      });
      if (generation !== this.generation) { invitation.dispose(); throw new Error("Invitation cancelled"); }
      this.current = invitation;
      if (this.state.phase !== "connected") {
        this.set({ ...this.value, phase: "waiting", expiresAt: invitation.expiresAt, sessionExpiresAt: invitation.sessionExpiresAt });
        this.timer = setTimeout(() => this.revoke("Invitation expired. Copy a new invitation."), Math.max(1, invitation.expiresAt - Date.now()));
      } else this.set({ ...this.value, sessionExpiresAt: invitation.sessionExpiresAt });
      return invitation;
    } catch (error) {
      if (generation === this.generation) this.revoke(error instanceof TypeError ? "Cannot reach this relay. Check the URL or choose another relay, then copy again." : error instanceof Error ? error.message : "Cannot create an invitation.");
      throw error;
    }
  }
  /** The owner can revoke immediately, including while a handoff is pending. */
  revoke(detail?: string): void {
    this.generation++; clearTimeout(this.timer);
    const current = this.current, creation = this.creation;
    this.current = undefined; this.creation = undefined;
    creation?.abort(); current?.dispose();
    this.set({ phase: "idle", detail });
  }
  private set(value: TerminalAgentAccessState): void { this.value = value; this.changes.fire(this.state); }
}

export function getTerminalAgentAccess(session: TerminalSession): TerminalAgentAccess {
  let access = accessBySession.get(session);
  if (!access) { access = new TerminalAgentAccess(session); accessBySession.set(session, access); }
  return access;
}
