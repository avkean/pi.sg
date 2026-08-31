// Static integer arithmetic coding, E1/E2/E3 renormalization. Independent JS
// implementation; all products stay below 2^53. This module knows only symbols.
const HALF = 0x80000000;
const QUARTER = 0x40000000;
const THREE_QUARTERS = 0xc0000000;
const FULL = 0x100000000;

export class ArithmeticEncoder {
  constructor() {
    this.low = 0;
    this.high = FULL - 1;
    this.pending = 0;
    this.out = [];
    this.byte = 0;
    this.bits = 0;
    this.bitLength = 0;
  }
  bit(value) {
    this.byte = this.byte * 2 + value;
    this.bits++;
    this.bitLength++;
    if (this.bits === 8) {
      this.out.push(this.byte);
      this.byte = 0;
      this.bits = 0;
    }
  }
  emit(value) {
    this.bit(value);
    while (this.pending > 0) {
      this.bit(1 - value);
      this.pending--;
    }
  }
  put(start, frequency, total = 65536) {
    if (!(frequency > 0 && start >= 0 && start + frequency <= total))
      throw new Error('Invalid symbol interval');
    const range = this.high - this.low + 1;
    this.high =
      this.low + Math.floor((range * (start + frequency)) / total) - 1;
    this.low += Math.floor((range * start) / total);
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
      this.low *= 2;
      this.high = this.high * 2 + 1;
    }
  }
  finish() {
    this.pending++;
    this.emit(this.low < QUARTER ? 0 : 1);
    if (this.bits) this.out.push(this.byte * 2 ** (8 - this.bits));
    return Uint8Array.from(this.out);
  }
}

export class ArithmeticDecoder {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1)
      throw new Error('Empty arithmetic stream');
    this.bytes = bytes;
    this.pos = 0;
    this.low = 0;
    this.high = FULL - 1;
    this.code = 0;
    for (let i = 0; i < 32; i++) this.code = this.code * 2 + this.bit();
  }
  bit() {
    const p = this.pos++;
    // Arithmetic termination permits a zero tail; bounded output and canonical
    // stream validation belong to the caller, not an unbounded input read loop.
    if (p >= this.bytes.length * 8) return 0;
    return (this.bytes[p >>> 3] >>> (7 - (p & 7))) & 1;
  }
  scaled(total = 65536) {
    const result = Math.floor(
      ((this.code - this.low + 1) * total - 1) / (this.high - this.low + 1)
    );
    if (result < 0 || result >= total)
      throw new Error('Corrupt arithmetic state');
    return result;
  }
  take(start, frequency, total = 65536) {
    const range = this.high - this.low + 1;
    this.high =
      this.low + Math.floor((range * (start + frequency)) / total) - 1;
    this.low += Math.floor((range * start) / total);
    for (;;) {
      if (this.high < HALF) {
        /* low half */
      } else if (this.low >= HALF) {
        this.code -= HALF;
        this.low -= HALF;
        this.high -= HALF;
      } else if (this.low >= QUARTER && this.high < THREE_QUARTERS) {
        this.code -= QUARTER;
        this.low -= QUARTER;
        this.high -= QUARTER;
      } else break;
      this.low *= 2;
      this.high = this.high * 2 + 1;
      this.code = this.code * 2 + this.bit();
    }
  }
}
