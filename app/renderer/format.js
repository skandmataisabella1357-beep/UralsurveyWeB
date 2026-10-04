'use strict';
// Оформление чисел, времени и координат для показа в окне.

window.Fmt = (() => {
  const NBSP = ' ';

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function num(value, digits = 0) {
    return value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // Градусы, минуты, секунды. secDigits — знаков после запятой в секундах.
  function dms(deg, kind, secDigits) {
    const hemi = kind === 'lat' ? (deg >= 0 ? 'с. ш.' : 'ю. ш.') : (deg >= 0 ? 'в. д.' : 'з. д.');
    const scale = 10 ** secDigits;
    let total = Math.round(Math.abs(deg) * 3600 * scale);
    const s = (total % (60 * scale)) / scale;
    total = Math.floor(total / (60 * scale));
    const m = total % 60;
    const d = Math.floor(total / 60);
    const sec = s.toLocaleString('ru-RU', { minimumFractionDigits: secDigits, maximumFractionDigits: secDigits });
    return { text: `${d}°${String(m).padStart(2, '0')}′${s < 10 ? '0' : ''}${sec}″`, hemi };
  }

  function rate(bitsPerSec) {
    if (bitsPerSec < 1000) return `${num(bitsPerSec)}${NBSP}бит/с`;
    return `${num(bitsPerSec / 1000, 1)}${NBSP}кбит/с`;
  }

  function bytes(n) {
    if (n < 1024) return `${n}${NBSP}Б`;
    if (n < 1024 ** 2) return `${num(n / 1024, 1)}${NBSP}КБ`;
    if (n < 1024 ** 3) return `${num(n / 1024 ** 2, 1)}${NBSP}МБ`;
    return `${num(n / 1024 ** 3, 2)}${NBSP}ГБ`;
  }

  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}${NBSP}с`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}${NBSP}мин ${String(s % 60).padStart(2, '0')}${NBSP}с`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}${NBSP}ч ${String(m % 60).padStart(2, '0')}${NBSP}мин`;
    return `${Math.floor(h / 24)}${NBSP}сут ${h % 24}${NBSP}ч`;
  }

  function clock(t) {
    return new Date(t).toLocaleTimeString('ru-RU', { hour12: false });
  }

  // «1 станция», «2 станции», «5 станций»
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  function interval(sec) {
    if (sec === null) return '—';
    if (sec < 0.95) return `${num(sec, 1)}${NBSP}с`;
    if (sec < 90) return `${num(Math.round(sec))}${NBSP}с`;
    return `${num(Math.round(sec / 60))}${NBSP}мин`;
  }

  return { esc, num, dms, rate, bytes, duration, clock, plural, interval, NBSP };
})();
