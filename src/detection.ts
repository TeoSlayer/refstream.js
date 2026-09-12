import { validReference, type FileDescriptor, type FileSource } from "./types.js";

export interface FileMatch {
  start: number;
  end: number;
  text: string;
  file: FileDescriptor;
  line?: number;
  column?: number;
}

/** Match only registered references. UTF-16 offsets; at most 32 matches in 8 KiB of text. No I/O. */
export function detectFiles(text: string, source: FileSource): FileMatch[] {
  if (typeof text !== "string" || text.length > 8192) return [];
  const matches: FileMatch[] = [];
  const files = source.list().slice(0, 256).sort((a, b) => b.reference.length - a.reference.length);
  const boundary = (character: string | undefined) => character === undefined || /[\s<>"'`()[\]{}|;,!]/u.test(character);
  for (const file of files) {
    if (!validReference(file.reference) || !source.has(file.reference)) continue;
    let offset = 0;
    while (offset < text.length && matches.length < 32) {
      const start = text.indexOf(file.reference, offset); if (start < 0) break;
      let end = start + file.reference.length; offset = end;
      if (!boundary(text[start - 1])) continue;
      const location = text.slice(end).match(/^(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?|\((\d+),(\d+)\))/u);
      const line = location ? Number(location[1] ?? location[3] ?? location[5]) : undefined;
      const rawColumn = location && (location[2] ?? location[4] ?? location[6]);
      const column = rawColumn ? Number(rawColumn) : undefined;
      if (line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000) || column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 1_000_000)) continue;
      if (location) end += location[0].length;
      if (!boundary(text[end]) && !(text[end] === "." && boundary(text[end + 1])) && !(text[end] === ":" && boundary(text[end + 1]))) continue;
      if (matches.some(match => start < match.end && end > match.start)) continue;
      matches.push({ start, end, text: text.slice(start, end), file: { ...file }, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}
