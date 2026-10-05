'use strict';
// Модуль «Расчёт подсети»: номера частот ГЛОНАСС.
// У каждого спутника ГЛОНАСС своя частота, и без её номера фазу из сообщений MSM4 не восстановить:
// в MSM4 этих номеров нет. Они есть в файле эфемерид. Чтобы RTKLIB узнал их при чтении потока,
// перед наблюдениями подкладывается одно короткое сообщение 1010 без измерений — только
// «спутник — номер частоты». Само оно в расчёт не попадает.

const { BitPacker } = require('../../server/rtcm/bitpack');
const rtcm = require('../../server/rtcm/messages');

// Номера частот из файла эфемерид RINEX 3: { номер спутника: номер частоты (−7…+6) }
function channels(navText) {
  const out = {};
  const lines = navText.split('\n');
  for (let i = 0; i < lines.length - 2; i++) {
    const m = /^R(\d\d) \d{4} /.exec(lines[i]);
    if (!m) continue;
    // Третья строка записи: Y, скорость, ускорение, номер частоты — поля по 19 знаков с отступом 4
    const k = Number(lines[i + 2].slice(61, 80));
    if (Number.isInteger(k) && k >= -7 && k <= 6) out[Number(m[1])] = k;
  }
  return out;
}

// Сообщение 1010 с номерами частот. stationId — как в потоке станции; at — время начала записи.
function hint(stationId, fcn, at) {
  const sats = Object.keys(fcn).map(Number).filter((p) => p >= 1 && p <= 24).sort((a, b) => a - b);
  if (!sats.length) return Buffer.alloc(0);
  const w = new BitPacker(61 + 79 * sats.length);
  // Время суток по шкале ГЛОНАСС (Москва), мс; признак «дальше будут ещё сообщения» — чтобы
  // пустая эпоха не попала в наблюдения
  const tod = (Math.floor(at / 1000) + 3 * 3600) % 86400 * 1000;
  w.u(12, 1010).u(12, stationId).u(27, tod).u(1, 1).u(5, sats.length).u(1, 0).u(3, 0);
  for (const prn of sats) {
    // Псевдодальность 0, фаза — «нет измерения» (0x80000), остальное нули
    w.u(6, prn).u(1, 0).u(5, fcn[prn] + 7).u(25, 0).u(20, 0x80000).u(7, 0).u(7, 0).u(8, 0);
  }
  return rtcm.frame(w.buf);
}

module.exports = { channels, hint };
