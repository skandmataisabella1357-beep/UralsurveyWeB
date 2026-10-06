'use strict';
// Модуль «Состав потока»: отбор спутниковых систем и прореживание эпох для точки сети раздачи.
// Сеть может отдавать роверу не всё, что шлёт база: только выбранные системы и не каждую
// секунду — для слабой связи или старых приёмников. Наблюдения остальных систем не меняются.
//
// Сообщения MSM одной эпохи связаны признаком «за этим сообщением идёт ещё одно»: у последнего
// он снят. Если часть сообщений убрать, признак у оставшихся надо расставить заново, иначе ровер
// будет ждать сообщение, которого не получит. Поэтому эпоха копится до своего последнего
// сообщения и уходит роверу целиком.

const { crc24q } = require('../../core/crc24q');

// Буква системы по номеру сообщения; null — не наблюдения
function systemOf(type) {
  if (type >= 1071 && type <= 1077) return 'G';
  if (type >= 1081 && type <= 1087) return 'R';
  if (type >= 1091 && type <= 1097) return 'E';
  if (type >= 1101 && type <= 1107) return 'S';
  if (type >= 1111 && type <= 1117) return 'J';
  if (type >= 1121 && type <= 1127) return 'C';
  if (type >= 1131 && type <= 1137) return 'I';
  return null;
}
const MAIN = ['G', 'R', 'E', 'C'];
const frameType = (buf) => (buf[3] << 4) | (buf[4] >> 4);
// Признак «идёт ещё сообщение» — 55-й бит тела: после номера сообщения, номера станции и времени
const more = (buf) => Boolean(buf[9] & 0x02);
function withMore(buf, flag) {
  if (more(buf) === flag) return buf;
  const out = Buffer.from(buf);
  out[9] = flag ? out[9] | 0x02 : out[9] & 0xfd;
  const end = out.length - 3;
  const crc = crc24q(out, 0, end);
  out[end] = (crc >> 16) & 0xff;
  out[end + 1] = (crc >> 8) & 0xff;
  out[end + 2] = crc & 0xff;
  return out;
}
// Время эпохи в миллисекундах от начала недели — у систем со шкалой GPS (GPS, Galileo, QZSS)
function gpsTow(buf, sys) {
  if (!['G', 'E', 'J'].includes(sys)) return null;
  return ((buf[6] << 22) | (buf[7] << 14) | (buf[8] << 6) | (buf[9] >> 2)) >>> 0;
}

// filter — { systems: ['G', 'R', 'E', 'C'], rate: секунд между эпохами }. Пустой или полный — без отбора.
function needed(filter) {
  if (!filter) return false;
  const systems = Array.isArray(filter.systems) ? filter.systems : MAIN;
  return MAIN.some((s) => !systems.includes(s)) || (Number(filter.rate) || 1) > 1;
}

class Shaper {
  constructor(filter = {}) {
    this.systems = Array.isArray(filter.systems) && filter.systems.length ? filter.systems : MAIN;
    this.all = MAIN.every((s) => this.systems.includes(s));
    this.stepMs = Math.max(1, Math.round(Number(filter.rate) || 1)) * 1000;
    this.epoch = [];
    this.count = 0;
  }

  // Системы помимо четырёх главных идут только в полном составе
  allows(sys) {
    return this.systems.includes(sys) || (this.all && !MAIN.includes(sys));
  }

  // Одно сообщение на входе — ноль, одно или несколько на выходе (эпоха уходит целиком)
  push(buf) {
    const type = frameType(buf);
    const sys = systemOf(type);
    if (!sys) {
      // Задержки ГЛОНАСС и прежние сообщения наблюдений — вместе со своей системой
      if (type === 1230 || (type >= 1009 && type <= 1012)) return this.allows('R') ? [buf] : [];
      return [buf];
    }
    this.epoch.push({ buf, sys });
    // Конец эпохи — сообщение без признака продолжения; запас — на случай потока, где его не снимают
    if (more(buf) && this.epoch.length < 16) return [];
    const group = this.epoch;
    this.epoch = [];
    const timed = group.find((m) => gpsTow(m.buf, m.sys) !== null);
    const keep = this.stepMs <= 1000 || (timed ? gpsTow(timed.buf, timed.sys) % this.stepMs === 0 : this.count++ % (this.stepMs / 1000) === 0);
    if (!keep) return [];
    const kept = group.filter((m) => this.allows(m.sys));
    return kept.map((m, i) => withMore(m.buf, i < kept.length - 1));
  }

  // Сообщение, которое уходит роверу при подключении: можно ли его отдавать при этом отборе
  passes(type) {
    return type === 1230 ? this.allows('R') : true;
  }
}

module.exports = { Shaper, needed, systemOf };
