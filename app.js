/* Невидимая часть бота: живёт на доске, ловит новые картинки и нажатия на кнопки карточек. */
(function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  const seen = new Set(); // картинки, про которые бот уже спрашивал
  let myId; // undefined = ещё не спрашивали, null = узнать не удалось
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

  // Клик по плашке статуса открывает выбор статуса, клик по History переносит к архиву персонажа.
  async function onButton(items) {
    try {
      if (!items || items.length !== 1 || items[0].type !== 'shape') return;
      const id = items[0].id;
      let hit = core.findButton(await batches(false), id);
      if (!hit) return;
      try { await board.deselect({ id }); } catch (e) { /* не критично */ }
      if (hit.action === 'hist') {
        const n = await core.zoomToArchive(hit.batch, hit.charId);
        if (!n) note('У этого персонажа пока нет прошлых версий');
        return;
      }
      await openPanel({ view: 'char', batchId: hit.batch.id, charId: hit.charId }); // если панель уже открыта, она переключится сама
    } catch (e) {
      console.error('[SGG bot]', e);
      diag('ошибка: ' + (e && e.message ? e.message : e));
    }
  }

  board.ui.on('icon:click', () => openPanel());
  board.ui.on('items:create', (e) => onImages('items:create', e.items, false));
  board.ui.on('selection:update', (e) => { onImages('selection', e.items, true); onButton(e.items); });
})();
