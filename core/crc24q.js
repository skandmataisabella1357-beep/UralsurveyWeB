'use strict';
// CRC-24Q (Qualcomm), контрольная сумма кадра RTCM 3.

const POLY = 0x1864cfb;
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 16;
  for (let j = 0; j < 8; j++) {
    crc <<= 1;
    if (crc & 0x1000000) crc ^= POLY;
  }
  TABLE[i] = crc & 0xffffff;
}

function crc24q(buf, start = 0, end = buf.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) & 0xffffff) ^ TABLE[((crc >>> 16) ^ buf[i]) & 0xff];
  }
  return crc;
}

module.exports = { crc24q };
