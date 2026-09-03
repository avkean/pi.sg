import { recoverDenseWide } from './dense.mjs';

export function normalizeMixedUnicodePayload(input) {
  return recoverDenseWide(input);
}

export function unescapeMixedPayload(input) {
  if (typeof input !== 'string')
    throw new TypeError('Mixed payload must be a string');
  if (!input.includes('%')) return input;
  if (
    input.length > 8192 ||
    /[/?#\\]/.test(input) ||
    /%(?![A-Fa-f0-9]{2})/.test(input)
  )
    throw new Error('Invalid escaped mixed payload');
  const decoded = decodeURIComponent(input);
  if (!decoded || /[%/?#\\]/.test(decoded))
    throw new Error('Invalid escaped mixed payload');
  return decoded;
}
