/* SGG Delivery Bot — логика раскладки. Работает и в браузере (window.SGG), и в Node (тесты). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SGG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.1.4';
  const MARK = 'SGG-BOT';
  const COLLECTION = 'sgg-delivery';

  // Строки в колонке персонажа (сверху вниз).
  const ROWS = [
    { key: 'pose', label: 'B/W Poses' },
    { key: 'design', label: 'B/W Design' },
    { key: 'face', label: 'Portrait' },
    { key: 'color', label: 'Color Sketch' },
    { key: 'render', label: 'Render' },
    { key: 'wip', label: 'Sketches / WIP' },
  ];

  // Секции Comparison Deck и какие типы доставки в них попадают.
  const DECKS = [
    { key: 'pose', title: 'B/W Poses', types: ['pose'] },
    { key: 'sketch', title: 'Approved Sketch (and WIPs)', types: ['design', 'color'] },
    { key: 'portrait', title: 'Portraits', types: ['face'] },
    { key: 'render', title: 'Approved Renders', types: ['render'] },
  ];

  // Типы доставки: куда в карточке персонажа (row) и в какую секцию деки (deck).
  const TYPES = [
    { id: 'color', label: 'Колор скетч', short: 'Color', row: 'color', deck: 'sketch', primary: true },
    { id: 'render', label: 'Рендер', short: 'Render', row: 'render', deck: 'render', primary: true },
    { id: 'pose', label: 'Ч/Б поза', short: 'Pose', row: 'pose', deck: 'pose', primary: false },
    { id: 'design', label: 'Ч/Б дизайн', short: 'B/W', row: 'design', deck: 'sketch', primary: false },
    { id: 'face', label: 'Лицо', short: 'Face', row: 'face', deck: 'portrait', primary: false },
    { id: 'sketch', label: 'Скетч / WIP', short: 'WIP', row: 'wip', deck: null, primary: false },
  ];
  const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const TYPE_BY_ROW = Object.fromEntries(TYPES.map((t) => [t.row, t]));
  const DECK_BY_KEY = Object.fromEntries(DECKS.map((d) => [d.key, d]));
  const ROW_BY_KEY = Object.fromEntries(ROWS.map((r) => [r.key, r]));

  // Нейтральные имена для песочницы: настоящие имена персонажей в код не попадают.
  const DEFAULT_CHARACTERS = Array.from({ length: 15 }, (_, i) => 'Character ' + String(i + 1).padStart(2, '0'));

  // Размеры тестового батча (в единицах доски).
  const L = {
    titleH: 60, deckW: 920, deckGap: 60, deckHeaderH: 40,
    colW: 300, colGap: 16, tagH: 28, nameH: 32, cellH: 170, cellGap: 4, sideGap: 40,
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const ddmm = (iso) => { const d = new Date(iso); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1); };

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

  /** Сетка слотов внутри зоны. rect — центр и размеры зоны в координатах доски. */
  function gridFor(kind, rect, perChar) {
    if (kind === 'deck') {
      const gap = 10, cellW = 140, capH = 20, cellH = 150, padTop = 10;
      let cols = Math.max(1, Math.floor((rect.w - gap) / (cellW + gap)));
      if (perChar > 1 && cols >= perChar) cols -= cols % perChar; // пары одного персонажа не рвутся по строкам
      return { gap, cellW, cellH, capH, padTop, cols };
    }
    const gap = 8, padTop = 20, capH = 30, cols = 2;
    return { gap, padTop, capH, cols, cellW: (rect.w - gap * (cols + 1)) / cols, cellH: rect.h - padTop - gap };
  }

  function slotRect(rect, g, i) {
    const col = i % g.cols, row = Math.floor(i / g.cols);
    const left = rect.x - rect.w / 2 + g.gap + col * (g.cellW + g.gap);
    const top = rect.y - rect.h / 2 + g.padTop + row * (g.cellH + g.gap);
    return { left, top, w: g.cellW, h: g.cellH, overflow: top + g.cellH > rect.y + rect.h / 2 + 0.5 };
  }

  /** Вписать картинку в область слота с сохранением пропорций. */
  function fitImage(natural, areaW, areaH) {
    const r = natural && natural.w > 0 && natural.h > 0 ? natural.w / natural.h : 1;
    return r >= areaW / areaH ? { width: areaW, h: areaW / r } : { height: areaH, h: areaH };
  }

  function deckHeight(chars, deck) {
    const g = gridFor('deck', { w: L.deckW }, deck.types.length);
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
      try { return await board.getById(id); } catch (e) { return null; }
    }

    async function removeIds(ids) {
      for (const id of ids) {
        if (!id) continue;
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

    async function zoneInfo(batch, key) {
      const id = batch.zones[key];
      const it = id ? await getItem(id) : null;
      if (!it) throw new Error('Зона «' + zoneTitle(batch, key) + '» не найдена на доске — похоже, её удалили.');
      const { rect, parent } = await absRect(it);
      const frame = it.type === 'frame' ? it : parent && parent.type === 'frame' ? parent : null;
      return { key, rect, frame };
    }

    function zoneTitle(batch, key) {
      const p = key.split(':');
      if (p[0] === 'deck') return DECK_BY_KEY[p[1]] ? DECK_BY_KEY[p[1]].title : key;
      const ch = batch.chars.find((c) => c.id === p[1]);
      return (ch ? ch.name : p[1]) + ' → ' + (ROW_BY_KEY[p[2]] ? ROW_BY_KEY[p[2]].label : p[2]);
    }

    // ---------- батчи ----------
    const listBatches = async () => (await store.get('batches')) || [];
    const getBatch = (id) => store.get('b:' + id);
    const saveBatch = (b) => store.set('b:' + b.id, b);
    const recKey = (batchId, charId, typeId) => 'd:' + batchId + ':' + charId + ':' + typeId;
    const getRecord = async (batchId, charId, typeId) => (await store.get(recKey(batchId, charId, typeId))) || { v: 0, card: [], deck: null };
    const getCharJira = (batchId, charId) => store.get('j:' + batchId + ':' + charId);

    /** Строит на доске тестовую копию секции батча: Comparison Deck слева, колонки персонажей справа. */
    async function buildTestBatch(opts) {
      const name = (opts && opts.name) || 'TEST BATCH';
      const names = (opts && opts.characters) || DEFAULT_CHARACTERS;
      const onProgress = (opts && opts.onProgress) || function () {};
      const chars = names.map((n, i) => ({ id: 'c' + pad2(i + 1), name: n }));
      const id = 'b' + Date.now().toString(36);

      const colsW = chars.length * (L.colW + L.colGap) - L.colGap;
      const totalW = L.deckW + L.sideGap + colsW;
      const deckH = L.deckHeaderH + DECKS.reduce((s, d) => s + L.deckGap + deckHeight(chars.length, d), 0);
      const colH = L.tagH + 6 + L.nameH + 6 + ROWS.length * (L.cellH + L.cellGap);
      const totalH = L.titleH + 40 + Math.max(deckH, colH);

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

      const jobs = []; // { kind, props, zone? }
      const shape = (left, top, w, h, content, style, zone) => jobs.push({
        kind: 'shape', zone,
        props: { shape: 'rectangle', content: content ? '<p>' + esc(content) + '</p>' : '', x: left + w / 2, y: top + h / 2, width: w, height: h, style: Object.assign({}, style) },
      });
      const dark = { fillColor: '#1f1f1f', color: '#ffffff', fontSize: 18, textAlign: 'center', textAlignVertical: 'middle', borderColor: '#1f1f1f', borderWidth: 1 };
      const grey = { fillColor: '#8c8c8c', color: '#ffffff', fontSize: 14, textAlign: 'center', textAlignVertical: 'middle', borderColor: '#8c8c8c', borderWidth: 1 };
      const tag = { fillColor: '#fff3b0', color: '#1f1f1f', fontSize: 10, textAlign: 'center', textAlignVertical: 'middle', borderColor: '#e0c95a', borderWidth: 1 };
      const cell = { fillColor: '#ffffff', color: '#9a9a9a', fontSize: 10, textAlign: 'left', textAlignVertical: 'top', borderColor: '#d0d0d0', borderWidth: 1 };

      shape(ox, oy, totalW, L.titleH, name, Object.assign({}, dark, { fontSize: 28 }));
      let top = oy + L.titleH + 40;
      shape(ox, top, L.deckW, L.deckHeaderH, 'COMPARISON DECK', grey);
      top += L.deckHeaderH;
      for (const d of DECKS) {
        top += L.deckGap;
        const h = deckHeight(chars.length, d);
        jobs.push({ kind: 'frame', zone: 'deck:' + d.key, props: { title: d.title, x: ox + L.deckW / 2, y: top + h / 2, width: L.deckW, height: h, style: { fillColor: '#f2f2f2' } } });
        top += h;
      }
      chars.forEach((ch, i) => {
        const left = ox + L.deckW + L.sideGap + i * (L.colW + L.colGap);
        let t = oy + L.titleH + 40;
        shape(left, t, L.colW, L.tagH, 'TO DO', tag);
        t += L.tagH + 6;
        shape(left, t, L.colW, L.nameH, ch.name, Object.assign({}, dark, { fontSize: 14 }));
        t += L.nameH + 6;
        for (const r of ROWS) {
          shape(left, t, L.colW, L.cellH, r.label, cell, 'char:' + ch.id + ':' + r.key);
          t += L.cellH + L.cellGap;
        }
      });

      const zones = {}, gen = [];
      let done = 0;
      const createOne = (j) => (j.kind === 'frame' ? board.createFrame(j.props) : board.createShape(j.props));
      try {
        const made = await inChunks(jobs, 4, async (j, n) => {
          const label = 'создание ' + j.kind + ' «' + (j.zone || j.props.title || 'оформление') + '»';
          let it;
          try { it = await createOne(j); } catch (first) {
            await pause(600); // одна повторная попытка: Miro иногда отбивает запрос под нагрузкой
            it = await step(label, () => createOne(j));
          }
          if (!it || !it.id) throw new Error('[' + label + '] Miro не вернул созданный элемент');
          if (j.zone) zones[j.zone] = it.id;
          gen.push(it.id);
          onProgress(++done, jobs.length);
          return it;
        });

        const batch = { id, name, jiraBase: '', chars, zones, v: 1 };
        await step('запись батча в хранилище доски', () => saveBatch(batch));
        await step('запись списка элементов', () => store.set('gen:' + id, gen));
        const list = (await step('чтение списка батчей', listBatches)).concat([{ id, name }]);
        await step('запись списка батчей', () => store.set('batches', list));
        try { await board.viewport.zoomTo(made[0]); } catch (e) { /* не критично */ }
        return batch;
      } catch (e) {
        // Не оставляем на доске половину батча.
        await inChunks(gen.slice(), 4, (gid) => removeIds([gid]));
        try { await store.remove('b:' + id); await store.remove('gen:' + id); } catch (e2) { /* нечего чистить */ }
        throw e;
      }
    }

    /** Убирает с доски всё, что создал бот для батча: зоны, картинки, подписи, записи реестра. */
    async function deleteBatch(batchId, onProgress) {
      const batch = await getBatch(batchId);
      const ids = [];
      if (batch) {
        const keys = [];
        for (const ch of batch.chars) for (const t of TYPES) keys.push([ch.id, t.id]);
        await inChunks(keys, 8, async ([c, t]) => {
          const k = recKey(batchId, c, t);
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
      await inChunks(list, 6, async (id) => { await removeIds([id]); if (onProgress) onProgress(++done, list.length); });
      await store.remove('gen:' + batchId);
      await store.remove('b:' + batchId);
      const rest = (await listBatches()).filter((b) => b.id !== batchId);
      await store.set('batches', rest);
    }

    // ---------- раскладка ----------
    async function drawInSlot(zone, grid, index, o) {
      const s = slotRect(zone.rect, grid, index);
      const areaH = s.h - grid.capH;
      const fit = fitImage(o.natural, s.w, areaH);
      const props = { url: o.dataUrl, title: o.title, x: s.left + s.w / 2, y: s.top + areaH / 2 };
      if (fit.width) props.width = fit.width; else props.height = fit.height;
      if (o.link) props.linkedTo = o.link;
      const img = await board.createImage(props);
      let cap;
      try {
        cap = await board.createText({
          content: '<p>' + o.caption + '</p>', x: s.left + s.w / 2, y: s.top + areaH + grid.capH / 2, width: s.w,
          style: { fontSize: 10, textAlign: 'center', color: '#555555' },
        });
      } catch (e) {
        await removeIds([img.id]);
        throw e;
      }
      let attached = true;
      if (zone.frame) {
        try { await zone.frame.add(img); await zone.frame.add(cap); } catch (e) { attached = false; }
      }
      return { img: img.id, cap: cap.id, overflow: s.overflow, attached };
    }

    /**
     * Разложить доставку.
     * opts: { batch, charId, typeId, dataUrl, natural:{w,h}, mode:'replace'|'add', jira, userName, sourceItemId }
     */
    async function place(opts) {
      const batch = opts.batch;
      const type = TYPE_BY_ID[opts.typeId];
      const charIdx = batch.chars.findIndex((c) => c.id === opts.charId);
      if (!type || charIdx < 0) throw new Error('Не выбран персонаж или тип доставки.');
      const ch = batch.chars[charIdx];
      const key = recKey(batch.id, ch.id, type.id);
      const rec = await getRecord(batch.id, ch.id, type.id);
      const v = rec.v + 1;
      const at = new Date().toISOString();
      const by = opts.userName || '';
      const jira = type.primary ? normalizeJira(opts.jira, batch.jiraBase) : null;
      const link = jira && jira.url ? jira.url : null;
      const title = [MARK, batch.name, ch.name, type.label, 'v' + v].join(' · ');
      const warnings = [];
      const base = { dataUrl: opts.dataUrl, natural: opts.natural, title, link };

      // Сначала находим обе зоны: если одной нет, на доске ничего не меняется.
      const deck = type.deck ? DECK_BY_KEY[type.deck] : null;
      const cardZone = await zoneInfo(batch, 'char:' + ch.id + ':' + type.row);
      const deckZone = deck ? await zoneInfo(batch, 'deck:' + deck.key) : null;

      // 1. Карточка персонажа: заменить последнюю версию или добавить рядом.
      const cardGrid = gridFor('card', cardZone.rect);
      const replacing = opts.mode !== 'add' && rec.card.length > 0;
      const old = replacing ? rec.card[rec.card.length - 1] : null;
      const used = new Set(rec.card.map((e) => e.slot));
      let slot = old ? old.slot : 0;
      if (!old) while (used.has(slot)) slot++;
      let caption = 'v' + v + ' · ' + ddmm(at) + (by ? ' · ' + esc(by) : '');
      if (jira) caption += ' · ' + (link ? '<a href="' + esc(link) + '">' + esc(jira.label) + '</a>' : esc(jira.label));
      const card = await drawInSlot(cardZone, cardGrid, slot, Object.assign({ caption }, base));
      if (card.overflow) warnings.push('В строке «' + ROW_BY_KEY[type.row].label + '» кончилось место — картинка легла ниже ячейки.');

      // 2. Comparison Deck: у каждого персонажа свой постоянный слот, там всегда последняя версия.
      let d = null;
      if (deck) {
        const k = deck.types.length;
        const grid = gridFor('deck', deckZone.rect, k);
        const idx = charIdx * k + deck.types.indexOf(type.id);
        const dcap = esc(ch.name) + (k > 1 ? ' · ' + type.short : '');
        try {
          d = await drawInSlot(deckZone, grid, idx, Object.assign({ caption: dcap }, base));
        } catch (e) {
          await removeIds([card.img, card.cap]); // не оставляем половину доставки
          throw e;
        }
        if (d.overflow) warnings.push('В секции «' + deck.title + '» кончилось место — растяни фрейм вниз.');
      }
      if (!card.attached || (d && !d.attached)) warnings.push('Картинка лежит поверх фрейма, но не прикрепилась к нему.');

      // 3. Новое на месте — убираем старое.
      if (old) { await removeIds([old.img, old.cap]); rec.card.pop(); }
      rec.card.push({ slot, img: card.img, cap: card.cap, v, by, at });
      if (d) {
        if (rec.deck) await removeIds([rec.deck.img, rec.deck.cap]);
        rec.deck = { img: d.img, cap: d.cap };
      }
      const deckTitle = deck ? deck.title : null;

      rec.v = v;
      if (jira) { rec.jira = opts.jira; await store.set('j:' + batch.id + ':' + ch.id, String(opts.jira).trim()); }
      await store.set(key, rec);
      if (opts.sourceItemId) await removeIds([opts.sourceItemId]);
      return { v, replaced: !!old, cardImageId: card.img, cardRow: ROW_BY_KEY[type.row].label, deckTitle, warnings, charName: ch.name, typeLabel: type.label };
    }

    // ---------- угадывание цели по месту, куда бросили картинку ----------
    async function loadZoneRects(batch) {
      const keys = Object.keys(batch.zones).filter((k) => k.indexOf('char:') === 0);
      const out = {};
      await inChunks(keys, 10, async (k) => {
        const it = await getItem(batch.zones[k]);
        if (it) out[k] = (await absRect(it)).rect;
      });
      return out;
    }

    function guessTarget(rects, pt) {
      let charOnly = null;
      for (const k of Object.keys(rects)) {
        const r = rects[k], p = k.split(':');
        const inX = pt.x >= r.x - r.w / 2 && pt.x <= r.x + r.w / 2;
        if (!inX) continue;
        if (pt.y >= r.y - r.h / 2 && pt.y <= r.y + r.h / 2) return { charId: p[1], typeId: TYPE_BY_ROW[p[2]] ? TYPE_BY_ROW[p[2]].id : null };
        charOnly = { charId: p[1], typeId: null };
      }
      return charOnly;
    }

    return {
      store, listBatches, getBatch, saveBatch, getRecord, getCharJira, buildTestBatch, deleteBatch,
      place, absRect, getItem, loadZoneRects, guessTarget, zoneTitle,
    };
  }

  return { VERSION, MARK, TYPES, ROWS, DECKS, TYPE_BY_ID, DECK_BY_KEY, ROW_BY_KEY, DEFAULT_CHARACTERS, L, create, pickImages, isBotImage, normalizeJira, gridFor, slotRect, fitImage, esc, ddmm };
});
