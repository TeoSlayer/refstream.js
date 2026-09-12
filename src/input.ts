/* eslint-disable no-control-regex -- Paste must remove embedded terminal escapes. */
import type { TerminalModes } from "./core.js";

export interface TerminalKey {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  getModifierState?(key: string): boolean;
}

/** null means the browser/IME owns the key; an encoded string goes only to the PTY. */
export function encodeTerminalKey(event: TerminalKey, modes: TerminalModes): string | null {
  const { key, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: meta } = event;
  if (event.isComposing || key === "Process" || key === "Dead" || meta) return null;
  if (event.getModifierState?.("AltGraph")) return [...key].length === 1 ? key : null;
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const prefix = alt ? "\x1b" : "";
  if (modes.applicationKeypadMode && modifier === 1 && event.code?.startsWith("Numpad")) {
    const keypad: Record<string, string> = {
      Numpad0: "p", Numpad1: "q", Numpad2: "r", Numpad3: "s", Numpad4: "t",
      Numpad5: "u", Numpad6: "v", Numpad7: "w", Numpad8: "x", Numpad9: "y",
      NumpadDecimal: "n", NumpadAdd: "k", NumpadSubtract: "m", NumpadMultiply: "j",
      NumpadDivide: "o", NumpadEnter: "M", NumpadEqual: "X",
    };
    if (keypad[event.code]) return `\x1bO${keypad[event.code]}`;
  }
  const cursor: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
  if (cursor[key]) {
    return modifier > 1 ? `\x1b[1;${modifier}${cursor[key]}` : `\x1b${modes.applicationCursorKeysMode ? "O" : "["}${cursor[key]}`;
  }
  const tilde: Record<string, number> = {
    Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
    F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
  };
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier > 1 ? `;${modifier}` : ""}~`;
  if (/^F[1-4]$/u.test(key)) {
    const code = "PQRS"[Number(key.slice(1)) - 1];
    return modifier > 1 ? `\x1b[1;${modifier}${code}` : `\x1bO${code}`;
  }
  if (key === "Enter") return prefix + (modes.newlineMode ? "\r\n" : "\r");
  if (key === "Backspace") return prefix + (ctrl ? "\b" : "\x7f");
  if (key === "Tab") return shift ? "\x1b[Z" : prefix + "\t";
  if (key === "Escape") return "\x1b";
  if (ctrl) {
    if (/^[a-z]$/iu.test(key)) return prefix + String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
    const controls: Record<string, number> = {
      " ": 0, "@": 0, "`": 0, "2": 0, "[": 27, "3": 27, "\\": 28, "4": 28,
      "]": 29, "5": 29, "^": 30, "6": 30, "_": 31, "-": 31, "7": 31, "8": 127, "?": 127,
    };
    return controls[key] === undefined ? null : prefix + String.fromCharCode(controls[key]);
  }
  return [...key].length === 1 ? prefix + key : null;
}

export function encodeTerminalPaste(text: string, bracketed: boolean): string {
  // An embedded ESC could close bracketed paste and execute the remaining text.
  const clean = text.replace(/\x1b/gu, "").replace(/\r?\n/gu, "\r");
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean;
}

export interface TerminalMouse {
  kind: "down" | "up" | "move" | "wheel";
  button: number;
  x: number; y: number;
  shift?: boolean; alt?: boolean; ctrl?: boolean;
}

export function encodeTerminalMouse(event: TerminalMouse, modes: TerminalModes): { data: string; binary: boolean } | null {
  if (modes.mouseTrackingMode === "none" || event.x < 1 || event.y < 1) return null;
  if (modes.mouseTrackingMode === "x10" && event.kind !== "down") return null;
  if (event.kind === "move" && (modes.mouseTrackingMode === "vt200" ||
      (modes.mouseTrackingMode === "drag" && event.button === 3))) return null;
  let button = event.button;
  if (event.kind === "wheel") button += 64;
  if (event.kind === "move") button += 32;
  if (modes.mouseTrackingMode !== "x10") button += (event.shift ? 4 : 0) + (event.alt ? 8 : 0) + (event.ctrl ? 16 : 0);
  if (modes.sgrMouse) return { data: `\x1b[<${button};${event.x};${event.y}${event.kind === "up" ? "m" : "M"}`, binary: false };
  if (event.x > 223 || event.y > 223) return null;
  if (event.kind === "up") button = 3 + (button & 28);
  return { data: `\x1b[M${String.fromCharCode(32 + button, 32 + event.x, 32 + event.y)}`, binary: true };
}
