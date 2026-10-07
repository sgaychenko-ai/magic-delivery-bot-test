/* SGG Delivery Bot — логика. Работает и в браузере (window.SGG), и в Node (тесты). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SGG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.4.0';
  const MARK = 'SGG-BOT';
  const COLLECTION = 'sgg-delivery';
  const FORMAT = 5; // формат батча: 5 = над ячейкой фидбека появилась плашка Feedback, ячейка стала больше

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
    // Фидбек, про который не сказали, чей он: в ячейке что-то лежало, а плашку Feedback не нажали. В панели не выбирается.
    { id: 'fb_any', label: 'Фидбек', en: 'Feedback', group: 'none', fb: 'any', color: '#888780', tint: '#F4F4F2' },
  ];
  const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const LEGACY_TYPES = ['color', 'render', 'pose', 'design', 'face', 'sketch'];

  // Нейтральные имена для песочницы: настоящие имена персонажей в код не попадают.
  const DEFAULT_CHARACTERS = Array.from({ length: 15 }, (_, i) => 'Character ' + String(i + 1).padStart(2, '0'));

  // Размеры тестового батча (в единицах доски).
  const L = {
    titleH: 60, deckW: 920, deckGap: 60, deckHeaderH: 40, sideGap: 40,
    cardW: 360, cardGap: 20, tagH: 30, nameH: 34, asH: 28, stageH: 38, stageGap: 4, pvH: 300, fbHeadH: 28, fbH: 300, histH: 28, gap: 6,
    archGap: 3200, archHeadH: 36, archLabelH: 24, archCellH: 160, archCapH: 28,
  };
  const stageRows = () => Math.ceil(STAGES.length / STAGE_COLS);
  const stripHeight = () => stageRows() * L.stageH + (stageRows() - 1) * L.stageGap;
  const cardHeight = () => L.tagH + L.nameH + L.asH + stripHeight() + L.pvH + L.fbHeadH + L.fbH + L.histH + L.gap * 7;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const ddmm = (iso) => { const d = new Date(iso); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1); };
  const para = (html) => '<p>' + html + '</p>';

  /** Текст элемента доски без разметки — так бот читает имя, которое поправили руками прямо на карточке. */
  function plainText(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  }
  /** Подпись под картинкой в Comparison Deck: имя персонажа и, если в секции несколько типов, какой это тип. */
  const deckCaption = (name, deck, type) => esc(name) + (deck.types.length > 1 && type ? ' · ' + type.short : '');
  /** Прямоугольник, уменьшенный со всех сторон на p, с тем же местом под подпись. */
  const inset = (box, p) => ({ left: box.left + p, top: box.top + p, w: box.w - p * 2, h: box.h - p * 2, capH: box.capH });

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

  /** Какая версия бота сейчас лежит на хостинге. null — узнать не удалось. Нужна, чтобы заметить устаревшую вкладку. */
  async function latestVersion() {
    try {
      if (typeof fetch !== 'function' || typeof location === 'undefined' || (typeof self !== 'undefined' && self.SGG_OFFLINE)) return null;
      const res = await fetch(new URL('version.json', location.href).href + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return null;
      const v = (await res.json()).version;
      return typeof v === 'string' ? v : null;
    } catch (e) { return null; }
  }
  const CHANNEL = 'sgg-delivery-bot'; // по этому каналу панель спрашивает невидимую часть бота, какой она версии

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

  // Набор — фидбек, который положили в ячейку руками: картинка, стикеры, текст. Он ездит целиком и не меняет размер.
  const isBundle = (e) => !!(e && e.items && e.items.length);
  const bundleIds = (e) => [e.img, e.cap].concat(e.items || []).filter(Boolean);

  /**
   * Места в хранилище под якорем персонажа, сверху вниз. Обычные сабмиты — по два в ряд,
   * набор занимает ряд целиком и столько высоты, сколько занимал в ячейке фидбека.
   */
  function archiveLayout(rect, entries) {
    const gap = 8, w = (rect.w - gap) / 2, left = rect.x - rect.w / 2, out = [];
    let top = rect.y + rect.h / 2 + gap, col = 0;
    for (const e of entries) {
      if (isBundle(e)) {
        if (col) { top += L.archCellH + gap; col = 0; }
        out.push({ left, top, w: rect.w, h: e.h || L.fbH, capH: 0 });
        top += (e.h || L.fbH) + gap;
      } else {
        out.push({ left: left + col * (w + gap), top, w, h: L.archCellH, capH: L.archCapH });
        if (++col === 2) { col = 0; top += L.archCellH + gap; }
      }
    }
    return out;
  }

  /** Общий прямоугольник нескольких элементов доски. */
  function bboxOf(objs) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const o of objs) { const w = o.width || 0, h = o.height || 0; l = Math.min(l, o.x - w / 2); t = Math.min(t, o.y - h / 2); r = Math.max(r, o.x + w / 2); b = Math.max(b, o.y + h / 2); }
    return { left: l, top: t, w: r - l, h: b - t };
  }

  /** «1 image, 2 notes» — что лежит в принятом фидбеке. */
  function describe(objs) {
    const n = { image: 0, note: 0, text: 0, item: 0 };
    for (const o of objs) n[o.type === 'image' ? 'image' : o.type === 'sticky_note' ? 'note' : o.type === 'text' ? 'text' : 'item']++;
    return Object.keys(n).filter((k) => n[k]).map((k) => n[k] + ' ' + k + (n[k] > 1 ? 's' : '')).join(', ');
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
  // Ячейка фидбека — место, куда кладут что угодно: картинку, стикеры, текст. Пустая подсказывает, что делать.
  const fbLook = (rec) => {
    const t = rec.fb ? TYPE_BY_ID[rec.fb.type] : null;
    return {
      content: t ? '' : para('Put feedback here: image, sticky notes, text.') + para('Then press “Feedback” above.'),
      style: Object.assign({}, BASE, { textAlign: 'left', textAlignVertical: 'top', fillColor: t ? t.tint : '#FAFAFA', borderColor: t ? t.color : '#D0D0D0', borderWidth: t ? 2 : 1, color: '#9A9A9A' }),
    };
  };
  // Плашка над ячейкой: по ней бот принимает то, что лежит в ячейке, и на ней написано, чей фидбек и что в нём.
  const fbHeadLook = (rec) => {
    const t = rec.fb ? TYPE_BY_ID[rec.fb.type] : null;
    if (!t) return { content: para('<strong>+ Feedback</strong> ▾'), style: Object.assign({}, BASE, { fontSize: 11, fillColor: '#FFFFFF', borderColor: '#D0D0D0', color: '#8C8C8C' }) };
    return {
      content: para('<strong>' + t.en + '</strong>' + (rec.fb.sum ? ' · ' + esc(rec.fb.sum) : '') + ' ▾'),
      style: Object.assign({}, BASE, { fontSize: 11, fillColor: t.color, borderColor: t.color, color: '#FFFFFF' }),
    };
  };
  // Поле под прошлым сабмитом в раскрытой истории: рамка цвета стадии, у фидбека — ещё и подложка его цвета.
  const pastLook = (e) => {
    const t = TYPE_BY_ID[e.type] || {};
    return Object.assign({}, BASE, { fillColor: t.tint || '#FFFFFF', borderColor: t.color || '#D0D0D0', borderWidth: 2, color: '#8C8C8C' });
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
        shape(left, t, L.cardW, L.fbHeadH, fbHeadLook(blank), { ref: [ch.id, 'fbh'] });
        t += L.fbHeadH + L.gap;
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
            if (part === 'fbh') btn[it.id] = [cid, 'fb'];
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
          for (const e of [rec.pv, rec.fb].concat(rec.arch || [], Object.values(rec.deck || {}))) if (e) ids.push(e.img, e.cap, e.bg, ...(e.items || []));
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
    /** Перерисовывает части карточки под запись персонажа. parts: status, assign (true или id фазы), stages, pv, fb (ячейка и плашка фидбека), hist. */
    async function refreshCard(batch, charId, rec, parts) {
      const ui = batch.ui[charId];
      const want = [];
      if (parts.status) want.push([ui.status, statusLook(rec.status)]);
      if (parts.assign) for (const ph of PHASES) if (parts.assign === true || parts.assign === ph.id) want.push([ui.as[ph.id], assignLook(ph, rec)]);
      if (parts.stages) for (const st of STAGES) want.push([ui.st[st.id], stageLook(st, rec)]);
      if (parts.pv) want.push([ui.pv, pvLook(rec)]);
      if (parts.fb) want.push([ui.fb, fbLook(rec)], [ui.fbh, fbHeadLook(rec)]);
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

    // ---------- фидбек: что лежит в ячейке, то и фидбек ----------
    /** Всё, что лежит на доске. Один запрос: по нему бот находит, что люди положили в ячейку фидбека. */
    async function readBoard() {
      try { return (await board.get()) || []; } catch (e) { return []; }
    }
    const rectOf = (it) => ({ x: it.x, y: it.y, w: it.width, h: it.height });

    /** Элементы, которые положили в ячейку руками: центр внутри ячейки, и это не часть карточки и не картинка бота. */
    function collect(batch, charId, rec, cell, all, ignore) {
      const ui = batch.ui[charId], skip = new Set(ignore || []);
      for (const id of [ui.status, ui.name, ui.hist, ui.pv, ui.fbh, ui.fb, ui.ar].concat(Object.values(ui.as), Object.values(ui.st))) skip.add(id);
      for (const e of [rec.pv, rec.fb].concat(rec.arch, Object.values(rec.deck))) if (e) { skip.add(e.img); skip.add(e.cap); skip.add(e.bg); }
      for (const e of rec.arch) for (const id of e.items || []) skip.add(id);
      const l = cell.x - cell.w / 2, r = cell.x + cell.w / 2, t = cell.y - cell.h / 2, b = cell.y + cell.h / 2;
      return all.filter((it) => it && !skip.has(it.id) && !hasParent(it) && it.type !== 'frame' && it.type !== 'connector' && it.type !== 'group'
        && isFinite(it.x) && isFinite(it.y) && it.x >= l && it.x <= r && it.y >= t && it.y <= b);
    }

    /** Запоминает в записи фидбека, что в нём лежит и как оно стоит относительно ячейки, — чтобы потом возить набор целиком. */
    function seal(e, cell, found, byId) {
      e.items = found.map((it) => it.id);
      e.w = cell.w; e.h = cell.h;
      const own = [e.img, e.cap].map((id) => byId.get(id)).filter(Boolean);
      const objs = own.concat(found);
      if (objs.length) { const bb = bboxOf(objs); e.dx = bb.left - (cell.x - cell.w / 2); e.dy = bb.top - (cell.y - cell.h / 2); }
      e.sum = describe((e.img && byId.get(e.img) ? [byId.get(e.img)] : []).concat(found));
      return e;
    }

    /** Переносит набор целиком: левый верхний угол его ячейки встаёт в точку (left, top). → запущенные обновления. */
    function moveBundle(got, e, left, top) {
      const objs = bundleIds(e).map((id) => got.get(id)).filter(Boolean);
      if (!objs.length) return [];
      const bb = bboxOf(objs), dx = left + (e.dx || 0) - bb.left, dy = top + (e.dy || 0) - bb.top;
      return objs.map((it) => { it.x += dx; it.y += dy; return it.sync(); });
    }

    /** Отправляет запись в хранилище на её место. got — уже прочитанные элементы (id → элемент). */
    function stow(got, arRect, rec, e) {
      const slot = archiveLayout(arRect, rec.arch)[rec.arch.indexOf(e)];
      if (isBundle(e)) return Promise.allSettled(moveBundle(got, e, slot.left, slot.top));
      return moveInto(inset(slot, 4), e);
    }

    const feedbackOptions = (rec) => {
      const cur = rec.fb ? rec.fb.type : '';
      const out = ['fb_client', 'fb_lead'].map((id) => ({ value: id, label: TYPE_BY_ID[id].en, fill: TYPE_BY_ID[id].tint, mark: id === cur }));
      if (rec.fb) out.push({ value: 'archive', label: '→ Move to history', fill: '#F2F2F2' });
      return out;
    };

    /**
     * Принимает как фидбек всё, что лежит в ячейке: картинки, стикеры, текст. Ничего не перезаливается и не двигается.
     * Повторное нажатие добирает то, что положили позже, и может поменять, чей это фидбек.
     * → { count, sum, fresh, rec }; count 0 — в ячейке пусто.
     */
    async function takeFeedback(batch, charId, typeId, userName, ignore) {
      const type = TYPE_BY_ID[typeId];
      if (!type || !type.fb) throw new Error('Нет такого типа фидбека.');
      const ui = batch.ui[charId];
      const rec = await getChar(batch.id, charId);
      if (rec.open) await setHistory(batch, charId, false, rec); // ячейка должна стоять на своём месте
      const [cellItem, all, open] = await Promise.all([getItem(ui.fb), readBoard(), store.get(menuKey(batch.id, charId))]);
      if (!cellItem) throw new Error('Ячейка фидбека не найдена на доске — похоже, её удалили.');
      const cell = rectOf(cellItem), byId = new Map(all.map((it) => [it.id, it]));
      const found = collect(batch, charId, rec, cell, all, (ignore || []).concat(open || [])); // строки раскрытого списка — не фидбек
      const keepsImage = !!(rec.fb && rec.fb.img && byId.get(rec.fb.img));
      if (!found.length && !keepsImage) {
        if (!rec.fb) return { count: 0, rec };
        rec.fb = null; // фидбек убрали из ячейки руками
        await Promise.all([store.set(charKey(batch.id, charId), rec), refreshCard(batch, charId, rec, { fb: true })]);
        return { count: 0, cleared: true, rec };
      }
      const fresh = !rec.fb;
      const e = rec.fb || { n: (rec.seq || 0) + 1, v: 0, ref: rec.pv ? entryTitle(rec.pv) : '', by: userName || '', at: new Date().toISOString() };
      e.type = type.id;
      seal(e, cell, found, byId);
      rec.fb = e;
      rec.seq = Math.max(rec.seq || 0, e.n);
      if (fresh) rec.status = 'fixes';
      const jobs = [store.set(charKey(batch.id, charId), rec), refreshCard(batch, charId, rec, { status: fresh, fb: true })];
      if (fresh && userName) jobs.push(addToTeam(batch.id, userName).catch(() => null));
      await Promise.all(jobs);
      return { count: found.length + (keepsImage ? 1 : 0), sum: e.sum, fresh, title: entryTitle(e), rec };
    }

    /** Убирает текущий фидбек из ячейки в историю, не дожидаясь нового сабмита. → { moved, rec } */
    async function archiveFeedback(batch, charId, ignore) {
      const ui = batch.ui[charId];
      const rec = await getChar(batch.id, charId);
      if (rec.open) await setHistory(batch, charId, false, rec);
      const [cellItem, ar, all, open] = await Promise.all([getItem(ui.fb), getItem(ui.ar), readBoard(), store.get(menuKey(batch.id, charId))]);
      if (!cellItem || !ar) throw new Error('Ячейка фидбека или хранилище не найдены на доске — похоже, их удалили.');
      const cell = rectOf(cellItem), byId = new Map(all.map((it) => [it.id, it]));
      const found = collect(batch, charId, rec, cell, all, (ignore || []).concat(open || []));
      const e = rec.fb || (found.length ? { n: (rec.seq || 0) + 1, type: 'fb_any', v: 0, ref: rec.pv ? entryTitle(rec.pv) : '', by: '', at: new Date().toISOString() } : null);
      if (!e) return { moved: 0, rec };
      seal(e, cell, found, byId);
      rec.fb = null;
      const has = isBundle(e) || !!(e.img && byId.get(e.img));
      if (has) { rec.arch.push(e); rec.seq = Math.max(rec.seq || 0, e.n); }
      await Promise.all([has ? stow(byId, rectOf(ar), rec, e) : null, store.set(charKey(batch.id, charId), rec), refreshCard(batch, charId, rec, { fb: true, hist: true })]);
      return { moved: has ? 1 : 0, title: entryTitle(e), rec };
    }

    /** Картинка лежит в ячейке фидбека какого-то персонажа? → { batch, charId } | null. Такую форма доставки не спрашивает. */
    async function feedbackCellAt(batches, item) {
      if (!item || hasParent(item)) return null;
      for (const b of batches || []) {
        const got = await getMany(b.chars.map((c) => b.ui[c.id].fb));
        for (const ch of b.chars) {
          const c = got.get(b.ui[ch.id].fb);
          if (c && Math.abs(item.x - c.x) <= c.width / 2 && Math.abs(item.y - c.y) <= c.height / 2) return { batch: b, charId: ch.id };
        }
      }
      return null;
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
      // Текущее содержимое карточки: превью, плашка и ячейка фидбека и всё, что бот принял как фидбек.
      const current = [ui.pv, rec.pv && rec.pv.img, rec.pv && rec.pv.cap, ui.fbh, ui.fb].concat(rec.fb ? bundleIds(rec.fb) : []).filter(Boolean);
      const got = await getMany(current.concat(...rec.arch.map((e) => [e.img, e.cap, e.bg].concat(e.items || [])), [ui.hist, ui.ar], rec.cells || []));
      const jobs = [];
      const fresh = []; // сабмиты, которым поле создано только что: [запись, поле]
      const shiftCurrent = (dy) => current.forEach((id) => { const it = got.get(id); if (it) { it.y += dy; jobs.push(it.sync()); } });
      // Поле под сабмитом создаётся один раз и дальше ездит вместе с ним: раскрыли — в карточку, свернули — в хранилище.
      const field = (e, x, y, w, h) => {
        const bg = e.bg ? got.get(e.bg) : null;
        if (bg) { bg.x = x; bg.y = y; bg.width = w; bg.height = h; jobs.push(bg.sync()); return; }
        jobs.push(board.createShape({ shape: 'rectangle', content: '', x, y, width: w, height: h, style: pastLook(e) }).then((it) => { e.bg = it.id; fresh.push([e, it]); }));
      };
      if (open) {
        const pv = got.get(ui.pv);
        if (!pv) throw new Error('Превью персонажа не найдено на доске — похоже, его удалили.');
        const pad = 8, x0 = pv.x, w0 = pv.width, h0 = pv.height;
        let top = pv.y - pv.height / 2;
        const top0 = top;
        past.forEach((e) => {
          const h = isBundle(e) ? e.h || h0 : h0; // набор занимает столько же, сколько занимал в ячейке фидбека
          field(e, x0, top + h / 2, w0, h);
          if (isBundle(e)) jobs.push(...moveBundle(got, e, x0 - w0 / 2, top));
          else jobs.push(...placeInto(got, { left: x0 - w0 / 2 + pad, top: top + pad, w: w0 - pad * 2, h: h0 - pad * 2, capH: 30 }, e));
          top += h + L.gap;
        });
        shiftCurrent(top - top0);
        rec.open = true; rec.shift = top - top0;
      } else {
        const ar = got.get(ui.ar);
        if (!ar) throw new Error('Хранилище прошлых сабмитов не найдено на доске — похоже, его удалили.');
        const slots = archiveLayout({ x: ar.x, y: ar.y, w: ar.width, h: ar.height }, rec.arch);
        shiftCurrent(-(rec.shift || 0));
        rec.arch.forEach((e, i) => {
          const slot = slots[i];
          if (e.bg && got.get(e.bg)) field(e, slot.left + slot.w / 2, slot.top + slot.h / 2, slot.w, slot.h);
          if (isBundle(e)) jobs.push(...moveBundle(got, e, slot.left, slot.top));
          else jobs.push(...placeInto(got, inset(slot, 4), e));
        });
        (rec.cells || []).forEach((id) => { const it = got.get(id); if (it) jobs.push(board.remove(it)); }); // рамки из версий до 0.3.1
        rec.open = false; rec.shift = 0; rec.cells = [];
      }
      const hist = got.get(ui.hist);
      if (hist) { const look = histLook(rec); hist.content = look.content; Object.assign(hist.style, look.style); jobs.push(hist.sync()); }
      // Если новых полей не будет, запись уходит вместе с движением — без лишнего круга.
      const creating = open && past.some((e) => !(e.bg && got.get(e.bg)));
      if (!creating) jobs.push(store.set(charKey(batch.id, charId), rec));
      await Promise.allSettled(jobs);
      if (creating) {
        // Новое поле Miro кладёт поверх всего. У обычного сабмита поднимаем над полем картинку и подпись;
        // у набора порядок слоёв трогать нельзя (стикер должен остаться над картинкой) — там поле уходит под низ.
        const tail = [store.set(charKey(batch.id, charId), rec)];
        const lift = [].concat(...fresh.filter((f) => !isBundle(f[0])).map((f) => [got.get(f[0].img), got.get(f[0].cap)])).filter(Boolean);
        if (lift.length) tail.push(Promise.resolve().then(() => board.bringToFront(lift)).catch(() => null));
        for (const f of fresh.filter((x) => isBundle(x[0]))) {
          const objs = bundleIds(f[0]).map((id) => got.get(id)).filter(Boolean);
          tail.push(Promise.resolve().then(() => board.sendToBack(f[1])).catch(() => board.bringToFront(objs)).catch(() => null));
        }
        await Promise.allSettled(tail);
      }
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
      // Перезалив не трогает фидбек, поэтому ячейку фидбека для него читать не нужно.
      const sweep = !(!isFb && !!opts.replace && !!before.pv && before.pv.type === type.id);
      // Реестр, зоны и содержимое доски читаем разом. Если зоны нет, на доске ничего не меняется.
      const [rec, zone, arZone, deckZone, deckIdx, fbCell, all, openMenuIds] = await Promise.all([
        before.open ? getChar(batch.id, ch.id) : Promise.resolve(before),
        zoneOf(isFb ? ui.fb : ui.pv, ch.name + (isFb ? ' → Feedback' : ' → превью')),
        zoneOf(ui.ar, ch.name + ' → архив'),
        deck ? zoneOf(batch.zones['deck:' + deck.key], deck.title) : Promise.resolve(null),
        deck ? deckIndex(batch.id, deck.key, ch.id) : Promise.resolve(-1),
        sweep && !isFb ? getItem(ui.fb) : Promise.resolve(null),
        sweep ? readBoard() : Promise.resolve([]),
        sweep ? store.get(menuKey(batch.id, ch.id)) : Promise.resolve(null),
      ]);
      // Что люди положили в ячейку фидбека руками — оно принадлежит текущему фидбеку, даже если плашку не нажали.
      const cell = isFb ? zone.rect : fbCell ? rectOf(fbCell) : null;
      const byId = new Map(all.map((it) => [it.id, it]));
      const inCell = sweep && cell ? collect(batch, ch.id, rec, cell, all, openMenuIds) : [];
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
      const r = zone.rect, pad = 8, capH = 30;
      const box = { left: r.x - r.w / 2 + pad, top: r.y - r.h / 2 + pad, w: r.w - pad * 2, h: r.h - pad * 2, capH };
      const draws = [drawAt(box, zone.frame, Object.assign({ caption }, base))];
      let deckOverflow = false;
      if (deck) {
        const slot = deckSlot(deckZone.rect, deckGrid(deckZone.rect), deckIdx);
        deckOverflow = slot.overflow;
        const dcap = deckCaption(ch.name, deck, type);
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
      let mineItems = [];
      if (isFb) {
        // Новый фидбек через форму: прежний уезжает со своими стикерами, а то, что положили в ячейку после него, остаётся новому.
        // Пустую запись (всё убрали руками) в историю не кладём.
        const alive = (e) => isBundle(e) || !!(e.img && byId.get(e.img));
        if (rec.fb) {
          const had = new Set(rec.fb.items || []);
          if (alive(seal(rec.fb, cell, inCell.filter((it) => had.has(it.id)), byId))) toArchive.push(rec.fb);
          mineItems = inCell.filter((it) => !had.has(it.id));
        } else mineItems = inCell;
      } else if (!redo) {
        if (rec.pv) toArchive.push(rec.pv);
        if (rec.fb && !cell) toArchive.push(rec.fb);
        else if (rec.fb) { seal(rec.fb, cell, inCell, byId); if (isBundle(rec.fb) || (rec.fb.img && byId.get(rec.fb.img))) toArchive.push(rec.fb); }
        else if (inCell.length) {
          // В ячейке что-то лежало, а плашку Feedback не нажали: уходит в историю как фидбек без автора, перед новым сабмитом.
          toArchive.push(seal({ n: entry.n, type: 'fb_any', v: 0, ref: rec.pv ? entryTitle(rec.pv) : '', by: '', at }, cell, inCell, byId));
          entry.n += 1;
        }
      }
      rec.arch = rec.arch.concat(toArchive);
      const moves = toArchive.map((e) => stow(byId, arZone.rect, rec, e));

      // 3. Запись персонажа.
      const mine = Object.assign({ img: card.img, cap: card.cap }, entry);
      if (isFb && mineItems.length) { // стикеры из ячейки едут вместе с новой картинкой фидбека
        mine.items = mineItems.map((it) => it.id);
        mine.w = cell.w; mine.h = cell.h;
        mine.sum = describe([{ type: 'image' }].concat(mineItems));
      }
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

    // ---------- имена ----------
    /**
     * Имя персонажа поменяли: записываем его в батч и переписываем подписи в Comparison Deck и в хранилище.
     * → true, если что-то изменилось.
     */
    async function renameChar(batch, charId, name) {
      const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60); // имя уже без разметки
      const ch = batch.chars.find((c) => c.id === charId);
      if (!ch || !clean) return false;
      const fresh = (await getBatch(batch.id)) || batch; // батч мог обновить кто-то ещё — правим свежую копию
      const fc = fresh.chars.find((c) => c.id === charId);
      ch.name = clean;
      if (!fc || fc.name === clean) return false;
      fc.name = clean;
      const [rec] = await Promise.all([getChar(batch.id, charId), saveBatch(fresh)]);
      const want = [[batch.ui[charId].ar, para(esc(clean))]];
      for (const d of DECKS) { const e = rec.deck[d.key]; if (e) want.push([e.cap, para(deckCaption(clean, d, TYPE_BY_ID[e.type]))]); }
      const got = await getMany(want.map((w) => w[0]));
      await Promise.allSettled(want.map(([id, content]) => { const it = got.get(id); if (!it) return null; it.content = content; return it.sync(); }));
      return true;
    }

    /** Сверяет имена в батче с тем, что написано на карточках. Доска главнее. → [{ charId, from, to }] */
    async function syncNames(batch) {
      const got = await getMany(batch.chars.map((c) => batch.ui[c.id].name));
      const out = [];
      for (const ch of batch.chars) {
        const it = got.get(batch.ui[ch.id].name), to = it ? plainText(it.content).slice(0, 60) : '', from = ch.name;
        if (to && to !== from) { await renameChar(batch, ch.id, to); out.push({ charId: ch.id, from, to }); }
      }
      return out;
    }

    /** Переносит экран к архиву персонажа — это и есть «раскрыть историю». */
    async function zoomToArchive(batch, charId) {
      const rec = await getChar(batch.id, charId);
      const ids = [batch.ui[charId].ar].concat(rec.arch.slice(-8).map((e) => e.img || (e.items || [])[0]));
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
      refreshCard, renameChar, syncNames, takeFeedback, archiveFeedback, feedbackOptions, feedbackCellAt, openMenu, closeMenu, statusOptions, assignOptions, setHistory, toggleHistory, collapseAll, zoomToArchive, absRect, getItem, loadZoneRects, guessTarget, findButton, loadBatchesFull,
    };
  }

  return {
    VERSION, MARK, FORMAT, STATUSES, STATUS_BY_ID, STAGES, STAGE_COLS, PHASES, TYPES, TYPE_BY_ID, DECKS, DECK_BY_KEY, DEFAULT_CHARACTERS, L,
    create, latestVersion, CHANNEL, plainText, pickImages, isBotImage, normalizeJira, shortName, phaseOfStage, deckGrid, deckSlot, archiveSlot, archiveLayout, isBundle, bundleIds, fitSide, timeline, pastSubmits, entryTitle, esc, ddmm,
  };
});
