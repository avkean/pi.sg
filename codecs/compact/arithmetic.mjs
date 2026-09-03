// Pi v1 integer intervals with a second, compact termination. The standard
// byte output stays identical, so both old and new links share one model pass.
import { bitsToBytes } from './frame.mjs';
const HALF = 0x80000000,
  QUARTER = 0x40000000,
  THREE_QUARTERS = 0xc0000000;
const metadata = new WeakMap();
export const describe = (bytes) => metadata.get(bytes);
export class ArithmeticDecoder {
  constructor(input) {
    const bytes = input instanceof Uint8Array ? input : null;
    const source = bytes ? null : input;
    if (bytes ? bytes.length > 6144 : typeof source?.bit !== 'function')
      throw new RangeError('Arithmetic input limit');
    this.bytes = bytes;
    this.source = source;
    this.position = 0;
    this.low = 0;
    this.high = 0xffffffff;
    this.value = 0;
    this.steps = 0;
    for (let i = 0; i < 32; i++) this.value = this.value * 2 + this.bit();
  }
  bit() {
    // A shortest dyadic point can need more than the old 32-bit zero suffix.
    // Bound total work, not the zero extension relative to transmitted length.
    if (this.position >= 65568) throw new RangeError('Arithmetic read limit');
    const i = this.position++;
    if (this.source) {
      const value = this.source.bit();
      if (value !== 0 && value !== 1)
        throw new Error('Invalid arithmetic bit source');
      return value;
    }
    return i >= this.bytes.length * 8
      ? 0
      : (this.bytes[i >>> 3] >>> (7 - (i & 7))) & 1;
  }
  target(total) {
    const value = Math.floor(
      ((this.value - this.low + 1) * total - 1) / (this.high - this.low + 1)
    );
    if (value < 0 || value >= total)
      throw new Error('Invalid arithmetic state');
    return value;
  }
  scaled(total = 65536) {
    return this.target(total);
  }
  take(start, frequency, total = 65536) {
    this.consume(start, start + frequency, total);
  }
  consume(lo, hi, total) {
    if (++this.steps > 32768) throw new RangeError('Arithmetic step limit');
    const range = this.high - this.low + 1;
    this.high = this.low + Math.floor((range * hi) / total) - 1;
    this.low += Math.floor((range * lo) / total);
    for (;;) {
      if (this.high < HALF) {
        /* lower half */
      } else if (this.low >= HALF) {
        this.low -= HALF;
        this.high -= HALF;
        this.value -= HALF;
      } else if (this.low >= QUARTER && this.high < THREE_QUARTERS) {
        this.low -= QUARTER;
        this.high -= QUARTER;
        this.value -= QUARTER;
      } else break;
      this.low *= 2;
      this.high = this.high * 2 + 1;
      this.value = this.value * 2 + this.bit();
    }
  }
}
export class ArithmeticEncoder {
  constructor(captureTrace = false) {
    this.low = 0;
    this.high = 0xffffffff;
    this.pending = 0;
    this.output = [];
    this.symbols = 0;
    this.shifts = 0;
    this.trace = captureTrace ? [] : null;
    this.source = null;
  }
  bind(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      this.symbols !== 0 ||
      this.source !== null
    )
      throw new Error('Invalid arithmetic source binding');
    let source = '';
    for (const byte of bytes) source += String.fromCharCode(byte);
    this.source = source;
  }
  emit(value) {
    this.output.push(value);
    while (this.pending > 0) {
      this.output.push(1 - value);
      this.pending--;
    }
    if (this.output.length > 65536)
      throw new RangeError('Arithmetic bit limit');
  }
  put(start, frequency, total = 65536) {
    this.write(start, start + frequency, total);
  }
  write(lo, hi, total) {
    if (
      ![lo, hi, total].every(Number.isInteger) ||
      lo < 0 ||
      hi <= lo ||
      hi > total ||
      total > 65536
    )
      throw new Error('Invalid frequency');
    this.trace?.push(lo, hi, total);
    if (++this.symbols > 32768) throw new RangeError('Arithmetic symbol limit');
    const range = this.high - this.low + 1;
    this.high = this.low + Math.floor((range * hi) / total) - 1;
    this.low += Math.floor((range * lo) / total);
    for (;;) {
      if (this.high < HALF) this.emit(0);
      else if (this.low >= HALF) {
        this.emit(1);
        this.low -= HALF;
        this.high -= HALF;
      } else if (this.low >= QUARTER && this.high < THREE_QUARTERS) {
        this.pending++;
        this.low -= QUARTER;
        this.high -= QUARTER;
      } else break;
      if (++this.shifts > 65536) throw new RangeError('Arithmetic shift limit');
      this.low *= 2;
      this.high = this.high * 2 + 1;
    }
  }
  finish() {
    // Reconstruct the finite dyadic interval by undoing all deferred E3 steps.
    // Bounds are capped above; BigInt work is confined to this finalizer.
    // All emitted prefix bits are fixed. Search only the deferred interval,
    // avoiding a whole-message BigInt and its quadratic accumulation cost.
    const prefix = this.output.slice();
    const tailWidth = this.pending + 32;
    const offset = ((1n << BigInt(this.pending)) - 1n) << 31n;
    const lower = offset + BigInt(this.low);
    const upper = offset + BigInt(this.high) + 1n;
    const point = (length) => {
      const step = 1n << BigInt(tailWidth - length);
      const q = (lower + step - 1n) / step;
      return { q, valid: q * step < upper };
    };
    let lo = 0,
      hi = tailWidth;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (point(mid).valid) hi = mid;
      else lo = mid + 1;
    }
    const terminalBits = prefix.concat(
      lo === 0 ? [] : [...point(lo).q.toString(2).padStart(lo, '0')].map(Number)
    );
    while (terminalBits.at(-1) === 0) terminalBits.pop();
    const interval = {
      prefix: Uint8Array.from(prefix),
      tailWidth,
      lower,
      upper,
      terminalBitLength: terminalBits.length
    };
    this.pending++;
    this.emit(this.low < QUARTER ? 0 : 1);
    const standardBits = this.output.slice(),
      bytes = bitsToBytes(standardBits),
      terminalBytes = bitsToBytes(terminalBits),
      description = {
        standard: { bytes, bitLength: standardBits.length },
        terminal: {
          bytes: terminalBytes,
          bitLength: terminalBits.length
        },
        interval,
        trace: this.trace && Uint32Array.from(this.trace),
        source: this.source
      };
    metadata.set(bytes, description);
    metadata.set(terminalBytes, description);
    return bytes;
  }
}
