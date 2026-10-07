'use strict';
// Модуль «VRS»: настройки виртуальных баз. Список один на всех — на службу VRS, на управление
// (проверка того, что ввёл администратор) и на панель (она строит по нему окно настроек).

const OPTIONS = require('./options.json');

// Приводит настройки к допустимым: чего нет или что не годится — берётся по умолчанию
function clean(given = {}) {
  const out = {};
  for (const o of OPTIONS) {
    const v = given[o.key];
    let ok = false;
    if (o.kind === 'int') ok = Number.isInteger(v) && v >= o.min && v <= o.max;
    else if (o.kind === 'number') ok = typeof v === 'number' && Number.isFinite(v) && v >= o.min && v <= o.max;
    else if (o.kind === 'bool') ok = typeof v === 'boolean';
    else if (o.kind === 'choice') ok = o.choices.some((c) => c[0] === v);
    else if (o.kind === 'text') ok = typeof v === 'string' && v.length >= 1 && v.length <= o.max && /^[\x20-\x7e]+$/.test(v);
    else if (o.kind === 'systems') ok = Array.isArray(v) && v.length > 0 && v.every((x) => o.choices.some((c) => c[0] === x));
    out[o.key] = ok ? v : o.default;
  }
  if (out.minAux > out.aux) out.minAux = out.aux;
  return out;
}

const defaults = () => clean({});

module.exports = { OPTIONS, clean, defaults };
