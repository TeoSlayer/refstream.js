/* eslint-disable no-control-regex -- Hyperlinks reject embedded control characters. */
/*
 * A terminal's unit is a cell, not a UTF-16 code unit. Ambiguous-width text is
 * narrow; combining marks and emoji continuations attach to the preceding
 * cell. These decisions are deliberately independent of the DOM and font.
 * Reference: https://www.unicode.org/reports/tr11/
 */
const MARK = /\p{Mark}/u;
const EMOJI = /\p{Emoji_Presentation}/u;
const EMOJI_VARIATION = /\p{Emoji}\ufe0f/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const JOINABLE_EMOJI = /\p{Extended_Pictographic}[\p{Mark}\p{Emoji_Modifier}]*\u200d$/u;
const MODIFIER_BASE = /\p{Emoji_Modifier_Base}\ufe0f?$/u;
const REGIONAL = /^[\u{1f1e6}-\u{1f1ff}]$/u;

export function joinsCell(previous: string, next: string): boolean {
  const code = next.codePointAt(0)!;
  if (code < 0x7f) return false;
  return MARK.test(next) || code === 0x200c || code === 0x200d ||
    (code >= 0x1f3fb && code <= 0x1f3ff && MODIFIER_BASE.test(previous)) ||
    (JOINABLE_EMOJI.test(previous) && PICTOGRAPHIC.test(next)) ||
    (REGIONAL.test(previous) && REGIONAL.test(next)) ||
    (code >= 0xe0020 && code <= 0xe007f && PICTOGRAPHIC.test(previous));
}

export function cellWidth(text: string): 0 | 1 | 2 {
  const code = text.codePointAt(0) ?? 0;
  if (text.length === 1 && code >= 0x20 && code < 0x7f) return 1;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0) || MARK.test(String.fromCodePoint(code)) ||
      code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff ||
      (code >= 0xe0020 && code <= 0xe007f)) return 0;
  if (EMOJI_VARIATION.test(text) || EMOJI.test(text) ||
      code >= 0x1100 && (
        code <= 0x115f || code === 0x2329 || code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x16fe0 && code <= 0x18dff) || (code >= 0x1aff0 && code <= 0x1b2ff) ||
        (code >= 0x20000 && code <= 0x3fffd)
      )) return 2;
  return 1;
}

export function safeHyperlink(value: string): string | undefined {
  if (value.length > 2048 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return url.href;
    }
  } catch { /* terminal output cannot create relative or executable URLs */ }
  return undefined;
}
