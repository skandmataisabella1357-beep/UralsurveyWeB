'use strict';
// Модуль «Журнал обрывов»: следит за связью станций и выдаёт события «связь пропала» и
// «связь вернулась». Ядро приёма не меняется: модуль раз в секунду-две смотрит на его снимки
// состояния. События уходят службе управления и хранятся в базе, поэтому журнал переживает
// перезапуск сервера.

// Причина обрыва человеческими словами: без хвоста «повтор через N с»
function why(link) {
  const detail = String(link.detail || '').replace(/;?\s*повтор через \d+ с\.?$/i, '').trim();
  return detail || link.stateLabel || link.state || '';
}

class OutageTracker {
  // graceMs — сколько новой станции даётся на первое подключение: дольше — это уже обрыв
  constructor({ graceMs = 60000 } = {}) {
    this.grace = graceMs;
    this.seen = new Map(); // код станции -> { up: true | false | null, firstSeen, reason }
  }

  // snapshots — снимки ядра [{ id, link: { state, detail, stateLabel } }]; sources — откуда
  // станция берётся, словами (код -> подпись). Возвращает события по порядку.
  step(snapshots, now, sources = {}) {
    const events = [];
    const present = new Set();
    for (const s of snapshots) {
      present.add(s.id);
      let rec = this.seen.get(s.id);
      if (!rec) {
        rec = { up: null, firstSeen: now, reason: '' };
        this.seen.set(s.id, rec);
      }
      if (s.link.state === 'online') {
        if (rec.up !== true) events.push({ t: 'up', station: s.id, at: now, reason: rec.reason });
        rec.up = true;
        rec.reason = '';
        continue;
      }
      const reason = why(s.link);
      if (rec.up === true) {
        rec.up = false;
        rec.reason = reason;
        events.push({ t: 'down', station: s.id, at: now, reason, source: sources[s.id] || '' });
      } else if (rec.up === null && now - rec.firstSeen >= this.grace) {
        // Станция так и не подключилась: обрыв считается с момента, как её начали слушать
        rec.up = false;
        rec.reason = reason;
        events.push({ t: 'down', station: s.id, at: rec.firstSeen, reason, source: sources[s.id] || '' });
      } else if (rec.up === false && reason && rec.reason !== reason && /ожид|подключ|waiting|connecting/i.test(rec.reason || 'ожидание')) {
        // Первая причина была общей («ждём данные»); более точная её заменяет
        rec.reason = reason;
      }
    }
    // Станцию убрали из приёма, пока она была без связи: обрыв закрывается, дальше её не слушают
    for (const [code, rec] of this.seen) {
      if (present.has(code)) continue;
      if (rec.up === false) events.push({ t: 'gone', station: code, at: now });
      this.seen.delete(code);
    }
    return events;
  }
}

module.exports = { OutageTracker, why };
