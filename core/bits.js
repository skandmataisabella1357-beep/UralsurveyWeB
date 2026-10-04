'use strict';
// Битовые поля RTCM: старший бит первым. Арифметика на числах double,
// поэтому поля до 53 бит читаются без потери точности (в RTCM максимум 38).

class BitReader {
  constructor(buf, bitPos = 0) {
    this.buf = buf;
    this.pos = bitPos;
    this.end = buf.length * 8;
  }

  u(len) {
    if (this.pos + len > this.end) {
      throw new RangeError('сообщение короче, чем требует его формат');
    }
    const buf = this.buf;
    let p = this.pos;
    let v = 0;
    for (let i = 0; i < len; i++, p++) {
      v = v * 2 + ((buf[p >> 3] >> (7 - (p & 7))) & 1);
    }
    this.pos = p;
    return v;
  }

  // Знаковое в дополнительном коде
  s(len) {
    const v = this.u(len);
    return v >= 2 ** (len - 1) ? v - 2 ** len : v;
  }

  skip(len) {
    if (this.pos + len > this.end) {
      throw new RangeError('сообщение короче, чем требует его формат');
    }
    this.pos += len;
  }

  // Строка из n байт (поля-описатели антенны и приёмника)
  str(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += String.fromCharCode(this.u(8));
    return out;
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.pos = 0;
  }

  u(len, value) {
    let v = Math.round(value);
    if (v < 0 || v >= 2 ** len) throw new RangeError(`значение ${value} не помещается в ${len} бит`);
    for (let i = len - 1; i >= 0; i--) {
      const bit = Math.floor(v / 2 ** i) % 2;
      const byte = this.pos >> 3;
      if (byte >= this.bytes.length) this.bytes.push(0);
      if (bit) this.bytes[byte] |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
    return this;
  }

  s(len, value) {
    const v = Math.round(value);
    return this.u(len, v < 0 ? v + 2 ** len : v);
  }

  str(text) {
    for (let i = 0; i < text.length; i++) this.u(8, text.charCodeAt(i) & 0xff);
    return this;
  }

  toBuffer() {
    return Buffer.from(this.bytes);
  }
}

module.exports = { BitReader, BitWriter };
