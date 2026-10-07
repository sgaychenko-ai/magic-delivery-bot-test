/* Панель бота: доставка картинок, статус и история персонажа, кто на какой фазе, настройки батча. */
(async function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  const $ = (id) => document.getElementById(id);

  const state = {
    list: [], full: [], batch: null, rects: null, rectsP: null,
    queue: [], current: null, loading: false,
    charId: null, typeId: null, rec: null,
    user: { id: null, name: '' }, busy: false, view: 'Empty', online: [],
    team: [], recs: {},
    touched: { char: false, type: false }, // что человек выбрал сам для текущей картинки — это бот не трогает
    hint: '',
  };
  const seen = new Set(); // картинки, про которые бот уже спрашивал
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- мелочи ----------
  const remember = (k, v) => { try { localStorage.setItem('sgg:' + k, v); } catch (e) { /* хранилище закрыто */ } };
  const recall = (k) => { try { return localStorage.getItem('sgg:' + k); } catch (e) { return null; } };
  const diagOn = () => recall('diag') !== '0';

  function log(text, kind) {
    const el = document.createElement('div');
    if (kind) el.className = kind;
    el.textContent = text;
    $('log').prepend(el);
    while ($('log').children.length > 6) $('log').lastChild.remove();
  }
  // В красной строке — что сломалось и где: первые строки стека нужны, чтобы найти место без консоли.
  const fail = (what, e) => {
    console.error('[SGG bot]', e);
    const where = e && e.stack ? String(e.stack).split('\n').slice(1, 5).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//g, '')).join(' ← ') : '';
    log(what + ': ' + (e && e.message ? e.message : String(e)) + (where ? ' · ' + where.slice(0, 420) : ''), 'err');
  };

  function showView(name) {
    state.view = name;
    for (const v of ['Empty', 'Delivery', 'Char', 'Team', 'Setup']) $('view' + v).hidden = v !== name;
    $('tabs').hidden = name === 'Empty';
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === name)));
    $('batchSelect').hidden = name === 'Empty' || state.full.length < 2;
    render();
  }

  function progress(id, done, total) {
    const el = $(id);
    el.hidden = false;
    el.firstElementChild.style.width = Math.round((done / Math.max(1, total)) * 100) + '%';
    if (done >= total) setTimeout(() => { el.hidden = true; }, 400);
  }

  // ---------- картинка ----------
  const loadImage = (src) => new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('Файл не читается как картинка.'));
    img.src = src;
  });
  const readFile = (file) => new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => no(new Error('Не удалось прочитать файл.'));
    r.readAsDataURL(file);
  });

  const DECK_SIDE = 1600; // в деке картинка мелкая — туда уходит копия не больше этого размера
  function shrink(img, natural, side, mime) {
    const k = side / Math.max(natural.w, natural.h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(natural.w * k));
    c.height = Math.max(1, Math.round(natural.h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(mime, 0.9);
  }

  /** Приводит картинку к виду, который Miro точно примет: PNG/JPEG/GIF, не больше 4096 px и ~6 МБ. */
  async function prepare(dataUrl) {
    const img = await loadImage(dataUrl);
    const natural = { w: img.naturalWidth, h: img.naturalHeight };
    const okType = /^data:image\/(png|jpe?g|gif);/i.test(dataUrl);
    const longest = Math.max(natural.w, natural.h);
    const deckDataUrl = longest > DECK_SIDE ? shrink(img, natural, DECK_SIDE, /^data:image\/jpe?g;/i.test(dataUrl) ? 'image/jpeg' : 'image/png') : null;
    if (okType && longest <= 4096 && dataUrl.length <= 8000000) return { dataUrl, natural, deckDataUrl };
    let out = shrink(img, natural, Math.min(longest, 3000), 'image/png');
    if (out.length > 8000000) out = shrink(img, natural, Math.min(longest, 3000), 'image/jpeg');
    return { dataUrl: out, natural, deckDataUrl };
  }

  // ---------- очередь ----------
  function enqueue(entries) {
    for (const e of entries) {
      if (e.kind === 'board' && (state.queue.some((q) => q.id === e.id) || (state.current && state.current.id === e.id))) continue;
      if (e.kind === 'board') seen.add(e.id);
      state.queue.push(e);
    }
    if (state.view !== 'Delivery' && state.batch) showView('Delivery');
    pump();
  }

  async function guessFor(item) {
    if (!state.batch) return null;
    try {
      const rects = state.rects || (await Promise.race([state.rectsP, sleep(1500).then(() => null)]));
      if (!rects) return null;
      const r = (await core.absRect(item)).rect;
      return core.guessTarget(rects, { x: r.x, y: r.y });
    } catch (e) { return null; }
  }

  /** Только что брошенная картинка может ещё загружаться — опрашиваем Miro, пока файл не появится. */
  async function dataUrlOf(item) {
    let err = null;
    for (let n = 0; n < 25; n++) {
      try { const u = await item.getDataUrl(); if (u) return u; } catch (e) { err = e; }
      await sleep(400);
    }
    throw err || new Error('Miro не отдал файл картинки.');
  }

  async function pump() {
    if (state.current || state.loading || !state.queue.length) { render(); return; }
    state.loading = true;
    const next = state.queue.shift();
    render();
    const t0 = performance.now();
    try {
      let raw = next.dataUrl, guess = null;
      if (next.kind === 'board') {
        const item = await core.getItem(next.id);
        if (!item) throw new Error('Картинку уже убрали с доски.');
        if (SGG.isBotImage(item)) { state.loading = false; pump(); return; }
        // Файл и догадку «куда бросили» получаем одновременно; зоны батча уже читаются в фоне.
        const got = await Promise.all([dataUrlOf(item), guessFor(item)]);
        raw = got[0]; guess = got[1];
      }
      const ready = await prepare(raw);
      state.current = { kind: next.kind, id: next.id || null, dataUrl: ready.dataUrl, deckDataUrl: ready.deckDataUrl, natural: ready.natural, took: (performance.now() - t0) / 1000 };
      // Догадка по месту, куда бросили, приходит с задержкой. Если человек уже выбрал сам — его выбор главнее.
      if (guess) {
        const took = [];
        if (!state.touched.char && guess.charId) { state.charId = guess.charId; took.push((state.batch.chars.find((c) => c.id === guess.charId) || {}).name); }
        if (!state.touched.type && guess.typeId) { state.typeId = guess.typeId; took.push(SGG.TYPE_BY_ID[guess.typeId].label); }
        state.hint = took.length ? 'Выбрал по месту, куда бросили: ' + took.join(' · ') + '. Можно поменять.' : '';
      }
    } catch (e) {
      fail('Не получилось взять картинку', e);
    }
    state.loading = false;
    await loadChar();
    if (!state.current && state.queue.length) pump();
  }

  function finishCurrent() {
    state.current = null;
    state.typeId = null;
    state.touched = { char: false, type: false };
    state.hint = '';
    pump();
  }

  // ---------- батчи ----------
  async function loadBatches(preferId) {
    state.list = await core.listBatches();
    state.full = await core.loadBatchesFull();
    const legacy = state.list.filter((b) => b.v !== SGG.FORMAT);
    $('legacy').hidden = !legacy.length;
    if (legacy.length) {
      $('legacyText').textContent = 'На доске остался батч старого формата «' + legacy[0].name + '». С новой версией он не работает.';
      $('legacyDelete').dataset.id = legacy[0].id;
    }
    const sel = $('batchSelect');
    sel.innerHTML = '';
    for (const b of state.full) sel.add(new Option(b.name, b.id));
    if (!state.full.length) { state.batch = null; $('cancelNew').hidden = true; showView('Empty'); return; }
    const want = preferId || recall('batch');
    const pick = state.full.find((b) => b.id === want) || state.full[state.full.length - 1];
    await selectBatch(pick.id);
  }

  async function selectBatch(id) {
    state.batch = state.full.find((b) => b.id === id) || (await core.getBatch(id));
    state.rects = null;
    state.rectsP = core.loadZoneRects(state.batch).then((r) => { state.rects = r; return r; }).catch(() => null);
    state.recs = {};
    try { state.team = await core.getTeam(id); } catch (e) { state.team = []; }
    $('teamNames').value = state.team.join('\n');
    $('batchSelect').value = id;
    remember('batch', id);
    for (const sid of ['charSelect', 'charSelect2']) {
      const cs = $(sid);
      cs.innerHTML = '';
      cs.add(new Option('— выбери персонажа —', ''));
      for (const ch of state.batch.chars) cs.add(new Option(ch.name, ch.id));
    }
    const last = recall('char:' + id);
    state.charId = state.batch.chars.some((c) => c.id === last) ? last : null;
    $('setupTitle').textContent = state.batch.name;
    $('jiraBase').value = state.batch.jiraBase || '';
    await loadChar();
  }

  let charLoad = 0;
  async function loadChar() {
    const my = ++charLoad; // если персонажа сменили, пока читалась запись, старый ответ не должен затереть новый
    const id = state.charId;
    let rec = null;
    state.rec = null;
    if (state.batch && id) {
      try { rec = await core.getChar(state.batch.id, id); } catch (e) { fail('Не прочитал карточку персонажа', e); }
    }
    if (my !== charLoad) return;
    state.rec = rec;
    if (rec) state.recs[id] = rec;
    fillAssign();
    render();
  }

  // ---------- форма ----------
  function buildStatic() {
    for (const t of SGG.TYPES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.type = t.id;
      b.textContent = t.label;
      b.style.setProperty('--chip', t.color);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { state.typeId = t.id; state.touched.type = true; state.hint = ''; if (t.primary && state.rec) $('jira').value = state.rec.jiraInput || ''; setIter('new'); render(); });
      $('types-' + t.group).append(b);
    }
    $('statusAfter').add(new Option('Авто', ''));
    for (const s of SGG.STATUSES) {
      $('statusAfter').add(new Option(s.label, s.id));
      $('statusSelect').add(new Option(s.label, s.id));
    }
    for (const ph of SGG.PHASES) {
      const row = document.createElement('label');
      row.className = 'artist';
      const name = document.createElement('span');
      name.textContent = ph.label;
      const sel = document.createElement('select');
      sel.id = 'assign-' + ph.id;
      sel.addEventListener('change', (e) => applyAssign(state.charId, ph.id, e.target.value));
      row.append(name, sel);
      $('assignRows').append(row);
    }
  }

  const setIter = (v) => { document.querySelector('input[name="iter"][value="' + v + '"]').checked = true; };
  const iterMode = () => document.querySelector('input[name="iter"]:checked').value;

  // ---------- кто на какой фазе ----------
  /** Список имён в выпадающем поле: сначала «я», потом команда и те, кто сейчас на доске. */
  function fillPeople(sel, current) {
    const me = state.user.name, names = [];
    for (const n of [me].concat(state.team, state.online)) if (n && names.indexOf(n) < 0) names.push(n);
    if (current && names.indexOf(current) < 0) names.push(current);
    sel.innerHTML = '';
    sel.add(new Option('не назначен', ''));
    for (const n of names) sel.add(new Option(n === me ? 'Я · ' + n : n, n));
    sel.value = current || '';
    sel.classList.toggle('empty', !current);
  }

  function fillAssign() {
    for (const ph of SGG.PHASES) {
      const sel = $('assign-' + ph.id);
      fillPeople(sel, (state.rec && (state.rec.assign || {})[ph.id]) || '');
      sel.disabled = !state.rec;
    }
  }

  async function applyAssign(charId, phaseId, name) {
    if (!state.batch || !charId) return;
    const ch = state.batch.chars.find((c) => c.id === charId);
    try {
      const rec = await core.setAssign(state.batch, charId, phaseId, name);
      state.recs[charId] = rec;
      if (charId === state.charId) state.rec = rec;
      if (name && state.team.indexOf(name) < 0) { state.team.push(name); $('teamNames').value = state.team.join('\n'); }
      log(ch.name + ' · ' + SGG.PHASES.find((p) => p.id === phaseId).label + ' → ' + (name || 'не назначен'), 'ok');
    } catch (e) { fail('Не назначил', e); }
    fillAssign();
    if (state.view === 'Team') renderTeam();
    render();
  }

  function renderTeam() {
    const box = $('teamTable');
    box.innerHTML = '';
    if (!state.batch) return;
    for (const t of ['Персонаж'].concat(SGG.PHASES.map((p) => p.label))) {
      const h = document.createElement('span');
      h.className = 'head';
      h.textContent = t;
      box.append(h);
    }
    for (const ch of state.batch.chars) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = ch.name;
      box.append(who);
      for (const ph of SGG.PHASES) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', ch.name + ' — ' + ph.label);
        fillPeople(sel, ((state.recs[ch.id] || {}).assign || {})[ph.id] || '');
        sel.addEventListener('change', (e) => applyAssign(ch.id, ph.id, e.target.value));
        box.append(sel);
      }
    }
  }

  async function loadTeam() {
    if (!state.batch) return;
    const id = state.batch.id;
    try {
      const got = await Promise.all([core.getTeam(id)].concat(state.batch.chars.map((c) => core.getChar(id, c.id))));
      if (!state.batch || state.batch.id !== id) return;
      state.team = got[0];
      state.batch.chars.forEach((c, i) => { state.recs[c.id] = got[i + 1]; });
      if (document.activeElement !== $('teamNames')) $('teamNames').value = state.team.join('\n');
    } catch (e) { fail('Не прочитал назначения', e); }
    renderTeam();
  }

  function render() {
    const type = SGG.TYPE_BY_ID[state.typeId];
    const ch = state.batch && state.batch.chars.find((c) => c.id === state.charId);
    const rec = state.rec;

    // Доставка
    $('thumb').hidden = !state.current;
    $('dropHint').hidden = !!state.current;
    if (state.current) $('thumb').src = state.current.dataUrl; else $('thumb').removeAttribute('src');
    $('dropHint').firstElementChild.textContent = state.loading ? 'Беру картинку…' : 'Кинь картинку на доску';
    $('queueInfo').textContent = state.queue.length ? 'в очереди ещё ' + state.queue.length : '';
    $('charSelect').value = state.charId || '';
    $('guessNote').hidden = !state.hint;
    $('guessNote').textContent = state.hint;
    document.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === state.typeId)));
    $('jiraField').hidden = !(type && type.primary);
    // Та же стадия, что сейчас в карточке: это новая итерация или перезалив текущей?
    const same = !!(ch && type && rec && rec.pv && !type.fb && rec.pv.type === type.id);
    $('iterBox').hidden = !same;
    if (!same) setIter('new');
    const redo = same && iterMode() === 'redo';
    if (same) {
      $('iterNew').textContent = 'Новая итерация — v' + (rec.pv.v + 1);
      $('iterRedo').textContent = 'Перезалить текущую v' + rec.pv.v;
    }
    const auto = !type ? '' : redo ? 'не менять' : SGG.STATUS_BY_ID[type.fb ? 'fixes' : 'internal'].label;
    $('statusAfter').options[0].textContent = auto ? 'Авто: ' + auto : 'Авто';

    let route = '';
    if (ch && type && rec) {
      if (type.fb) {
        route = 'Встанет в блок фидбека карточки «' + ch.name + '»' + (rec.pv ? ' — к ' + SGG.entryTitle(rec.pv) : '') + '.';
        if (rec.fb) route += ' Прежний фидбек уйдёт в историю.';
      } else if (redo) {
        route = 'Заменит в карточке «' + ch.name + '» файл ' + SGG.entryTitle(rec.pv) + '. Номер итерации не изменится.';
      } else {
        route = 'Встанет в карточку «' + ch.name + '» как ' + type.en + ' v' + ((rec.vers[type.id] || 0) + 1);
        route += type.deck ? ' и в «' + SGG.DECK_BY_KEY[type.deck].title + '».' : '.';
        if (rec.pv) route += ' Текущая (' + SGG.entryTitle(rec.pv) + ') уйдёт в историю.';
        const ph = type.stage ? SGG.phaseOfStage(type.stage) : null;
        if (ph && state.user.name && !(rec.assign || {})[ph.id]) route += ' Фаза ' + ph.label + ' запишется на тебя.';
      }
    }
    $('route').textContent = route;
    $('place').disabled = state.busy || !state.current || !ch || !type || !rec;
    $('skip').disabled = state.busy || !state.current;
    $('place').textContent = state.busy ? 'Раскладываю…' : 'Разложить';

    // Персонаж
    $('charSelect2').value = state.charId || '';
    const has = !!(ch && rec);
    $('statusSelect').disabled = !has || state.busy;
    $('showArchive').disabled = !has || state.busy;
    $('showArchive').textContent = has && rec.open ? 'Свернуть историю на доске' : 'Раскрыть историю на доске';
    $('statusSelect').value = has ? rec.status : 'todo';
    $('statusSwatch').style.background = has ? SGG.STATUS_BY_ID[rec.status].fill : 'transparent';
    const tl = $('timeline');
    tl.innerHTML = '';
    const rows = has ? SGG.timeline(rec) : [];
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = has ? 'Доставок пока не было.' : 'Выбери персонажа.';
      tl.append(p);
    }
    for (const e of rows) {
      const t = SGG.TYPE_BY_ID[e.type] || {};
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tl-row';
      row.style.setProperty('--chip', t.color || '#888');
      if (t.tint) row.style.background = t.tint;
      const a = document.createElement('b');
      a.textContent = SGG.entryTitle(e);
      const b = document.createElement('span');
      b.textContent = SGG.ddmm(e.at) + (e.by ? ' · ' + e.by : '') + (e.where === 'card' ? ' · в карточке' : ' · в архиве');
      row.append(a, b);
      row.addEventListener('click', async () => {
        try { const it = await core.getItem(e.img); if (it) await board.viewport.zoomTo(it); else log('Этой картинки уже нет на доске.', 'warn'); } catch (err) { fail('Не показал', err); }
      });
      tl.append(row);
    }
  }

  async function doPlace() {
    if (state.busy || !state.current) return;
    state.busy = true;
    render();
    try {
      const t0 = performance.now(), took = state.current.took || 0;
      try { const u = await board.getUserInfo(); state.user = { id: u.id, name: u.name || '' }; } catch (e) { /* остаётся прежнее имя */ }
      const res = await core.place({
        batch: state.batch, charId: state.charId, typeId: state.typeId,
        dataUrl: state.current.dataUrl, deckDataUrl: state.current.deckDataUrl, natural: state.current.natural,
        jira: $('jira').value, userName: state.user.name, statusAfter: $('statusAfter').value, replace: iterMode() === 'redo',
        sourceItemId: state.current.kind === 'board' ? state.current.id : null,
      });
      remember('char:' + state.batch.id, state.charId);
      state.rec = res.rec;
      state.recs[state.charId] = res.rec;
      if (state.user.name && state.team.indexOf(state.user.name) < 0) state.team.push(state.user.name);
      let line = res.charName + ' · ' + res.title + (res.replaced ? ' — перезалит в карточке' : ' — в карточке') + (res.deckTitle ? ' и в деке «' + res.deckTitle + '»' : '');
      if (res.archived) line += ', в архив ушло: ' + res.archived;
      line += ' · статус ' + SGG.STATUS_BY_ID[res.status].label;
      line += ' · взял за ' + took.toFixed(1) + ' с, разложил за ' + ((performance.now() - t0) / 1000).toFixed(1) + ' с';
      log(line, 'ok');
      for (const w of res.warnings) log(w, 'warn');
      $('statusAfter').value = '';
      setIter('new');
      state.busy = false;
      fillAssign();
      finishCurrent();
      try { const it = await core.getItem(res.cardImageId); if (it) await board.viewport.zoomTo(it); } catch (e) { /* не критично */ }
    } catch (e) {
      state.busy = false;
      fail('Не разложил', e);
      render();
    }
  }

  // ---------- события доски ----------
  // Новую картинку ловим двумя путями: событием создания и тем, что Miro сам выделяет только что добавленное.
  function onImages(source, items, requireFresh) {
    if (!state.batch) return;
    if (!(items || []).some((i) => i.type === 'image')) return;
    const res = SGG.pickImages(items, { uid: state.user.id, seen, requireFresh, now: Date.now() });
    if (res.take.length) enqueue(res.take.map((i) => ({ kind: 'board', id: i.id })));
    else if (diagOn() && res.why.some((w) => w !== 'картинка бота' && w !== 'уже видел' && w !== 'старая')) log('Диагностика: ' + source + ' — пропуск: ' + res.why.join(', '));
  }

  async function openChar(batchId, charId) {
    try {
      if (!state.batch || state.batch.id !== batchId) await selectBatch(batchId);
      state.charId = charId;
      await loadChar();
      showView('Char');
    } catch (e) { fail('Не открыл персонажа', e); }
  }

  async function takeSelected() {
    try {
      const images = (await board.getSelection()).filter((i) => i.type === 'image' && !SGG.isBotImage(i));
      if (!images.length) { log('На доске не выделена картинка (картинки, которые положил бот, не в счёт).', 'warn'); return; }
      enqueue(images.map((i) => ({ kind: 'board', id: i.id })));
    } catch (e) { fail('Не прочитал выделение', e); }
  }

  async function addFiles(files) {
    for (const f of files) {
      if (!f || String(f.type).indexOf('image/') !== 0) { log('«' + (f && f.name) + '» — не картинка, пропустил.', 'warn'); continue; }
      try { enqueue([{ kind: 'file', dataUrl: await readFile(f), name: f.name }]); } catch (e) { fail('Файл', e); }
    }
  }

  // ---------- привязка кнопок ----------
  buildStatic();
  $('version').textContent = 'SGG Delivery Bot ' + SGG.VERSION + ' · песочница';

  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    showView(b.dataset.view);
    if (b.dataset.view === 'Char') loadChar();
    if (b.dataset.view === 'Team') { renderTeam(); loadTeam(); }
  }));
  $('batchSelect').addEventListener('change', (e) => selectBatch(e.target.value).catch((err) => fail('Батч', err)));
  const onChar = async (e) => {
    state.charId = e.target.value || null;
    state.touched.char = true; // выбрано руками — догадка по месту больше не вмешивается
    state.hint = '';
    if (state.charId) remember('char:' + state.batch.id, state.charId);
    await loadChar();
  };
  $('charSelect').addEventListener('change', onChar);
  $('charSelect2').addEventListener('change', onChar);
  document.querySelectorAll('input[name="iter"]').forEach((r) => r.addEventListener('change', render));
  $('place').addEventListener('click', doPlace);
  $('skip').addEventListener('click', () => { log('Пропустил — картинка осталась как была.'); finishCurrent(); });
  $('takeSelected').addEventListener('click', takeSelected);
  $('pickFile').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  document.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  $('statusSelect').addEventListener('change', async (e) => {
    const id = e.target.value; // читаем до перерисовки: она возвращает в список текущий статус
    if (!state.rec || state.busy) { render(); return; }
    state.busy = true;
    render();
    try {
      state.rec = await core.setStatus(state.batch, state.charId, id);
      log(state.batch.chars.find((c) => c.id === state.charId).name + ' · статус ' + SGG.STATUS_BY_ID[id].label, 'ok');
    } catch (err) { fail('Не сменил статус', err); }
    state.busy = false;
    render();
  });
  $('saveTeam').addEventListener('click', async () => {
    try {
      state.team = await core.setTeam(state.batch.id, $('teamNames').value.split(/[\n,;]+/));
      $('teamNames').value = state.team.join('\n');
      log('Команда сохранена: ' + (state.team.length ? state.team.join(', ') : 'пусто') + '.', 'ok');
      fillAssign();
      renderTeam();
    } catch (e) { fail('Не сохранил команду', e); }
  });
  $('teamOnline').addEventListener('click', async () => {
    try { state.online = (await board.getOnlineUsers()).map((u) => u.name).filter(Boolean); } catch (e) { /* остаётся прежний список */ }
    const have = $('teamNames').value.split(/[\n,;]+/).map((n) => n.trim()).filter(Boolean);
    const add = state.online.concat(state.user.name ? [state.user.name] : []).filter((n, i, a) => have.indexOf(n) < 0 && a.indexOf(n) === i);
    if (!add.length) { log('Все, кто сейчас на доске, уже в списке.'); return; }
    $('teamNames').value = have.concat(add).join('\n');
    log('Добавил: ' + add.join(', ') + '. Нажми «Сохранить команду».');
  });
  $('showArchive').addEventListener('click', async () => {
    if (!state.rec || state.busy) return;
    state.busy = true;
    render();
    try {
      const res = await core.toggleHistory(state.batch, state.charId);
      state.rec = res.rec;
      if (!res.count) log('У этого персонажа пока нет прошлых сабмитов.', 'warn');
      else if (res.focus.length) await board.viewport.zoomTo(res.focus);
    } catch (e) { fail('Не раскрыл историю', e); }
    state.busy = false;
    render();
  });
  $('collapseAll').addEventListener('click', async () => {
    try { const n = await core.collapseAll(state.batch); log(n ? 'Свернул историй: ' + n + '.' : 'Раскрытых историй нет.', 'ok'); await loadChar(); } catch (e) { fail('Не свернул', e); }
  });

  $('createBatch').addEventListener('click', async () => {
    const btn = $('createBatch');
    btn.disabled = true;
    try {
      const n = Math.min(15, Math.max(1, parseInt($('newCount').value, 10) || 15));
      const b = await core.buildTestBatch({
        name: $('newName').value.trim() || 'TEST BATCH',
        characters: SGG.DEFAULT_CHARACTERS.slice(0, n),
        onProgress: (d, t) => progress('createProgress', d, t),
      });
      log('Батч «' + b.name + '» построен: ' + b.chars.length + ' персонажей.', 'ok');
      await loadBatches(b.id);
      showView('Delivery');
      pump();
    } catch (e) { fail('Не построил батч', e); }
    btn.disabled = false;
  });
  $('cancelNew').addEventListener('click', () => showView('Setup'));
  $('legacyDelete').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await core.deleteBatch(e.target.dataset.id, (d, t) => progress('createProgress', d, t));
      log('Старый батч удалён с доски.', 'ok');
      await loadBatches();
      if (state.batch) showView('Delivery');
    } catch (err) { fail('Не удалил старый батч', err); }
    e.target.disabled = false;
  });

  $('saveSetup').addEventListener('click', async () => {
    try {
      state.batch.jiraBase = $('jiraBase').value.trim();
      await core.saveBatch(state.batch);
      log('Сохранил.', 'ok');
    } catch (e) { fail('Не сохранил', e); }
  });
  $('diag').checked = diagOn();
  $('diag').addEventListener('change', (e) => { remember('diag', e.target.checked ? '1' : '0'); log(e.target.checked ? 'Диагностика включена.' : 'Диагностика выключена.'); });
  $('showBatch').addEventListener('click', async () => {
    try {
      const ids = Object.values(state.batch.zones).concat(state.batch.chars.map((c) => state.batch.ui[c.id].pv));
      const items = (await Promise.all(ids.map((id) => core.getItem(id)))).filter(Boolean);
      if (items.length) await board.viewport.zoomTo(items);
    } catch (e) { fail('Не нашёл батч', e); }
  });
  $('newBatch').addEventListener('click', () => { $('cancelNew').hidden = false; showView('Empty'); });

  let armed = false;
  $('deleteBatch').addEventListener('click', async () => {
    const btn = $('deleteBatch');
    if (!armed) {
      armed = true;
      btn.textContent = 'Точно удалить «' + state.batch.name + '»?';
      setTimeout(() => { armed = false; btn.textContent = 'Удалить батч с доски'; }, 4000);
      return;
    }
    armed = false;
    btn.disabled = true;
    try {
      const name = state.batch.name;
      await core.deleteBatch(state.batch.id, (d, t) => progress('deleteProgress', d, t));
      log('Батч «' + name + '» удалён с доски.', 'ok');
      await loadBatches();
      if (state.batch) showView('Setup');
    } catch (e) { fail('Не удалил', e); }
    btn.disabled = false;
    btn.textContent = 'Удалить батч с доски';
  });

  // ---------- версия ----------
  /** Спрашивает невидимую часть бота на этой доске, какой она версии. null — не ответила. */
  async function askHeadless() {
    let ch;
    try { ch = new BroadcastChannel(SGG.CHANNEL); } catch (e) { return undefined; } // канала нет — проверить нечем
    let mine = null;
    try { mine = (await board.getInfo()).id; } catch (e) { /* сравним без номера доски */ }
    const from = Math.random().toString(36).slice(2);
    let got = null;
    ch.onmessage = (e) => { const d = e.data; if (d && d.headless && d.to === from && (!mine || !d.board || d.board === mine)) got = d.headless; };
    for (let n = 0; n < 3 && !got; n++) { ch.postMessage({ ask: 'headless', from }); await sleep(1200); }
    ch.close();
    return got;
  }
  async function checkVersions() {
    const el = $('stale');
    const say = (text) => { el.textContent = text + ' Обнови страницу доски: Cmd + R на Mac, Ctrl + R на Windows.'; el.hidden = false; };
    try {
      const latest = await SGG.latestVersion();
      if (latest && latest !== SGG.VERSION) { say('Вышла версия бота ' + latest + ', а открыта ' + SGG.VERSION + '.'); return; }
      const head = await askHeadless();
      if (head === null) say('Похоже, доска открыта со старой версией бота — тогда кнопки на карточках (статус, Sketch, Render, History) не работают.');
      else if (head && head !== SGG.VERSION) say('На доске работает бот ' + head + ', а панель уже ' + SGG.VERSION + ' — кнопки на карточках могут не работать.');
    } catch (e) { /* проверка версии не должна мешать работе */ }
  }

  // ---------- старт ----------
  checkVersions();
  try {
    try { const u = await board.getUserInfo(); state.user = { id: u.id, name: u.name || '' }; } catch (e) { /* без identity:read работаем без имени */ }
    try { state.online = (await board.getOnlineUsers()).map((u) => u.name).filter(Boolean); } catch (e) { /* список подсказок не критичен */ }
    await loadBatches();
    board.ui.on('items:create', (e) => onImages('items:create', e.items, false));
    board.ui.on('selection:update', (e) => onImages('selection', e.items, true));
    let data = null;
    try { data = await board.ui.getPanelData(); } catch (e) { /* открыли по иконке */ }
    if (state.batch) {
      showView('Delivery');
      if (data && data.view === 'char' && data.charId) await openChar(data.batchId, data.charId);
      else if (data && Array.isArray(data.itemIds) && data.itemIds.length) enqueue(data.itemIds.map((id) => ({ kind: 'board', id })));
      else {
        const sel = (await board.getSelection()).filter((i) => i.type === 'image' && !SGG.isBotImage(i));
        if (sel.length) enqueue(sel.map((i) => ({ kind: 'board', id: i.id })));
      }
    }
    render();
  } catch (e) {
    fail('Бот не запустился', e);
  }
})();
