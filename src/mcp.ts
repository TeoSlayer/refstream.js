import type { TerminalSession } from "./session.js";
import type { Disposable } from "./types.js";
import { connectTerminalRelay, parseTerminalRelayPairing, type TerminalRelayPairing } from "./relay.js";

export interface TerminalAgentOptions {
  /** One-time pairing URL returned by the MCP companion's terminal_pair tool. */
  pairingUrl: string;
  /** Pin the expected relay. The hosted UI requires the selected relay to match. */
  relayUrl?: string;
  permission: "read" | "control";
  title?: string;
  onStatus?: (status: "connecting" | "connected" | "disconnected", detail?: string) => void;
}
export interface TerminalAgentRequest { method: string; args?: Record<string, unknown> }

/** Validate before replacing a live connection. No network, popup or terminal access. */
export function validateTerminalAgentPairing(pairingUrl: string, origin: string, relayUrl?: string): TerminalRelayPairing | null {
  let url: URL; try { url = new URL(pairingUrl); } catch { throw new Error("Use the complete pairing URL supplied by your agent"); }
  if (new URLSearchParams(url.hash.slice(1)).has("v")) return parseTerminalRelayPairing(pairingUrl, origin, relayUrl);
  const params = new URLSearchParams(url.hash.slice(1)); const token = params.get("token");
  if (relayUrl || pairingUrl.length > 8192 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/pair" || url.username || url.password || url.search || !token || !/^[a-f0-9]{64}$/u.test(token) || params.get("origin") !== origin || [...params.keys()].length !== 2) {
    throw new Error("Use a pairing URL created for this page and the selected relay. Ask your agent for a fresh pairing URL.");
  }
  return null;
}

