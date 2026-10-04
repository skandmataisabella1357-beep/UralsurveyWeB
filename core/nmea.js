'use strict';
// Разбор строки NMEA GGA: координаты, качество решения, число спутников.

const { D2R } = require('./geo');

function dm(value, hemi) {
  if (!value) return null;
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return null;
  const deg = Math.floor(v / 100);
  const out = deg + (v - deg * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -out : out;
}

function parseGga(line) {
  const f = line.slice(0, line.lastIndexOf('*')).split(',');
  if (!/^\$..GGA$/.test(f[0]) || f.length < 12) return null;
  const lat = dm(f[2], f[3]);
  const lon = dm(f[4], f[5]);
  const quality = parseInt(f[6], 10) || 0;
  if (lat === null || lon === null || quality === 0) return null;
  const msl = parseFloat(f[9]);
  const geoid = parseFloat(f[11]);
  return {
    lat: lat * D2R,
    lon: lon * D2R,
    // Высота над эллипсоидом = высота над геоидом + превышение геоида
    h: (Number.isFinite(msl) ? msl : 0) + (Number.isFinite(geoid) ? geoid : 0),
    quality,
    satCount: parseInt(f[7], 10) || 0,
  };
}

module.exports = { parseGga };
