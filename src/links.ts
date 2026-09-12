import { safeHyperlink } from "./unicode.js";
import type { TerminalCore } from "./core.js";

export interface TerminalFileReference {
  /** Untrusted output, not permission to access a file. The host owns path resolution and authorization. */
  path: string;
  text: string;
  line?: number;
  column?: number;
  buffer: "normal" | "alternate";
  row: number;
  columnInBuffer: number;
  lineId: number;
}
export type DetectedTerminalLink = { start: number; end: number; text: string } & (
  { kind: "url"; url: string } | { kind: "file"; path: string; line?: number; column?: number }
);
export interface RenderedTerminalLink { key: string; url?: string; file?: TerminalFileReference; label: string }
export interface TerminalRowLink { start: number; end: number; target: RenderedTerminalLink }

const KNOWN_NAMES = new Set(["Makefile", "Dockerfile", "Containerfile", "LICENSE", "README", "Gemfile", "Procfile", "Cargo.lock"]);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function trimEnd(value: string): string {
  let text = value.replace(/[.,;!]+$/u, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1);
  }
  return text;
}

export function fileReference(value: string): { path: string; line?: number; column?: number } | undefined {
  if (!value || value.length > 2048 || UNSAFE_TEXT.test(value)) return;
  let path = value;
  let location: RegExpMatchArray | null = null;
  if (path.startsWith("file://")) {
    try {
      const url = new URL(path);
      if (url.protocol !== "file:" || url.hostname && url.hostname !== "localhost" || url.username || url.password || url.search) return;
      const hash = url.hash;
      if (hash && !/^#L\d+(?:C\d+)?$/u.test(hash)) return;
      path = decodeURIComponent(url.pathname);
      if (hash) path += hash;
    } catch { return; }
  } else if (/^[a-z][a-z\d+.-]*:\/\//iu.test(path)) return;
  location = path.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?|\((\d+),(\d+)\))$/u);
  if (location) path = path.slice(0, -location[0].length);
  else path = path.replace(/:$/u, "");
  if (!path || UNSAFE_TEXT.test(path) || path.includes("?") || path.includes("#") || path.startsWith("//") || path.startsWith("\\\\")) return;
  const pieces = path.split(/[\\/]/u);
  const basename = pieces[pieces.length - 1] ?? "";
  const hasName = /^(?:[\p{L}\p{N}_@+ -]+\.)+[\p{L}][\p{L}\p{N}_.+-]{0,15}$/u.test(basename) || /^\.[\p{L}\p{N}_.-]+$/u.test(basename) || KNOWN_NAMES.has(basename);
  const hasPath = /[\\/]/u.test(path) && !path.endsWith("/") && !path.endsWith("\\") && (hasName || Boolean(location) || /^(?:\/|\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/])/iu.test(path));
  if (!hasPath && !hasName) return;
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return;
  const line = location ? Number(location[1] ?? location[3] ?? location[5]) : undefined;
  const column = location && (location[2] ?? location[4] ?? location[6]) ? Number(location[2] ?? location[4] ?? location[6]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000) || column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 1_000_000)) return;
  return { path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

/** Bounded, local text detection. No resolution, network requests or filesystem access. Offsets are UTF-16. */
export function detectTerminalLinks(text: string, files = false): DetectedTerminalLink[] {
  if (text.length > 8192) return [];
  const links: DetectedTerminalLink[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
    const value = trimEnd(match[0]); const url = safeHyperlink(value);
    if (url) links.push({ start: match.index!, end: match.index! + value.length, text: value, kind: "url", url });
    if (links.length >= 32) break;
  }
  if (files && links.length < 32) {
    const pattern = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([^\s<>"'`\[\]{}|;]+))/gu;
    for (const match of text.matchAll(pattern)) {
      const quoted = match[1] ?? match[2] ?? match[3];
      let value = quoted ?? match[4];
      let start = match.index! + (quoted === undefined ? 0 : 1);
      if (quoted === undefined) {
        while (value.startsWith("(")) { value = value.slice(1); start++; }
        value = trimEnd(value);
      }
      if (!value || links.some(link => start < link.end && start + value.length > link.start)) continue;
      const reference = fileReference(value);
      if (!reference) continue;
      links.push({ start, end: start + value.length, text: value, kind: "file", ...reference });
      if (links.length >= 32) break;
    }
  }
  return links.sort((a, b) => a.start - b.start);
}

/** Cache whole wrapped lines, retaining only groups used in the current viewport. */
export class TerminalLinkCache {
  private cache = new Map<number, { signature: string; rows: Map<number, TerminalRowLink[]> }>();
  rows(core: TerminalCore, first: number, end: number, files: boolean, urls: boolean, canResolve?: (reference: Readonly<TerminalFileReference>) => boolean): Map<number, TerminalRowLink[]> {
    const result = new Map<number, TerminalRowLink[]>(); const retained = new Set<number>();
    if (!files && !urls) { this.cache.clear(); return result; }
    for (let row = first; row < end;) {
      let start = row; let last = row;
      while (start > 0 && core.getLine(start)?.isWrapped && row - start < 32) start--;
      while (last + 1 < core.length && core.getLine(last + 1)?.isWrapped && last - start < 32) last++;
      if (core.getLine(start)?.isWrapped || last - start >= 32) { row = last + 1; continue; }
      const lines = Array.from({ length: last - start + 1 }, (_, index) => core.getLine(start + index)!);
      const id = lines[0].id;
      const signature = `${core.type}:${core.cols}:${files}:${urls}:` + lines.map(line => `${line.id}.${line.version}`).join(",");
      retained.add(id);
      let cached = this.cache.get(id);
      if (!cached || cached.signature !== signature) {
        const text = lines.map(line => line.translateToString(false)).join("").trimEnd();
        const detected = files || text.includes("://") ? detectTerminalLinks(text, files) : [];
        let offset = 0;
        const cells: { from: number; to: number; lineId: number; row: number; column: number; width: number; explicit: boolean }[] = [];
        if (detected.length) for (const [index, line] of lines.entries()) for (let column = 0; column < core.cols; column++) {
          const cell = line.cells[column]; if (!cell.width) continue;
          const value = cell.text || " ";
          cells.push({ from: offset, to: offset + value.length, lineId: line.id, row: start + index, column, width: cell.width, explicit: Boolean(cell.attributes.link || cell.attributes.hidden) });
          offset += value.length;
        }
        const rows = new Map<number, TerminalRowLink[]>();
        for (const link of detected) {
          if (link.kind === "url" && !urls) continue;
          const matching = cells.filter(cell => cell.to > link.start && cell.from < link.end);
          if (!matching.length || matching.some(cell => cell.explicit)) continue;
          const firstCell = matching[0];
          const target: RenderedTerminalLink = { key: `${firstCell.lineId}:${firstCell.column}:${link.text}`, label: link.kind === "url" ? link.url : `Preview ${link.text}`,
            ...(link.kind === "url" ? { url: link.url } : { file: { path: link.path, text: link.text, line: link.line, column: link.column, buffer: core.type, row: firstCell.row, columnInBuffer: firstCell.column, lineId: firstCell.lineId } }) };
          if (target.file && canResolve) {
            try { if (canResolve(Object.freeze({ ...target.file })) !== true) continue; }
            catch { continue; }
          }
          for (const cell of matching) {
            const ranges = rows.get(cell.lineId) ?? []; const previous = ranges[ranges.length - 1];
            if (previous?.target === target && previous.end === cell.column) previous.end += cell.width;
            else ranges.push({ start: cell.column, end: cell.column + cell.width, target });
            rows.set(cell.lineId, ranges);
          }
        }
        cached = { signature, rows }; this.cache.set(id, cached);
      }
      for (const [lineId, ranges] of cached.rows) {
        for (const range of ranges) if (range.target.file) {
          const offset = lines.findIndex(line => line.id === range.target.file!.lineId);
          if (offset >= 0) range.target.file.row = start + offset;
        }
        result.set(lineId, ranges);
      }
      row = last + 1;
    }
    for (const id of this.cache.keys()) if (!retained.has(id)) this.cache.delete(id);
    return result;
  }
  clear(): void { this.cache.clear(); }
}
