/* Невидимая часть бота: живёт на доске, открывает панель по иконке и когда на доске появилась новая картинка. */
(function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  const seen = new Set(); // картинки, про которые бот уже спрашивал
  let myId; // undefined = ещё не спрашивали, null = узнать не удалось

  async function me() {
    if (myId === undefined) {
      try { myId = (await board.getUserInfo()).id; } catch (e) { myId = null; }
    }
    return myId;
  }

  const diagOn = () => { try { return localStorage.getItem('sgg:diag') !== '0'; } catch (e) { return true; } };
  async function diag(text) {
    if (!diagOn()) return;
    try { await board.notifications.showInfo(('Bot: ' + text).slice(0, 78)); } catch (e) { /* подсказка не критична */ }
  }

  async function openPanel(data) {
    if (!(await board.ui.canOpenPanel())) return false;
    await board.ui.openPanel({ url: new URL('panel.html', window.location.href).href, data: data || {} });
    return true;
  }

  // Новую картинку ловим двумя путями: событием создания и тем, что Miro сам выделяет только что добавленное.
  async function handle(source, items, requireFresh) {
    try {
      const all = items || [];
      if (!all.some((i) => i.type === 'image')) {
        if (source === 'items:create' && all.length) diag(source + ': ' + all.map((i) => i.type).join(', ').slice(0, 40));
        return;
      }
      const res = SGG.pickImages(all, { uid: await me(), seen, requireFresh, now: Date.now() });
      if (!res.take.length) {
        const loud = res.why.filter((w) => w !== 'картинка бота' && w !== 'уже видел' && w !== 'старая');
        if (loud.length || (source === 'items:create' && res.why.indexOf('уже видел') < 0 && res.why.indexOf('картинка бота') < 0)) {
          diag(source + ': пропуск — ' + res.why.join(', '));
        }
        return;
      }
      if (!(await core.listBatches()).length) { diag(source + ': на доске нет батча'); return; }
      res.take.forEach((i) => seen.add(i.id));
      const opened = await openPanel({ itemIds: res.take.map((i) => i.id) });
      diag(source + ': картинка ×' + res.take.length + (opened ? ' → открыл панель' : ' → панель уже открыта'));
    } catch (e) {
      console.error('[SGG bot]', e);
      diag('ошибка: ' + (e && e.message ? e.message : e));
    }
  }

  board.ui.on('icon:click', () => openPanel());
  board.ui.on('items:create', (e) => handle('items:create', e.items, false));
  board.ui.on('selection:update', (e) => handle('selection', e.items, true));
})();
