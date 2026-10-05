'use strict';
// Набор служебных сообщений станции, готовый к выдаче. Сообщения собираются один раз —
// при заведении станции и при правке каталога, — а дальше каждому пользователю уходят
// те же готовые байты: на раздаче ничего не кодируется.

const m = require('./messages');

class ServiceSet {
  constructor(entry) {
    this.update(entry);
  }

  // entry: { stationId, position: { ecef, antennaHeight, ...признаки },
  //          descriptors: [{ type, antenna, receiver, ... }], glonassBiases: { aligned, biases } | null }
  update(entry) {
    const { stationId } = entry;
    this.stationId = stationId;
    this.position = m.encodePosition({ ...entry.position, stationId });
    this.descriptors = (entry.descriptors || []).map((d) => m.encodeDescriptor({ ...d, stationId }));
    this.biases = entry.glonassBiases ? m.encodeGlonassBiases({ ...entry.glonassBiases, stationId }) : null;
    // Одним куском — новому пользователю сразу после ответа «200»: координаты базы,
    // оборудование и задержки ГЛОНАСС приходят раньше первых наблюдений
    this.burst = Buffer.concat([this.position, ...this.descriptors, ...(this.biases ? [this.biases] : [])]);
    this.version = (this.version || 0) + 1;
    return this;
  }
}

// Набор, повторяющий то, что станция передаёт сейчас: из разобранных служебных кадров её потока.
// frames — тела кадров (payload) сообщений 1005/1006, 1007/1008/1033 и 1230.
function mirror(stationId, frames) {
  const entry = { stationId, position: null, descriptors: [], glonassBiases: null };
  for (const payload of frames) {
    const type = (payload[0] << 4) | (payload[1] >> 4);
    if (type === 1005 || type === 1006) entry.position = m.decodePosition(payload);
    else if (type === 1007 || type === 1008 || type === 1033) entry.descriptors.push(m.decodeDescriptor(payload));
    else if (type === 1230) entry.glonassBiases = m.decodeGlonassBiases(payload);
  }
  if (!entry.position) throw new Error('в потоке станции нет координат (сообщения 1005 или 1006)');
  return new ServiceSet(entry);
}

module.exports = { ServiceSet, mirror };
