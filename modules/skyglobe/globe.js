'use strict';
// Окно «Спутники на шаре»: каркасный земной шар, вокруг него спутники, на шаре — станции сети.
// Лёгкое: обычный холст без 3D-ускорения, кадр рисуется только когда что-то изменилось.

(() => {
  const RE = 6371e3;
  const D2R = Math.PI / 180;
  const SYS = {
    GPS: { name: 'GPS', color: '#84c8ff' },
    GLO: { name: 'ГЛОНАСС', color: '#f09ccc' },
    GAL: { name: 'Galileo', color: '#86e2c0' },
    BDS: { name: 'BeiDou', color: '#ffc48e' },
  };
  const TRAIL = 200; // точек следа на спутник
  const GLOBE_FIT = 33000e3;

  const $ = (id) => document.getElementById(id);
  const canvas = $('globe');
  const ctx = canvas.getContext('2d');
  let data = null;
  let selected = null; // название выбранной станции
  const trails = new Map(); // метка -> [ecef, ...]
  const view = { lon: 61, lat: 28, fit: GLOBE_FIT };
  let size = { w: 0, h: 0 };
  let colors = {};
  let dirty = true;
  let stationPoints = []; // экранные точки станций последнего кадра — для выбора щелчком

  const shortName = (name) => name.replace(/_MSM\d$/i, '');
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const get = (name) => css.getPropertyValue(name).trim();
    colors = { text: get('--text'), muted: get('--muted'), faint: get('--faint'), flow: get('--flow'), fail: get('--fail') };
    dirty = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    size = { w: window.innerWidth, h: window.innerHeight };
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  // Камера смотрит на точку с долготой lon и широтой lat: она попадает в центр окна.
  // z > 0 — ближняя к зрителю сторона.
  function camera() {
    const l = view.lon * D2R;
    const t = view.lat * D2R;
    const depth = [Math.cos(l) * Math.cos(t), Math.sin(l) * Math.cos(t), Math.sin(t)];
    const right = [-Math.sin(l), Math.cos(l), 0];
    const up = [
      depth[1] * right[2] - depth[2] * right[1],
      depth[2] * right[0] - depth[0] * right[2],
      depth[0] * right[1] - depth[1] * right[0],
    ];
    const k = Math.min(size.w, size.h) / 2 / view.fit;
    const cx = size.w / 2;
    const cy = size.h / 2;
    const project = (p) => ({
      x: cx + (p[0] * right[0] + p[1] * right[1] + p[2] * right[2]) * k,
      y: cy - (p[0] * up[0] + p[1] * up[1] + p[2] * up[2]) * k,
      z: p[0] * depth[0] + p[1] * depth[1] + p[2] * depth[2],
    });
    project.k = k;
    return project;
  }

  // Контуры суши: один раз переводим градусы в точки на шаре
  let land = null;
  function landLines() {
    if (!land) {
      land = (window.LAND || []).map((line) => {
        const pts = [];
        for (let i = 0; i < line.length; i += 2) pts.push(onSphere(line[i + 1], line[i], RE));
        return pts;
      });
    }
    return land;
  }

  const onSphere = (lat, lon, r) => [r * Math.cos(lat * D2R) * Math.cos(lon * D2R), r * Math.cos(lat * D2R) * Math.sin(lon * D2R), r * Math.sin(lat * D2R)];
  const geodetic = (p) => ({ lat: Math.asin(p[2] / Math.hypot(...p)) / D2R, lon: Math.atan2(p[1], p[0]) / D2R });

  function networkCenter() {
    if (!data || !data.stations.length) return null;
    return [0, 1, 2].map((k) => data.stations.reduce((sum, st) => sum + st.ecef[k], 0) / data.stations.length);
  }

  // Линия на шаре: ближняя половина ярче дальней
  function sphereLine(project, points, color, near, far) {
    for (const front of [false, true]) {
      ctx.beginPath();
      let pen = false;
      for (const p of points) {
        const s = project(p);
        if ((s.z >= 0) !== front) { pen = false; continue; }
        if (pen) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
        pen = true;
      }
      ctx.globalAlpha = front ? near : far;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawEarth(project) {
    const c = project([0, 0, 0]);
    const r = RE * project.k;
    if (r < 4000) {
      const glow = ctx.createRadialGradient(c.x - r * 0.3, c.y - r * 0.35, r * 0.1, c.x, c.y, r * 1.4);
      glow.addColorStop(0, 'rgba(168, 144, 255, 0.28)');
      glow.addColorStop(0.6, 'rgba(132, 200, 255, 0.12)');
      glow.addColorStop(1, 'rgba(132, 200, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size.w, size.h);
    }
    // Вблизи сетка гуще: шаг подбирается по масштабу
    const step = r > 6000 ? 1 : (r > 1500 ? 5 : (r > 500 ? 10 : 30));
    const seg = Math.min(6, step);
    ctx.lineWidth = 1;
    for (let lon = 0; lon < 360; lon += step) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += seg) pts.push(onSphere(lat, lon, RE));
      sphereLine(project, pts, '#a890ff', 0.28, 0.07);
    }
    for (let lat = -90 + step; lat < 90; lat += step) {
      const pts = [];
      for (let lon = 0; lon <= 360; lon += seg) pts.push(onSphere(lat, lon, RE));
      sphereLine(project, pts, lat === 0 ? '#86e2c0' : '#84c8ff', lat === 0 ? 0.5 : 0.25, 0.07);
    }
    // Материки: контуры поверх сетки, ближняя сторона ярче
    ctx.lineWidth = 1.1;
    for (const pts of landLines()) sphereLine(project, pts, colors.text, 0.75, 0.1);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = '#a890ff';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return { c, r };
  }

  // Скрыт ли объект Землёй: он за плоскостью экрана и попадает в круг шара
  const hidden = (s, earth) => s.z < 0 && Math.hypot(s.x - earth.c.x, s.y - earth.c.y) < earth.r;

  function dot(x, y, r, color, alpha) {
    // Свечение без размытия: полупрозрачный круг побольше и яркий поменьше
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * 0.22;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.clearRect(0, 0, size.w, size.h);
    const project = camera();
    const earth = drawEarth(project);
    stationPoints = [];
    if (!data) return;

    const center = networkCenter();
    const station = selected ? data.stations.find((st) => st.name === selected) : null;
    const tracked = station ? new Set(station.sats) : null;
    const origin = station ? station.ecef : center;
    const o = origin ? project(origin) : null;

    ctx.font = '350 9px "Martian Mono", monospace';
    ctx.textBaseline = 'middle';

    // Спутники: следы, лучи от сети или выбранной станции, точки с подписями
    for (const sat of data.sats) {
      const sys = SYS[sat.sys];
      const s = project(sat.ecef);
      const behind = hidden(s, earth);
      const active = !tracked || tracked.has(sat.label);

      const trail = trails.get(sat.label);
      if (trail && trail.length > 1 && active) {
        ctx.beginPath();
        trail.forEach((p, i) => {
          const q = project(p);
          if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        });
        ctx.strokeStyle = sys.color;
        ctx.globalAlpha = behind ? 0.1 : 0.45;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (behind) continue;

      if (o && active) {
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(s.x, s.y);
        ctx.strokeStyle = sys.color;
        ctx.globalAlpha = tracked ? 0.4 : 0.12;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      dot(s.x, s.y, 3, sys.color, active ? 1 : 0.22);
      ctx.fillStyle = colors.muted;
      ctx.globalAlpha = active ? 1 : 0.3;
      ctx.fillText(sat.label, s.x + 6, s.y);
      ctx.globalAlpha = 1;
    }

    // Станции сети на шаре. Издалека они сливаются — обводим сеть кольцом с подписью.
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const st of data.stations) {
      const s = project(st.ecef);
      if (s.z <= 0) continue;
      stationPoints.push({ name: st.name, x: s.x, y: s.y });
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    const spread = Math.max(maxX - minX, maxY - minY);
    const close = spread > 160; // станции различимы — подписываем каждую
    for (const p of stationPoints) {
      const st = data.stations.find((x) => x.name === p.name);
      const isSel = p.name === selected;
      dot(p.x, p.y, isSel ? 3.4 : (close ? 2.8 : 1.6), st.online ? colors.flow : colors.fail, 1);
      if (isSel) {
        ctx.strokeStyle = colors.text;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (close || isSel) {
        ctx.fillStyle = isSel ? colors.text : colors.muted;
        ctx.fillText(shortName(p.name), p.x + (isSel ? 11 : 6), p.y);
      }
    }
    if (!close && stationPoints.length && center) {
      const c = project(center);
      const ring = Math.max(11, spread / 2 + 7);
      ctx.strokeStyle = colors.flow;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (!selected) {
        ctx.fillStyle = colors.text;
        ctx.fillText(`сеть, ${data.stations.length}`, c.x + ring + 5, c.y);
      }
    }
  }

  // ---------- Плашки поверх шара ----------

  function updatePanels() {
    if (!data) return;
    const total = data.sats.length;
    $('count').textContent = total ? String(total) : '';
    $('legend').innerHTML = Object.entries(SYS).map(([key, sys]) => {
      const n = data.sats.filter((s) => s.sys === key).length;
      return `<li><i style="background:${sys.color}"></i><b>${sys.name}</b><span>${n || '—'}</span></li>`;
    }).join('');

    if (selected && !data.stations.some((st) => st.name === selected)) selected = null;
    $('stations').innerHTML = data.stations.map((st) => `<button type="button" data-station="${esc(st.name)}" aria-pressed="${st.name === selected}" class="${st.online ? '' : 'is-off'}">${esc(shortName(st.name))}</button>`).join('');

    const note = $('note');
    const station = selected ? data.stations.find((st) => st.name === selected) : null;
    if (station) {
      const shown = new Set(data.sats.map((s) => s.label));
      const mine = station.sats.filter((l) => shown.has(l));
      const parts = Object.entries(SYS).map(([key, sys]) => {
        const n = mine.filter((l) => data.sats.find((s) => s.label === l).sys === key).length;
        return n ? `${sys.name} ${n}` : '';
      }).filter(Boolean).join(', ');
      note.textContent = station.online
        ? `${shortName(station.name)} принимает ${mine.length} из ${total} спутников: ${parts || 'нет данных'}. Остальные приглушены.`
        : `${shortName(station.name)} сейчас без связи.`;
    } else if (!total) {
      note.textContent = data.stations.length >= 5
        ? 'Ждём наблюдения со станций…'
        : 'Положение спутников считается по наблюдениям сети: нужно не меньше пяти станций с координатами.';
    } else {
      note.textContent = `Положение спутников вычислено по наблюдениям ${data.stations.length} станций сети, без эфемерид: направление приближённое. Щёлкните станцию в списке — покажу, какие спутники она принимает.`;
    }
  }

  function select(name) {
    selected = selected === name ? null : name;
    updatePanels();
    dirty = true;
  }

  // Вид: весь шар со спутниками или сеть вблизи
  function setView(mode) {
    const center = networkCenter();
    const g = center ? geodetic(center) : { lat: 57, lon: 61 };
    if (mode === 'net' && center) {
      const reach = Math.max(...data.stations.map((st) => Math.hypot(st.ecef[0] - center[0], st.ecef[1] - center[1], st.ecef[2] - center[2])));
      view.lon = g.lon;
      view.lat = g.lat;
      view.fit = Math.max(60e3, reach * 1.5);
    } else {
      view.lon = g.lon;
      view.lat = Math.max(15, g.lat - 30);
      view.fit = GLOBE_FIT;
    }
    for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === mode));
    dirty = true;
  }

  // ---------- Данные ----------

  let first = true;
  window.sky.onData((next) => {
    data = next;
    const alive = new Set();
    for (const sat of data.sats) {
      alive.add(sat.label);
      const trail = trails.get(sat.label) || [];
      trail.push(sat.ecef);
      if (trail.length > TRAIL) trail.shift();
      trails.set(sat.label, trail);
    }
    for (const label of trails.keys()) if (!alive.has(label)) trails.delete(label);
    if (first && data.stations.length) {
      first = false;
      setView('globe');
    }
    updatePanels();
    dirty = true;
  });
  window.sky.onTheme((theme) => {
    document.documentElement.dataset.theme = theme;
    readColors();
  });
  window.sky.onSelect((name) => {
    if (!data || !data.stations.some((st) => st.name === name)) return;
    selected = name;
    updatePanels();
    dirty = true;
  });

  // ---------- Мышь ----------

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, lon: view.lon, lat: view.lat, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    document.body.classList.add('is-dragging');
    // Чем ближе вид, тем меньше градусов на пиксель
    const rate = 0.3 * Math.min(1, view.fit / GLOBE_FIT * 4);
    view.lon = drag.lon - dx * rate;
    view.lat = Math.max(-89, Math.min(89, drag.lat + dy * rate));
    dirty = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      // Щелчок без движения: выбор станции, если попали рядом с ней
      let best = null;
      for (const p of stationPoints) {
        const dist = Math.hypot(p.x - e.clientX, p.y - e.clientY);
        if (dist < 12 && (!best || dist < best.dist)) best = { name: p.name, dist };
      }
      if (best) select(best.name);
    }
    drag = null;
    document.body.classList.remove('is-dragging');
  });
  canvas.addEventListener('pointercancel', () => { drag = null; document.body.classList.remove('is-dragging'); });
  canvas.addEventListener('wheel', (e) => {
    view.fit = Math.max(40e3, Math.min(60000e3, view.fit * (e.deltaY > 0 ? 1.15 : 0.87)));
    for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', 'false');
    dirty = true;
  }, { passive: true });

  $('stations').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-station]');
    if (btn) select(btn.dataset.station);
  });
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));

  window.addEventListener('resize', resize);
  window.addEventListener('themechange', readColors);

  // Кадр рисуется только когда что-то изменилось
  function frame() {
    requestAnimationFrame(frame);
    if (!dirty || document.hidden) return;
    dirty = false;
    draw();
  }

  readColors();
  resize();
  document.fonts.ready.then(() => { dirty = true; });
  requestAnimationFrame(frame);
})();
