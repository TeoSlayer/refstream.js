export interface Utf8State {
  point: number; needed: number; seen: number; lower: number; upper: number; bomSeen: boolean;
}

/** Stateful UTF-8 decoding whose incomplete code point can survive a snapshot. */
export class Utf8Decoder {
  state: Utf8State = { point: 0, needed: 0, seen: 0, lower: 0x80, upper: 0xbf, bomSeen: false };
  private complete = new TextDecoder("utf-8", { ignoreBOM: true });
  decode(bytes: Uint8Array): string {
    const state = this.state;
    let result = "";
    const emit = (point: number) => {
      if (point !== 0xfeff || state.bomSeen) result += String.fromCodePoint(point);
      state.bomSeen = true;
    };
    for (let index = 0; index < bytes.length; index++) {
      if (!state.needed && bytes.length - index > 64) {
        // The platform decoder is fast, but its hidden streaming state cannot
        // be snapshotted. Give it only complete sequences; retain the tail here.
        const end = completeEnd(bytes, index);
        let decoded = this.complete.decode(bytes.subarray(index, end));
        if (decoded) {
          if (!state.bomSeen && decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
          state.bomSeen = true; result += decoded;
        }
        index = end;
        if (index === bytes.length) break;
      }
      const byte = bytes[index];
      if (!state.needed) {
        if (byte < 0x80) { emit(byte); continue; }
        if (byte >= 0xc2 && byte <= 0xdf) { state.needed = 1; state.point = byte & 0x1f; }
        else if (byte >= 0xe0 && byte <= 0xef) {
          state.needed = 2; state.point = byte & 0x0f;
          if (byte === 0xe0) state.lower = 0xa0;
          if (byte === 0xed) state.upper = 0x9f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          state.needed = 3; state.point = byte & 0x07;
          if (byte === 0xf0) state.lower = 0x90;
          if (byte === 0xf4) state.upper = 0x8f;
        } else emit(0xfffd);
        continue;
      }
      if (byte < state.lower || byte > state.upper) {
        state.point = state.needed = state.seen = 0;
        state.lower = 0x80; state.upper = 0xbf;
        emit(0xfffd); index--; continue;
      }
      state.lower = 0x80; state.upper = 0xbf;
      state.point = (state.point << 6) | (byte & 0x3f);
      if (++state.seen === state.needed) {
        emit(state.point);
        state.point = state.needed = state.seen = 0;
      }
    }
    return result;
  }
}

/** Only a valid, incomplete final sequence belongs to the resumable tail. */
function completeEnd(bytes: Uint8Array, start: number): number {
  const end = bytes.length;
  let lead = end - 1;
  while (lead >= Math.max(start, end - 4) && bytes[lead] >= 0x80 && bytes[lead] <= 0xbf) lead--;
  if (lead < start || lead < end - 4) return end;
  const first = bytes[lead];
  const needed = first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : 0;
  const seen = end - lead - 1;
  if (!needed || seen >= needed) return end;
  const next = bytes[lead + 1];
  if (seen && ((first === 0xe0 && next < 0xa0) || (first === 0xed && next > 0x9f) || (first === 0xf0 && next < 0x90) || (first === 0xf4 && next > 0x8f))) return end;
  return lead;
}
