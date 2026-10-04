'use strict';
// Выделение кадров из входного потока байтов. Понимает RTCM 3 и NMEA,
// а также распознаёт (без разбора) сырые форматы u-blox, Septentrio и NovAtel,
// чтобы подсказать, что именно отдаёт приёмник.

const { crc24q } = require('./crc24q');

const MAX_NMEA = 100;
const MAX_UBX = 8192;

function nmeaChecksumOk(line) {
  const star = line.lastIndexOf('*');
  if (star < 0 || star + 3 !== line.length) return false;
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= line.charCodeAt(i);
  return sum === parseInt(line.slice(star + 1), 16);
}

class StreamParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.inSync = false;
    this.stats = {
      bytes: 0,
      rtcmFrames: 0,
      crcErrors: 0,
      nmeaLines: 0,
      ubxFrames: 0,
      sbfSync: 0,
      novatelSync: 0,
      junkBytes: 0,
    };
  }

  // Принимает очередную порцию байтов, возвращает найденные в ней кадры:
  // { kind: 'rtcm', type, payload } или { kind: 'nmea', line }
  push(chunk) {
    const out = [];
    const st = this.stats;
    st.bytes += chunk.length;
    const b = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const n = b.length;
    let p = 0;

    while (p < n) {
      const c = b[p];

      if (c === 0xd3) {
        if (n - p < 3) break;
        if ((b[p + 1] & 0xfc) === 0) {
          const len = ((b[p + 1] & 0x03) << 8) | b[p + 2];
          if (n - p < len + 6) break;
          const end = p + 3 + len;
          const crc = (b[end] << 16) | (b[end + 1] << 8) | b[end + 2];
          if (crc24q(b, p, end) === crc) {
            if (len >= 2) {
              out.push({
                kind: 'rtcm',
                type: (b[p + 3] << 4) | (b[p + 4] >> 4),
                payload: Buffer.from(b.subarray(p + 3, end)),
              });
              st.rtcmFrames++;
            }
            this.inSync = true;
            p = end + 3;
            continue;
          }
          // Сбой CRC считаем один раз на каждую потерю синхронизации
          if (this.inSync) {
            st.crcErrors++;
            this.inSync = false;
          }
        }
        p++;
        st.junkBytes++;
        continue;
      }

      if (c === 0x24) { // '$'
        if (n - p < 2) break;
        if (b[p + 1] === 0x40) { // "$@" — кадр SBF
          st.sbfSync++;
          p += 2;
          continue;
        }
        const nl = b.indexOf(0x0a, p);
        if (nl === -1) {
          if (n - p < MAX_NMEA) break;
        } else if (nl - p <= MAX_NMEA) {
          const line = b.toString('latin1', p, nl).trim();
          if (/^\$[A-Z]{2}[A-Z0-9]{3},/.test(line) && nmeaChecksumOk(line)) {
            out.push({ kind: 'nmea', line });
            st.nmeaLines++;
            p = nl + 1;
            continue;
          }
        }
        p++;
        st.junkBytes++;
        continue;
      }

      if (c === 0xb5) { // UBX: B5 62 class id len(2) payload ck_a ck_b
        if (n - p < 6) break;
        if (b[p + 1] === 0x62) {
          const len = b[p + 4] | (b[p + 5] << 8);
          if (len <= MAX_UBX) {
            if (n - p < len + 8) break;
            let a = 0;
            let k = 0;
            for (let i = p + 2; i < p + 6 + len; i++) {
              a = (a + b[i]) & 0xff;
              k = (k + a) & 0xff;
            }
            if (a === b[p + 6 + len] && k === b[p + 7 + len]) {
              st.ubxFrames++;
              p += len + 8;
              continue;
            }
          }
        }
        p++;
        st.junkBytes++;
        continue;
      }

      if (c === 0xaa) { // NovAtel: AA 44 12 (длинный заголовок) или AA 44 13
        if (n - p < 3) break;
        if (b[p + 1] === 0x44 && (b[p + 2] === 0x12 || b[p + 2] === 0x13)) st.novatelSync++;
        p++;
        st.junkBytes++;
        continue;
      }

      p++;
      st.junkBytes++;
    }

    this.buf = p < n ? Buffer.from(b.subarray(p)) : Buffer.alloc(0);
    return out;
  }

  // Вывод о формате потока по накопленной статистике
  format() {
    const st = this.stats;
    const parts = [];
    if (st.rtcmFrames >= 2) parts.push('RTCM 3');
    if (st.nmeaLines >= 2) parts.push('NMEA');
    if (parts.length) return { known: true, label: parts.join(' + ') };
    if (st.ubxFrames >= 2) return { known: false, label: 'u-blox UBX (сырой формат)' };
    if (st.sbfSync >= 5) return { known: false, label: 'похоже на Septentrio SBF' };
    if (st.novatelSync >= 5) return { known: false, label: 'похоже на NovAtel / Unicore' };
    if (st.bytes > 4096) return { known: false, label: 'формат не распознан' };
    return { known: false, label: st.bytes ? 'определяется…' : '—' };
  }

  reset() {
    this.buf = Buffer.alloc(0);
    this.inSync = false;
  }
}

module.exports = { StreamParser };
