/* Невидимая часть бота: живёт на доске, ловит новые картинки и нажатия на кнопки карточек. */
(function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  const seen = new Set(); // картинки, про которые бот уже спрашивал
  let user; // undefined = ещё не спрашивали
  const busy = new Set();
  let cache = { at: 0, batches: [] }; // батчи с картой кнопок, чтобы не читать хранилище на каждый клик
  let online = { at: 0, names: [] };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  async function me(fresh) {
    if (fresh || user === undefined) {
      try { const u = await board.getUserInfo(); user = { id: u.id, name: u.name || '' }; } catch (e) { user = { id: null, name: '' }; }
    }
    return user;
  }
  async function onlineNames() {
    if (Date.now() - online.at > 30000) {
      try { online = { at: Date.now(), names: (await board.getOnlineUsers()).map((u) => u.name).filter(Boolean) }; } catch (e) { online = { at: Date.now(), names: [] }; }
    }
    return online.names;
  }

  const diagOn = () => { try { return localStorage.getItem('sgg:diag') !== '0'; } catch (e) { return true; } };
  async function note(text) {
    try { await board.notifications.showInfo(String(text).slice(0, 78)); } catch (e) { /* подсказка не критична */ }
  }
  const diag = (text) => (diagOn() ? note('Bot: ' + text) : null);
  // С включённой диагностикой бот дописывает, сколько секунд заняло действие, — так видно, где доска отвечает медленно.
  const secs = (t0) => (diagOn() ? ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с' : '');

  async function openPanel(data) {
    if (!(await board.ui.canOpenPanel())) return false;
    // Версия в адресе — чтобы после обновления бота браузер не подсунул старую панель из кэша.
    await board.ui.openPanel({ url: new URL('panel.html?v=' + SGG.VERSION, window.location.href).href, data: data || {} });
    return true;
  }

  // ---------- версия ----------
  // Вкладка с доской может быть открыта давно, а бот за это время обновился. Старая невидимая часть не узнаёт
  // карточки нового формата, и кнопки молчат. Поэтому она сама проверяет, не вышла ли новая версия, и говорит об этом.
  let newer = null, checkedAt = 0;
  const staleText = () => 'Вышла версия бота ' + newer + '. Обнови страницу доски';
  async function checkVersion(force) {
    if (!force && Date.now() - checkedAt < 30000) return newer;
    checkedAt = Date.now();
    const v = await SGG.latestVersion();
    if (v && v !== SGG.VERSION && v !== newer) { newer = v; note(staleText()); }
    return newer;
  }
  let boardId; // панель спрашивает по каналу, жива ли невидимая часть на этой доске и какой она версии
  async function myBoard() {
    if (boardId === undefined) { try { boardId = (await board.getInfo()).id; } catch (e) { boardId = null; } }
    return boardId;
  }
  let channel = null;
  try {
    channel = new BroadcastChannel(SGG.CHANNEL);
    channel.onmessage = async (e) => {
      if (e.data && e.data.ask === 'headless') channel.postMessage({ headless: SGG.VERSION, board: await myBoard(), to: e.data.from });
    };
  } catch (e) { /* без канала панель просто не сможет проверить версию */ }
  const tell = (msg) => { try { if (channel) channel.postMessage(msg); } catch (e) { /* панель узнает при следующем открытии */ } };

  // ---------- имя персонажа поправили руками на карточке ----------
  // Miro не сообщает, что текст изменился. Зато плашку имени при правке выделяют: когда выделение с неё уходит,
  // бот перечитывает текст и, если он другой, переписывает подписи в Comparison Deck.
  let lastName = null; // { batch, charId, id } — плашка имени, выделенная прямо сейчас
  async function checkName(n, again) {
    try {
      const it = await core.getItem(n.id);
      if (!it) return;
      const ch = n.batch.chars.find((c) => c.id === n.charId), from = ch.name, to = SGG.plainText(it.content).slice(0, 60);
      if (!to || to === from) { if (again) setTimeout(() => checkName(n, false), 1600); return; } // текст мог ещё не сохраниться
      if (await core.renameChar(n.batch, n.charId, to)) { note('Имя обновлено: ' + from + ' → ' + to); tell({ changed: 'names', batch: n.batch.id }); }
    } catch (e) { console.error('[SGG bot]', e); diag('имя не обновилось: ' + (e && e.message ? e.message : e)); }
  }
  async function onName(items) {
    try {
      const one = items && items.length === 1 && items[0].type === 'shape' ? items[0] : null;
      const prev = lastName;
      lastName = null;
      if (one) {
        for (const b of await batches(false)) {
          const ch = b.chars.find((c) => b.ui[c.id] && b.ui[c.id].name === one.id);
          if (ch) { lastName = { batch: b, charId: ch.id, id: one.id }; break; }
        }
      }
      if (prev && !(lastName && lastName.id === prev.id)) setTimeout(() => checkName(prev, true), 400);
    } catch (e) { console.error('[SGG bot]', e); }
  }

  async function batches(force) {
    if (force || Date.now() - cache.at > 20000) cache = { at: Date.now(), batches: await core.loadBatchesFull() };
    return cache.batches;
  }

  // Новую картинку ловим двумя путями: событием создания и тем, что Miro сам выделяет только что добавленное.
  async function onImages(source, items, requireFresh) {
    try {
      const all = items || [];
      if (!all.some((i) => i.type === 'image')) return;
      const res = SGG.pickImages(all, { uid: (await me()).id, seen, requireFresh, now: Date.now() });
      if (!res.take.length) {
        const loud = res.why.filter((w) => w !== 'картинка бота' && w !== 'уже видел' && w !== 'старая');
        if (loud.length) diag(source + ': пропуск — ' + res.why.join(', '));
        return;
      }
      if (!(await batches(true)).length) { diag(source + ': на доске нет батча'); return; }
      res.take.forEach((i) => seen.add(i.id));
      await openPanel({ itemIds: res.take.map((i) => i.id) });
    } catch (e) {
      console.error('[SGG bot]', e);
      diag('ошибка: ' + (e && e.message ? e.message : e));
    }
  }

  // Кнопки на доске. Плашка статуса и плашки Sketch / Render раскрывают список прямо под собой; History раскрывает историю.
  let menu = null; // открытый список: { batch, charId, phase|null, current, map, items, at, anchor, anchorId, timer }

  async function closeMenu(pick) { // pick === null — закрыли, ничего не выбрав
    const m = menu;
    if (!m) return;
    menu = null;
    clearTimeout(m.timer);
    const jobs = [core.closeMenu(m.batch, m.charId, m.items)];
    const name = m.batch.chars.find((c) => c.id === m.charId).name, t0 = Date.now();
    let done = '';
    if (pick !== null && pick !== m.current) { // список убирается и карточка перекрашивается одновременно
      if (m.phase) {
        jobs.push(core.setAssign(m.batch, m.charId, m.phase, pick, m.anchor));
        done = name + ' · ' + SGG.PHASES.find((p) => p.id === m.phase).label + ' → ' + (pick || 'никто');
      } else {
        jobs.push(core.setStatus(m.batch, m.charId, pick, m.anchor));
        done = name + ' → ' + SGG.STATUS_BY_ID[pick].label;
      }
    }
    await Promise.all(jobs);
    if (done) note(done + secs(t0));
  }

  async function openMenuFor(hit, anchor) {
    const phase = hit.action.indexOf('as:') === 0 ? hit.action.slice(3) : null;
    let current, options;
    if (phase) {
      const got = await Promise.all([core.getChar(hit.batch.id, hit.charId), core.getTeam(hit.batch.id), me(true), onlineNames()]);
      current = (got[0].assign || {})[phase] || '';
      options = core.assignOptions(got[1], current, got[2].name, got[3]);
      if (!options.length) { note('Некого выбрать: добавь имена в панели бота → Команда'); return; }
    } else {
      current = (await core.getChar(hit.batch.id, hit.charId)).status;
      options = core.statusOptions(current);
    }
    const res = await core.openMenu(hit.batch, hit.charId, anchor, options);
    menu = { batch: hit.batch, charId: hit.charId, phase, current, map: res.map, items: res.items, at: Date.now(), anchor, anchorId: anchor.id, timer: setTimeout(() => closeMenu(null).catch(() => {}), 20000) };
  }

  async function onHistory(hit) {
    const t0 = Date.now();
    const res = await core.toggleHistory(hit.batch, hit.charId);
    if (!res.count) { note('У этого персонажа пока нет прошлых сабмитов'); return; }
    if (diagOn()) note((res.open ? 'История раскрыта' : 'История свёрнута') + secs(t0));
    if (!res.open || res.focus.length < 2) return;
    // Экран двигаем, только если раскрытая карточка не помещается.
    try {
      const vp = await board.viewport.get();
      const top = Math.min(...res.focus.map((i) => i.y - i.height / 2)), bottom = Math.max(...res.focus.map((i) => i.y + i.height / 2));
      if (top < vp.y || bottom > vp.y + vp.height) await board.viewport.zoomTo(res.focus);
    } catch (e) { /* не критично */ }
  }

  /** Нажали на плашку карточки, которую бот не узнал. Говорим почему, а не молчим. */
  async function unknownButton() {
    let list = [];
    try { list = await core.listBatches(); } catch (e) { /* хранилище недоступно */ }
    if (list.some((b) => b.v > SGG.FORMAT) || (await checkVersion(true))) { note(newer ? staleText() : 'Бот на этой вкладке устарел. Обнови страницу доски'); return; }
    if (list.some((b) => b.v < SGG.FORMAT)) { note('Этот батч от старой версии бота. Открой панель — она предложит пересоздать'); return; }
    diag('эта плашка не из моего батча · батчей вижу: ' + cache.batches.length);
  }

  async function onButton(items) {
    try {
      const one = items && items.length === 1 && items[0].type === 'shape' ? items[0] : null;
      if (menu) {
        if (one && has(menu.map, one.id)) { await closeMenu(menu.map[one.id]); return; } // выбрали строку списка
        const fresh = Date.now() - menu.at < 500; // сразу после открытия Miro шлёт пустое выделение — не закрываемся
        if (!fresh && !(one && one.id === menu.anchorId)) await closeMenu(null); // кликнули мимо списка
      }
      if (!one) return;
      let hit = core.findButton(await batches(false), one.id);
      if (!hit && /▾|History/.test(String(one.content || ''))) {
        // Похоже на кнопку карточки, но бот её не знает: батч только что построили или он от другой версии бота.
        hit = core.findButton(await batches(true), one.id);
        if (!hit) { await unknownButton(); return; }
      }
      if (!hit) return;
      const unselect = Promise.resolve().then(() => board.deselect({ id: one.id })).catch(() => {}); // рамку выделения снимаем, не дожидаясь ответа
      const key = hit.batch.id + ':' + hit.charId + ':' + hit.action;
      if (busy.has(key)) return; // второе нажатие, пока первое ещё выполняется
      busy.add(key);
      try {
        if (hit.action === 'hist') { await onHistory(hit); return; }
        const same = menu && menu.anchorId === one.id;
        if (menu) await closeMenu(null);
        if (!same) { await unselect; await openMenuFor(hit, one); } // повторный клик по той же плашке просто закрывает список
      } finally { busy.delete(key); }
    } catch (e) {
      console.error('[SGG bot]', e);
      diag('ошибка: ' + (e && e.message ? e.message : e));
    }
  }

  board.ui.on('icon:click', () => openPanel());
  checkVersion(true);
  setInterval(() => checkVersion(true), 10 * 60 * 1000);
  board.ui.on('items:create', (e) => onImages('items:create', e.items, false));
  board.ui.on('selection:update', (e) => { onImages('selection', e.items, true); onButton(e.items); onName(e.items); });
})();
