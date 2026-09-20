/** Growable typed-array builders — conversion accumulates into these instead of JS number[] (≈2× less memory). */

export class Float32Builder {
  private buf: Float32Array;
  len = 0;

  constructor(initial = 1 << 14) {
    this.buf = new Float32Array(initial);
  }

  private ensure(extra: number): void {
    // Stryker disable next-line ConditionalExpression: </= boundary is behaviour-equivalent (growing early is harmless)
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(a: number, b: number, c: number): void {
    this.ensure(3);
    this.buf[this.len++] = a;
    this.buf[this.len++] = b;
    this.buf[this.len++] = c;
  }

  view(): Float32Array {
    return this.buf.subarray(0, this.len);
  }
}

export class Uint32Builder {
  private buf: Uint32Array;
  len = 0;

  constructor(initial = 1 << 13) {
    this.buf = new Uint32Array(initial);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  push(a: number): void {
    this.ensure(1);
    this.buf[this.len++] = a;
  }

  view(): Uint32Array {
    return this.buf.subarray(0, this.len);
  }
}
