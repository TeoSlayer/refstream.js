import type { Disposable } from "./types.js";

export const defaultTerminalRelay = "https://mcp.shell.online";
export const terminalRelayMaxFrame = 2 * 1024 * 1024;
const hex = /^[a-f0-9]{64}$/u;
const roomPattern = /^[a-f0-9]{24}$/u;
const encoder = new TextEncoder();

/** Relays use an origin, never credentials, query parameters or an arbitrary endpoint. */
export function normalizeTerminalRelay(value: string): string {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error("Enter an HTTPS relay URL, such as https://mcp.shell.online");
  let url: URL; try { url = new URL(value); } catch { throw new Error("Enter a valid HTTPS relay URL"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use an HTTPS relay origin, or HTTP on localhost for development");
  return url.origin;
}
export interface TerminalRelayPairing { relayUrl: string; id: string; token: string; key: string; origin: string }
const invitationPrefix = "shell-invite-v1.";

/** An invitation is deliberately not a web URL, so previews cannot fetch its secrets. */
export function encodeTerminalAgentInvitation(pair: TerminalRelayPairing): string {
  const value = JSON.stringify([pair.relayUrl, pair.id, pair.token, pair.key, pair.origin]);
  const token = invitationPrefix + btoa(String.fromCharCode(...encoder.encode(value))).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  parseTerminalAgentInvitation(token);
  return token;
}

export function parseTerminalAgentInvitation(value: string): TerminalRelayPairing {
  if (typeof value !== "string" || value.length > 8192 || !value.startsWith(invitationPrefix) || !/^[A-Za-z0-9_-]+$/u.test(value.slice(invitationPrefix.length))) throw new Error("Invalid invitation. Copy a fresh invitation from the terminal.");
  try {
    const encoded = value.slice(invitationPrefix.length).replace(/-/gu, "+").replace(/_/gu, "/");
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))));
    if (!Array.isArray(data) || data.length !== 5 || data.some(item => typeof item !== "string")) throw new Error();
    const [relay, id, token, key, origin] = data as string[];
    const relayUrl = normalizeTerminalRelay(relay);
    if (relayUrl !== relay || !roomPattern.test(id) || !hex.test(token) || !hex.test(key) || normalizeTerminalRelay(origin) !== origin) throw new Error();
    return { relayUrl, id, token, key, origin };
  } catch { throw new Error("Invalid invitation. Copy a fresh invitation from the terminal."); }
}
export function parseTerminalRelayPairing(value: string, expectedOrigin?: string, expectedRelay?: string): TerminalRelayPairing {
  if (value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error("Use the complete pairing URL supplied by your agent");
  let url: URL; try { url = new URL(value); } catch { throw new Error("Use the complete pairing URL supplied by your agent"); }
  const params = new URLSearchParams(url.hash.slice(1));
  if (url.pathname !== "/pair" || url.username || url.password || url.search || params.get("v") !== "1" || [...params.keys()].length !== 5 || new Set(params.keys()).size !== 5) throw new Error("Use the complete pairing URL supplied by your agent");
  const relayUrl = normalizeTerminalRelay(url.origin);
  const id = params.get("room") ?? "", token = params.get("token") ?? "", key = params.get("key") ?? "", origin = params.get("origin") ?? "";
  if (!roomPattern.test(id) || !hex.test(token) || !hex.test(key) || normalizeTerminalRelay(origin) !== origin) throw new Error("Invalid pairing URL. Ask your agent for a new one.");
  if (expectedOrigin && origin !== expectedOrigin) throw new Error("This pairing belongs to a different website. Ask your agent to pair with this page's origin.");
  if (expectedRelay && relayUrl !== normalizeTerminalRelay(expectedRelay)) throw new Error("The pairing URL uses a different relay. Select that relay first.");
  return { relayUrl, id, token, key, origin };
}

/** HKDF-separated AES-GCM directions. The PSK is created by a client and never sent to the relay. */
export async function createTerminalRelayCipher(keyHex: string, id: string, origin: string, role: "agent" | "browser") {
  if (!hex.test(keyHex) || !roomPattern.test(id) || !["agent", "browser"].includes(role)) throw new Error("Invalid relay encryption parameters");
  const raw = Uint8Array.from(keyHex.match(/../gu)!, byte => parseInt(byte, 16));
  const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]); raw.fill(0);
  const context = `shell-terminal-relay-v1\n${id}\n${origin}`;
  const derive = (sender: string) => crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(context), info: encoder.encode(`sender:${sender}`) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const sending = await derive(role), receiving = await derive(role === "agent" ? "browser" : "agent");
  let sent = 0n, received = 0n;
  return {
    async encode(value: unknown): Promise<ArrayBuffer> {
      const plain = encoder.encode(JSON.stringify(value));
      if (plain.byteLength > terminalRelayMaxFrame - 25 || sent >= 0xffff_ffff_ffff_ffffn) throw new Error("Relay message too large");
      const header = new Uint8Array(9); header[0] = 1; new DataView(header.buffer).setBigUint64(1, ++sent);
      const iv = new Uint8Array(12); iv.set(header.subarray(1), 4);
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header, tagLength: 128 }, sending, plain);
      const frame = new Uint8Array(header.length + encrypted.byteLength); frame.set(header); frame.set(new Uint8Array(encrypted), 9); return frame.buffer;
    },
    async decode(frame: ArrayBuffer): Promise<unknown> {
      if (!(frame instanceof ArrayBuffer) || frame.byteLength < 25 || frame.byteLength > terminalRelayMaxFrame) throw new Error("Invalid encrypted relay message");
      const bytes = new Uint8Array(frame), sequence = new DataView(frame).getBigUint64(1);
      if (bytes[0] !== 1 || sequence !== received + 1n) throw new Error("Relay message was replayed or reordered");
      const iv = new Uint8Array(12); iv.set(bytes.subarray(1, 9), 4);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: bytes.subarray(0, 9), tagLength: 128 }, receiving, bytes.subarray(9));
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)); received = sequence; return value;
    },
  };
}