/** The narrow command boundary; transport messages never evaluate page JavaScript. */
export async function handleTerminalAgentRequest(session: TerminalSession, request: TerminalAgentRequest, permission: "read" | "control", signal?: AbortSignal): Promise<unknown> {
  if (session.signal.aborted || signal?.aborted) throw new Error("Terminal access has ended");
  if (!request || typeof request !== "object" || typeof request.method !== "string" || (request.args !== undefined && (!request.args || typeof request.args !== "object" || Array.isArray(request.args)))) throw new TypeError("Invalid terminal request");
  const args = request.args ?? {};
  const text = (key: string, max = 8192) => {
    const value = args[key]; if (typeof value !== "string" || value.length > max) throw new TypeError(`Invalid ${key}`); return value;
  };
  const number = (key: string, fallback?: number) => {
    const value = args[key];
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Invalid ${key}`);
    return value as number;
  };
  const expected = () => {
    const value = number("expectedSequence");
    if (value === undefined) throw new TypeError(`${request.method} requires expectedSequence from a recent read`);
    return value;
  };
  if (["send_text", "send_key", "execute", "ask", "collect_task", "cancel_task"].includes(request.method) && permission !== "control") throw new Error("This session grants read access only");
  switch (request.method) {
    case "read": return session.read({ startRow: number("startRow"), maxRows: number("maxRows", 100) });
    case "search": return session.search(text("query", 512), args.caseSensitive === true).slice(0, 100);
    case "commands": return session.commands.list().slice(-100).map(({ output: _output, ...record }) => record);
    case "command_output": return session.commands.output(number("commandId", 0)!);
    case "wait": return session.wait(number("afterSequence", session.sequence)!, Math.min(number("timeoutMs", 15_000)!, 30_000), signal);
    case "tasks": return { terminalSessionId: session.id, tasks: session.tasks.summary() };
    case "ask": {
      if (args.kind !== undefined && args.kind !== "command" && args.kind !== "message") throw new TypeError("Choose command or message");
      return session.ask(text("prompt"), text("taskId", 128), expected(), { kind: args.kind, confirmEmptyInput: args.confirmEmptyInput === true });
    }
    case "read_task": return session.readTask(text("taskId", 128));
    case "wait_task": return session.waitTask(text("taskId", 128), number("afterRevision", 0)!, Math.min(number("timeoutMs", 15_000)!, 30_000), signal);
    case "collect_task": {
      if (args.completion !== undefined && args.completion !== "agent_observed") throw new TypeError("Only the host or shell may report their own completion events");
      return session.collectTask(text("taskId", 128), { expectedSequence: number("expectedSequence"), answer: args.answer === undefined ? undefined : text("answer", 32768), completion: args.completion });
    }
    case "cancel_task": return session.cancelTask(text("taskId", 128), text("reason", 1024));
    case "can_disconnect": session.assertCanDisconnect(); return { allowed: true };
    case "send_text": return session.sendText(text("text"), text("inputId", 128), expected(), args.confirmEmptyInput === true);
    case "send_key": return session.sendKey({ key: text("key", 32), ctrlKey: args.ctrl === true, altKey: args.alt === true, shiftKey: args.shift === true }, text("inputId", 128), expected());
    case "execute": return session.execute(text("command"), text("inputId", 128), expected());
    default: throw new Error("Unsupported terminal operation");
  }
}

/**
 * Authorize one terminal through a local companion popup. HTTPS pages can use
 * postMessage without making insecure fetch/WebSocket requests themselves.
 * Only the exact popup, origin and one-time token can reach this session.
 */
export function connectTerminalAgent(session: TerminalSession, options: TerminalAgentOptions): Disposable {
  if (session.signal.aborted) throw new Error("Terminal access has ended");
  const view = session.terminal.element?.ownerDocument.defaultView;
  if (!view) throw new Error("Open the terminal in a browser before connecting an agent");
  if (!["read", "control"].includes(options.permission)) throw new TypeError("Choose read or control access");
  const remote = validateTerminalAgentPairing(options.pairingUrl, view.location.origin, options.relayUrl);
  if (remote) return connectRemoteAgent(session, options, remote);
  const url = new URL(options.pairingUrl);
  const params = new URLSearchParams(url.hash.slice(1));
  const token = params.get("token");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/pair" || url.username || url.password || url.search || !token || !/^[a-f0-9]{64}$/u.test(token) || params.get("origin") !== view.location.origin) {
    throw new Error("Use a pairing URL created for this page's exact origin by the local MCP companion");
  }
  if (!["read", "control"].includes(options.permission)) throw new TypeError("Choose read or control access");
  const popup = view.open(url.href, `shell-terminal-agent-${token.slice(0, 12)}`, "popup,width=440,height=340");
  if (!popup) throw new Error("Allow this page to open the local agent pairing window");
  const abort = new AbortController();
  const channel = "shell-terminal-mcp-v1";
  let disposed = false;
  let connected = false;
  let pending = 0;
  const send = (message: Record<string, unknown>) => popup.postMessage({ channel, token, ...message }, url.origin);
  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== popup || event.origin !== url.origin || !event.data || event.data.channel !== channel || event.data.token !== token) return;
    const message = event.data;
    if (message.type === "ready") {
      send({ type: "attach", sessionId: token.slice(0, 24), title: (options.title ?? session.terminal.core.title ?? "Browser terminal").slice(0, 256), permission: options.permission });
    } else if (message.type === "status") {
      connected = message.status === "connected";
      options.onStatus?.(connected ? "connected" : "disconnected", typeof message.detail === "string" ? message.detail.slice(0, 256) : undefined);
    } else if (message.type === "request" && typeof message.id === "string" && message.id.length <= 128) {
      if (pending >= 16) { send({ type: "response", id: message.id, error: "Too many pending terminal requests" }); return; }
      pending++;
      void handleTerminalAgentRequest(session, message.request, options.permission, abort.signal).then(
        result => { if (!disposed) send({ type: "response", id: message.id, result }); },
        error => { if (!disposed) send({ type: "response", id: message.id, error: error instanceof Error ? error.message : "Terminal request failed" }); },
      ).finally(() => pending--);
    }
  };
  view.addEventListener("message", receive);
  const timer = setInterval(() => { if (popup.closed) dispose(); }, 500);
  const timeout = setTimeout(() => { if (!connected) dispose("Pairing timed out. Create a fresh pairing URL and try again."); }, 30_000);
  const ended = () => dispose("Terminal session ended.");
  session.signal.addEventListener("abort", ended, { once: true });
  options.onStatus?.("connecting");
  function dispose(detail?: string) {
    if (disposed) return;
    disposed = true; abort.abort(); clearInterval(timer); clearTimeout(timeout);
    session.signal.removeEventListener("abort", ended);
    view!.removeEventListener("message", receive); popup!.close(); options.onStatus?.("disconnected", detail);
  }
  return { dispose };
}

export function connectRemoteAgent(session: TerminalSession, options: TerminalAgentOptions, pair: TerminalRelayPairing, connectionOptions: { onAuthenticated?: () => void; pairingTimeoutMs?: number } = {}): Disposable {
  if (session.signal.aborted) throw new Error("Terminal access has ended");
  if (!["read", "control"].includes(options.permission)) throw new TypeError("Choose read or control access");
  const abort = new AbortController(); let pending = 0, connected = false;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  const ended = () => connection.dispose();
  const connection = connectTerminalRelay({
    ...pair, ...connectionOptions, role: "browser",
    onPaired(channel) {
      void channel.send({ type: "attach", version: 1, permission: options.permission, title: (options.title ?? session.terminal.core.title ?? "Browser terminal").slice(0, 256), origin: pair.origin }).catch(() => {});
    },
    onMessage(value, channel) {
      if (!value || typeof value !== "object") { channel.dispose(); return; }
      const message = value as Record<string, unknown>;
      if (!connected) {
        if (message.type !== "ready" || message.version !== 1) { channel.dispose(); return; }
        connected = true; clearTimeout(handshake); options.onStatus?.("connected"); return;
      }
      if (message.type !== "request" || typeof message.id !== "string" || message.id.length > 128) { channel.dispose(); return; }
      if (pending >= 16) { void channel.send({ type: "response", id: message.id, error: "Too many pending terminal requests" }).catch(() => {}); return; }
      pending++;
      void handleTerminalAgentRequest(session, message.request as TerminalAgentRequest, options.permission, abort.signal).then(
        result => { if (!abort.signal.aborted) return channel.send({ type: "response", id: message.id, result }); },
        error => { if (!abort.signal.aborted) return channel.send({ type: "response", id: message.id, error: error instanceof Error ? error.message : "Terminal request failed" }); },
      ).catch(() => {}).finally(() => { pending--; });
    },
    onClose(detail) { clearTimeout(handshake); abort.abort(); session.signal.removeEventListener("abort", ended); options.onStatus?.("disconnected", detail); },
  });
  handshake = setTimeout(() => { connection.dispose(); }, (connectionOptions.pairingTimeoutMs ?? 125_000) + 5000);
  session.signal.addEventListener("abort", ended, { once: true });
  options.onStatus?.("connecting");
  return { dispose() { connection.dispose(); } };
}
