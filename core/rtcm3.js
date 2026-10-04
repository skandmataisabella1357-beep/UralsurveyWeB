'use strict';
// Разбор сообщений RTCM 3: координаты станции, описания оборудования,
// наблюдения MSM и эфемериды GPS. На вход подаётся тело кадра без
// преамбулы и CRC (кадры выделяет core/stream.js).

const { BitReader } = require('./bits');

const CLIGHT = 299792458.0;
const RANGE_MS = CLIGHT * 0.001; // метров в одной световой миллисекунде

const P2_5 = 2 ** -5;
const P2_19 = 2 ** -19;
const P2_24 = 2 ** -24;
const P2_29 = 2 ** -29;
const P2_31 = 2 ** -31;
const P2_33 = 2 ** -33;
const P2_43 = 2 ** -43;
const P2_55 = 2 ** -55;

// Порядок совпадает с нумерацией MSM: 107x GPS, 108x ГЛОНАСС и так далее.
const SYSTEMS = [
  { key: 'GPS', letter: 'G', name: 'GPS' },
  { key: 'GLO', letter: 'R', name: 'ГЛОНАСС' },
  { key: 'GAL', letter: 'E', name: 'Galileo' },
  { key: 'SBS', letter: 'S', name: 'SBAS' },
  { key: 'QZS', letter: 'J', name: 'QZSS' },
  { key: 'BDS', letter: 'C', name: 'BeiDou' },
  { key: 'IRN', letter: 'I', name: 'NavIC' },
];

// Обозначения сигналов MSM (идентификаторы 1..32) в кодах RINEX.
/* eslint-disable */
const MSM_SIGNALS = {
  GPS: ['', '1C', '1P', '1W', '', '', '', '2C', '2P', '2W', '', '', '', '', '2S', '2L', '2X', '', '', '', '', '5I', '5Q', '5X', '', '', '', '', '', '1S', '1L', '1X'],
  GLO: ['', '1C', '1P', '', '', '', '', '2C', '2P', '', '3I', '3Q', '3X', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  GAL: ['', '1C', '1A', '1B', '1X', '1Z', '', '6C', '6A', '6B', '6X', '6Z', '', '7I', '7Q', '7X', '', '8I', '8Q', '8X', '', '5I', '5Q', '5X', '', '', '', '', '', '', '', ''],
  SBS: ['', '1C', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '5I', '5Q', '5X', '', '', '', '', '', '', '', ''],
  QZS: ['', '1C', '', '', '', '', '', '', '6S', '6L', '6X', '', '', '', '2S', '2L', '2X', '', '', '', '', '5I', '5Q', '5X', '', '', '', '', '', '1S', '1L', '1X'],
  BDS: ['', '2I', '2Q', '2X', '', '', '', '6I', '6Q', '6X', '', '', '', '7I', '7Q', '7X', '', '', '', '', '', '5D', '5P', '5X', '7D', '', '', '', '', '1D', '1P', '1X'],
  IRN: ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '5A', '', '', '', '', '', '', '', '', '', ''],
};
/* eslint-enable */

const EPHEMERIS_TYPES = { 1019: 'GPS', 1020: 'GLO', 1041: 'IRN', 1042: 'BDS', 1044: 'QZS', 1045: 'GAL', 1046: 'GAL' };

function isMsm(type) {
  if (type < 1071 || type > 1137) return false;
  const n = type % 10;
  return n >= 1 && n <= 7;
}

function msmInfo(type) {
  return { sys: SYSTEMS[Math.floor((type - 1071) / 10)], level: type % 10 };
}

function satLabel(sys, prn) {
  let n = prn;
  if (sys.key === 'SBS') n = prn + 19; // PRN 120 -> S20
  return sys.letter + String(n).padStart(2, '0');
}

