'use strict';
// Упаковка и распаковка битовых полей RTCM для сервера: старший бит первым.
// В отличие от побитовых читателя и писателя ядра, здесь поле кладётся и берётся
// кусками до байта за шаг и без промежуточных массивов: служебные сообщения сервер
// собирает на ходу, и это не должно стоить заметного времени.
//
// Значения — обычные числа: поля RTCM не длиннее 38 бит, а double точно держит 53.

class BitPacker {
  // bits — длина сообщения в битах; она известна заранее по составу полей
  constructor(bits) {
    this.buf = Buffer.alloc((bits + 7) >> 3);
    this.pos = 0;
  }

  u(len, value) {
    const v = Math.round(value);
    if (!(v >= 0) || v >= 2 ** len) throw new RangeError(`значение ${value} не помещается в ${len} бит`);
    if (this.pos + len > this.buf.length * 8) throw new RangeError('сообщение длиннее, чем объявлено');
    let left = len;
    let pos = this.pos;
    while (left > 0) {
      const room = 8 - (pos & 7);
      const take = left < room ? left : room;
      // Старшие take бит из оставшихся left
      const part = Math.floor(v / 2 ** (left - take)) % 2 ** take;
      this.buf[pos >> 3] |= part << (room - take);
      pos += take;
      left -= take;
    }
    this.pos = pos;
    return this;
  }

  // Знаковое в дополнительном коде
  s(len, value) {
    const v = Math.round(value);
    if (v < -(2 ** (len - 1)) || v >= 2 ** (len - 1)) throw new RangeError(`значение ${value} не помещается в ${len} бит со знаком`);
    return this.u(len, v < 0 ? v + 2 ** len : v);
  }

  // Строка: по байту на знак, только латиница и цифры (ASCII)
  str(text) {
    for (let i = 0; i < text.length; i++) this.u(8, text.charCodeAt(i) & 0xff);
    return this;
  }
}

class BitUnpacker {
  constructor(buf, bitPos = 0) {
    this.buf = buf;
    this.pos = bitPos;
  }

  u(len) {
    if (this.pos + len > this.buf.length * 8) throw new RangeError('сообщение короче, чем требует его формат');
    let left = len;
    let pos = this.pos;
    let v = 0;
    while (left > 0) {
      const room = 8 - (pos & 7);
      const take = left < room ? left : room;
      const part = (this.buf[pos >> 3] >> (room - take)) & ((1 << take) - 1);
      v = v * 2 ** take + part;
      pos += take;
      left -= take;
    }
    this.pos = pos;
    return v;
  }

  s(len) {
    const v = this.u(len);
    return v >= 2 ** (len - 1) ? v - 2 ** len : v;
  }

  str(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += String.fromCharCode(this.u(8));
    return out;
  }
}

module.exports = { BitPacker, BitUnpacker };
