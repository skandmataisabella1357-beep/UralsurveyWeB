'use strict';
// Модуль «Расчёт подсети»: прореживание потока перед записью.
// Для статики хватает одной эпохи в несколько секунд: файл в разы меньше, расчёт быстрее.
// Служебные сообщения (координаты, оборудование) пишутся все — они редкие и короткие.

function isMsm(type) {
  return type >= 1071 && type <= 1137;
}

// Время эпохи в миллисекундах от начала недели — у систем, где оно в шкале GPS
function gpsTow(type, payload) {
  const gpsScale = (type >= 1071 && type <= 1077) || (type >= 1091 && type <= 1097) || (type >= 1111 && type <= 1117);
  if (!gpsScale || payload.length < 7) return null;
  return ((payload[3] << 22) | (payload[4] << 14) | (payload[5] << 6) | (payload[6] >> 2)) >>> 0;
}

// Решает по каждому сообщению, писать ли его. ГЛОНАСС и BeiDou идут в своих шкалах времени,
// поэтому берутся или пропускаются вместе с эпохой GPS или Galileo, после которой пришли.
class Thinner {
  constructor(stepMs = 5000) {
    this.stepMs = stepMs;
    this.keep = false;
  }

  take(type, payload) {
    if (!isMsm(type)) return true;
    const tow = gpsTow(type, payload);
    if (tow !== null) this.keep = tow % this.stepMs === 0;
    return this.keep;
  }
}

module.exports = { Thinner, gpsTow };