function messageName(type) {
  if (isMsm(type)) {
    const { sys, level } = msmInfo(type);
    return `Наблюдения ${sys.name}, MSM${level}`;
  }
  switch (type) {
    case 1001: case 1002: case 1003: case 1004: return 'Наблюдения GPS (старый формат)';
    case 1005: return 'Координаты станции';
    case 1006: return 'Координаты станции и высота антенны';
    case 1007: return 'Тип антенны';
    case 1008: return 'Тип и серийный номер антенны';
    case 1009: case 1010: case 1011: case 1012: return 'Наблюдения ГЛОНАСС (старый формат)';
    case 1013: return 'Системные параметры';
    case 1019: return 'Эфемериды GPS';
    case 1020: return 'Эфемериды ГЛОНАСС';
    case 1029: return 'Текстовая строка';
    case 1033: return 'Тип приёмника и антенны';
    case 1041: return 'Эфемериды NavIC';
    case 1042: return 'Эфемериды BeiDou';
    case 1044: return 'Эфемериды QZSS';
    case 1045: return 'Эфемериды Galileo F/NAV';
    case 1046: return 'Эфемериды Galileo I/NAV';
    case 1230: return 'Кодовые задержки ГЛОНАСС';
    default:
      if (type >= 4001 && type <= 4095) return 'Фирменное сообщение производителя';
      if (type >= 1057 && type <= 1068) return 'Поправки SSR';
      return 'Прочее';
  }
}

// 1005 / 1006: координаты опорной точки антенны в ECEF
function decodeStationPosition(type, payload) {
  const r = new BitReader(payload);
  r.skip(12);
  const stationId = r.u(12);
  const itrfYear = r.u(6);
  r.skip(4); // признаки GPS, ГЛОНАСС, Galileo, опорной станции
  const x = r.s(38) * 1e-4;
  r.skip(2);
  const y = r.s(38) * 1e-4;
  r.skip(2);
  const z = r.s(38) * 1e-4;
  const antennaHeight = type === 1006 ? r.u(16) * 1e-4 : null;
  return { stationId, itrfYear, ecef: [x, y, z], antennaHeight };
}

// 1007 / 1008 / 1033: описания антенны и приёмника
function decodeDescriptors(type, payload) {
  const r = new BitReader(payload);
  r.skip(12);
  const out = { stationId: r.u(12) };
  out.antenna = r.str(r.u(8)).trim();
  r.skip(8); // номер установки антенны
  if (type >= 1008) out.antennaSerial = r.str(r.u(8)).trim();
  if (type === 1033) {
    out.receiver = r.str(r.u(8)).trim();
    out.firmware = r.str(r.u(8)).trim();
    out.receiverSerial = r.str(r.u(8)).trim();
  }
  return out;
}

// MSM1..MSM7. Возвращает список спутников с сигналами: отношение сигнал/шум
// и полную псевдодальность в метрах (где формат её содержит).
function decodeMsm(type, payload) {
  const { sys, level } = msmInfo(type);
  const r = new BitReader(payload);
  r.skip(12);
  const stationId = r.u(12);
  const epoch = r.u(30);
  const multiple = r.u(1) === 1;
  r.skip(3 + 7 + 2 + 2 + 1 + 3);

  const prns = [];
  for (let i = 1; i <= 64; i++) if (r.u(1)) prns.push(i);
  const sigIds = [];
  for (let i = 1; i <= 32; i++) if (r.u(1)) sigIds.push(i);
  const nsat = prns.length;
  const nsig = sigIds.length;
  if (nsat * nsig > 64) throw new RangeError('маска ячеек MSM больше 64 бит');
  const cellMask = [];
  let ncell = 0;
  for (let i = 0; i < nsat * nsig; i++) {
    const b = r.u(1);
    cellMask.push(b);
    ncell += b;
  }

  // Данные по спутникам: грубая дальность в целых и долях миллисекунды
  const roughInt = new Array(nsat).fill(null);
  const roughMod = new Array(nsat).fill(0);
  const extended = level === 5 || level === 7;
  if (level >= 4) for (let i = 0; i < nsat; i++) roughInt[i] = r.u(8);
  if (extended) r.skip(4 * nsat);
  for (let i = 0; i < nsat; i++) roughMod[i] = r.u(10);
  if (extended) r.skip(14 * nsat);

  // Данные по сигналам: поля идут блоками, каждое по всем ячейкам
  const hi = level >= 6;
  const finePr = new Array(ncell).fill(null);
  const cnr = new Array(ncell).fill(null);
  if (level !== 2) {
    const bits = hi ? 20 : 15;
    const invalid = -(2 ** (bits - 1));
    const scale = hi ? P2_29 : P2_24;
    for (let k = 0; k < ncell; k++) {
      const v = r.s(bits);
      finePr[k] = v === invalid ? null : v * scale;
    }
  }
  if (level !== 1) r.skip(((hi ? 24 : 22) + (hi ? 10 : 4) + 1) * ncell);
  if (level >= 4) {
    for (let k = 0; k < ncell; k++) {
      const v = r.u(hi ? 10 : 6);
      cnr[k] = v === 0 ? null : v * (hi ? 0.0625 : 1);
    }
  }

  const names = MSM_SIGNALS[sys.key];
  const sats = [];
  let k = 0;
  for (let i = 0; i < nsat; i++) {
    const signals = [];
    for (let j = 0; j < nsig; j++) {
      if (!cellMask[i * nsig + j]) continue;
      const id = sigIds[j];
      let pr = null;
      if (roughInt[i] !== null && roughInt[i] !== 255 && finePr[k] !== null) {
        pr = (roughInt[i] + roughMod[i] / 1024 + finePr[k]) * RANGE_MS;
      }
      signals.push({ id, code: names[id - 1] || `#${id}`, cnr: cnr[k], pr });
      k++;
    }
    if (signals.length) sats.push({ prn: prns[i], label: satLabel(sys, prns[i]), signals });
  }
  return { sys: sys.key, level, stationId, epoch, multiple, sats };
}

