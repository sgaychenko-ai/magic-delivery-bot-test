/* Невидимая часть бота: живёт на доске, открывает панель по иконке и когда на доску бросили картинку. */
(function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  let myId; // undefined = ещё не спрашивали, null = узнать не удалось

  async function me() {
    if (myId === undefined) {
      try { myId = (await board.getUserInfo()).id; } catch (e) { myId = null; }
    }
    return myId;
  }

  async function openPanel(data) {
    if (await board.ui.canOpenPanel()) await board.ui.openPanel({ url: new URL('panel.html', window.location.href).href, data: data || {} });
  }

  board.ui.on('icon:click', () => openPanel());

  board.ui.on('items:create', async (event) => {
    try {
      const images = (event.items || []).filter((i) => i.type === 'image' && String(i.title || '').indexOf(SGG.MARK) !== 0);
      if (!images.length) return;
      const uid = await me();
      const mine = images.filter((i) => !uid || !i.createdBy || i.createdBy === uid);
      if (!mine.length) return;
      if (!(await core.listBatches()).length) return; // на досках без батча бот не всплывает
      await openPanel({ itemIds: mine.map((i) => i.id) });
    } catch (e) {
      console.error('[SGG bot]', e);
    }
  });
})();
