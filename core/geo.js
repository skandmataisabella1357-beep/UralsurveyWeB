'use strict';
// Геодезические преобразования на эллипсоиде WGS84.

const RE = 6378137.0;
const FE = 1 / 298.257223563;
const E2 = FE * (2 - FE);
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ECEF (м) -> широта, долгота (рад), высота над эллипсоидом (м)
function ecefToLlh(x, y, z) {
  const r2 = x * x + y * y;
  let zz = z;
  let zk = 0;
  let v = RE;
  for (let i = 0; i < 20 && Math.abs(zz - zk) >= 1e-4; i++) {
    zk = zz;
    const sinp = zz / Math.sqrt(r2 + zz * zz);
    v = RE / Math.sqrt(1 - E2 * sinp * sinp);
    zz = z + v * E2 * sinp;
  }
  const lat = r2 > 1e-12 ? Math.atan(zz / Math.sqrt(r2)) : (z > 0 ? Math.PI / 2 : -Math.PI / 2);
  const lon = r2 > 1e-12 ? Math.atan2(y, x) : 0;
  const h = Math.sqrt(r2 + zz * zz) - v;
  return { lat, lon, h };
}

function llhToEcef(lat, lon, h) {
  const sinp = Math.sin(lat);
  const cosp = Math.cos(lat);
  const v = RE / Math.sqrt(1 - E2 * sinp * sinp);
  return [
    (v + h) * cosp * Math.cos(lon),
    (v + h) * cosp * Math.sin(lon),
    (v * (1 - E2) + h) * sinp,
  ];
}

// Вектор ECEF -> локальная система «восток, север, верх» в точке (lat, lon)
function ecefToEnu(lat, lon, d) {
  const sinp = Math.sin(lat);
  const cosp = Math.cos(lat);
  const sinl = Math.sin(lon);
  const cosl = Math.cos(lon);
  return [
    -sinl * d[0] + cosl * d[1],
    -sinp * cosl * d[0] - sinp * sinl * d[1] + cosp * d[2],
    cosp * cosl * d[0] + cosp * sinl * d[1] + sinp * d[2],
  ];
}

module.exports = { RE, FE, D2R, R2D, ecefToLlh, llhToEcef, ecefToEnu };
