'use strict';
// Модуль «Геоид»: высота геоида над эллипсоидом WGS-84.
// Нужен, чтобы из высоты над эллипсоидом (её даёт спутниковое определение) получить отметку:
// H = h − N. Работает и в окне (window.Geoid), и на сервере (require).
//
// Данные — файл russia2008-ural.json: вырезка из файла Trimble Russia2008.ggf заказчика
// (модель EGM2008, сетка 1 минута) на Свердловскую область с соседями, 55–62,5° с. ш.,
// 56–67° в. д. Это тот же геоид, что стоит у заказчика в TBC и контроллерах: отметки станций
// совпадают с его таблицей до миллиметра. Между узлами — билинейная интерполяция.
//
// Формат GGF: заголовок 146 байт (границы и шаг сетки — числа double с 48-го байта, число
// строк и столбцов — int32 с 96-го), дальше значения float32 строками с юга на север.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geoid = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  function bytes(base64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
    const text = atob(base64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }

  // grid — содержимое egm2008-ural.json. Возвращает { model, undulation(lat, lon), covers(lat, lon) }.
  function create(grid) {
    const raw = bytes(grid.data);
    const { width, height, north, west, step, offset, scale } = grid;
    // В файле значения — двухбайтовые целые, старший байт первым; высота = offset + scale · значение
    const at = (row, col) => offset + scale * ((raw[(row * width + col) * 2] << 8) | raw[(row * width + col) * 2 + 1]);
    const covers = (lat, lon) => lat <= north && lat >= north - (height - 1) * step && lon >= west && lon <= west + (width - 1) * step;
    function undulation(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !covers(lat, lon)) return null;
      const y = Math.min((north - lat) / step, height - 1 - 1e-9);
      const x = Math.min((lon - west) / step, width - 1 - 1e-9);
      const r = Math.floor(y);
      const c = Math.floor(x);
      const fy = y - r;
      const fx = x - c;
      return (1 - fy) * ((1 - fx) * at(r, c) + fx * at(r, c + 1)) + fy * ((1 - fx) * at(r + 1, c) + fx * at(r + 1, c + 1));
    }
    return { model: grid.model, source: grid.source, undulation, covers };
  }

  return { create };
});
