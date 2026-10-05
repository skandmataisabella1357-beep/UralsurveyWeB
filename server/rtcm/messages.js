'use strict';
// Служебные сообщения RTCM 3, которые сервер формирует сам: координаты базы (1005, 1006),
// описание оборудования (1007, 1008, 1033), кодовые задержки ГЛОНАСС (1230) и пересчёт
// координат (1021, 1025). Для каждого сообщения есть пара: собрать из полей и разобрать
// в те же поля. Разбор нужен, чтобы повторить нынешнее содержимое потоков точка в точку.
//
// Состав и разрядность полей — по открытому описанию сообщений (библиотека pyrtcm);
// собранные кадры сверены с её разбором, см. test/rtcm-encode.test.js.

const { crc24q } = require('../../core/crc24q');
const { BitPacker, BitUnpacker } = require('./bitpack');

// Кадр: преамбула 0xD3, длина (10 бит), тело, контрольная сумма CRC-24Q
function frame(payload) {
  if (payload.length > 1023) throw new RangeError('тело сообщения RTCM длиннее 1023 байт');
  const out = Buffer.allocUnsafe(payload.length + 6);
  out[0] = 0xd3;
  out[1] = payload.length >> 8;
  out[2] = payload.length & 0xff;
  payload.copy(out, 3);
  writeCrc(out);
  return out;
}

function writeCrc(buf) {
  const end = buf.length - 3;
  const crc = crc24q(buf, 0, end);
  buf[end] = crc >> 16;
  buf[end + 1] = (crc >> 8) & 0xff;
  buf[end + 2] = crc & 0xff;
}

function checkStation(id) {
  if (!Number.isInteger(id) || id < 0 || id > 4095) throw new RangeError('номер станции — целое число от 0 до 4095');
}

function checkText(text, name) {
  if (typeof text !== 'string' || text.length > 31 || /[^\x20-\x7e]/.test(text)) {
    throw new RangeError(`${name}: до 31 знака, только латиница, цифры и знаки ASCII`);
  }
}

// ---------- 1005 и 1006: координаты опорной точки антенны ----------
// Координаты — X, Y, Z в метрах, в потоке с шагом 0,1 мм.
// flags повторяют служебные признаки сообщения; по умолчанию — как у действующих потоков.

const POSITION_DEFAULTS = {
  itrfYear: 0, gps: 1, glonass: 1, galileo: 1, referenceStation: 0, singleOscillator: 0, reserved: 0, quarterCycle: 0,
};

function encodePosition({ stationId, ecef, antennaHeight = null, ...flags }) {
  checkStation(stationId);
  const f = { ...POSITION_DEFAULTS, ...flags };
  const withHeight = antennaHeight !== null && antennaHeight !== undefined;
  const w = new BitPacker(withHeight ? 168 : 152);
  w.u(12, withHeight ? 1006 : 1005).u(12, stationId).u(6, f.itrfYear);
  w.u(1, f.gps).u(1, f.glonass).u(1, f.galileo).u(1, f.referenceStation);
  w.s(38, ecef[0] * 1e4).u(1, f.singleOscillator).u(1, f.reserved);
  w.s(38, ecef[1] * 1e4).u(2, f.quarterCycle);
  w.s(38, ecef[2] * 1e4);
  if (withHeight) w.u(16, antennaHeight * 1e4);
  return frame(w.buf);
}

// payload — тело кадра без преамбулы и контрольной суммы
function decodePosition(payload) {
  const r = new BitUnpacker(payload);
  const type = r.u(12);
  if (type !== 1005 && type !== 1006) throw new Error(`это сообщение ${type}, а не 1005 или 1006`);
  const out = { type, stationId: r.u(12), itrfYear: r.u(6), gps: r.u(1), glonass: r.u(1), galileo: r.u(1), referenceStation: r.u(1) };
  const x = r.s(38);
  out.singleOscillator = r.u(1);
  out.reserved = r.u(1);
  const y = r.s(38);
  out.quarterCycle = r.u(2);
  const z = r.s(38);
  // Целые десятые доли миллиметра хранятся без потерь; метры получаются делением
  out.ecef = [x / 1e4, y / 1e4, z / 1e4];
  out.antennaHeight = type === 1006 ? r.u(16) / 1e4 : null;
  return out;
}

// ---------- 1007, 1008, 1033: антенна и приёмник ----------

