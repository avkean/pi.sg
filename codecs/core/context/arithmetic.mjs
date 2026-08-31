// Original implementation of the standard finite-precision arithmetic interval
// coder (E1/E2/E3 renormalization). No external source code copied.
const HALF = 0x80000000,
  QUARTER = 0x40000000,
  THREE_QUARTERS = 0xc0000000,
  MAX = 0xffffffff;
export class ArithmeticEncoder {
  constructor() {
    this.low = 0;
    this.high = MAX;
    this.pending = 0;
    this.bytes = [];
    this.byte = 0;
    this.bits = 0;
  }
  bit(b) {
    this.byte = this.byte * 2 + b;
    if (++this.bits === 8) {
      this.bytes.push(this.byte);
      this.byte = 0;
      this.bits = 0;
    }
  }
  emit(b) {
    this.bit(b);
    while (this.pending > 0) {
      this.bit(1 - b);
      this.pending--;
    }
  }
  write(lo, hi, total) {
    if (!(0 <= lo && lo < hi && hi <= total && total < 65536))
      throw Error('Invalid arithmetic frequency');
    const range = this.high - this.low + 1;
    this.high = this.low + Math.floor((range * hi) / total) - 1;
    this.low += Math.floor((range * lo) / total);
    while (true) {
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
    while (this.bits) this.bit(0);
    return Uint8Array.from(this.bytes);
  }
}
export class ArithmeticDecoder {
  constructor(bytes) {
    if (!bytes.length) throw Error('Empty arithmetic payload');
    this.bytes = bytes;
    this.position = 0;
    this.low = 0;
    this.high = MAX;
    this.value = 0;
    for (let i = 0; i < 32; i++) this.value = this.value * 2 + this.bit();
  }
  bit() {
    if (this.position > this.bytes.length * 8 + 32)
      throw Error('Truncated arithmetic payload');
    const i = this.position++;
    return i >= this.bytes.length * 8
      ? 0
      : (this.bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  target(total) {
    return Math.floor(
      ((this.value - this.low + 1) * total - 1) / (this.high - this.low + 1)
    );
  }
  consume(lo, hi, total) {
    const range = this.high - this.low + 1;
    this.high = this.low + Math.floor((range * hi) / total) - 1;
    this.low += Math.floor((range * lo) / total);
    while (true) {
      if (this.high < HALF) {
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
