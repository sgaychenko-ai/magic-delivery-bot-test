/* Невидимая часть бота: живёт на доске, ловит новые картинки и нажатия на кнопки карточек. */
(function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  const seen = new Set(); // картинки, про которые бот уже спрашивал
  let myId; // undefined = ещё не спрашивали, null = узнать не удалось
  const busy = new Set();
  let cache = { at: 0, batches: [] }; // батчи с картой кнопок, чтобы не читать хранилище на каждый клик

  async function me() {
    if (myId === undefined) {
      try { myId = (await board.getUserInfo()).id; } catch (e) { myId = null; }
    }
    return myId;
  }

  const diagOn = () => { try { return localStorage.getItem('sgg:diag') !== '0'; } catch (e) { return true; } };
  async function note(text) {
    try { await board.notifications.showInfo(String(text).slice(0, 78)); } catch (e) { /* подсказка не критична */ }
  }
  const diag = (text) => (diagOn() ? note('Bot: ' + text) : null);

  async function openPanel(data) {
    if (!(await board.ui.canOpenPanel())) return false;
    await board.ui.openPanel({ url: new URL('panel.html', window.location.href).href, data: data || {} });
    return true;
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
      const res = SGG.pickImages(all, { uid: await me(), seen, requireFresh, now: Date.now() });
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

  // Кнопки на доске. Плашка статуса раскрывает список статусов прямо под собой; History раскрывает или сворачивает историю.
  let menu = null; // открытый список статусов: { batch, charId, map, at, tagId, timer }

  async function closeMenu(pick) {
    const m = menu;
    if (!m) return;
    menu = null;
    clearTimeout(m.timer);
    const res = await core.closeStatusMenu(m.batch, m.charId, pick);
    if (res.changed) note(m.batch.chars.find((c) => c.id === m.charId).name + ' → ' + SGG.STATUS_BY_ID[pick].label);
  }

  async function onButton(items) {
    try {
      const one = items && items.length === 1 && items[0].type === 'shape' ? items[0] : null;
      if (menu) {
        if (one && menu.map[one.id]) { await closeMenu(menu.map[one.id]); return; } // выбрали статус из списка
        const fresh = Date.now() - menu.at < 500; // сразу после открытия Miro шлёт пустое выделение — не закрываемся
        if (!fresh && !(one && one.id === menu.tagId)) await closeMenu(null); // кликнули мимо списка
      }
      if (!one) return;
      const hit = core.findButton(await batches(false), one.id);
      if (!hit) return;
      try { await board.deselect({ id: one.id }); } catch (e) { /* не критично */ }
      const key = hit.batch.id + ':' + hit.charId + ':' + hit.action;
      if (busy.has(key)) return; // второе нажатие, пока первое ещё выполняется
      busy.add(key);
      try {
        if (hit.action === 'status') {
          const same = menu && menu.batch.id === hit.batch.id && menu.charId === hit.charId;
          if (menu) await closeMenu(null);
          if (same) return; // повторный клик по плашке закрывает список
          const map = await core.openStatusMenu(hit.batch, hit.charId);
          menu = { batch: hit.batch, charId: hit.charId, map, at: Date.now(), tagId: one.id, timer: setTimeout(() => closeMenu(null).catch(() => {}), 20000) };
          return;
        }
        const res = await core.toggleHistory(hit.batch, hit.charId);
        if (!res.count) note('У этого персонажа пока нет прошлых сабмитов');
        else if (res.open) {
          const ui = hit.batch.ui[hit.charId];
          const ends = (await Promise.all([core.getItem(ui.status), core.getItem(ui.fb)])).filter(Boolean);
          if (ends.length) await board.viewport.zoomTo(ends);
        }
      } finally { busy.delete(key); }
    } catch (e) {
      console.error('[SGG bot]', e);
      diag('ошибка: ' + (e && e.message ? e.message : e));
    }
  }

  board.ui.on('icon:click', () => openPanel());
  board.ui.on('items:create', (e) => onImages('items:create', e.items, false));
  board.ui.on('selection:update', (e) => { onImages('selection', e.items, true); onButton(e.items); });
})();
