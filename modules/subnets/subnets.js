'use strict';
// Модуль «Подсети»: оператор обводит на карте контур, станции внутри него образуют подсеть.
// Внутри подсети станции соединяются треугольниками; каждая сторона — базовая линия.
// Ядро не трогает: берёт снимки состояния станций и рисует поверх карты.

window.Subnets = (() => {
  const G = window.SubnetGeometry;
  const MARK = '<svg class="station-mark" viewBox="0 0 28 26" aria-hidden="true"><path d="M4 22 14 4l10 18Z"/><path d="M9 13h10M14 4v18"/></svg>';
  const ICON = '<path d="M5 8 13 4l6 7-4 9-9-3Z"/><path d="M5 8l10 12M13 4 6 17M19 11 6 17"/>';
  const STYLE = {
    outline: { color: '#a890ff', weight: 1.5, dashArray: '5 6', fillColor: '#a890ff', fillOpacity: 0.05 },
    outlineSelected: { color: '#a890ff', weight: 2.5, dashArray: '5 6', fillColor: '#a890ff', fillOpacity: 0.1 },
    lineOk: { color: '#86e2c0', weight: 2, opacity: 0.9 },
    lineDown: { color: '#f09ccc', weight: 1.5, opacity: 0.8, dashArray: '3 6' },
    draft: { color: '#ffc48e', weight: 2, dashArray: '4 5' },
  };

  let api = null; // { core, map, fit, fmt, toast, rerender }
  let subnets = [];
  let stations = [];
  let selectedId = null;
  let confirmRemove = null;
  const layers = new Map(); // id подсети -> { group, key }
  let draft = null; // идущее рисование: { points, line, note }

  // ---------- Расчёт состояния ----------

  function satLabels(st) {
    const set = new Set();
    for (const c of st.constellations) for (const s of c.sats) set.add(s.label);
    return set;
  }

  // Состав подсети на сейчас: станции с координатами и стороны между ними
  function describe(subnet) {
    const byId = new Map(stations.map((s) => [s.id, s]));
    const known = subnet.stationIds.map((id) => byId.get(id)).filter(Boolean);
    const placed = known.filter((s) => s.position);
    const lines = G.baselines(placed.map((s) => ({ lat: s.position.lat, lon: s.position.lon, ecef: s.position.ecef }))).map((l) => {
      const a = placed[l.a];
      const b = placed[l.b];
      const up = a.link.state === 'online' && b.link.state === 'online';
      let common = 0;
      if (up) {
        const other = satLabels(b);
        for (const label of satLabels(a)) if (other.has(label)) common++;
      }
      return { a, b, length: l.length, up, common };
    });
    const online = known.filter((s) => s.link.state === 'online').length;
    return { known, placed, lines, online, missing: subnet.stationIds.length - known.length };
  }

  function stateClass(d) {
    if (!d.known.length || !d.online) return 'is-fail';
    return d.online === d.known.length ? 'is-online' : 'is-wait';
  }

  // ---------- Карта ----------

  function redraw() {
    const seen = new Set();
    for (const subnet of subnets) {
      seen.add(subnet.id);
      const d = describe(subnet);
      const selected = subnet.id === selectedId;
      const key = JSON.stringify([selected, subnet.polygon, d.lines.map((l) => [l.a.id, l.b.id, l.up, l.a.position.lat, l.b.position.lat])]);
      const old = layers.get(subnet.id);
      if (old && old.key === key) continue;
      if (old) old.group.remove();
      const group = L.layerGroup();
      const outline = L.polygon(subnet.polygon, selected ? STYLE.outlineSelected : STYLE.outline);
      outline.on('click', () => { if (!draft) select(subnet.id); });
      outline.addTo(group);
      for (const l of d.lines) {
        L.polyline([[l.a.position.lat, l.a.position.lon], [l.b.position.lat, l.b.position.lon]],
          { ...(l.up ? STYLE.lineOk : STYLE.lineDown), interactive: false }).addTo(group);
      }
      group.addTo(api.map);
      layers.set(subnet.id, { group, key });
    }
    for (const [id, layer] of layers) {
      if (seen.has(id)) continue;
      layer.group.remove();
      layers.delete(id);
    }
  }

  // ---------- Рисование контура ----------

  function startDrawing() {
    if (draft) return;
    const note = document.createElement('p');
    note.className = 'map-note glass';
    note.textContent = 'Обведите подсеть: щёлкайте по карте, ставя вершины контура. Двойной щелчок — закончить, Esc — отменить.';
    document.querySelector('.map-wrap').appendChild(note);
    draft = { points: [], line: L.polyline([], STYLE.draft).addTo(api.map), note };
    api.map.doubleClickZoom.disable();
    api.map.getContainer().style.cursor = 'crosshair';
    api.map.on('click', onDraftClick);
    api.map.on('mousemove', onDraftMove);
    api.map.on('dblclick', finishDrawing);
  }

  function stopDrawing() {
    if (!draft) return;
    api.map.off('click', onDraftClick);
    api.map.off('mousemove', onDraftMove);
    api.map.off('dblclick', finishDrawing);
    api.map.getContainer().style.cursor = '';
    // Двойной щелчок, которым закончили контур, не должен приблизить карту
    setTimeout(() => api.map.doubleClickZoom.enable(), 300);
    draft.line.remove();
    draft.note.remove();
    draft = null;
  }

  function onDraftClick(e) {
    const last = draft.points[draft.points.length - 1];
    // Двойной щелчок приходит ещё и двумя одиночными: вторую вершину в ту же точку не ставим
    if (last && api.map.latLngToContainerPoint(last).distanceTo(e.containerPoint) < 6) return;
    draft.points.push(e.latlng);
    draft.line.setLatLngs(draft.points);
  }

  function onDraftMove(e) {
    if (!draft.points.length) return;
    draft.line.setLatLngs([...draft.points, e.latlng, draft.points[0]]);
  }

  function finishDrawing() {
    const polygon = draft.points.map((p) => [p.lat, p.lng]);
    stopDrawing();
    if (polygon.length < 3) {
      api.toast('Контур не замкнут: нужно не меньше трёх вершин');
      return;
    }
    const inside = stations.filter((s) => !s.demo && s.position && G.pointInPolygon(s.position.lat, s.position.lon, polygon));
    if (inside.length < 3) {
      api.toast(`Внутри контура ${inside.length} ${api.fmt.plural(inside.length, 'станция', 'станции', 'станций')} с известным положением, а для подсети нужно не меньше трёх`, 7000);
      return;
    }
    askName(polygon, inside);
  }

  // ---------- Окно с названием ----------

  let dialog = null;

  function askName(polygon, inside) {
    const { esc } = api.fmt;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'dialog';
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = `<form method="dialog" novalidate>
      <h2>Новая подсеть</h2>
      <p class="hint">В контур попало ${inside.length} ${api.fmt.plural(inside.length, 'станция', 'станции', 'станций')}: ${esc(inside.map((s) => s.name).join(', '))}.</p>
      <label class="field"><span>Название</span><input name="name" type="text" maxlength="60" autocomplete="off" value="Подсеть ${subnets.length + 1}"></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="dialog-actions">
        <button class="btn btn-quiet" type="button" data-cancel>Отмена</button>
        <button class="btn btn-primary" type="submit">Создать</button>
      </div>
    </form>`;
    const form = dialog.querySelector('form');
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const saved = await api.core.saveSubnet({ name: form.elements.name.value, polygon, stationIds: inside.map((s) => s.id) });
        subnets = await api.core.listSubnets();
        dialog.close();
        select(saved.id);
      } catch (err) {
        const el = dialog.querySelector('.form-error');
        el.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        el.hidden = false;
      }
    });
    dialog.showModal();
    form.elements.name.select();
  }

  // ---------- Выбор и панели ----------

  function select(id) {
    selectedId = id;
    confirmRemove = null;
    redraw();
    api.rerender();
  }

  function deselect() {
    if (selectedId === null) return;
    selectedId = null;
    confirmRemove = null;
    redraw();
  }

  // Подсети для каталога слева: под каждой показываются её станции
  function groups() {
    return subnets.map((subnet) => {
      const d = describe(subnet);
      return {
        id: subnet.id,
        name: subnet.name,
        mark: MARK,
        cls: stateClass(d),
        online: d.online,
        total: d.known.length,
        stationIds: d.known.map((s) => s.id),
        selected: subnet.id === selectedId,
      };
    });
  }

  // Панель справа. Возвращает true, если выбрана подсеть и панель занята ею.
  function renderInspector(setHtml, $) {
    const subnet = subnets.find((s) => s.id === selectedId);
    if (!subnet) return false;
    const { esc, num, plural, NBSP } = api.fmt;
    const d = describe(subnet);
    const n = d.known.length;
    const removing = confirmRemove === subnet.id;
    const up = d.lines.filter((l) => l.up).length;

    setHtml($('ins-head'), `<div class="ins-section">
      <h1 class="head-name">${esc(subnet.name)}</h1>
      <p class="head-endpoint">Подсеть: ${n} ${plural(n, 'станция', 'станции', 'станций')}, ${d.lines.length} ${plural(d.lines.length, 'базовая линия', 'базовые линии', 'базовых линий')}</p>
      <p class="head-state ${stateClass(d)}"><span>На связи ${d.online} из ${n}<small>линий в работе: ${up} из ${d.lines.length}</small></span></p>
      <div class="head-actions">
        <button class="btn btn-quiet btn-small" type="button" data-subnet-action="show">Показать на карте</button>
        <button class="btn btn-quiet btn-small ${removing ? 'btn-danger' : ''}" type="button" data-subnet-action="remove">${removing ? 'Точно удалить?' : 'Удалить'}</button>
      </div>
    </div>`);

    const rows = d.lines.slice().sort((x, y) => x.length - y.length).map((l) => `<tr>
      <td colspan="2">${esc(l.a.name)} — ${esc(l.b.name)}</td>
      <td class="fig">${num(l.length / 1000, 3)}${NBSP}км</td>
      <td class="fig">${l.up ? l.common : '—'}</td>
    </tr>`).join('');
    let notes = '';
    if (d.placed.length < n) notes += `<p class="notice">У ${n - d.placed.length} ${plural(n - d.placed.length, 'станции', 'станций', 'станций')} пока нет координат: линии к ним появятся, когда придут данные.</p>`;
    if (d.missing) notes += `<p class="notice">${d.missing} ${plural(d.missing, 'станция удалена', 'станции удалены', 'станций удалено')} из списка и в подсети больше не участвует.</p>`;
    setHtml($('ins-position'), `<div class="ins-section ins-rule">
      <h2 class="ins-title"><span>Базовые линии</span><span class="fig">${d.lines.length}</span></h2>
      ${rows ? `<table class="messages subnet-lines">
        <thead><tr><th colspan="2">Линия</th><th>Длина</th><th>Общих сп.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
      ${notes}
      <p class="source">Длина — расстояние по прямой между координатами станций из их потоков. Общие спутники — те, что одновременно видят обе станции линии. Решение по фазовым измерениям пока не считается.</p>
    </div>`);

    const list = d.known.map((s) => `<tr>
      <td colspan="2">${esc(s.name)}</td>
      <td>${s.link.state === 'online' ? 'на связи' : 'нет связи'}</td>
      <td class="fig">${s.satTotal}</td>
    </tr>`).join('');
    setHtml($('ins-sats'), `<div class="ins-section ins-rule">
      <h2 class="ins-title"><span>Станции подсети</span><span class="fig">${n}</span></h2>
      <table class="messages subnet-lines">
        <thead><tr><th colspan="2">Станция</th><th>Связь</th><th>Спутников</th></tr></thead>
        <tbody>${list}</tbody>
      </table>
    </div>`);
    for (const id of ['ins-stream', 'ins-messages', 'ins-log']) setHtml($(id), '');
    return true;
  }

  // Действия из каталога: показать подсеть на карте, удалить без лишних вопросов
  function show(id) {
    const subnet = subnets.find((x) => x.id === id);
    if (subnet) api.fit(subnet.polygon);
  }

  async function remove(id) {
    await api.core.removeSubnet(id);
    subnets = await api.core.listSubnets();
    if (selectedId === id) selectedId = null;
    confirmRemove = null;
    redraw();
    api.rerender();
  }

  async function onAction(action) {
    const subnet = subnets.find((s) => s.id === selectedId);
    if (!subnet) return;
    if (action === 'show') {
      api.fit(subnet.polygon);
    } else if (action === 'remove') {
      if (confirmRemove !== subnet.id) {
        confirmRemove = subnet.id;
        api.rerender();
        setTimeout(() => {
          if (confirmRemove === subnet.id) {
            confirmRemove = null;
            api.rerender();
          }
        }, 4000);
        return;
      }
      await api.core.removeSubnet(subnet.id);
      subnets = await api.core.listSubnets();
      selectedId = null;
      confirmRemove = null;
      redraw();
      api.rerender();
      api.toast('Подсеть удалена');
    }
  }

  // ---------- Запуск ----------

  async function init(options) {
    api = options;
    subnets = await api.core.listSubnets();

    api.addCommand({
      id: 'subnet',
      label: 'Подсеть',
      icon: ICON,
      run: startDrawing,
    }, 'demo');

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && draft) stopDrawing();
    });
    document.getElementById('ins-head').addEventListener('click', (event) => {
      const el = event.target.closest('[data-subnet-action]');
      if (el) onAction(el.dataset.subnetAction);
    });
    api.rerender();
  }

  function update(list) {
    stations = list;
    if (api) redraw();
  }

  return { init, update, select, deselect, selected: () => selectedId, groups, renderInspector, show, remove, draw: startDrawing, icon: ICON };
})();
