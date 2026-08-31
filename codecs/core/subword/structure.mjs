// Exact byte inspection, never URL parsing or normalization. The state selects
// a token distribution; it does not change, remove, or reconstruct any bytes.
export const CONTEXT_COUNT = 18;
export function initialState() {
  return { phase: 0, scheme: 0, previous: 0 };
}
function kind(byte) {
  if (byte >= 48 && byte <= 57) return 2;
  if ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte >= 128)
    return 1;
  return 0;
}
export function context(state) {
  return state.phase * 3 + state.previous;
}
export function advance(state, bytes, from = 0, to = bytes.length) {
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    if (state.phase === 0) {
      if (b === 58) state.scheme = 1;
      else if (b === 47 && state.scheme === 1) state.scheme = 2;
      else if (b === 47 && state.scheme === 2) {
        state.phase = 1;
        state.scheme = 0;
      } else state.scheme = 0;
    } else if (state.phase < 5 && b === 35) state.phase = 5;
    else if (state.phase === 1 && b === 47) state.phase = 2;
    else if ((state.phase === 1 || state.phase === 2) && b === 63)
      state.phase = 3;
    else if (state.phase === 3 && b === 61) state.phase = 4;
    else if (state.phase === 4 && b === 38) state.phase = 3;
    state.previous = kind(b);
  }
  return state;
}
export function byteContexts(bytes) {
  const state = initialState(),
    contexts = new Uint8Array(bytes.length + 1);
  for (let i = 0; i < bytes.length; i++) {
    contexts[i] = context(state);
    advance(state, bytes, i, i + 1);
  }
  contexts[bytes.length] = context(state);
  return contexts;
}