export interface TerminalRelayConnection extends Disposable { send(value: unknown): Promise<void> }
export interface TerminalRelayConnectionOptions extends TerminalRelayPairing {
  role: "agent" | "browser";
  /** Browser invitations can wait up to five minutes for the agent to join. */
  pairingTimeoutMs?: number;
  /** The browser uses native WebSocket. Node adapters can supply a compatible constructor. */
  createWebSocket?(url: string): WebSocket;
  onAuthenticated?(): void;
  onPaired(connection: TerminalRelayConnection): void;
  onMessage(value: unknown, connection: TerminalRelayConnection): void;
  onClose(detail: string): void;
}

/** A single-use connection. Re-pair after disconnect; this never resumes nonce counters with an old key. */
export function connectTerminalRelay(options: TerminalRelayConnectionOptions): TerminalRelayConnection {
  const relay = normalizeTerminalRelay(options.relayUrl);
  if (!roomPattern.test(options.id) || !hex.test(options.token) || !hex.test(options.key)) throw new Error("Invalid relay pairing");
  const ws = (options.createWebSocket ?? (url => new WebSocket(url)))(`${relay.replace(/^http/u, "ws")}/v1/sessions/${options.id}`);
  ws.binaryType = "arraybuffer";
  const cipher = createTerminalRelayCipher(options.key, options.id, options.origin, options.role);
  let closed = false, paired = false, queuedBytes = 0, queuedFrames = 0, queuedSends = 0;
  let receiving = Promise.resolve(), sending = Promise.resolve();
  const timeout = setTimeout(() => close("Invitation expired. Copy a new invitation to connect."), Math.max(1000, Math.min(options.pairingTimeoutMs ?? 125_000, 305_000)));
  const api: TerminalRelayConnection = {
    send(value) {
      if (closed || !paired) return Promise.reject(new Error("Relay is disconnected"));
      if (++queuedSends > 16) { queuedSends--; close("Too many pending relay messages"); return Promise.reject(new Error("Too many pending relay messages")); }
      const next = sending.then(async () => {
        const frame = await (await cipher).encode(value);
        if (closed || ws.readyState !== 1) throw new Error("Relay is disconnected");
        if (ws.bufferedAmount + frame.byteLength > 4 * 1024 * 1024) throw new Error("Relay is too slow. Pair again when the connection improves.");
        ws.send(frame);
      });
      sending = next.catch(() => { close("Relay delivery failed. Read the terminal state before retrying input."); }).finally(() => { queuedSends--; });
      return next;
    },
    dispose() { close("Agent disconnected. Your shell is still running."); },
  };
  function close(detail: string) {
    if (closed) return; closed = true; clearTimeout(timeout);
    ws.removeEventListener("open", opened); ws.removeEventListener("message", message);
    // Node WebSockets emit an error when cancelled during connection. Keep the
    // error handler until the socket closes, so Stop agent cannot crash the companion.
    if (ws.readyState === 3) { ws.removeEventListener("close", ended); ws.removeEventListener("error", failed); }
    // Do not echo untrusted remote close reasons into the UI.
    if (ws.readyState < 2) ws.close(1000, "Pairing ended");
    options.onClose(detail);
  }
  function opened() { if (!closed) ws.send(JSON.stringify({ type: "auth", version: 1, role: options.role, token: options.token })); }
  function ended() {
    ws.removeEventListener("close", ended); ws.removeEventListener("error", failed);
    close("Agent disconnected or invitation expired. Your shell is still running. Copy a new invitation to reconnect.");
  }
  function failed() { close("Cannot reach the relay. Check the relay URL and your connection, then pair again."); }
  function message(event: MessageEvent) {
    if (closed) return;
    const data: unknown = event.data;
    if (typeof data === "string") {
      try {
        if (data.length > 128) throw new Error(); const control = JSON.parse(data);
        if (control.version !== 1 || !["paired", "waiting"].includes(control.type) || paired) throw new Error();
        options.onAuthenticated?.();
        if (control.type === "paired") { paired = true; clearTimeout(timeout); options.onPaired(api); }
      } catch { close("Invalid relay handshake. Copy a new invitation to reconnect."); }
      return;
    }
    if (!paired || !(data instanceof ArrayBuffer) || data.byteLength > terminalRelayMaxFrame || ++queuedFrames > 16 || (queuedBytes += data.byteLength) > 4 * 1024 * 1024) { close("Relay traffic limit reached"); return; }
    receiving = receiving.then(async () => {
      const value = await (await cipher).decode(data);
      if (!closed) options.onMessage(value, api);
    }).catch(() => { close("Encrypted relay verification failed. Copy a new invitation to reconnect."); }).finally(() => { queuedFrames--; queuedBytes -= data.byteLength; });
  }
  ws.addEventListener("open", opened); ws.addEventListener("message", message); ws.addEventListener("close", ended); ws.addEventListener("error", failed);
  void cipher.catch(() => { close("This browser needs Web Crypto in a secure HTTPS context to pair."); });
  return api;
}