function encodeDescriptor({ type = 1033, stationId, antenna = '', setupId = 0, antennaSerial = '', receiver = '', firmware = '', receiverSerial = '' }) {
  if (![1007, 1008, 1033].includes(type)) throw new RangeError('описание оборудования — сообщение 1007, 1008 или 1033');
  checkStation(stationId);
  const texts = [antenna];
  if (type >= 1008) texts.push(antennaSerial);
  if (type === 1033) texts.push(receiver, firmware, receiverSerial);
  texts.forEach((t, i) => checkText(t, ['тип антенны', 'номер антенны', 'тип приёмника', 'версия прошивки', 'номер приёмника'][i]));
  const bits = 24 + 8 + texts.reduce((sum, t) => sum + 8 + t.length * 8, 0);
  const w = new BitPacker(bits);
  w.u(12, type).u(12, stationId);
  w.u(8, antenna.length).str(antenna).u(8, setupId);
  for (const t of texts.slice(1)) w.u(8, t.length).str(t);
  return frame(w.buf);
}

function decodeDescriptor(payload) {
  const r = new BitUnpacker(payload);
  const type = r.u(12);
  if (![1007, 1008, 1033].includes(type)) throw new Error(`это сообщение ${type}, а не 1007, 1008 или 1033`);
  const out = { type, stationId: r.u(12) };
  out.antenna = r.str(r.u(8));
  out.setupId = r.u(8);
  if (type >= 1008) out.antennaSerial = r.str(r.u(8));
  if (type === 1033) {
    out.receiver = r.str(r.u(8));
    out.firmware = r.str(r.u(8));
    out.receiverSerial = r.str(r.u(8));
  }
  return out;
}

// ---------- 1230: кодовые задержки ГЛОНАСС ----------
// biases — метры по сигналам l1ca, l1p, l2ca, l2p; сигнал без значения в сообщение не входит.
// Шаг 0,02 м, пределы ±655,34 м.

const GLO_SIGNALS = ['l1ca', 'l1p', 'l2ca', 'l2p'];

function encodeGlonassBiases({ stationId, aligned = 0, reserved = 0, biases = {} }) {
  checkStation(stationId);
  const present = GLO_SIGNALS.filter((k) => biases[k] !== undefined && biases[k] !== null);
  const w = new BitPacker(32 + 16 * present.length);
  w.u(12, 1230).u(12, stationId).u(1, aligned).u(3, reserved);
  for (const k of GLO_SIGNALS) w.u(1, present.includes(k) ? 1 : 0);
  for (const k of present) w.s(16, biases[k] / 0.02);
  return frame(w.buf);
}

function decodeGlonassBiases(payload) {
  const r = new BitUnpacker(payload);
  const type = r.u(12);
  if (type !== 1230) throw new Error(`это сообщение ${type}, а не 1230`);
  const out = { type, stationId: r.u(12), aligned: r.u(1), reserved: r.u(3), biases: {} };
  const mask = GLO_SIGNALS.map(() => r.u(1));
  // Значение в сотых долях метра считаем целыми, чтобы не получить 19,060000000000002
  GLO_SIGNALS.forEach((k, i) => { if (mask[i]) out.biases[k] = (r.s(16) * 2) / 100; });
  return out;
}

// ---------- 1021: семь параметров (Гельмерт) ----------
// Сдвиги — метры (шаг 1 мм, до ±4194,303 м); повороты — угловые секунды (шаг 0,00002″);
// масштаб — миллионные доли (шаг 0,00001). Область действия — градусы, в потоке с шагом 2″.
// Полуоси эллипсоидов — метры: в потоке идут добавки к 6 370 000 и 6 350 000 м.
// Знак поворотов сообщение не задаёт само: его определяет computation (DF150) и стандарт
// RTCM 10403; перед выпуском параметров в поток он проверяется на ровере.

function encodeHelmert(p) {
  const source = p.sourceName || '';
  const target = p.targetName || '';
  checkText(source, 'название исходной системы');
  checkText(target, 'название целевой системы');
  const w = new BitPacker(412 + 8 * (source.length + target.length));
  w.u(12, 1021);
  w.u(5, source.length).str(source);
  w.u(5, target.length).str(target);
  w.u(8, p.systemId || 0).u(10, p.utilized || 0).u(5, p.plate || 0).u(4, p.computation || 0).u(2, p.heightIndicator || 0);
  w.s(19, p.area.lat * 1800).s(20, p.area.lon * 1800).u(14, p.area.dLat * 1800).u(14, p.area.dLon * 1800);
  w.s(23, p.dx * 1000).s(23, p.dy * 1000).s(23, p.dz * 1000);
  w.s(32, p.rx / 0.00002).s(32, p.ry / 0.00002).s(32, p.rz / 0.00002);
  w.s(25, p.scale / 0.00001);
  w.u(24, (p.sourceA - 6370000) * 1000).u(25, (p.sourceB - 6350000) * 1000);
  w.u(24, (p.targetA - 6370000) * 1000).u(25, (p.targetB - 6350000) * 1000);
  w.u(3, p.horizontalQuality || 0).u(3, p.verticalQuality || 0);
  return frame(w.buf);
}

