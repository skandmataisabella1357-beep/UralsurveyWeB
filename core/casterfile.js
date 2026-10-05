'use strict';
// Текстовый список кастеров, с которых загружаются базовые станции.
// Одна строка — один кастер:
//   адрес:порт  логин  пароль  [отбор]
// Поля разделяются пробелами, табуляцией или точкой с запятой. Отбор — часть названия
// точки подключения; «*» — брать все точки. Пустые строки и строки с «#» пропускаются.

function parseCasterFile(text, defaultFilter = '') {
  const casters = [];
  const errors = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const n = i + 1;
    const f = line.split(/[\s;]+/).filter(Boolean);
    const m = /^(?:ntrip:\/\/|http:\/\/)?(.+):(\d+)\/?$/.exec(f[0]);
    if (!m) {
      errors.push({ line: n, text: `строка ${n}: первым должно идти «адрес:порт», а там «${f[0]}»` });
      return;
    }
    const port = Number(m[2]);
    if (port < 1 || port > 65535) {
      errors.push({ line: n, text: `строка ${n}: порт ${m[2]} вне диапазона 1–65535` });
      return;
    }
    if (f.length > 4) {
      errors.push({ line: n, text: `строка ${n}: лишние поля после отбора (ждём «адрес:порт логин пароль отбор»)` });
      return;
    }
    let filter = f[3] === undefined ? defaultFilter : f[3];
    if (filter === '*') filter = '';
    casters.push({ line: n, host: m[1], port, username: f[1] || '', password: f[2] || '', filter });
  });
  return { casters, errors };
}

module.exports = { parseCasterFile };
