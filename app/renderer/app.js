'use strict';
// Окно: список станций, карта, панель выбранной станции, форма подключения.

(() => {
  const { esc, num, dms, rate, bytes, duration, clock, plural, interval, NBSP } = window.Fmt;
  const core = window.core;
  const $ = (id) => document.getElementById(id);

  const state = {
    stations: [], // снимки состояния от ядра
    configs: [], // сохранённые настройки подключений
    selectedId: null,
    demo: false,
    confirmRemove: null,
    coordSys: 'geo', // в чём показывать положение: 'geo' или система из модуля координат
  };

  // Модуль «Подсети» подключается отдельным файлом; до загрузки списка подсетей он молчит
  let Subnets = null;

  // Модуль «Системы координат» подключается отдельным файлом; без него остаются широта и долгота
  const CoordSys = window.CoordSys || null;
  try {
    const saved = localStorage.getItem('coordsys');
    if (saved && CoordSys && CoordSys.list().some((s) => s.id === saved)) state.coordSys = saved;
  } catch (err) { /* выбор просто не запомнится */ }

  const MARK = '<svg class="station-mark" viewBox="0 0 28 26" aria-hidden="true"><path d="M14 2.5 25.5 23h-23Z"/><circle cx="14" cy="16" r="2.6"/></svg>';

  const MODE_HINTS = {
    tcp: 'Программа сама подключается к адресу и порту, с которого приёмник или сервер отдаёт поток.',
    ntrip: 'Программа подключается к кастеру как обычный NTRIP-клиент и берёт поток с указанной точки подключения.',
    listen: 'Программа открывает порт на этом компьютере и ждёт, пока приёмник подключится к нему сам.',
  };

  // Меняем разметку, только если она действительно изменилась
  const cache = new WeakMap();
  function setHtml(el, html) {
    if (cache.get(el) === html) return;
    cache.set(el, html);
    el.innerHTML = html;
  }

  function stateClass(st) {
    switch (st.link.state) {
      case 'online': return 'is-online';
      case 'connecting': case 'waiting': case 'listening': return 'is-wait';
      case 'idle': return '';
      default: return 'is-fail';
    }
  }

  function stateLine(st) {
    const l = st.link;
    switch (l.state) {
      case 'online': return 'Данные идут';
      case 'connecting': return 'Подключаемся…';
      case 'waiting': return 'Соединение есть, ждём данные';
      case 'listening': return 'Ждём подключения приёмника';
      case 'retry': return 'Нет связи';
      case 'error': return 'Остановлено';
      default: return 'Отключено';
    }
  }

  function upperFirst(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : text;
  }

  // ---------- Верхняя полоса ----------

  function renderSummary() {
    const n = state.stations.length;
    if (!n) {
      setHtml($('summary'), 'Станций пока нет');
      return;
    }
    const online = state.stations.filter((s) => s.link.state === 'online').length;
    // Один и тот же спутник видят многие станции: считаем разные спутники, а не сумму по станциям
    const seen = new Set();
    for (const s of state.stations) {
      for (const c of s.constellations) for (const sat of c.sats) seen.add(sat.label);
    }
    const sats = seen.size;
    let text = `<b>${online} из ${n}</b> ${plural(n, 'станции', 'станций', 'станций')} на связи`;
    if (online) text += `, в слежении <b>${sats}</b> ${plural(sats, 'спутник', 'спутника', 'спутников')}`;
    setHtml($('summary'), text);
  }

  // ---------- Список станций ----------

  // Строка станции в каталоге — всегда одна строка: справа число спутников или короткое
  // состояние. Причина сбоя — во всплывающей подсказке и в панели станции.
  function stationRow(st, child) {
    const online = st.link.state === 'online';
    let figures;
    let hint = '';
    if (online) {
      figures = `<span class="station-figures fig" title="Спутников в слежении">${st.satTotal}</span>`;
    } else {
      const short = { connecting: 'подключение', waiting: 'ждём данные', listening: 'ждём приёмник', retry: 'нет связи', error: 'ошибка', idle: 'остановлена' }[st.link.state] || 'отключено';
      figures = `<span class="station-figures">${short}</span>`;
      hint = st.link.detail ? ` title="${esc(upperFirst(st.link.detail.split(';')[0]))}"` : '';
    }
    const selected = st.id === state.selectedId && !(Subnets && Subnets.selected());
    return `<button class="station ${stateClass(st)}${child ? ' is-child' : ''}" type="button" data-id="${esc(st.id)}" aria-current="${selected}"${hint}>
      ${MARK}
      <span class="station-name">${esc(st.name)}</span>
      ${figures}
    </button>`;
  }

  // Блоки каталога сворачиваются щелчком по заголовку; выбор запоминается
  let foldedBlocks = [];
  try { foldedBlocks = JSON.parse(localStorage.getItem('blocks') || '[]'); } catch (err) { /* все развёрнуты */ }

  function blockHead(id, title, count) {
    return `<button class="cat-head" type="button" data-block="${id}" aria-expanded="${!foldedBlocks.includes(id)}">
      <span>${title}</span><span class="fig">${count}</span>
    </button>`;
  }

  function renderRail() {
    const n = state.stations.length;
    const online = state.stations.filter((s) => s.link.state === 'online').length;
    $('rail-count').textContent = n ? `${online}/${n}` : '';

    // Блок «Станции»: все базовые станции сети
    let html = blockHead('stations', 'Станции', n ? `${online}/${n}` : '0');
    if (!foldedBlocks.includes('stations')) {
      html += n
        ? state.stations.map((st) => stationRow(st, false)).join('')
        : '<div class="rail-empty">Станций пока нет. Правый щелчок по заголовку блока — добавить.</div>';
    }

    // Блок «Подсети»: под каждой подсетью — её станции
    if (Subnets) {
      const groups = Subnets.groups();
      const byId = new Map(state.stations.map((s) => [s.id, s]));
      html += blockHead('subnets', 'Подсети', String(groups.length));
      if (!foldedBlocks.includes('subnets')) {
        if (!groups.length) html += '<div class="rail-empty">Подсетей пока нет. Правый щелчок по заголовку блока — обвести новую.</div>';
        for (const g of groups) {
          html += `<button class="station is-group ${g.cls}" type="button" data-subnet="${esc(g.id)}" aria-current="${g.selected}">
            ${g.mark}
            <span class="station-name">${esc(g.name)}</span>
            <span class="station-figures fig" title="Станций на связи">${g.online}/${g.total}</span>
          </button>`;
          for (const id of g.stationIds) {
            const st = byId.get(id);
            if (st) html += stationRow(st, true);
          }
        }
      }
    }
    setHtml($('rail'), html);
  }

  // ---------- Панель станции ----------

  function renderHead(st) {
    const l = st.link;
    let sub = '';
    if (l.state === 'online') sub = `на связи ${duration(Date.now() - l.stateSince)}`;
    else if (l.detail) sub = upperFirst(l.detail);
    // Кнопки лежат в отдельном блоке: он не перерисовывается каждую секунду, и нажатие не теряется
    const removing = state.confirmRemove === st.id;
    setHtml($('ins-head'), `<div class="ins-section">
      <h1 class="head-name">${esc(st.name)}</h1>
      <p class="head-endpoint fig">${esc(st.endpoint)}</p>
      <div id="head-state-slot"></div>
      <div class="head-actions">
        <button class="btn btn-quiet btn-small" type="button" data-action="reconnect">Переподключить</button>
        ${st.demo ? '' : `<button class="btn btn-quiet btn-small" type="button" data-action="edit">Изменить</button>
        <button class="btn btn-quiet btn-small ${removing ? 'btn-danger' : ''}" type="button" data-action="remove">${removing ? 'Точно удалить?' : 'Удалить'}</button>`}
      </div>
    </div>`);
    setHtml($('head-state-slot'), `<p class="head-state ${stateClass(st)}"><span>${esc(stateLine(st))}${sub ? `<small>${esc(sub)}</small>` : ''}</span></p>`);
  }

  function renderPosition(st) {
    const p = st.position;
    if (!p && st.probe && st.link.state !== 'online') {
      setHtml($('ins-position'), `<div class="ins-section ins-rule">
        <h2 class="ins-title">Почему нет данных</h2>
        ${probeHtml(st.probe)}
      </div>`);
      return;
    }
    if (!p) {
      const note = st.positionNote
        || (st.link.state === 'online' ? 'Координаты станции пока не получены.' : 'Координаты появятся, когда пойдут данные.');
      setHtml($('ins-position'), `<div class="ins-section ins-rule">
        <h2 class="ins-title">Положение станции</h2>
        <p class="notice ${st.positionNote ? '' : 'is-plain'}">${esc(note)}</p>
      </div>`);
      return;
    }
    const exact = p.source === 'rtcm';
    const lat = dms(p.lat, 'lat', exact ? 5 : 1);
    const lon = dms(p.lon, 'lon', exact ? 5 : 1);
    const d = exact ? 4 : 0;
    let source;
    if (exact) {
      source = `Координаты переданы самой станцией в сообщении ${p.messageType}.`;
      if (p.antennaHeight !== null) source += ` Высота антенны ${num(p.antennaHeight, 4)}${NBSP}м.`;
    } else if (p.source === 'computed') {
      const spread = p.sigma === null ? '' : `, разброс ±${num(p.sigma, 1)}${NBSP}м`;
      source = `<b>Вычислено по наблюдениям</b>: в потоке координат станции нет. Среднее за ${num(p.epochs)} ${plural(p.epochs, 'эпоху', 'эпохи', 'эпох')}${spread}, в решении ${p.satsUsed} ${plural(p.satsUsed, 'спутник', 'спутника', 'спутников')} GPS${p.dualFrequency ? ', две частоты' : ', одна частота'}. Точность метровая, это не каталожные координаты пункта.`;
    } else {
      source = 'Координаты взяты из строки NMEA GGA приёмника. Точность зависит от режима его работы.';
    }
    // Система координат выбирается в меню отображения справа вверху
    const flat = CoordSys && state.coordSys !== 'geo' ? CoordSys.convert(state.coordSys, p.ecef) : null;
    let rows;
    if (flat) {
      const fd = exact ? 3 : 0;
      rows = `<dt>Север, X</dt><dd class="fig">${num(flat.north, fd)}<span>м</span></dd>
        <dt>Восток, Y</dt><dd class="fig">${num(flat.east, fd)}<span>м</span></dd>
        <dt>Высота</dt><dd class="fig">${num(p.h, exact ? 3 : 0)}<span>м над эллипсоидом WGS-84</span></dd>`;
      source += ` Плоские координаты: ${esc(flat.name)}, зона ${flat.zone}, на основе ${esc(flat.datum)}.`;
      if (!flat.verified) source += ' <b>Параметры пересчёта с каталогом не сверены</b>: расхождение с каталожными координатами может достигать метров.';
    } else {
      rows = `<dt>Широта</dt><dd class="fig">${lat.text}<span>${lat.hemi}</span></dd>
        <dt>Долгота</dt><dd class="fig">${lon.text}<span>${lon.hemi}</span></dd>
        <dt>Высота</dt><dd class="fig">${num(p.h, exact ? 3 : 0)}<span>м над эллипсоидом</span></dd>`;
    }
    setHtml($('ins-position'), `<div class="ins-section ins-rule">
      <h2 class="ins-title"><span>Положение станции</span><span>${flat ? `${esc(flat.name)}, зона ${flat.zone}` : 'WGS-84'}</span></h2>
      <dl class="coords">
        ${rows}
      </dl>
      <dl class="ecef">
        <div><dt>X</dt><dd class="fig">${num(p.ecef[0], d)}<span>м</span></dd></div>
        <div><dt>Y</dt><dd class="fig">${num(p.ecef[1], d)}<span>м</span></dd></div>
        <div><dt>Z</dt><dd class="fig">${num(p.ecef[2], d)}<span>м</span></dd></div>
      </dl>
      <p class="source">${source}</p>
    </div>`);
  }

  // Что выяснила проверка порта, который принял соединение и молчит
  function probeHtml(probe) {
    if (probe.kind === 'caster') {
      const list = probe.mountpoints.map((m) => {
        const title = [m.format, m.details, m.systems, m.auth === 'N' ? 'без пароля' : 'нужен логин и пароль'].filter(Boolean).join(', ');
        return `<button class="btn btn-quiet btn-small" type="button" data-mount="${esc(m.name)}" title="${esc(title)}">${esc(m.name)}</button>`;
      }).join('');
      return `<p class="notice">Это порт NTRIP-кастера: сам по себе он поток не отдаёт, нужно выбрать точку подключения${probe.mountpoints.length ? '' : ', но список точек кастер не прислал'}.</p>
        ${list ? `<div class="mounts">${list}</div>` : ''}`;
    }
    if (probe.kind === 'stream') {
      return '<p class="notice">Порт начинает отдавать поток только после запроса. Переключите станцию в режим «NTRIP-кастер».</p>';
    }
    if (probe.kind === 'text') {
      return `<p class="notice">Порт отвечает текстом, а не потоком данных: «${esc(probe.text)}».</p>`;
    }
    if (probe.kind === 'silent' && probe.tunnel) {
      return `<p class="notice">Соединение идёт через VPN (${esc(probe.tunnel)}). Туннель принимает его сам, а данных от станции нет: похоже, до приёмника запрос не доходит. Выключите VPN или добавьте адрес станции в его исключения, и приложение подключится само.</p>`;
    }
    if (probe.kind === 'silent') {
      return '<p class="notice">Порт принимает соединение, но ничего не передаёт и на запрос NTRIP не отвечает. Так ведёт себя порт, на который приёмник сам отправляет поток: сервер там ждёт данные, а не раздаёт их. Второй вариант — источник сейчас молчит.</p>';
    }
    return `<p class="notice">Проверить порт не удалось: ${esc(probe.text)}.</p>`;
  }

  function renderSats(st) {
    if (!st.constellations.length) {
      setHtml($('ins-sats'), '');
      return;
    }
    const rows = st.constellations.map((c) => {
      const bars = c.sats.map((s) => {
        const cls = s.cnr === null ? 'is-blank' : (s.cnr < 32 ? 'is-weak' : '');
        const h = s.cnr === null ? 3 : Math.max(2, Math.min(24, Math.round((s.cnr - 20) / 35 * 24)));
        const title = s.cnr === null ? s.label : `${s.label}: ${num(s.cnr, 0)} дБ·Гц`;
        return `<span class="bar ${cls}" title="${esc(title)}"><span class="bar-track"><i style="height:${h}px"></i></span><span class="fig">${esc(s.label.slice(1))}</span></span>`;
      }).join('');
      const eph = st.ephemeris[c.key];
      const ephText = eph ? `эфемериды: ${eph} сп.` : '';
      return `<div class="sys">
        <div><div class="sys-name">${esc(c.name)}</div><div class="sys-count fig">${c.count}</div></div>
        <div class="bars">${bars}</div>
        <div class="sys-signals"><span class="fig">${esc(c.signals.join(' '))}</span><span>${esc(ephText)}</span></div>
      </div>`;
    }).join('');
    setHtml($('ins-sats'), `<div class="ins-section ins-rule">
      <h2 class="ins-title"><span>Спутники в слежении</span><span class="fig">${st.satTotal}</span></h2>
      ${rows}
    </div>`);
  }

  function renderStream(st) {
    const l = st.link;
    const d = st.descriptors;
    const facts = [];
    const add = (name, value, fig) => facts.push(`<dt>${name}</dt><dd${fig ? ' class="fig"' : ''}>${value}</dd>`);
    add('Формат', esc(st.format.label));
    if (l.state === 'online') add('Скорость', esc(rate(l.bitsPerSec)), true);
    add('Принято', esc(bytes(l.bytesTotal)), true);
    if (st.frames) add('Сообщений RTCM', num(st.frames), true);
    if (st.frames) add('Сбоев контрольной суммы', num(st.crcErrors), true);
    add('Переподключений', num(l.reconnects), true);
    if (st.relay) {
      const r = st.relay;
      add(`Раздача на порту ${r.port}`, r.error ? esc(r.error) : `${r.clients} ${plural(r.clients, 'клиент', 'клиента', 'клиентов')}`);
    }
    if (st.stationId !== null) add('Номер станции в потоке', String(st.stationId), true);
    if (d.receiver) add('Приёмник', esc([d.receiver, d.firmware].filter(Boolean).join(', ')));
    if (d.receiverSerial) add('Серийный номер приёмника', esc(d.receiverSerial), true);
    if (d.antenna) add('Антенна', esc(d.antenna));
    if (d.antennaSerial) add('Серийный номер антенны', esc(d.antennaSerial), true);
    setHtml($('ins-stream'), `<div class="ins-section ins-rule">
      <h2 class="ins-title">Поток</h2>
      <dl class="facts">${facts.join('')}</dl>
    </div>`);
  }

  function renderMessages(st) {
    if (!st.messages.length) {
      setHtml($('ins-messages'), '');
      return;
    }
    const rows = st.messages.map((m) => `<tr>
      <td class="fig">${m.type}</td>
      <td>${esc(m.name)}</td>
      <td class="fig">${esc(interval(m.intervalSec))}</td>
      <td class="fig">${num(m.count)}</td>
    </tr>`).join('');
    setHtml($('ins-messages'), `<div class="ins-section ins-rule">
      <h2 class="ins-title">Состав потока</h2>
      <table class="messages">
        <thead><tr><th>Тип</th><th>Что это</th><th>Период</th><th>Всего</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
  }

  function renderLog(st) {
    if (!st.log.length) {
      setHtml($('ins-log'), '');
      return;
    }
    const rows = st.log.slice(-30).reverse().map((e) => `<li class="is-${e.level}"><time class="fig">${clock(e.t)}</time><span>${esc(e.text)}${e.repeat > 1 ? ` (×${e.repeat})` : ''}</span></li>`).join('');
    setHtml($('ins-log'), `<div class="ins-section ins-rule">
      <h2 class="ins-title">Журнал</h2>
      <ol class="log">${rows}</ol>
    </div>`);
  }

  function renderInspector() {
    if (Subnets && Subnets.renderInspector(setHtml, $)) return;
    const st = state.stations.find((s) => s.id === state.selectedId);
    if (!st) {
      setHtml($('ins-head'), `<div class="inspector-empty"><img class="empty-emblem" src="assets/uci-emblem.svg" alt=""><b>Станция не выбрана</b>Добавьте станцию или выберите её в списке слева — здесь появятся состояние связи, координаты и состав потока.</div>`);
      for (const id of ['ins-position', 'ins-sats', 'ins-stream', 'ins-messages', 'ins-log']) setHtml($(id), '');
      return;
    }
    renderHead(st);
    renderPosition(st);
    renderSats(st);
    renderStream(st);
    renderMessages(st);
    renderLog(st);
  }

  function renderMapNote() {
    const el = $('map-note');
    const placed = state.stations.filter((s) => s.position).length;
    let text = '';
    if (state.stations.length && !placed) {
      text = 'Станций с известным положением пока нет. Точка появится на карте, когда придут координаты или накопятся эфемериды для расчёта.';
    }
    el.hidden = !text;
    if (text) el.textContent = text;
  }

  function render() {
    if (!state.stations.some((s) => s.id === state.selectedId)) {
      state.selectedId = state.stations.length ? state.stations[0].id : null;
    }
    renderSummary();
    renderRail();
    renderInspector();
    renderMapNote();
    window.StationMap.update(state.stations, state.selectedId);
    if (Subnets) Subnets.update(state.stations);
  }

  function select(id, focusMap) {
    if (Subnets) Subnets.deselect();
    state.selectedId = id;
    state.confirmRemove = null;
    render();
    if (focusMap) window.StationMap.focus(id);
    // Окно спутников, если открыто, показывает спутники выбранной станции
    const picked = state.stations.find((s) => s.id === id);
    if (picked && core.selectSky) core.selectSky(picked.name);
  }

  // ---------- Форма станции ----------

  const dialog = $('station-dialog');
  const form = $('station-form');
  let editingId = null;

  function syncMode() {
    const mode = form.elements.mode.value;
    $('mode-hint').textContent = MODE_HINTS[mode];
    for (const el of form.querySelectorAll('[data-modes]')) {
      el.hidden = !el.dataset.modes.split(' ').includes(mode);
    }
  }

  function openDialog(cfg) {
    editingId = cfg ? cfg.id : null;
    form.reset();
    $('form-error').hidden = true;
    $('dialog-title').textContent = cfg ? 'Настройки станции' : 'Новая станция';
    if (cfg) {
      form.elements.name.value = cfg.name;
      form.elements.mode.value = cfg.mode;
      form.elements.host.value = cfg.host || '';
      form.elements.port.value = cfg.port;
      form.elements.mountpoint.value = cfg.mountpoint || '';
      form.elements.username.value = cfg.username || '';
      form.elements.relayPort.value = cfg.relayPort || '';
      form.elements.password.placeholder = cfg.hasPassword ? 'сохранён, оставьте пустым' : '';
    } else {
      form.elements.password.placeholder = '';
    }
    syncMode();
    dialog.showModal();
    form.elements.name.focus();
  }

  form.addEventListener('change', syncMode);
  $('dialog-cancel').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = form.elements;
    try {
      const saved = await core.saveStation({
        id: editingId,
        name: f.name.value,
        mode: f.mode.value,
        host: f.host.value,
        port: f.port.value,
        mountpoint: f.mountpoint.value,
        username: f.username.value,
        password: f.password.value,
        relayPort: f.relayPort.value,
      });
      state.configs = await core.listStations();
      state.selectedId = saved.id;
      dialog.close();
    } catch (err) {
      const el = $('form-error');
      // Electron добавляет к тексту ошибки служебный префикс
      el.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      el.hidden = false;
    }
  });

  // ---------- Форма кастера ----------

  const casterDialog = $('caster-dialog');
  const casterForm = $('caster-form');

  function remoteError(err) {
    // Electron добавляет к тексту ошибки служебный префикс
    return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  async function openCasterDialog() {
    const d = await core.casterDefaults();
    casterForm.reset();
    $('caster-error').hidden = true;
    casterForm.elements.host.value = d.host || '';
    casterForm.elements.port.value = d.port || '';
    casterForm.elements.filter.value = d.filter || '';
    casterDialog.showModal();
    casterForm.elements.username.focus();
  }
  $('caster-cancel').addEventListener('click', () => casterDialog.close());

  casterForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = casterForm.elements;
    const btn = $('caster-save');
    btn.disabled = true;
    try {
      const res = await core.importCaster({
        host: f.host.value,
        port: f.port.value,
        username: f.username.value,
        password: f.password.value,
        filter: f.filter.value,
      });
      state.configs = await core.listStations();
      casterDialog.close();
      importToast(res);
    } catch (err) {
      const el = $('caster-error');
      el.textContent = remoteError(err);
      el.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // Итог добавления точек: сколько добавлено, что пропущено как повтор, что не получилось
  function importToast(res) {
    const parts = [];
    if (res.added) parts.push(`добавлено ${res.added} ${plural(res.added, 'станция', 'станции', 'станций')}`);
    if (res.updated) parts.push(`обновлён вход у ${res.updated}`);
    if (res.skipped.length) {
      const names = res.skipped.map((s) => (s.name === s.same ? s.name : `${s.name} = ${s.same}`)).join(', ');
      parts.push(`пропущено как повтор: ${names}`);
    }
    let text = parts.length ? upperFirst(parts.join(', ')) : 'Все эти точки уже есть в списке';
    const problems = res.problems || [];
    if (problems.length) text += `. Не получилось: ${problems.join('; ')}`;
    toast(text, res.skipped.length || problems.length ? 12000 : undefined);
  }

  // Загрузка станций из текстового списка кастеров
  async function importFromFile() {
    const btn = $('caster-file');
    btn.disabled = true;
    try {
      const res = await core.importCasterFile();
      if (!res) return; // файл не выбран
      state.configs = await core.listStations();
      if (casterDialog.open) casterDialog.close();
      importToast(res);
    } catch (err) {
      if (casterDialog.open) {
        const el = $('caster-error');
        el.textContent = remoteError(err);
        el.hidden = false;
      } else {
        toast(remoteError(err), 9000);
      }
    } finally {
      btn.disabled = false;
    }
  }
  $('caster-file').addEventListener('click', importFromFile);

  // ---------- Команды: выпадающее меню плитками ----------

  const ICONS = {
    station: '<path d="M12 4 21 20H3Z"/><circle cx="12" cy="15" r="1.4"/>',
    caster: '<path d="M12 21V11"/><path d="M8.5 14.5a5 5 0 0 1 0-7M15.5 7.5a5 5 0 0 1 0 7M6 17a8.5 8.5 0 0 1 0-12M18 5a8.5 8.5 0 0 1 0 12"/>',
    file: '<path d="M7 3h7l4 4v14H7Z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
    demo: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
    theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z" fill="currentColor"/>',
    sky: '<circle cx="12" cy="12" r="4.5"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-28 12 12)"/><circle cx="20.2" cy="7.6" r="1.2" fill="currentColor"/>',
  };

  // Модули добавляют сюда свои команды через addCommand
  const commands = [
    { id: 'station', label: 'Станция', icon: ICONS.station, run: () => openDialog(null) },
    { id: 'caster', label: 'С кастера', icon: ICONS.caster, run: openCasterDialog },
    { id: 'file', label: 'Из файла', icon: ICONS.file, run: importFromFile },
    { id: 'sky', label: 'Спутники 3D', icon: ICONS.sky, run: () => core.openSky() },
    {
      id: 'demo',
      label: () => (state.demo ? 'Убрать демо' : 'Демо-станции'),
      icon: ICONS.demo,
      run: async () => { state.demo = await core.setDemo(!state.demo); },
    },
    {
      id: 'theme',
      label: () => (window.Theme.current() === 'dark' ? 'Светлая тема' : 'Тёмная тема'),
      icon: ICONS.theme,
      run: () => {
        const next = window.Theme.current() === 'dark' ? 'light' : 'dark';
        window.Theme.set(next);
        core.setTheme(next);
      },
    },
  ];

  function addCommand(cmd, beforeId) {
    const i = commands.findIndex((c) => c.id === beforeId);
    if (i === -1) commands.push(cmd);
    else commands.splice(i, 0, cmd);
  }

  const menu = $('menu');
  function closeMenu() {
    menu.hidden = true;
    $('menu-btn').setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    menu.innerHTML = commands.map((c) => `<button class="tile" type="button" role="menuitem" data-cmd="${esc(c.id)}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${c.icon}</svg>
      <span>${esc(typeof c.label === 'function' ? c.label() : c.label)}</span>
    </button>`).join('');
    menu.hidden = false;
    $('menu-btn').setAttribute('aria-expanded', 'true');
  }
  $('menu-btn').addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-cmd]');
    if (!tile) return;
    closeMenu();
    const cmd = commands.find((c) => c.id === tile.dataset.cmd);
    if (cmd) cmd.run();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !event.target.closest('#menu, #menu-btn')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu();
  });

  // ---------- Правый щелчок в каталоге: действия плитками ----------

  function toggleBlock(id) {
    foldedBlocks = foldedBlocks.includes(id) ? foldedBlocks.filter((x) => x !== id) : [...foldedBlocks, id];
    try { localStorage.setItem('blocks', JSON.stringify(foldedBlocks)); } catch (err) { /* не запомнится */ }
    render();
  }

  async function removeStation(id) {
    await core.removeStation(id);
    state.configs = await core.listStations();
    state.stations = state.stations.filter((s) => s.id !== id);
    render();
  }

  const CTX_ICONS = {
    reconnect: '<path d="M19 12a7 7 0 1 1-2.2-5.1"/><path d="M19 4v4h-4"/>',
    edit: '<path d="M5 19l1-4L16 5l3 3L9 18Z"/><path d="M14 7l3 3"/>',
    map: '<path d="M12 21s6-5.6 6-10.5a6 6 0 0 0-12 0C6 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2"/>',
    remove: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    fold: '<path d="M5 8h14M5 12h14M5 16h9"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    play: '<path d="M8 5.5v13l10-6.5Z"/>',
  };

  // Какие действия доступны для строки каталога, по которой щёлкнули
  function contextActions(target) {
    const stationEl = target.closest('[data-id]');
    const subnetEl = target.closest('[data-subnet]');
    const blockEl = target.closest('[data-block]');
    if (stationEl) {
      const id = stationEl.dataset.id;
      const st = state.stations.find((s) => s.id === id);
      const cfg = state.configs.find((c) => c.id === id);
      if (!st) return null;
      const list = [
        { label: 'Обновить связь', icon: CTX_ICONS.reconnect, run: async () => { await core.reconnect(id); toast('Переподключаемся'); } },
        st.link.state === 'idle'
          ? { label: 'Запустить', icon: CTX_ICONS.play, run: async () => { await core.pauseStation(id, false); toast('Станция запущена'); } }
          : { label: 'Остановить', icon: CTX_ICONS.stop, run: async () => { await core.pauseStation(id, true); toast('Станция остановлена'); } },
        { label: 'На карте', icon: CTX_ICONS.map, run: () => select(id, true) },
        { label: 'Спутники 3D', icon: ICONS.sky, run: async () => { await core.openSky(); setTimeout(() => core.selectSky(st.name), 900); } },
      ];
      if (cfg && !st.demo) {
        list.push({ label: 'Изменить', icon: CTX_ICONS.edit, run: () => openDialog(cfg) });
        list.push({ label: 'Удалить', icon: CTX_ICONS.remove, danger: true, run: async () => { await removeStation(id); toast('Станция удалена'); } });
      }
      return { title: st.name, list };
    }
    if (subnetEl && Subnets) {
      const id = subnetEl.dataset.subnet;
      return {
        title: subnetEl.querySelector('.station-name').textContent,
        list: [
          { label: 'На карте', icon: CTX_ICONS.map, run: () => { Subnets.select(id, true); Subnets.show(id); } },
          { label: 'Удалить', icon: CTX_ICONS.remove, danger: true, run: async () => { await Subnets.remove(id); toast('Подсеть удалена'); } },
        ],
      };
    }
    if (blockEl && blockEl.dataset.block === 'stations') {
      const real = state.stations.filter((s) => !s.demo);
      const list = [
        { label: 'Станция', icon: ICONS.station, run: () => openDialog(null) },
        { label: 'С кастера', icon: ICONS.caster, run: openCasterDialog },
        { label: 'Из файла', icon: ICONS.file, run: importFromFile },
      ];
      if (real.length) {
        list.push({
          label: 'Обновить все связи',
          icon: CTX_ICONS.reconnect,
          run: async () => { for (const st of real) await core.reconnect(st.id); toast('Переподключаем все станции'); },
        });
        const running = real.filter((st) => st.link.state !== 'idle');
        if (running.length) {
          list.push({
            label: 'Остановить все',
            icon: CTX_ICONS.stop,
            run: async () => { for (const st of running) await core.pauseStation(st.id, true); toast('Все станции остановлены'); },
          });
        }
        if (running.length < real.length) {
          list.push({
            label: 'Запустить все',
            icon: CTX_ICONS.play,
            run: async () => { for (const st of real) if (st.link.state === 'idle') await core.pauseStation(st.id, false); toast('Станции запущены'); },
          });
        }
        list.push({
          label: 'Удалить все',
          icon: CTX_ICONS.remove,
          danger: true,
          run: async () => { for (const st of real) await removeStation(st.id); toast('Все станции удалены'); },
        });
      }
      list.push({ label: foldedBlocks.includes('stations') ? 'Развернуть' : 'Свернуть', icon: CTX_ICONS.fold, run: () => toggleBlock('stations') });
      return { title: 'Станции', list };
    }
    if (blockEl && blockEl.dataset.block === 'subnets' && Subnets) {
      return {
        title: 'Подсети',
        list: [
          { label: 'Новая подсеть', icon: Subnets.icon, run: () => Subnets.draw() },
          { label: foldedBlocks.includes('subnets') ? 'Развернуть' : 'Свернуть', icon: CTX_ICONS.fold, run: () => toggleBlock('subnets') },
        ],
      };
    }
    return null;
  }

  const ctx = $('ctx-menu');
  let ctxList = [];
  function closeCtx() { ctx.hidden = true; }
  function tileHtml(a, i, armed) {
    return `<button class="tile${a.danger ? ' is-danger' : ''}" type="button" role="menuitem" data-i="${i}"${armed ? ' data-armed="1"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${a.icon}</svg>
      <span>${esc(armed ? 'Точно?' : a.label)}</span>
    </button>`;
  }
  $('rail').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const actions = contextActions(event.target);
    if (!actions) { closeCtx(); return; }
    closeMenu();
    ctxList = actions.list;
    ctx.innerHTML = `<p class="menu-title">${esc(actions.title)}</p>${ctxList.map((a, i) => tileHtml(a, i, false)).join('')}`;
    ctx.hidden = false;
    // Меню не должно уйти за край окна
    const w = ctx.offsetWidth;
    const h = ctx.offsetHeight;
    ctx.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - w - 8))}px`;
    ctx.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - h - 8))}px`;
  });
  ctx.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-i]');
    if (!tile) return;
    const action = ctxList[Number(tile.dataset.i)];
    // Удаление срабатывает со второго нажатия
    if (action.danger && !tile.dataset.armed) {
      tile.outerHTML = tileHtml(action, Number(tile.dataset.i), true);
      return;
    }
    closeCtx();
    action.run();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!ctx.hidden && !event.target.closest('#ctx-menu')) closeCtx();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !ctx.hidden) closeCtx();
  });

  // ---------- Сворачивание разделов панели ----------

  const SECTIONS = ['ins-position', 'ins-sats', 'ins-stream', 'ins-messages', 'ins-log'];
  let collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem('collapsed') || '[]'); } catch (err) { /* начнём с развёрнутых */ }
  for (const id of SECTIONS) $(id).classList.toggle('is-collapsed', collapsed.includes(id));
  // Разделы перерисовываются раз в секунду, поэтому ловим нажатие, а не отпускание
  $('inspector').addEventListener('pointerdown', (event) => {
    const title = event.target.closest('.ins-title');
    if (!title || event.target.closest('button')) return;
    const box = title.closest(SECTIONS.map((id) => `#${id}`).join(', '));
    if (!box) return;
    const on = box.classList.toggle('is-collapsed');
    collapsed = collapsed.filter((id) => id !== box.id);
    if (on) collapsed.push(box.id);
    try { localStorage.setItem('collapsed', JSON.stringify(collapsed)); } catch (err) { /* не запомнится */ }
  });

  // ---------- Действия ----------

  // Список перерисовывается раз в секунду, поэтому выбираем по нажатию, а не по отпусканию кнопки
  for (const type of ['pointerdown', 'click']) {
    $('rail').addEventListener(type, (event) => {
      const block = event.target.closest('[data-block]');
      if (block) {
        if (type === 'click') toggleBlock(block.dataset.block);
        return;
      }
      const subnet = event.target.closest('[data-subnet]');
      if (subnet && Subnets) {
        if (subnet.dataset.subnet !== Subnets.selected()) Subnets.select(subnet.dataset.subnet);
        return;
      }
      const item = event.target.closest('[data-id]');
      if (item && (item.dataset.id !== state.selectedId || type === 'click')) select(item.dataset.id, true);
    });
  }

  $('ins-head').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const id = state.selectedId;
    const action = btn.dataset.action;
    if (action === 'reconnect') {
      await core.reconnect(id);
      toast('Переподключаемся');
    } else if (action === 'edit') {
      const cfg = state.configs.find((c) => c.id === id);
      if (cfg) openDialog(cfg);
    } else if (action === 'remove') {
      if (state.confirmRemove !== id) {
        state.confirmRemove = id;
        render();
        setTimeout(() => {
          if (state.confirmRemove === id) {
            state.confirmRemove = null;
            render();
          }
        }, 4000);
        return;
      }
      state.confirmRemove = null;
      await core.removeStation(id);
      state.configs = await core.listStations();
      state.stations = state.stations.filter((s) => s.id !== id);
      render();
      toast('Станция удалена');
    }
  });

  // ---------- Меню отображения справа: система координат ----------

  const VIEW_ICONS = {
    geo: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 2.6 3 13.4 0 16M12 4c-3 2.6-3 13.4 0 16"/>',
    flat: '<path d="M4 4h16v16H4ZM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  };
  const viewMenu = $('view-menu');
  function closeViewMenu() {
    viewMenu.hidden = true;
    $('view-btn').setAttribute('aria-expanded', 'false');
  }
  function openViewMenu() {
    const options = [{ id: 'geo', name: 'WGS-84' }, ...(CoordSys ? CoordSys.list() : [])];
    viewMenu.innerHTML = options.map((o) => `<button class="tile" type="button" role="menuitemradio" data-cs="${esc(o.id)}" aria-checked="${o.id === state.coordSys}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${o.id === 'geo' ? VIEW_ICONS.geo : VIEW_ICONS.flat}</svg>
      <span>${esc(o.name)}</span>
    </button>`).join('') + `<button class="tile" type="button" role="menuitem" data-open="sky">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.sky}</svg>
      <span>Спутники 3D</span>
    </button>`;
    viewMenu.hidden = false;
    $('view-btn').setAttribute('aria-expanded', 'true');
  }
  $('view-btn').addEventListener('click', () => (viewMenu.hidden ? openViewMenu() : closeViewMenu()));
  viewMenu.addEventListener('click', (event) => {
    if (event.target.closest('[data-open="sky"]')) {
      closeViewMenu();
      core.openSky();
      return;
    }
    const tile = event.target.closest('[data-cs]');
    if (!tile) return;
    state.coordSys = tile.dataset.cs;
    try { localStorage.setItem('coordsys', state.coordSys); } catch (err) { /* не запомнится */ }
    closeViewMenu();
    render();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!viewMenu.hidden && !event.target.closest('#view-menu, #view-btn')) closeViewMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !viewMenu.hidden) closeViewMenu();
  });

  // Выбор точки подключения из списка, который прислал кастер
  $('ins-position').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mount]');
    if (!btn) return;
    const cfg = state.configs.find((c) => c.id === state.selectedId);
    if (cfg) openDialog({ ...cfg, mode: 'ntrip', mountpoint: btn.dataset.mount });
  });

  let toastTimer = null;
  function toast(text, ms = 2600) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- Запуск ----------

  async function start() {
    window.StationMap.init((id) => select(id, false));
    core.setTheme(window.Theme.current());
    const info = await core.info();
    state.demo = info.demo;
    state.configs = await core.listStations();
    core.onSnapshot((list) => {
      state.stations = list;
      render();
    });
    render();
    if (window.Subnets && core.listSubnets) {
      await window.Subnets.init({ core, map: window.StationMap.map(), fit: window.StationMap.fit, fmt: window.Fmt, toast, rerender: render, addCommand });
      Subnets = window.Subnets;
      render();
    }
  }

  start();
})();