// 1001..1004 и 1009..1012: из старых сообщений берём только число спутников
function decodeLegacyObsHeader(type, payload) {
  const r = new BitReader(payload);
  r.skip(12);
  const stationId = r.u(12);
  r.skip(type <= 1004 ? 30 : 27);
  r.skip(1);
  return { sys: type <= 1004 ? 'GPS' : 'GLO', stationId, satCount: r.u(5) };
}

// 1019: эфемериды GPS в единицах СИ (углы в радианах)
function decodeGpsEphemeris(payload) {
  const r = new BitReader(payload);
  r.skip(12);
  const e = { prn: r.u(6), week: r.u(10), ura: r.u(4) };
  r.skip(2);
  e.idot = r.s(14) * P2_43 * Math.PI;
  e.iode = r.u(8);
  e.toc = r.u(16) * 16;
  e.af2 = r.s(8) * P2_55;
  e.af1 = r.s(16) * P2_43;
  e.af0 = r.s(22) * P2_31;
  e.iodc = r.u(10);
  e.crs = r.s(16) * P2_5;
  e.deln = r.s(16) * P2_43 * Math.PI;
  e.m0 = r.s(32) * P2_31 * Math.PI;
  e.cuc = r.s(16) * P2_29;
  e.ecc = r.u(32) * P2_33;
  e.cus = r.s(16) * P2_29;
  e.sqrtA = r.u(32) * P2_19;
  e.toe = r.u(16) * 16;
  e.cic = r.s(16) * P2_29;
  e.omega0 = r.s(32) * P2_31 * Math.PI;
  e.cis = r.s(16) * P2_29;
  e.i0 = r.s(32) * P2_31 * Math.PI;
  e.crc = r.s(16) * P2_5;
  e.omega = r.s(32) * P2_31 * Math.PI;
  e.omegaDot = r.s(24) * P2_43 * Math.PI;
  e.tgd = r.s(8) * P2_31;
  e.health = r.u(6);
  return e;
}

// Номер спутника из сообщения с эфемеридами любой системы
function ephemerisSat(type, payload) {
  const sysKey = EPHEMERIS_TYPES[type];
  const r = new BitReader(payload);
  r.skip(12);
  const prn = r.u(type === 1044 ? 4 : 6);
  const sys = SYSTEMS.find((s) => s.key === sysKey);
  return { sys: sysKey, prn, label: satLabel(sys, prn) };
}

module.exports = {
  CLIGHT,
  RANGE_MS,
  SYSTEMS,
  EPHEMERIS_TYPES,
  isMsm,
  msmInfo,
  satLabel,
  messageName,
  decodeStationPosition,
  decodeDescriptors,
  decodeMsm,
  decodeLegacyObsHeader,
  decodeGpsEphemeris,
  ephemerisSat,
};
