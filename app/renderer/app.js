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
  };

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
    const sats = state.stations.reduce((sum, s) => sum + s.satTotal, 0);
    let text = `<b>${online} из ${n}</b> ${plural(n, 'станции', 'станций', 'станций')} на связи`;
    if (online) text += `, в слежении <b>${sats}</b> ${plural(sats, 'спутник', 'спутника', 'спутников')}`;
    setHtml($('summary'), text);
  }

  // ---------- Список станций ----------

  function renderRail() {
    if (!state.stations.length) {
      setHtml($('rail'), `<div class="rail-empty"><b>Список пуст</b>Добавьте станцию: нужен адрес и порт, с которого идёт её поток.</div>`);
      return;
    }
    const html = state.stations.map((st) => {
      const figures = st.link.state === 'online'
        ? `<span class="station-figures fig"><span><b>${esc(rate(st.link.bitsPerSec))}</b></span><span><b>${st.satTotal}</b> сп.</span></span>`
        : '';
      const detail = st.link.state === 'retry' || st.link.state === 'error'
        ? `: ${esc(st.link.detail.split(';')[0])}`
        : '';
      return `<button class="station ${stateClass(st)}" type="button" data-id="${esc(st.id)}" aria-current="${st.id === state.selectedId}">
        ${MARK}
        <span class="station-name">${esc(st.name)}</span>
        <span class="station-state">${esc(stateLine(st))}${detail}</span>
        ${figures}
      </button>`;
    }).join('');
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
    setHtml($('ins-position'), `<div class="ins-section ins-rule">
      <h2 class="ins-title">Положение станции</h2>
      <dl class="coords">
        <dt>Широта</dt><dd class="fig">${lat.text}<span>${lat.hemi}</span></dd>
        <dt>Долгота</dt><dd class="fig">${lon.text}<span>${lon.hemi}</span></dd>
        <dt>Высота</dt><dd class="fig">${num(p.h, exact ? 3 : 0)}<span>м над эллипсоидом</span></dd>
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
        const h = s.cnr === null ? 3 : Math.max(3, Math.min(34, Math.round((s.cnr - 20) / 35 * 34)));
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
  }

  function select(id, focusMap) {
    state.selectedId = id;
    state.confirmRemove = null;
    render();
    if (focusMap) window.StationMap.focus(id);
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

  $('caster-btn').addEventListener('click', async () => {
    const d = await core.casterDefaults();
    casterForm.reset();
    $('caster-error').hidden = true;
    casterForm.elements.host.value = d.host || '';
    casterForm.elements.port.value = d.port || '';
    casterForm.elements.filter.value = d.filter || '';
    casterDialog.showModal();
    casterForm.elements.username.focus();
  });
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
      const parts = [];
      if (res.added) parts.push(`добавлено ${res.added} ${plural(res.added, 'станция', 'станции', 'станций')}`);
      if (res.updated) parts.push(`обновлён вход у ${res.updated}`);
      toast(parts.length ? upperFirst(parts.join(', ')) : 'Все эти точки уже есть в списке');
    } catch (err) {
      const el = $('caster-error');
      el.textContent = remoteError(err);
      el.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Действия ----------

  $('add-btn').addEventListener('click', () => openDialog(null));

  $('demo-btn').addEventListener('click', async () => {
    state.demo = await core.setDemo(!state.demo);
    syncDemoButton();
  });

  function syncThemeButton() {
    $('theme-btn').textContent = window.Theme.current() === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }

  $('theme-btn').addEventListener('click', () => {
    const next = window.Theme.current() === 'dark' ? 'light' : 'dark';
    window.Theme.set(next);
    core.setTheme(next);
  });
  window.addEventListener('themechange', syncThemeButton);

  function syncDemoButton() {
    const btn = $('demo-btn');
    btn.textContent = state.demo ? 'Убрать демо-станции' : 'Показать демо-станции';
    btn.setAttribute('aria-pressed', String(state.demo));
  }

  // Список перерисовывается раз в секунду, поэтому выбираем по нажатию, а не по отпусканию кнопки
  for (const type of ['pointerdown', 'click']) {
    $('rail').addEventListener(type, (event) => {
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

  // Выбор точки подключения из списка, который прислал кастер
  $('ins-position').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mount]');
    if (!btn) return;
    const cfg = state.configs.find((c) => c.id === state.selectedId);
    if (cfg) openDialog({ ...cfg, mode: 'ntrip', mountpoint: btn.dataset.mount });
  });

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------- Запуск ----------

  async function start() {
    window.StationMap.init((id) => select(id, false));
    syncThemeButton();
    core.setTheme(window.Theme.current());
    const info = await core.info();
    state.demo = info.demo;
    syncDemoButton();
    state.configs = await core.listStations();
    core.onSnapshot((list) => {
      state.stations = list;
      render();
    });
    render();
  }

  start();
})();
