import type { ReadableBuffer } from "./types.js";

export interface TerminalMatch {
  row: number;
  column: number;
  length: number;
  preview: string;
}

/**
 * Streaming literal search, including soft wraps, wide cells and combining
 * characters. KMP keeps both running time and scratch memory bounded, even for
 * one enormous logical line. No regular expression comes from terminal input.
 */
export function findInTerminal(
  buffer: ReadableBuffer,
  cols: number,
  query: string,
  caseSensitive = false,
  limit = 1000,
): TerminalMatch[] {
  if (!query || query.length > 512 || limit < 1) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const prefix = Array<number>(needle.length).fill(0);
  for (let index = 1, length = 0; index < needle.length; index++) {
    while (length && needle[index] !== needle[length]) length = prefix[length - 1];
    if (needle[index] === needle[length]) length++;
    prefix[index] = length;
  }
  const positions = Array<number>(needle.length);
  const ends = Array<number>(needle.length);
  const matches: TerminalMatch[] = [];
  let matched = 0;
  let processed = 0;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (!line.isWrapped) matched = 0;
    let end = line.length;
    if (!buffer.getLine(row + 1)?.isWrapped) {
      while (end > 0) {
        const cell = line.getCell(end - 1);
        if (cell?.getChars() || cell?.getWidth() === 0) break;
        end--;
      }
    }
    for (let col = 0; col < end; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) continue;
      const text = cell.getChars() || " ";
      const normalized = caseSensitive ? text : text.toLowerCase();
      for (let unit = 0; unit < normalized.length; unit++) {
        const slot = processed % needle.length;
        positions[slot] = row * cols + col;
        ends[slot] = row * cols + col + cell.getWidth();
        const character = normalized[unit];
        while (matched && character !== needle[matched]) matched = prefix[matched - 1];
        if (character === needle[matched]) matched++;
        if (matched === needle.length) {
          const start = positions[(processed + 1 - needle.length) % needle.length];
          const startRow = Math.floor(start / cols);
          matches.push({
            row: startRow, column: start % cols, length: ends[slot] - start,
            preview: buffer.getLine(startRow)?.translateToString(true) ?? "",
          });
          if (matches.length >= limit) return matches;
          matched = prefix[matched - 1];
        }
        processed++;
      }
    }
  }
  return matches;
}

/** A deliberate local export of retained output; soft wraps become one logical line. */
export function terminalTranscript(buffer: ReadableBuffer): string {
  let last = buffer.length - 1;
  while (last >= 0 && !buffer.getLine(last)?.translateToString(true)) last--;
  let text = "";
  for (let row = 0; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row > 0 && !line.isWrapped) text += "\n";
    text += line.translateToString(!buffer.getLine(row + 1)?.isWrapped);
  }
  return text ? `${text}\n` : "";
}