function decodeHelmert(payload) {
  const r = new BitUnpacker(payload);
  const type = r.u(12);
  if (type !== 1021) throw new Error(`это сообщение ${type}, а не 1021`);
  const out = { type };
  out.sourceName = r.str(r.u(5));
  out.targetName = r.str(r.u(5));
  out.systemId = r.u(8);
  out.utilized = r.u(10);
  out.plate = r.u(5);
  out.computation = r.u(4);
  out.heightIndicator = r.u(2);
  out.area = { lat: r.s(19) / 1800, lon: r.s(20) / 1800, dLat: r.u(14) / 1800, dLon: r.u(14) / 1800 };
  out.dx = r.s(23) / 1000;
  out.dy = r.s(23) / 1000;
  out.dz = r.s(23) / 1000;
  out.rx = (r.s(32) * 2) / 100000;
  out.ry = (r.s(32) * 2) / 100000;
  out.rz = (r.s(32) * 2) / 100000;
  out.scale = r.s(25) / 100000;
  out.sourceA = 6370000 + r.u(24) / 1000;
  out.sourceB = 6350000 + r.u(25) / 1000;
  out.targetA = 6370000 + r.u(24) / 1000;
  out.targetB = 6350000 + r.u(25) / 1000;
  out.horizontalQuality = r.u(3);
  out.verticalQuality = r.u(3);
  return out;
}

// Пределы, в которые параметры обязаны уложиться до выпуска в поток
const HELMERT_LIMITS = { shift: 4194.303, rotation: 42949.67294, scale: 167.77215 };

// ---------- 1025: проекция (в том числе поперечная Меркатора — Гаусса — Крюгера) ----------
// Широта и долгота начала — градусы (шаг 0,000000011°); масштаб на осевом меридиане —
// как множитель (в потоке — добавка к 0,993 в миллионных долях с шагом 0,00001);
// смещения — метры (шаг 1 мм).

const PROJECTION = { TM: 1, TMS: 2, LCC1SP: 3, LCC2SP: 4, LCCW: 5, CS: 6, OM: 7, OS: 8, PS: 9, DS: 10 };
const ANGLE_STEP = 0.000000011;

function encodeProjection(p) {
  const w = new BitPacker(196);
  w.u(12, 1025).u(8, p.systemId || 0).u(6, p.projection === undefined ? PROJECTION.TM : p.projection);
  w.s(34, p.lat0 / ANGLE_STEP).s(35, p.lon0 / ANGLE_STEP);
  w.u(30, (p.scale * 1e6 - 993000) / 0.00001);
  w.u(36, p.falseEasting * 1000).s(35, p.falseNorthing * 1000);
  return frame(w.buf);
}

function decodeProjection(payload) {
  const r = new BitUnpacker(payload);
  const type = r.u(12);
  if (type !== 1025) throw new Error(`это сообщение ${type}, а не 1025`);
  return {
    type,
    systemId: r.u(8),
    projection: r.u(6),
    lat0: r.s(34) * ANGLE_STEP,
    lon0: r.s(35) * ANGLE_STEP,
    scale: (993000 + r.u(30) / 100000) / 1e6,
    falseEasting: r.u(36) / 1000,
    falseNorthing: r.s(35) / 1000,
  };
}

// ---------- Номер станции в готовом кадре ----------

// У каких сообщений вторым полем идёт номер станции. У эфемерид (1019, 1020, 1042–1046)
// на этом месте номер спутника: их трогать нельзя.
function hasStationId(type) {
  return (type >= 1001 && type <= 1013) || type === 1029 || type === 1033 || type === 1230
    || (type >= 1071 && type <= 1137);
}

function frameType(buf) {
  return (buf[3] << 4) | (buf[4] >> 4);
}

function frameStationId(buf) {
  return ((buf[4] & 0x0f) << 8) | buf[5];
}

// Меняет номер станции прямо в кадре и пересчитывает контрольную сумму. Наблюдения при этом
// не затрагиваются: правятся 12 бит заголовка и три байта CRC. Возвращает true, если кадр изменён.
// Кадр должен принадлежать вызывающему: если его читают и другие, сначала нужна копия.
function restamp(buf, stationId) {
  if (buf.length < 9 || buf[0] !== 0xd3) return false;
  if (!hasStationId(frameType(buf)) || frameStationId(buf) === stationId) return false;
  buf[4] = (buf[4] & 0xf0) | (stationId >> 8);
  buf[5] = stationId & 0xff;
  writeCrc(buf);
  return true;
}

module.exports = {
  frame,
  encodePosition,
  decodePosition,
  encodeDescriptor,
  decodeDescriptor,
  encodeGlonassBiases,
  decodeGlonassBiases,
  encodeHelmert,
  decodeHelmert,
  HELMERT_LIMITS,
  encodeProjection,
  decodeProjection,
  PROJECTION,
  hasStationId,
  frameType,
  frameStationId,
  restamp,
};
