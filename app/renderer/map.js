'use strict';
// Карта: подложка OpenStreetMap, градусная сетка поверх и знаки станций.

window.StationMap = (() => {
  const { esc } = window.Fmt;

  // Шаги сетки в градусах: от 10° до 1″
  const STEPS = [10, 5, 2, 1, 0.5, 1 / 6, 1 / 12, 1 / 30, 1 / 60, 1 / 120, 1 / 360, 1 / 720, 1 / 3600];

  let map;
  let canvas;
  let onSelect = () => {};
  let userMoved = false;
  let located = 0;
  // Поля карты, занятые панелями: слева список, справа панель станции, сверху полоса
  const insets = { left: 276, top: 64, right: 368, bottom: 12 };
  const pins = new Map(); // id -> { marker, key }

  function init(select) {
    onSelect = select;
    map = L.map('map', {
      center: [57.2, 60.6],
      zoom: 7,
      minZoom: 3,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
    });
    map.attributionControl.setPrefix(false);
    L.control.zoom({ position: 'bottomright', zoomInTitle: 'Приблизить', zoomOutTitle: 'Отдалить' }).addTo(map);
    // Масштабная линейка с русскими единицами
    L.Control.Scale.include({
      _updateMetric(maxMeters) {
        const meters = this._getRoundNum(maxMeters);
        this._updateScale(this._mScale, meters < 1000 ? `${meters} м` : `${meters / 1000} км`, meters / maxMeters);
      },
    });
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© участники OpenStreetMap',
    }).addTo(map);

    canvas = document.getElementById('graticule');
    map.on('move zoom resize viewreset', drawGraticule);
    map.on('dragstart', () => { userMoved = true; });
    map.getContainer().addEventListener('wheel', () => { userMoved = true; }, { passive: true });
    new ResizeObserver(() => {
      map.invalidateSize();
      drawGraticule();
    }).observe(map.getContainer());
    window.addEventListener('themechange', drawGraticule);
    document.fonts.ready.then(drawGraticule);
    drawGraticule();
  }

  function axisLabel(value, step, kind) {
    const hemi = kind === 'lat' ? (value >= 0 ? 'с' : 'ю') : (value >= 0 ? 'в' : 'з');
    let total = Math.round(Math.abs(value) * 3600);
    const s = total % 60;
    total = Math.floor(total / 60);
    const m = total % 60;
    const d = Math.floor(total / 60);
    let text = `${d}°`;
    if (step < 1) text += `${String(m).padStart(2, '0')}′`;
    if (step < 1 / 60) text += `${String(s).padStart(2, '0')}″`;
    return `${text} ${hemi}`;
  }

  function drawGraticule() {
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const b = map.getBounds();
    const want = (b.getEast() - b.getWest()) / Math.max(2, size.x / 190);
    const step = STEPS.find((s) => s <= want) || STEPS[STEPS.length - 1];

    // Цвета сетки берём из темы; подписи ставим в свободной от панелей части карты
    const css = getComputedStyle(document.documentElement);
    ctx.lineWidth = 1;
    ctx.strokeStyle = css.getPropertyValue('--grid').trim();
    ctx.fillStyle = css.getPropertyValue('--grid-text').trim();
    ctx.font = '350 10px "Martian Mono", monospace';
    ctx.textBaseline = 'top';
    const { left, top, right, bottom } = insets;

    const lat0 = b.getCenter().lat;
    for (let i = Math.ceil(b.getWest() / step); i * step <= b.getEast(); i++) {
      const lon = i * step;
      const x = Math.round(map.latLngToContainerPoint([lat0, lon]).x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.y);
      ctx.stroke();
      const wrapped = ((lon + 540) % 360) - 180;
      if (x > left + 70 && x < size.x - right - 60) ctx.fillText(axisLabel(wrapped, step, 'lon'), x + 5, top + 6);
    }
    const south = Math.max(b.getSouth(), -85);
    const north = Math.min(b.getNorth(), 85);
    for (let i = Math.ceil(south / step); i * step <= north; i++) {
      const lat = i * step;
      const y = Math.round(map.latLngToContainerPoint([lat, b.getWest()]).y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.x, y);
      ctx.stroke();
      if (y > top + 26 && y < size.y - bottom - 40) ctx.fillText(axisLabel(lat, step, 'lat'), left + 6, y + 5);
    }
  }

  function stateClass(station) {
    switch (station.link.state) {
      case 'online': return 'is-online';
      case 'connecting': case 'waiting': case 'listening': return 'is-wait';
      case 'idle': return '';
      default: return 'is-fail';
    }
  }

  function pinHtml(station, selected) {
    const cls = ['pin', stateClass(station)];
    if (selected) cls.push('is-selected');
    if (station.position.source !== 'rtcm') cls.push('is-approx');
    return `<div class="${cls.join(' ')}">
      <span class="pin-glow"></span><span class="pin-ring"></span>
      <svg viewBox="0 0 30 28"><path class="pin-tri" d="M15 3 27 24.5H3Z"/><circle class="pin-dot" cx="15" cy="17" r="2.8"/></svg>
      <span class="pin-label">${esc(station.name)}</span>
    </div>`;
  }

  // Привести знаки на карте в соответствие со снимком состояния станций
  function update(stations, selectedId) {
    const seen = new Set();
    for (const st of stations) {
      if (!st.position) continue;
      seen.add(st.id);
      const selected = st.id === selectedId;
      const latlng = [st.position.lat, st.position.lon];
      const key = `${stateClass(st)}|${selected}|${st.position.source}|${st.name}`;
      let pin = pins.get(st.id);
      if (!pin) {
        const marker = L.marker(latlng, { icon: icon(st, selected), keyboard: false });
        marker.on('click', () => onSelect(st.id));
        marker.addTo(map);
        pin = { marker, key };
        pins.set(st.id, pin);
      } else {
        pin.marker.setLatLng(latlng);
        if (pin.key !== key) {
          pin.marker.setIcon(icon(st, selected));
          pin.key = key;
        }
      }
      pin.marker.setZIndexOffset(selected ? 1000 : 0);
    }
    for (const [id, pin] of pins) {
      if (seen.has(id)) continue;
      pin.marker.remove();
      pins.delete(id);
    }
    // Пока оператор сам не трогал карту, держим в кадре все станции с координатами
    if (!userMoved && seen.size !== located) {
      located = seen.size;
      fitAll();
    }
  }

  function icon(station, selected) {
    return L.divIcon({ className: '', html: pinHtml(station, selected), iconSize: [30, 28], iconAnchor: [15, 17] });
  }

  function fitAll() {
    const pts = [...pins.values()].map((p) => p.marker.getLatLng());
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts), { ...viewPadding(70), maxZoom: pts.length === 1 ? 12 : 13 });
  }

  // Отступы, чтобы точка попадала в видимую часть карты, а не под панели
  function viewPadding(extra) {
    return {
      paddingTopLeft: [insets.left + extra, insets.top + extra],
      paddingBottomRight: [insets.right + extra, insets.bottom + extra],
    };
  }

  function focus(id) {
    const pin = pins.get(id);
    if (!pin) return;
    const p = pin.marker.getLatLng();
    map.fitBounds(L.latLngBounds([p, p]), { ...viewPadding(70), maxZoom: Math.max(map.getZoom(), 11), animate: true });
  }

  // Показать заданные точки [широта, долгота] в свободной от панелей части карты
  function fit(points) {
    if (points.length) map.fitBounds(L.latLngBounds(points), { ...viewPadding(50), animate: true });
  }

  return { init, update, focus, fitAll, fit, map: () => map };
})();
