/* SGG Delivery Bot — логика. Работает и в браузере (window.SGG), и в Node (тесты). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SGG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.3.1';
  const MARK = 'SGG-BOT';
  const COLLECTION = 'sgg-delivery';
  const FORMAT = 4; // формат батча: 4 = карточки с назначениями по фазам

  // Статусы над персонажем — как на рабочей доске.
  const STATUSES = [
    { id: 'todo', label: 'TO DO', fill: '#FFF6BF' },
    { id: 'wip', label: 'WIP', fill: '#F5C142' },
    { id: 'internal', label: 'INTERNAL REVIEW', fill: '#DEDAFA' },
    { id: 'external', label: 'EXTERNAL REVIEW', fill: '#BCD4FB' },
    { id: 'fixes', label: 'FEEDBACK FIXES', fill: '#8D80E8' },
    { id: 'hold', label: 'ON HOLD', fill: '#C4C4C4' },
    { id: 'approved', label: 'APPROVED', fill: '#ADFF85' },
  ];
  const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

  // Стадии персонажа по порядку — полоска в карточке, у каждой свой исполнитель и свой счёт итераций.
  const STAGES = [
    { id: 'mood', label: 'Moodboard' },
    { id: 'pose', label: 'B/W Poses' },
    { id: 'design', label: 'B/W Design' },
    { id: 'color', label: 'Color Sketch' },
    { id: 'mid', label: 'Mid Render' },
    { id: 'render', label: 'Render' },
  ];
  const STAGE_COLS = 3; // полоска стадий в два ряда по три

  // Фазы: художника назначают на фазу целиком — скетч или рендер.
  const PHASES = [
    { id: 'sketch', label: 'Sketch', stages: ['mood', 'pose', 'design', 'color'] },
    { id: 'render', label: 'Render', stages: ['mid', 'render'] },
  ];
  const phaseOfStage = (stageId) => PHASES.find((p) => p.stages.indexOf(stageId) >= 0) || null;

  // Секции Comparison Deck и какие типы доставки в них попадают.
  // В секции у персонажа одно место — там его последний сабмит из этих типов. Места идут по порядку готовности:
  // кто первым сдал, тот первый в ряду, поэтому готовые работы стоят рядом, а не разбросаны по номерам персонажей.
  const DECKS = [
    { key: 'pose', title: 'B/W Poses', types: ['pose'] },
    { key: 'sketch', title: 'Approved Sketch (and WIPs)', types: ['design', 'color'] },
    { key: 'portrait', title: 'Portraits', types: ['face'] },
    { key: 'render', title: 'Approved Renders', types: ['render'] },
  ];
  const DECK_BY_KEY = Object.fromEntries(DECKS.map((d) => [d.key, d]));

  // Что можно доставить. label — в панели, en — в подписях на доске, color — цвет стадии, fb — чей фидбек.
  // У стадии каждая новая доставка — следующая итерация (v1, v2, …).
  const TYPES = [
    { id: 'mood', label: 'Moodboard', en: 'Moodboard', group: 'stage', stage: 'mood', deck: null, short: 'Mood', color: '#9A6B1F' },
    { id: 'pose', label: 'B/W Poses', en: 'B/W Poses', group: 'stage', stage: 'pose', deck: 'pose', short: 'Pose', color: '#5F5E5A' },
    { id: 'design', label: 'B/W Design', en: 'B/W Design', group: 'stage', stage: 'design', deck: 'sketch', short: 'B/W', color: '#5F5E5A' },
    { id: 'color', label: 'Color Sketch', en: 'Color Sketch', group: 'stage', stage: 'color', deck: 'sketch', short: 'Color', primary: true, color: '#D85A30' },
    { id: 'mid', label: 'Mid Render', en: 'Mid Render', group: 'stage', stage: 'mid', deck: null, short: 'Mid', color: '#1D9E75' },
    { id: 'render', label: 'Render', en: 'Render', group: 'stage', stage: 'render', deck: 'render', short: 'Render', primary: true, color: '#0F6E56' },
    { id: 'face', label: 'Лицо', en: 'Portrait', group: 'extra', stage: null, deck: 'portrait', short: 'Face', color: '#888780' },
    { id: 'sketch', label: 'Скетч / WIP', en: 'Sketch / WIP', group: 'extra', stage: null, deck: null, short: 'WIP', color: '#888780' },
    { id: 'fb_lead', label: 'Фидбек лида', en: 'Lead feedback', group: 'fb', fb: 'lead', color: '#7F77DD', tint: '#EEEDFE' },
    { id: 'fb_client', label: 'Фидбек клиента', en: 'Client feedback', group: 'fb', fb: 'client', color: '#378ADD', tint: '#E6F1FB' },
  ];
  const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const LEGACY_TYPES = ['color', 'render', 'pose', 'design', 'face', 'sketch'];

  // Нейтральные имена для песочницы: настоящие имена персонажей в код не попадают.
  const DEFAULT_CHARACTERS = Array.from({ length: 15 }, (_, i) => 'Character ' + String(i + 1).padStart(2, '0'));

  // Размеры тестового батча (в единицах доски).
  const L = {
    titleH: 60, deckW: 920, deckGap: 60, deckHeaderH: 40, sideGap: 40,
    cardW: 360, cardGap: 20, tagH: 30, nameH: 34, asH: 28, stageH: 38, stageGap: 4, pvH: 300, fbH: 150, histH: 28, gap: 6,
    archGap: 3200, archHeadH: 36, archLabelH: 24, archCellH: 160, archCapH: 28,
  };
  const stageRows = () => Math.ceil(STAGES.length / STAGE_COLS);
  const stripHeight = () => stageRows() * L.stageH + (stageRows() - 1) * L.stageGap;
  const cardHeight = () => L.tagH + L.nameH + L.asH + stripHeight() + L.pvH + L.fbH + L.histH + L.gap * 6;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const ddmm = (iso) => { const d = new Date(iso); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1); };
  const para = (html) => '<p>' + html + '</p>';

  const isBotImage = (i) => String((i && i.title) || '').indexOf(MARK) === 0;
  const FRESH_MS = 3 * 60 * 1000;

  /**
   * Отбирает из события доски картинки, на которые бот должен отреагировать.
   * o: { uid, seen:Set, requireFresh, now } → { take:[items], why:[причины отказа] }
   */
  function pickImages(items, o) {
    const out = { take: [], why: [] };
    for (const i of items || []) {
      if (!i || i.type !== 'image') continue;
      if (isBotImage(i)) { out.why.push('картинка бота'); continue; }
      if (o.seen && o.seen.has(i.id)) { out.why.push('уже видел'); continue; }
      if (o.uid && i.createdBy && String(i.createdBy) !== String(o.uid)) { out.why.push('чужая'); continue; }
      if (o.requireFresh) {
        const t = Date.parse(i.createdAt);
        if (isNaN(t)) { out.why.push('нет даты'); continue; }
        if (Math.abs(o.now - t) > FRESH_MS) { out.why.push('старая'); continue; }
      }
      out.take.push(i);
    }
    return out;
  }

  /** Ссылка на Jira: полный URL, либо ключ задачи + базовый адрес из настроек батча. */
  function normalizeJira(input, base) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^https?:\/\/\S+$/i.test(raw)) {
      const m = raw.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
      return { url: raw, label: m ? m[1].toUpperCase() : 'Jira' };
    }
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(raw)) {
      const key = raw.toUpperCase();
      const b = String(base || '').trim().replace(/\/+$/, '');
      return { url: /^https?:\/\//i.test(b) ? b + '/browse/' + key : null, label: key };
    }
    return { url: null, label: raw.slice(0, 40) };
  }

  /** Сетка слотов внутри секции деки. rect — центр и размеры зоны в координатах доски. */
  function deckGrid(rect) {
    const gap = 10, cellW = 140, capH = 20, cellH = 150, padTop = 10;
    return { gap, cellW, cellH, capH, padTop, cols: Math.max(1, Math.floor((rect.w - gap) / (cellW + gap))) };
  }

  function deckSlot(rect, g, i) {
    const col = i % g.cols, row = Math.floor(i / g.cols);
    const left = rect.x - rect.w / 2 + g.gap + col * (g.cellW + g.gap);
    const top = rect.y - rect.h / 2 + g.padTop + row * (g.cellH + g.gap);
    return { left, top, w: g.cellW, h: g.cellH, capH: g.capH, overflow: top + g.cellH > rect.y + rect.h / 2 + 0.5 };
  }

  /** Слот архива: под якорем персонажа, по две картинки в ряд, сверху вниз. */
  function archiveSlot(rect, i) {
    const gap = 8, w = (rect.w - gap) / 2;
    const left = rect.x - rect.w / 2 + (i % 2) * (w + gap);
    const top = rect.y + rect.h / 2 + gap + Math.floor(i / 2) * (L.archCellH + gap);
    return { left, top, w, h: L.archCellH, capH: L.archCapH };
  }

  /** Вписать картинку в область с сохранением пропорций: задаём только одну сторону. */
  function fitSide(ratio, areaW, areaH) {
    const r = ratio > 0 && isFinite(ratio) ? ratio : 1;
    return r >= areaW / areaH ? { width: areaW } : { height: areaH };
  }

  function deckHeight(chars) {
    const g = deckGrid({ w: L.deckW });
    return g.padTop + (Math.ceil(chars / g.cols) + 1) * (g.cellH + g.gap) + g.gap; // +1 строка запаса
  }

  /** Оборачивает шаг, чтобы в ошибке было видно, на чём именно споткнулись. */
  async function step(label, fn) {
    try { return await fn(); } catch (e) {
      const err = new Error('[' + label + '] ' + (e && e.message ? e.message : String(e)));
      err.stack = e && e.stack ? e.stack : err.stack;
      throw err;
    }
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function inChunks(list, size, fn) {
    const out = [];
    for (let i = 0; i < list.length; i += size) {
      out.push(...(await Promise.all(list.slice(i, i + size).map(fn))));
    }
    return out;
  }

  const emptyChar = () => ({ status: 'todo', assign: {}, cur: null, vers: {}, pv: null, fb: null, deck: {}, arch: [], open: false, shift: 0, cells: [], menu: [] });

  // Порядок сдачи: номер сабмита у персонажа; время — запасной ключ для записей без номера.
  const byTime = (a, b) => (a.n || 0) - (b.n || 0) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

  /** Прошлые сабмиты персонажа по порядку сдачи, старые первыми. */
  const pastSubmits = (rec) => rec.arch.slice().sort(byTime);

  /** Лента истории персонажа, свежее сверху. */
  function timeline(rec) {
    const out = rec.arch.map((e) => Object.assign({ where: 'archive' }, e));
    if (rec.pv) out.push(Object.assign({ where: 'card' }, rec.pv));
    if (rec.fb) out.push(Object.assign({ where: 'card' }, rec.fb));
    return out.sort(byTime).reverse();
  }

  /** Короткая подпись записи истории: «Color sketch v2» или «Client feedback · Color sketch v2». */
  function entryTitle(e) {
    const t = TYPE_BY_ID[e.type] || { en: e.type };
    return t.fb ? t.en + (e.ref ? ' · ' + e.ref : '') : t.en + ' v' + e.v;
  }

  // Оформление элементов карточки.
  const BASE = { fontSize: 10, textAlign: 'center', textAlignVertical: 'middle', borderWidth: 1 };
  const statusLook = (id) => {
    const s = STATUS_BY_ID[id] || STATUSES[0];
    return { content: para('<strong>' + s.label + '</strong> ▾'), style: Object.assign({}, BASE, { fontSize: 12, fillColor: s.fill, borderColor: s.fill, color: '#1F1F1F' }) };
  };
  // Ячейка стадии: название и номер последней итерации.
  function stageLook(stage, rec) {
    const order = STAGES.map((s) => s.id);
    const type = TYPE_BY_ID[stage.id];
    const ver = rec.vers[stage.id] || 0;
    const iter = para(ver ? 'v' + ver : '—');
    if (rec.cur === stage.id) {
      return { content: para('<strong>' + stage.label + '</strong>') + iter, style: Object.assign({}, BASE, { fillColor: type.color, borderColor: type.color, color: '#FFFFFF' }) };
    }
    if (ver > 0 && order.indexOf(stage.id) < order.indexOf(rec.cur)) {
      return { content: para('<strong>✓ ' + stage.label + '</strong>') + iter, style: Object.assign({}, BASE, { fillColor: '#EDEDED', borderColor: '#CFCFCF', color: '#1F1F1F' }) };
    }
    return { content: para(stage.label) + iter, style: Object.assign({}, BASE, { fillColor: '#FFFFFF', borderColor: '#D0D0D0', color: '#8C8C8C' }) };
  }
  // Плашка назначения: «Sketch: Anna ▾». Пустая — приглашение назначить.
  function shortName(name) {
    const p = String(name || '').trim().split(/\s+/);
    return p.length > 1 && name.length > 14 ? p[0] + ' ' + p[p.length - 1][0].toUpperCase() + '.' : p.join(' ');
  }
  function assignLook(phase, rec) {
    const who = (rec.assign || {})[phase.id];
    return {
      content: para(phase.label + ': <strong>' + (who ? esc(shortName(who)) : 'assign') + '</strong> ▾'),
      style: Object.assign({}, BASE, { fontSize: 11, fillColor: '#FFFFFF', borderColor: who ? '#1F1F1F' : '#D0D0D0', color: who ? '#1F1F1F' : '#8C8C8C' }),
    };
  }
  const pvLook = (rec) => {
    const t = rec.pv ? TYPE_BY_ID[rec.pv.type] : null;
    return { content: '', style: Object.assign({}, BASE, { fillColor: '#FFFFFF', borderColor: t ? t.color : '#D0D0D0', borderWidth: t ? 3 : 1, color: '#8C8C8C' }) };
  };
  const fbLook = (rec) => {
    const t = rec.fb ? TYPE_BY_ID[rec.fb.type] : null;
    return {
      content: para(t ? '<strong>' + t.en + '</strong>' : 'Feedback'),
      style: Object.assign({}, BASE, { textAlign: 'left', textAlignVertical: 'top', fillColor: t ? t.tint : '#FAFAFA', borderColor: t ? t.color : '#D0D0D0', borderWidth: t ? 2 : 1, color: t ? t.color : '#9A9A9A' }),
    };
  };
  // Кнопка истории стоит под полоской стадий и не двигается: раскрыл и свернул в одном и том же месте.
  const histLook = (rec) => {
    const n = rec.arch.length;
    const text = rec.open ? '▾ Hide history' : n ? '▸ History · ' + n + ' earlier' : 'History · no earlier submits';
    return { content: para('<strong>' + text + '</strong>'), style: Object.assign({}, BASE, { fontSize: 11, fillColor: n ? '#E8ECFF' : '#F2F2F2', borderColor: n ? '#4262FF' : '#D0D0D0', color: n ? '#2A3FBF' : '#8C8C8C' }) };
  };

  function create(miro) {
    const board = miro.board;
    // window.miro — «ленивая» обёртка: метод надо брать и вызывать одним действием, с уже готовыми аргументами.
    // Если между «взял метод» и «вызвал» случится другое обращение к miro, вызов теряет свой объект
    // и падает с Symbol(Commander). Поэтому хранилище завёрнуто в обычные функции.
    const coll = () => miro.board.storage.collection(COLLECTION);
    const store = {
      get: (k) => coll().get(k),
      set: (k, v) => coll().set(k, v),
      remove: (k) => coll().remove(k),
    };
    const hasParent = (it) => it && it.parentId && it.parentId !== 'null';

    async function getItem(id) {
      if (!id) return null;
      try { return await board.getById(id); } catch (e) { return null; }
    }

    /** Читает много элементов одним запросом; если какого-то уже нет — по одному. → Map id → элемент. */
    async function getMany(ids) {
      const list = [...new Set(ids.filter(Boolean))];
      const out = new Map();
      if (!list.length) return out;
      try {
        for (const it of await board.get({ id: list })) out.set(it.id, it);
        return out;
      } catch (e) { /* читаем по одному */ }
      await Promise.all(list.map(async (id) => { const it = await getItem(id); if (it) out.set(id, it); }));
      return out;
    }

    async function removeIds(ids) {
      for (const id of ids) {
        const it = await getItem(id);
        if (it) { try { await board.remove(it); } catch (e) { /* уже удалили руками */ } }
      }
    }

    /** Прямоугольник элемента в координатах доски (учитывает, что внутри фрейма x/y относительные). */
    async function absRect(it) {
      let x = it.x, y = it.y, parent = null;
      if (hasParent(it)) {
        parent = await getItem(it.parentId);
        if (parent && it.relativeTo === 'parent_top_left') {
          x = parent.x - parent.width / 2 + it.x;
          y = parent.y - parent.height / 2 + it.y;
        }
      }
      return { rect: { x, y, w: it.width, h: it.height }, parent };
    }

    async function zoneOf(id, title) {
      const it = await getItem(id);
      if (!it) throw new Error('Зона «' + title + '» не найдена на доске — похоже, её удалили.');
      const { rect, parent } = await absRect(it);
      return { rect, frame: it.type === 'frame' ? it : parent && parent.type === 'frame' ? parent : null };
    }

    // ---------- батчи и персонажи ----------
    const listBatches = async () => (await store.get('batches')) || [];
    const getBatch = (id) => store.get('b:' + id);
    const saveBatch = (b) => store.set('b:' + b.id, b);
    const charKey = (batchId, charId) => 'c:' + batchId + ':' + charId;
    const menuKey = (batchId, charId) => 'm:' + batchId + ':' + charId;
    const getChar = async (batchId, charId) => Object.assign(emptyChar(), (await store.get(charKey(batchId, charId))) || {});

    // Команда батча — список имён для назначений. Лежит отдельным ключом, чтобы не перезаписывать сам батч.
    const teamKey = (batchId) => 'team:' + batchId;
    const cleanNames = (list) => [...new Set((list || []).map((n) => String(n || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 40);
    const getTeam = async (batchId) => (await store.get(teamKey(batchId))) || [];
    async function setTeam(batchId, names) {
      const list = cleanNames(names);
      await store.set(teamKey(batchId), list);
      return list;
    }
    async function addToTeam(batchId, name) {
      const n = String(name || '').trim();
      const list = await getTeam(batchId);
      if (!n || list.indexOf(n) >= 0) return list;
      return setTeam(batchId, list.concat([n]));
    }

    /** Строит тестовый батч: Comparison Deck слева, карточки персонажей справа, под ними место под архив. */
    async function buildTestBatch(opts) {
      const name = (opts && opts.name) || 'TEST BATCH';
      const names = (opts && opts.characters) || DEFAULT_CHARACTERS;
      const onProgress = (opts && opts.onProgress) || function () {};
      const chars = names.map((n, i) => ({ id: 'c' + pad2(i + 1), name: n }));
      const id = 'b' + Date.now().toString(36);

      const cardsW = chars.length * (L.cardW + L.cardGap) - L.cardGap;
      const totalW = L.deckW + L.sideGap + cardsW;
      const deckH = L.deckHeaderH + DECKS.length * (L.deckGap + deckHeight(chars.length));
      const cardH = cardHeight();
      const totalH = L.titleH + 40 + Math.max(deckH, cardH + L.archGap + L.archHeadH + L.archLabelH);

      // Место: правее всего, что уже лежит на доске, чтобы ничего не накрыть. Пустая доска — по центру экрана.
      let ox = -totalW / 2, oy = -totalH / 2;
      try { const vp = await board.viewport.get(); ox = vp.x + vp.width / 2 - totalW / 2; oy = vp.y + vp.height / 2 - totalH / 2; } catch (e) { /* центр доски */ }
      try {
        const top = (await board.get()).filter((i) => i && !hasParent(i) && isFinite(i.x) && isFinite(i.y) && i.width > 0);
        if (top.length) {
          ox = Math.max(...top.map((i) => i.x + i.width / 2)) + 600;
          oy = Math.min(...top.map((i) => i.y - (i.height || 0) / 2));
        }
      } catch (e) { /* остаёмся по центру экрана */ }

      const jobs = []; // { kind, props, zone?, ref?:[charId, part] }
      const shape = (left, top, w, h, look, extra) => jobs.push(Object.assign({
        kind: 'shape',
        props: { shape: 'rectangle', content: look.content || '', x: left + w / 2, y: top + h / 2, width: w, height: h, style: Object.assign({}, look.style) },
      }, extra || {}));
      const dark = (text, size) => ({ content: para(esc(text)), style: Object.assign({}, BASE, { fontSize: size, fillColor: '#1F1F1F', borderColor: '#1F1F1F', color: '#FFFFFF' }) });
      const grey = (text) => ({ content: para(esc(text)), style: Object.assign({}, BASE, { fontSize: 14, fillColor: '#8C8C8C', borderColor: '#8C8C8C', color: '#FFFFFF' }) });
      const blank = emptyChar();

      shape(ox, oy, totalW, L.titleH, dark(name, 28));
      const bodyTop = oy + L.titleH + 40;
      let top = bodyTop;
      shape(ox, top, L.deckW, L.deckHeaderH, grey('COMPARISON DECK'));
      top += L.deckHeaderH;
      for (const d of DECKS) {
        top += L.deckGap;
        const h = deckHeight(chars.length);
        jobs.push({ kind: 'frame', zone: 'deck:' + d.key, props: { title: d.title, x: ox + L.deckW / 2, y: top + h / 2, width: L.deckW, height: h, style: { fillColor: '#f2f2f2' } } });
        top += h;
      }
      const cardsLeft = ox + L.deckW + L.sideGap;
      const archTop = bodyTop + cardH + L.archGap;
      const archHead = grey('STORAGE · earlier submits rest here while the card history is collapsed (managed by the bot)');
      archHead.style.textAlign = 'left';
      shape(cardsLeft, archTop, cardsW, L.archHeadH, archHead);
      const stageW = (L.cardW - L.stageGap * (STAGE_COLS - 1)) / STAGE_COLS;
      chars.forEach((ch, i) => {
        const left = cardsLeft + i * (L.cardW + L.cardGap);
        let t = bodyTop;
        shape(left, t, L.cardW, L.tagH, statusLook('todo'), { ref: [ch.id, 'status'] });
        t += L.tagH + L.gap;
        shape(left, t, L.cardW, L.nameH, dark(ch.name, 14), { ref: [ch.id, 'name'] });
        t += L.nameH + L.gap;
        const asW = (L.cardW - L.stageGap * (PHASES.length - 1)) / PHASES.length;
        PHASES.forEach((ph, k) => shape(left + k * (asW + L.stageGap), t, asW, L.asH, assignLook(ph, blank), { ref: [ch.id, 'as:' + ph.id] }));
        t += L.asH + L.gap;
        STAGES.forEach((st, k) => shape(left + (k % STAGE_COLS) * (stageW + L.stageGap), t + Math.floor(k / STAGE_COLS) * (L.stageH + L.stageGap), stageW, L.stageH, stageLook(st, blank), { ref: [ch.id, 'st:' + st.id] }));
        t += stripHeight() + L.gap;
        shape(left, t, L.cardW, L.histH, histLook(blank), { ref: [ch.id, 'hist'] });
        t += L.histH + L.gap;
        shape(left, t, L.cardW, L.pvH, pvLook(blank), { ref: [ch.id, 'pv'] });
        t += L.pvH + L.gap;
        shape(left, t, L.cardW, L.fbH, fbLook(blank), { ref: [ch.id, 'fb'] });
        shape(left, archTop + L.archHeadH + L.gap, L.cardW, L.archLabelH, { content: para(esc(ch.name)), style: Object.assign({}, BASE, { fillColor: '#F2F2F2', borderColor: '#D0D0D0', color: '#444444' }) }, { ref: [ch.id, 'ar'] });
      });

      const zones = {}, ui = {}, btn = {}, gen = [];
      chars.forEach((ch) => { ui[ch.id] = { st: {}, as: {} }; });
      let done = 0;
      const createOne = (j) => (j.kind === 'frame' ? board.createFrame(j.props) : board.createShape(j.props));
      try {
        const made = await inChunks(jobs, 8, async (j) => {
          const label = 'создание ' + j.kind + ' «' + (j.zone || (j.ref ? j.ref.join(' ') : '') || j.props.title || 'оформление') + '»';
          let it;
          try { it = await createOne(j); } catch (first) {
            await pause(600); // одна повторная попытка: Miro иногда отбивает запрос под нагрузкой
            it = await step(label, () => createOne(j));
          }
          if (!it || !it.id) throw new Error('[' + label + '] Miro не вернул созданный элемент');
          if (j.zone) zones[j.zone] = it.id;
          if (j.ref) {
            const [cid, part] = j.ref;
            if (part.indexOf('st:') === 0) ui[cid].st[part.slice(3)] = it.id;
            else if (part.indexOf('as:') === 0) ui[cid].as[part.slice(3)] = it.id;
            else ui[cid][part] = it.id;
            if (part === 'status' || part === 'hist' || part.indexOf('as:') === 0) btn[it.id] = [cid, part];
          }
          gen.push(it.id);
          onProgress(++done, jobs.length);
          return it;
        });

        const batch = { id, name, v: FORMAT, jiraBase: '', chars, zones, ui, btn };
        await step('запись батча в хранилище доски', () => saveBatch(batch));
        if (opts && opts.team && opts.team.length) await step('запись команды', () => setTeam(id, opts.team));
        await step('запись списка элементов', () => store.set('gen:' + id, gen));
        const list = (await step('чтение списка батчей', listBatches)).concat([{ id, name, v: FORMAT }]);
        await step('запись списка батчей', () => store.set('batches', list));
        try { await board.viewport.zoomTo(made[0]); } catch (e) { /* не критично */ }
        return batch;
      } catch (e) {
        // Не оставляем на доске половину батча.
        await inChunks(gen.slice(), 8, (gid) => removeIds([gid]));
        try { await store.remove('b:' + id); await store.remove('gen:' + id); await store.remove(teamKey(id)); } catch (e2) { /* нечего чистить */ }
        throw e;
      }
    }

    /** Убирает с доски всё, что создал бот для батча: карточки, деку, картинки, подписи, записи реестра. */
    async function deleteBatch(batchId, onProgress) {
      const batch = await getBatch(batchId);
      const ids = [];
      if (batch && batch.ui) { // карточки персонажей (0.2.0 и новее)
        await Promise.all(DECKS.map((d) => store.remove('deck:' + batchId + ':' + d.key)));
        await inChunks(batch.chars, 8, async (ch) => {
          const open = await store.get(menuKey(batchId, ch.id));
          if (open) { ids.push(...open); await store.remove(menuKey(batchId, ch.id)); }
          const rec = await store.get(charKey(batchId, ch.id));
          if (!rec) return;
          for (const e of [rec.pv, rec.fb].concat(rec.arch || [], Object.values(rec.deck || {}))) if (e) ids.push(e.img, e.cap);
          ids.push(...(rec.cells || []), ...(rec.menu || []));
          await store.remove(charKey(batchId, ch.id));
        });
      } else if (batch) { // батч старого формата (до 0.2.0)
        const keys = [];
        for (const ch of batch.chars) for (const t of LEGACY_TYPES) keys.push('d:' + batchId + ':' + ch.id + ':' + t);
        await inChunks(keys, 8, async (k) => {
          const rec = await store.get(k);
          if (!rec) return;
          for (const e of rec.card || []) ids.push(e.img, e.cap);
          if (rec.deck) ids.push(rec.deck.img, rec.deck.cap);
          await store.remove(k);
        });
        await inChunks(batch.chars, 8, (ch) => store.remove('j:' + batchId + ':' + ch.id));
      }
      ids.push(...((await store.get('gen:' + batchId)) || []));
      const list = ids.filter(Boolean);
      let done = 0;
      await inChunks(list, 8, async (id) => { await removeIds([id]); if (onProgress) onProgress(++done, list.length); });
      await store.remove('gen:' + batchId);
      await store.remove(teamKey(batchId));
      await store.remove('b:' + batchId);
      const rest = (await listBatches()).filter((b) => b.id !== batchId);
      await store.set('batches', rest);
    }

    // ---------- карточка ----------
    /** Перерисовывает части карточки под запись персонажа. parts: status, assign (true или id фазы), stages, pv, fb, hist. */
    async function refreshCard(batch, charId, rec, parts) {
      const ui = batch.ui[charId];
      const want = [];
      if (parts.status) want.push([ui.status, statusLook(rec.status)]);
      if (parts.assign) for (const ph of PHASES) if (parts.assign === true || parts.assign === ph.id) want.push([ui.as[ph.id], assignLook(ph, rec)]);
      if (parts.stages) for (const st of STAGES) want.push([ui.st[st.id], stageLook(st, rec)]);
      if (parts.pv) want.push([ui.pv, pvLook(rec)]);
      if (parts.fb) want.push([ui.fb, fbLook(rec)]);
      if (parts.hist) want.push([ui.hist, histLook(rec)]);
      const got = await getMany(want.map((w) => w[0]));
      const res = await Promise.allSettled(want.map(([id, look]) => {
        const it = got.get(id);
        if (!it) return null;
        it.content = look.content;
        Object.assign(it.style, look.style);
        return it.sync();
      }));
      return res.every((r) => r.status === 'fulfilled');
    }

    /** Перекрашивает плашку. Если элемент уже на руках (по нему только что кликнули), доска заново не читается. */
    async function paint(id, look, known) {
      const it = known && known.id === id && typeof known.sync === 'function' ? known : (await getMany([id])).get(id);
      if (!it) return false;
      it.content = look.content;
      if (it.style) Object.assign(it.style, look.style); else it.style = Object.assign({}, look.style);
      await it.sync();
      return true;
    }

    /** Меняет статус. known — сама плашка статуса, если она уже прочитана: тогда цвет меняется сразу, без чтения доски. */
    async function setStatus(batch, charId, statusId, known) {
      if (!STATUS_BY_ID[statusId]) throw new Error('Нет такого статуса.');
      const [rec] = await Promise.all([
        getChar(batch.id, charId).then(async (r) => { r.status = statusId; await store.set(charKey(batch.id, charId), r); return r; }),
        paint(batch.ui[charId].status, statusLook(statusId), known).catch(() => false),
      ]);
      return rec;
    }

    /** Назначает художника на фазу (sketch или render). Пустое имя снимает назначение. */
    async function setAssign(batch, charId, phaseId, name, known) {
      const phase = PHASES.find((p) => p.id === phaseId);
      if (!phase) throw new Error('Нет такой фазы.');
      const who = String(name || '').trim().slice(0, 40);
      const [rec] = await Promise.all([
        getChar(batch.id, charId).then(async (r) => { r.assign = r.assign || {}; r.assign[phaseId] = who; await store.set(charKey(batch.id, charId), r); return r; }),
        paint(batch.ui[charId].as[phaseId], assignLook(phase, { assign: { [phaseId]: who } }), known).catch(() => false),
        addToTeam(batch.id, who).catch(() => null),
      ]);
      return rec;
    }

    /**
     * Выпадающий список прямо на доске: плашки под элементом anchor (плашка статуса или назначения).
     * options: [{ value, label, fill?, mark? }] → { map: { idПлашки: value }, items }. Плашки временные, их убирает closeMenu.
     */
    async function openMenu(batch, charId, anchor, options) {
      const tag = typeof anchor === 'string' ? await getItem(anchor) : anchor;
      if (!tag) throw new Error('Элемент карточки не найден на доске.');
      const r = (await absRect(tag)).rect;
      const [left, made] = await Promise.all([
        store.get(menuKey(batch.id, charId)),
        Promise.all(options.map((o, i) => board.createShape({
          shape: 'rectangle', content: para('<strong>' + (o.mark ? '✓ ' : '') + esc(o.label) + '</strong>'),
          x: r.x, y: r.y + r.h / 2 + i * r.h + r.h / 2, width: r.w, height: r.h,
          style: Object.assign({}, BASE, { fontSize: r.w < 250 ? 11 : 12, fillColor: o.fill || '#FFFFFF', borderColor: o.mark ? '#1F1F1F' : '#C9C9C9', borderWidth: o.mark ? 2 : 1, color: '#1F1F1F' }),
        }))),
      ]);
      const map = {};
      made.forEach((it, i) => { map[it.id] = options[i].value; });
      // Запоминаем плашки, чтобы убрать их, даже если вкладку закрыли с открытым списком; заодно убираем забытые.
      await Promise.all([store.set(menuKey(batch.id, charId), made.map((it) => it.id))].concat((left || []).map((id) => removeIds([id]))));
      return { map, items: made };
    }

    async function closeMenu(batch, charId, items) {
      await Promise.allSettled((items || []).map((it) => board.remove(it)).concat([store.remove(menuKey(batch.id, charId))]));
    }

    const statusOptions = (current) => STATUSES.map((st) => ({ value: st.id, label: st.label, fill: st.fill, mark: st.id === current }));

    /** Варианты для списка назначения: сначала «я», потом команда и те, кто сейчас на доске, в конце — снять назначение. */
    function assignOptions(team, current, me, online) {
      const names = [];
      for (const n of [me].concat(team || [], online || [])) if (n && names.indexOf(n) < 0) names.push(n);
      if (current && names.indexOf(current) < 0) names.push(current);
      const out = names.slice(0, 14).map((n) => ({ value: n, label: n === me ? 'Me · ' + n : n, mark: n === current }));
      if (current) out.push({ value: '', label: '— Unassign', fill: '#F2F2F2' });
      return out;
    }

    // ---------- раскладка ----------
    /**
     * Место персонажа в секции деки. Первый сабмит персонажа занимает следующее свободное место, дальше оно за ним закреплено.
     * Запись перечитывается: если двое заняли место одновременно и чья-то запись потерялась, она повторяется.
     */
    async function deckIndex(batchId, deckKey, charId) {
      const key = 'deck:' + batchId + ':' + deckKey;
      for (let attempt = 0; attempt < 3; attempt++) {
        const list = (await store.get(key)) || [];
        if (list.indexOf(charId) >= 0) return list.indexOf(charId);
        await store.set(key, list.concat([charId]));
        const check = (await store.get(key)) || [];
        if (check.indexOf(charId) >= 0) return check.indexOf(charId);
      }
      throw new Error('Не удалось занять место в «' + DECK_BY_KEY[deckKey].title + '» — попробуй ещё раз.');
    }

    /** Создаёт картинку с подписью в прямоугольнике box = { left, top, w, h, capH }. */
    async function drawAt(box, frame, o) {
      const areaH = box.h - box.capH;
      const ratio = o.natural && o.natural.h > 0 ? o.natural.w / o.natural.h : 1;
      const props = Object.assign({ url: o.dataUrl, title: o.title, x: box.left + box.w / 2, y: box.top + areaH / 2 }, fitSide(ratio, box.w, areaH));
      if (o.link) props.linkedTo = o.link;
      const capProps = {
        content: para(o.caption), x: box.left + box.w / 2, y: box.top + areaH + box.capH / 2, width: box.w,
        style: { fontSize: 10, textAlign: 'center', color: o.color || '#555555' },
      };
      // Картинка и подпись создаются одновременно; если одно не вышло — второе убираем.
      const res = await Promise.allSettled([board.createImage(props), board.createText(capProps)]);
      const failed = res.find((r) => r.status === 'rejected');
      if (failed) {
        await removeIds(res.filter((r) => r.status === 'fulfilled').map((r) => r.value.id));
        throw failed.reason;
      }
      const img = res[0].value, cap = res[1].value;
      let attached = true;
      if (frame) {
        try { await frame.add(img); await frame.add(cap); } catch (e) { attached = false; }
      }
      return { img: img.id, cap: cap.id, attached };
    }

    /** Переносит уже лежащие на доске картинку и подпись в прямоугольник box. Файл заново не грузится. */
    async function moveInto(box, entry) {
      const areaH = box.h - box.capH;
      const [img, cap] = await Promise.all([getItem(entry.img), getItem(entry.cap)]);
      const jobs = [];
      if (img) {
        const side = fitSide(img.width / img.height, box.w, areaH);
        if (side.width) img.width = side.width; else img.height = side.height;
        img.x = box.left + box.w / 2;
        img.y = box.top + areaH / 2;
        jobs.push(img.sync());
      }
      if (cap) {
        cap.width = box.w;
        cap.x = box.left + box.w / 2;
        cap.y = box.top + areaH + box.capH / 2;
        jobs.push(cap.sync());
      }
      await Promise.allSettled(jobs);
      return [img, cap].filter(Boolean);
    }
    const moveToArchive = (arRect, index, entry) => moveInto(archiveSlot(arRect, index), entry);

    /** Ставит уже прочитанные картинку и подпись в прямоугольник box; возвращает запущенные обновления. */
    function placeInto(got, box, entry) {
      const areaH = box.h - box.capH, img = got.get(entry.img), cap = got.get(entry.cap), out = [];
      if (img) {
        const side = fitSide(img.width / img.height, box.w, areaH);
        if (side.width) img.width = side.width; else img.height = side.height;
        img.x = box.left + box.w / 2;
        img.y = box.top + areaH / 2;
        out.push(img.sync());
      }
      if (cap) {
        cap.width = box.w;
        cap.x = box.left + box.w / 2;
        cap.y = box.top + areaH + box.capH / 2;
        out.push(cap.sync());
      }
      return out;
    }

    /**
     * Раскрывает или сворачивает историю прямо в карточке.
     * Раскрыто: под кнопкой History идут все прошлые сабмиты по порядку сдачи, текущий — ниже них.
     * Свёрнуто: в карточке только текущий, прошлые лежат в хранилище.
     * Файлы не перезагружаются: всё читается одним запросом, дальше элементы только двигаются, все разом.
     */
    async function setHistory(batch, charId, open, known) {
      const rec = known || (await getChar(batch.id, charId));
      const ui = batch.ui[charId];
      if (!!rec.open === !!open) return { open: !!rec.open, count: rec.arch.length, rec, focus: [] };
      const past = pastSubmits(rec);
      if (open && !past.length) return { open: false, count: 0, rec, focus: [] };
      const current = [ui.pv, rec.pv && rec.pv.img, rec.pv && rec.pv.cap, ui.fb, rec.fb && rec.fb.img, rec.fb && rec.fb.cap].filter(Boolean);
      const got = await getMany(current.concat(...rec.arch.map((e) => [e.img, e.cap]), [ui.hist, ui.ar], rec.cells || []));
      const jobs = [];
      const shiftCurrent = (dy) => current.forEach((id) => { const it = got.get(id); if (it) { it.y += dy; jobs.push(it.sync()); } });
      if (open) {
        const pv = got.get(ui.pv);
        if (!pv) throw new Error('Превью персонажа не найдено на доске — похоже, его удалили.');
        const stepY = pv.height + L.gap, shift = past.length * stepY, top0 = pv.y - pv.height / 2, pad = 8;
        const box0 = { left: pv.x - pv.width / 2 + pad, w: pv.width - pad * 2, h: pv.height - pad * 2, capH: 30 };
        shiftCurrent(shift);
        past.forEach((e, i) => jobs.push(...placeInto(got, Object.assign({ top: top0 + i * stepY + pad }, box0), e)));
        rec.open = true; rec.shift = shift;
      } else {
        const ar = got.get(ui.ar);
        if (!ar) throw new Error('Хранилище прошлых сабмитов не найдено на доске — похоже, его удалили.');
        const arRect = { x: ar.x, y: ar.y, w: ar.width, h: ar.height };
        shiftCurrent(-(rec.shift || 0));
        rec.arch.forEach((e, i) => jobs.push(...placeInto(got, archiveSlot(arRect, i), e)));
        (rec.cells || []).forEach((id) => { const it = got.get(id); if (it) jobs.push(board.remove(it)); }); // рамки из версий до 0.3.1
        rec.open = false; rec.shift = 0; rec.cells = [];
      }
      const hist = got.get(ui.hist);
      if (hist) { const look = histLook(rec); hist.content = look.content; Object.assign(hist.style, look.style); jobs.push(hist.sync()); }
      jobs.push(store.set(charKey(batch.id, charId), rec));
      await Promise.allSettled(jobs);
      return { open: rec.open, count: rec.arch.length, rec, focus: [hist, got.get(ui.fb)].filter(Boolean) };
    }

    const toggleHistory = async (batch, charId) => { const rec = await getChar(batch.id, charId); return setHistory(batch, charId, !rec.open, rec); };

    async function collapseAll(batch) {
      let n = 0;
      await inChunks(batch.chars, 4, async (ch) => { const rec = await getChar(batch.id, ch.id); if (rec.open) { await setHistory(batch, ch.id, false, rec); n++; } });
      return n;
    }

    /**
     * Доставка: коммит стадии или фидбек.
     * opts: { batch, charId, typeId, dataUrl, deckDataUrl?, natural:{w,h}, jira, userName, sourceItemId, statusAfter?, replace? }
     * replace — перезалив: картинка заменяет текущую итерацию этой же стадии, номер итерации не растёт.
     */
    async function place(opts) {
      const batch = opts.batch;
      const type = TYPE_BY_ID[opts.typeId];
      const charIdx = batch.chars.findIndex((c) => c.id === opts.charId);
      if (!type || charIdx < 0) throw new Error('Не выбран персонаж или тип доставки.');
      const ch = batch.chars[charIdx];
      const ui = batch.ui[ch.id];
      const isFb = !!type.fb;
      const deck = type.deck ? DECK_BY_KEY[type.deck] : null;

      // Раскрытую историю сначала сворачиваем: новая картинка встаёт в обычную карточку.
      const before = await getChar(batch.id, ch.id);
      if (before.open) await setHistory(batch, ch.id, false, before);
      // Реестр и зоны читаем разом. Если зоны нет, на доске ничего не меняется.
      const [rec, zone, arZone, deckZone, deckIdx] = await Promise.all([
        before.open ? getChar(batch.id, ch.id) : Promise.resolve(before),
        zoneOf(isFb ? ui.fb : ui.pv, ch.name + (isFb ? ' → Feedback' : ' → превью')),
        zoneOf(ui.ar, ch.name + ' → архив'),
        deck ? zoneOf(batch.zones['deck:' + deck.key], deck.title) : Promise.resolve(null),
        deck ? deckIndex(batch.id, deck.key, ch.id) : Promise.resolve(-1),
      ]);
      const at = new Date().toISOString();
      const by = opts.userName || '';
      const redo = !isFb && !!opts.replace && !!rec.pv && rec.pv.type === type.id;
      const v = isFb ? 0 : redo ? rec.pv.v : (rec.vers[type.id] || 0) + 1;
      const ref = isFb && rec.pv ? entryTitle(rec.pv) : '';
      const jira = type.primary ? normalizeJira(opts.jira, batch.jiraBase) : null;
      const link = jira && jira.url ? jira.url : null;
      const entry = { n: redo ? rec.pv.n : (rec.seq || 0) + 1, type: type.id, v, ref, by, at, jira: jira ? jira.label : '', link: link || '' };
      const title = [MARK, batch.name, ch.name, entryTitle(entry)].join(' · ');
      const base = { dataUrl: opts.dataUrl, natural: opts.natural, title, link, color: type.color };

      let caption = '<strong>' + esc(entryTitle(entry)) + '</strong> · ' + ddmm(at) + (by ? ' · ' + esc(by) : '');
      if (jira) caption += ' · ' + (link ? '<a href="' + esc(link) + '">' + esc(jira.label) + '</a>' : esc(jira.label));

      // 1. Новая картинка в карточке (превью или блок фидбека) и копия в деке — одновременно.
      const r = zone.rect, pad = 8, padTop = isFb ? 20 : pad, capH = 30;
      const box = { left: r.x - r.w / 2 + pad, top: r.y - r.h / 2 + padTop, w: r.w - pad * 2, h: r.h - padTop - pad, capH };
      const draws = [drawAt(box, zone.frame, Object.assign({ caption }, base))];
      let deckOverflow = false;
      if (deck) {
        const slot = deckSlot(deckZone.rect, deckGrid(deckZone.rect), deckIdx);
        deckOverflow = slot.overflow;
        const dcap = esc(ch.name) + (deck.types.length > 1 ? ' · ' + type.short : '');
        draws.push(drawAt(slot, deckZone.frame, Object.assign({}, base, { caption: dcap, color: '#555555' }, opts.deckDataUrl ? { dataUrl: opts.deckDataUrl } : {})));
      }
      const drawn = await Promise.allSettled(draws);
      const bad = drawn.find((x) => x.status === 'rejected');
      if (bad) { // не оставляем половину доставки
        await removeIds([].concat(...drawn.filter((x) => x.status === 'fulfilled').map((x) => [x.value.img, x.value.cap])));
        throw bad.reason;
      }
      const card = drawn[0].value, d = deck ? drawn[1].value : null;
      const warnings = [];
      if (deckOverflow) warnings.push('В секции «' + deck.title + '» кончилось место — растяни фрейм вниз.');
      if ((d && !d.attached) || !card.attached) warnings.push('Картинка лежит поверх фрейма, но не прикрепилась к нему.');

      // 2. Прежнее содержимое карточки уезжает в архив: старый фидбек всегда, старый коммит — когда пришёл новый коммит.
      const toArchive = [];
      if (isFb) { if (rec.fb) toArchive.push(rec.fb); } else if (!redo) { if (rec.pv) toArchive.push(rec.pv); if (rec.fb) toArchive.push(rec.fb); }
      const moves = toArchive.map((e, i) => moveToArchive(arZone.rect, rec.arch.length + i, e));
      rec.arch = rec.arch.concat(toArchive);

      // 3. Запись персонажа.
      const mine = Object.assign({ img: card.img, cap: card.cap }, entry);
      const stale = [];
      if (isFb) {
        rec.fb = mine;
      } else {
        if (redo) stale.push(rec.pv.img, rec.pv.cap); else rec.fb = null; // перезалив: старый файл убираем, фидбек к этой итерации остаётся
        rec.pv = mine;
        rec.vers[type.id] = v;
        if (type.stage) {
          rec.cur = type.stage;
          const ph = phaseOfStage(type.stage); // кто сдал первым, тот и назначен на фазу, если её никто не взял
          rec.assign = rec.assign || {};
          if (ph && by && !rec.assign[ph.id]) rec.assign[ph.id] = by;
        }
        if (d) {
          if (rec.deck[deck.key]) stale.push(rec.deck[deck.key].img, rec.deck[deck.key].cap); // в секции остаётся только последний сабмит
          rec.deck[deck.key] = { img: d.img, cap: d.cap, type: type.id };
        }
        if (jira) rec.jiraInput = String(opts.jira).trim();
      }
      rec.seq = Math.max(rec.seq || 0, entry.n);
      rec.status = STATUS_BY_ID[opts.statusAfter] ? opts.statusAfter : redo ? rec.status : isFb ? 'fixes' : 'internal';

      const tail = moves.concat([store.set(charKey(batch.id, ch.id), rec)], stale.map((id) => removeIds([id])));
      if (opts.sourceItemId) tail.push(removeIds([opts.sourceItemId]));
      if (by) tail.push(addToTeam(batch.id, by).catch(() => null)); // кто доставляет, тот появляется в списке команды
      // Реестр, архив и оформление карточки обновляются одновременно.
      const drawnOk = (await Promise.all([refreshCard(batch, ch.id, rec, { status: true, assign: !isFb, stages: !isFb, pv: !isFb, fb: true, hist: true })].concat(tail)))[0];
      if (!drawnOk) warnings.push('Картинка на месте, но оформление карточки обновилось не полностью.');
      return {
        v, isFeedback: isFb, replaced: redo, title: entryTitle(entry), cardImageId: card.img, deckTitle: deck ? deck.title : null,
        archived: toArchive.length, status: rec.status, warnings, charName: ch.name, typeLabel: type.label, rec,
      };
    }

    /** Переносит экран к архиву персонажа — это и есть «раскрыть историю». */
    async function zoomToArchive(batch, charId) {
      const rec = await getChar(batch.id, charId);
      const ids = [batch.ui[charId].ar].concat(rec.arch.slice(-8).map((e) => e.img));
      const items = (await Promise.all(ids.map((id) => getItem(id)))).filter(Boolean);
      if (items.length) await board.viewport.zoomTo(items);
      return rec.arch.length;
    }

    // ---------- угадывание цели по месту, куда бросили картинку ----------
    async function loadZoneRects(batch) {
      const want = [];
      for (const ch of batch.chars) {
        const ui = batch.ui[ch.id];
        want.push([ch.id + ':pv', ui.pv], [ch.id + ':fb', ui.fb]);
        for (const st of STAGES) want.push([ch.id + ':st:' + st.id, ui.st[st.id]]);
      }
      const out = {};
      await inChunks(want, 16, async ([k, id]) => {
        const it = await getItem(id);
        if (it) out[k] = (await absRect(it)).rect;
      });
      return out;
    }

    /**
     * Куда бросили картинку → { charId, typeId|null, group|null } или null.
     * Срабатывает, только если точка попала в саму карточку: на ячейку стадии, на превью или на блок фидбека.
     */
    function guessTarget(rects, pt) {
      for (const k of Object.keys(rects)) {
        const r = rects[k], p = k.split(':');
        if (pt.x < r.x - r.w / 2 || pt.x > r.x + r.w / 2 || pt.y < r.y - r.h / 2 || pt.y > r.y + r.h / 2) continue;
        if (p[1] === 'st') return { charId: p[0], typeId: p[2], group: null };
        return { charId: p[0], typeId: null, group: p[1] === 'fb' ? 'fb' : null };
      }
      return null;
    }

    /** Кнопка бота на доске (плашка статуса или History) → { batch, charId, action }. */
    function findButton(batches, itemId) {
      for (const b of batches || []) {
        const hit = b && b.btn && b.btn[itemId];
        if (hit) return { batch: b, charId: hit[0], action: hit[1] };
      }
      return null;
    }

    /** Все батчи нового формата целиком — для кнопок на доске. */
    async function loadBatchesFull() {
      const list = (await listBatches()).filter((b) => b.v === FORMAT);
      return (await Promise.all(list.map((b) => getBatch(b.id)))).filter(Boolean);
    }

    return {
      store, listBatches, getBatch, saveBatch, getChar, getTeam, setTeam, addToTeam, buildTestBatch, deleteBatch, place, setStatus, setAssign,
      refreshCard, openMenu, closeMenu, statusOptions, assignOptions, setHistory, toggleHistory, collapseAll, zoomToArchive, absRect, getItem, loadZoneRects, guessTarget, findButton, loadBatchesFull,
    };
  }

  return {
    VERSION, MARK, FORMAT, STATUSES, STATUS_BY_ID, STAGES, STAGE_COLS, PHASES, TYPES, TYPE_BY_ID, DECKS, DECK_BY_KEY, DEFAULT_CHARACTERS, L,
    create, pickImages, isBotImage, normalizeJira, shortName, phaseOfStage, deckGrid, deckSlot, archiveSlot, fitSide, timeline, pastSubmits, entryTitle, esc, ddmm,
  };
});
