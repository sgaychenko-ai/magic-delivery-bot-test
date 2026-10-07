/* SGG Delivery Bot — логика. Работает и в браузере (window.SGG), и в Node (тесты). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SGG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.2.0';
  const MARK = 'SGG-BOT';
  const COLLECTION = 'sgg-delivery';
  const FORMAT = 2; // формат батча: 2 = карточки персонажей

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

  // Основные стадии — полоска в карточке, у каждой свой исполнитель.
  const STAGES = [
    { id: 'pose', label: 'Pose' },
    { id: 'design', label: 'Design' },
    { id: 'color', label: 'Color' },
    { id: 'render', label: 'Render' },
  ];

  // Секции Comparison Deck и какие типы доставки в них попадают.
  const DECKS = [
    { key: 'pose', title: 'B/W Poses', types: ['pose'] },
    { key: 'sketch', title: 'Approved Sketch (and WIPs)', types: ['design', 'color'] },
    { key: 'portrait', title: 'Portraits', types: ['face'] },
    { key: 'render', title: 'Approved Renders', types: ['render'] },
  ];
  const DECK_BY_KEY = Object.fromEntries(DECKS.map((d) => [d.key, d]));

  // Что можно доставить. color — цвет стадии на доске; fb — чей фидбек.
  const TYPES = [
    { id: 'color', label: 'Колор скетч', en: 'Color sketch', group: 'main', stage: 'color', deck: 'sketch', short: 'Color', primary: true, color: '#D85A30' },
    { id: 'render', label: 'Рендер', en: 'Render', group: 'main', stage: 'render', deck: 'render', short: 'Render', primary: true, color: '#1D9E75' },
    { id: 'pose', label: 'Ч/Б поза', en: 'B/W pose', group: 'prod', stage: 'pose', deck: 'pose', short: 'Pose', color: '#5F5E5A' },
    { id: 'design', label: 'Ч/Б дизайн', en: 'B/W design', group: 'prod', stage: 'design', deck: 'sketch', short: 'B/W', color: '#5F5E5A' },
    { id: 'face', label: 'Лицо', en: 'Portrait', group: 'prod', stage: null, deck: 'portrait', short: 'Face', color: '#888780' },
    { id: 'sketch', label: 'Скетч / WIP', en: 'Sketch / WIP', group: 'prod', stage: null, deck: null, short: 'WIP', color: '#888780' },
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
    cardW: 360, cardGap: 20, tagH: 30, nameH: 34, stageH: 46, pvH: 300, fbH: 150, histH: 28, gap: 6,
    archGap: 160, archHeadH: 36, archLabelH: 24, archCellH: 160, archCapH: 28,
  };
  const cardHeight = () => L.tagH + L.nameH + L.stageH + L.pvH + L.fbH + L.histH + L.gap * 5;

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
  function deckGrid(rect, perChar) {
    const gap = 10, cellW = 140, capH = 20, cellH = 150, padTop = 10;
    let cols = Math.max(1, Math.floor((rect.w - gap) / (cellW + gap)));
    if (perChar > 1 && cols >= perChar) cols -= cols % perChar; // пары одного персонажа не рвутся по строкам
    return { gap, cellW, cellH, capH, padTop, cols };
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

  function deckHeight(chars, deck) {
    const g = deckGrid({ w: L.deckW }, deck.types.length);
    const rows = Math.ceil((chars * deck.types.length) / g.cols) + 1; // +1 строка запаса
    return g.padTop + rows * (g.cellH + g.gap) + g.gap;
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

  const emptyChar = () => ({ status: 'todo', artists: {}, cur: null, vers: {}, pv: null, fb: null, deck: {}, arch: [] });

  /** Лента истории персонажа, свежее сверху. */
  function timeline(rec) {
    const out = [];
    if (rec.fb) out.push(Object.assign({ where: 'card' }, rec.fb));
    if (rec.pv) out.push(Object.assign({ where: 'card' }, rec.pv));
    for (let i = rec.arch.length - 1; i >= 0; i--) out.push(Object.assign({ where: 'archive' }, rec.arch[i]));
    return out;
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
  function stageLook(stage, rec) {
    const order = STAGES.map((s) => s.id);
    const type = TYPE_BY_ID[stage.id];
    const who = esc(rec.artists[stage.id] || '—');
    const started = (rec.vers[stage.id] || 0) > 0;
    if (rec.cur === stage.id) {
      return { content: para('<strong>' + stage.label + '</strong>') + para(who), style: Object.assign({}, BASE, { fillColor: type.color, borderColor: type.color, color: '#FFFFFF' }) };
    }
    if (started && order.indexOf(stage.id) < order.indexOf(rec.cur)) {
      return { content: para('<strong>✓ ' + stage.label + '</strong>') + para(who), style: Object.assign({}, BASE, { fillColor: '#EDEDED', borderColor: '#CFCFCF', color: '#1F1F1F' }) };
    }
    return { content: para(stage.label) + para(who), style: Object.assign({}, BASE, { fillColor: '#FFFFFF', borderColor: '#D0D0D0', color: '#8C8C8C' }) };
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
  const histLook = (rec) => ({
    content: para('History · ' + timeline(rec).length + ' ▸'),
    style: Object.assign({}, BASE, { fontSize: 11, fillColor: '#F2F2F2', borderColor: '#D0D0D0', color: '#444444' }),
  });

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
    const getChar = async (batchId, charId) => Object.assign(emptyChar(), (await store.get(charKey(batchId, charId))) || {});

    /** Строит тестовый батч: Comparison Deck слева, карточки персонажей справа, под ними место под архив. */
    async function buildTestBatch(opts) {
      const name = (opts && opts.name) || 'TEST BATCH';
      const names = (opts && opts.characters) || DEFAULT_CHARACTERS;
      const onProgress = (opts && opts.onProgress) || function () {};
      const chars = names.map((n, i) => ({ id: 'c' + pad2(i + 1), name: n }));
      const id = 'b' + Date.now().toString(36);

      const cardsW = chars.length * (L.cardW + L.cardGap) - L.cardGap;
      const totalW = L.deckW + L.sideGap + cardsW;
      const deckH = L.deckHeaderH + DECKS.reduce((s, d) => s + L.deckGap + deckHeight(chars.length, d), 0);
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
        const h = deckHeight(chars.length, d);
        jobs.push({ kind: 'frame', zone: 'deck:' + d.key, props: { title: d.title, x: ox + L.deckW / 2, y: top + h / 2, width: L.deckW, height: h, style: { fillColor: '#f2f2f2' } } });
        top += h;
      }
      const cardsLeft = ox + L.deckW + L.sideGap;
      const archTop = bodyTop + cardH + L.archGap;
      shape(cardsLeft, archTop, cardsW, L.archHeadH, grey('ARCHIVE · earlier versions and closed feedback, managed by the bot'));
      const stageW = (L.cardW - 4 * (STAGES.length - 1)) / STAGES.length;
      chars.forEach((ch, i) => {
        const left = cardsLeft + i * (L.cardW + L.cardGap);
        let t = bodyTop;
        shape(left, t, L.cardW, L.tagH, statusLook('todo'), { ref: [ch.id, 'status'] });
        t += L.tagH + L.gap;
        shape(left, t, L.cardW, L.nameH, dark(ch.name, 14), { ref: [ch.id, 'name'] });
        t += L.nameH + L.gap;
        STAGES.forEach((st, k) => shape(left + k * (stageW + 4), t, stageW, L.stageH, stageLook(st, blank), { ref: [ch.id, 'st:' + st.id] }));
        t += L.stageH + L.gap;
        shape(left, t, L.cardW, L.pvH, pvLook(blank), { ref: [ch.id, 'pv'] });
        t += L.pvH + L.gap;
        shape(left, t, L.cardW, L.fbH, fbLook(blank), { ref: [ch.id, 'fb'] });
        t += L.fbH + L.gap;
        shape(left, t, L.cardW, L.histH, histLook(blank), { ref: [ch.id, 'hist'] });
        shape(left, archTop + L.archHeadH + L.gap, L.cardW, L.archLabelH, { content: para(esc(ch.name)), style: Object.assign({}, BASE, { fillColor: '#F2F2F2', borderColor: '#D0D0D0', color: '#444444' }) }, { ref: [ch.id, 'ar'] });
      });

      const zones = {}, ui = {}, btn = {}, gen = [];
      chars.forEach((ch) => { ui[ch.id] = { st: {} }; });
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
            if (part.indexOf('st:') === 0) ui[cid].st[part.slice(3)] = it.id; else ui[cid][part] = it.id;
            if (part === 'status' || part === 'hist') btn[it.id] = [cid, part];
          }
          gen.push(it.id);
          onProgress(++done, jobs.length);
          return it;
        });

        const batch = { id, name, v: FORMAT, jiraBase: '', chars, zones, ui, btn };
        await step('запись батча в хранилище доски', () => saveBatch(batch));
        await step('запись списка элементов', () => store.set('gen:' + id, gen));
        const list = (await step('чтение списка батчей', listBatches)).concat([{ id, name, v: FORMAT }]);
        await step('запись списка батчей', () => store.set('batches', list));
        try { await board.viewport.zoomTo(made[0]); } catch (e) { /* не критично */ }
        return batch;
      } catch (e) {
        // Не оставляем на доске половину батча.
        await inChunks(gen.slice(), 8, (gid) => removeIds([gid]));
        try { await store.remove('b:' + id); await store.remove('gen:' + id); } catch (e2) { /* нечего чистить */ }
        throw e;
      }
    }

    /** Убирает с доски всё, что создал бот для батча: карточки, деку, картинки, подписи, записи реестра. */
    async function deleteBatch(batchId, onProgress) {
      const batch = await getBatch(batchId);
      const ids = [];
      if (batch && batch.v === FORMAT) {
        await inChunks(batch.chars, 8, async (ch) => {
          const rec = await store.get(charKey(batchId, ch.id));
          if (!rec) return;
          for (const e of [rec.pv, rec.fb].concat(rec.arch || [], Object.values(rec.deck || {}))) if (e) ids.push(e.img, e.cap);
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
      await store.remove('b:' + batchId);
      const rest = (await listBatches()).filter((b) => b.id !== batchId);
      await store.set('batches', rest);
    }

    // ---------- карточка ----------
    /** Перерисовывает части карточки под запись персонажа. parts: status, stages, pv, fb, hist. */
    async function refreshCard(batch, charId, rec, parts) {
      const ui = batch.ui[charId];
      const upd = async (id, look) => {
        const it = await getItem(id);
        if (!it) return;
        it.content = look.content;
        Object.assign(it.style, look.style);
        await it.sync();
      };
      const jobs = [];
      if (parts.status) jobs.push(upd(ui.status, statusLook(rec.status)));
      if (parts.stages) for (const st of STAGES) jobs.push(upd(ui.st[st.id], stageLook(st, rec)));
      if (parts.pv) jobs.push(upd(ui.pv, pvLook(rec)));
      if (parts.fb) jobs.push(upd(ui.fb, fbLook(rec)));
      if (parts.hist) jobs.push(upd(ui.hist, histLook(rec)));
      const res = await Promise.allSettled(jobs);
      return res.every((r) => r.status === 'fulfilled');
    }

    async function setStatus(batch, charId, statusId) {
      if (!STATUS_BY_ID[statusId]) throw new Error('Нет такого статуса.');
      const rec = await getChar(batch.id, charId);
      rec.status = statusId;
      await store.set(charKey(batch.id, charId), rec);
      await refreshCard(batch, charId, rec, { status: true });
      return rec;
    }

    async function setArtists(batch, charId, artists) {
      const rec = await getChar(batch.id, charId);
      for (const st of STAGES) if (artists[st.id] != null) rec.artists[st.id] = String(artists[st.id]).trim().slice(0, 40);
      await store.set(charKey(batch.id, charId), rec);
      await refreshCard(batch, charId, rec, { stages: true });
      return rec;
    }

    // ---------- раскладка ----------
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

    /** Переносит картинку и подпись из карточки в слот архива. Файл заново не грузится. */
    async function moveToArchive(arRect, index, entry) {
      const s = archiveSlot(arRect, index);
      const areaH = s.h - s.capH;
      const [img, cap] = await Promise.all([getItem(entry.img), getItem(entry.cap)]);
      const jobs = [];
      if (img) {
        const side = fitSide(img.width / img.height, s.w, areaH);
        if (side.width) img.width = side.width; else img.height = side.height;
        img.x = s.left + s.w / 2;
        img.y = s.top + areaH / 2;
        jobs.push(img.sync());
      }
      if (cap) {
        cap.width = s.w;
        cap.x = s.left + s.w / 2;
        cap.y = s.top + areaH + s.capH / 2;
        jobs.push(cap.sync());
      }
      await Promise.allSettled(jobs);
    }

    /**
     * Доставка: коммит стадии или фидбек.
     * opts: { batch, charId, typeId, dataUrl, deckDataUrl?, natural:{w,h}, jira, userName, sourceItemId, statusAfter? }
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

      // Реестр и зоны читаем разом. Если зоны нет, на доске ничего не меняется.
      const [rec, zone, arZone, deckZone] = await Promise.all([
        getChar(batch.id, ch.id),
        zoneOf(isFb ? ui.fb : ui.pv, ch.name + (isFb ? ' → Feedback' : ' → превью')),
        zoneOf(ui.ar, ch.name + ' → архив'),
        deck ? zoneOf(batch.zones['deck:' + deck.key], deck.title) : Promise.resolve(null),
      ]);
      const at = new Date().toISOString();
      const by = opts.userName || '';
      const v = isFb ? 0 : (rec.vers[type.id] || 0) + 1;
      const ref = isFb && rec.pv ? entryTitle(rec.pv) : '';
      const jira = type.primary ? normalizeJira(opts.jira, batch.jiraBase) : null;
      const link = jira && jira.url ? jira.url : null;
      const entry = { type: type.id, v, ref, by, at, jira: jira ? jira.label : '', link: link || '' };
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
        const k = deck.types.length;
        const slot = deckSlot(deckZone.rect, deckGrid(deckZone.rect, k), charIdx * k + deck.types.indexOf(type.id));
        deckOverflow = slot.overflow;
        const dcap = esc(ch.name) + (k > 1 ? ' · ' + type.short : '');
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
      if (isFb) { if (rec.fb) toArchive.push(rec.fb); } else { if (rec.pv) toArchive.push(rec.pv); if (rec.fb) toArchive.push(rec.fb); }
      const moves = toArchive.map((e, i) => moveToArchive(arZone.rect, rec.arch.length + i, e));
      rec.arch = rec.arch.concat(toArchive);

      // 3. Запись персонажа.
      const mine = Object.assign({ img: card.img, cap: card.cap }, entry);
      const stale = [];
      if (isFb) {
        rec.fb = mine;
      } else {
        rec.pv = mine;
        rec.fb = null;
        rec.vers[type.id] = v;
        if (type.stage) { rec.cur = type.stage; if (by) rec.artists[type.stage] = by; }
        if (d) {
          if (rec.deck[type.id]) stale.push(rec.deck[type.id].img, rec.deck[type.id].cap);
          rec.deck[type.id] = { img: d.img, cap: d.cap };
        }
        if (jira) rec.jiraInput = String(opts.jira).trim();
      }
      rec.status = STATUS_BY_ID[opts.statusAfter] ? opts.statusAfter : isFb ? 'fixes' : 'internal';

      const tail = moves.concat([store.set(charKey(batch.id, ch.id), rec)], stale.map((id) => removeIds([id])));
      if (opts.sourceItemId) tail.push(removeIds([opts.sourceItemId]));
      await Promise.all(tail);
      const drawnOk = await refreshCard(batch, ch.id, rec, { status: true, stages: !isFb, pv: !isFb, fb: true, hist: true });
      if (!drawnOk) warnings.push('Картинка на месте, но оформление карточки обновилось не полностью.');
      return {
        v, isFeedback: isFb, title: entryTitle(entry), cardImageId: card.img, deckTitle: deck ? deck.title : null,
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

    /** → { charId, typeId|null, group|null }: бросили на стадию — знаем тип, на блок фидбека — знаем, что это фидбек. */
    function guessTarget(rects, pt) {
      let charOnly = null;
      for (const k of Object.keys(rects)) {
        const r = rects[k], p = k.split(':');
        if (pt.x < r.x - r.w / 2 || pt.x > r.x + r.w / 2) continue;
        if (p[1] !== 'st') charOnly = charOnly || { charId: p[0], typeId: null, group: null };
        if (pt.y < r.y - r.h / 2 || pt.y > r.y + r.h / 2) continue;
        if (p[1] === 'st') return { charId: p[0], typeId: p[2], group: null };
        return { charId: p[0], typeId: null, group: p[1] === 'fb' ? 'fb' : null };
      }
      return charOnly;
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
      store, listBatches, getBatch, saveBatch, getChar, buildTestBatch, deleteBatch, place, setStatus, setArtists,
      refreshCard, zoomToArchive, absRect, getItem, loadZoneRects, guessTarget, findButton, loadBatchesFull,
    };
  }

  return {
    VERSION, MARK, FORMAT, STATUSES, STATUS_BY_ID, STAGES, TYPES, TYPE_BY_ID, DECKS, DECK_BY_KEY, DEFAULT_CHARACTERS, L,
    create, pickImages, isBotImage, normalizeJira, deckGrid, deckSlot, archiveSlot, fitSide, timeline, entryTitle, esc, ddmm,
  };
});
