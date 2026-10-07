/* Панель бота: спрашивает «что это», показывает куда ляжет, раскладывает. */
(async function () {
  'use strict';
  const board = miro.board;
  const core = SGG.create(miro);
  const $ = (id) => document.getElementById(id);

  const state = {
    batches: [], batch: null, rects: null,
    queue: [], current: null, loading: false,
    charId: null, typeId: null, rec: null,
    user: { id: null, name: '' }, busy: false, lastImageId: null,
  };

  // ---------- мелочи ----------
  const remember = (k, v) => { try { localStorage.setItem('sgg:' + k, v); } catch (e) { /* хранилище закрыто */ } };
  const recall = (k) => { try { return localStorage.getItem('sgg:' + k); } catch (e) { return null; } };

  function log(text, kind) {
    const el = document.createElement('div');
    if (kind) el.className = kind;
    el.textContent = text;
    $('log').prepend(el);
    while ($('log').children.length > 6) $('log').lastChild.remove();
  }
  const fail = (what, e) => { console.error('[SGG bot]', e); log(what + ': ' + (e && e.message ? e.message : String(e)), 'err'); };

  function showView(name) {
    for (const v of ['Empty', 'Delivery', 'Setup']) $('view' + v).hidden = v !== name;
    $('toSetup').hidden = name !== 'Delivery';
    $('toDelivery').hidden = name !== 'Setup';
    $('batchSelect').hidden = name === 'Empty' || state.batches.length < 2;
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

  /** Приводит картинку к виду, который Miro точно примет: PNG/JPEG/GIF, не больше 4096 px и ~6 МБ. */
  async function prepare(dataUrl) {
    const img = await loadImage(dataUrl);
    const natural = { w: img.naturalWidth, h: img.naturalHeight };
    const okType = /^data:image\/(png|jpe?g|gif);/i.test(dataUrl);
    const longest = Math.max(natural.w, natural.h);
    if (okType && longest <= 4096 && dataUrl.length <= 8000000) return { dataUrl, natural };
    const scale = Math.min(1, 3000 / longest);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(natural.w * scale));
    c.height = Math.max(1, Math.round(natural.h * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let out = c.toDataURL('image/png');
    if (out.length > 8000000) {
      const ctx = c.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      out = c.toDataURL('image/jpeg', 0.9);
    }
    return { dataUrl: out, natural };
  }

  // ---------- очередь ----------
  function enqueue(entries) {
    for (const e of entries) {
      if (e.kind === 'board' && (state.queue.some((q) => q.id === e.id) || (state.current && state.current.id === e.id))) continue;
      state.queue.push(e);
    }
    pump();
  }

  async function pump() {
    if (state.current || state.loading || !state.queue.length) { render(); return; }
    state.loading = true;
    const next = state.queue.shift();
    try {
      let raw = next.dataUrl, guess = null;
      if (next.kind === 'board') {
        const item = await core.getItem(next.id);
        if (!item) throw new Error('Картинку уже убрали с доски.');
        raw = await item.getDataUrl();
        if (state.batch) {
          if (!state.rects) state.rects = await core.loadZoneRects(state.batch);
          const r = (await core.absRect(item)).rect;
          guess = core.guessTarget(state.rects, { x: r.x, y: r.y });
        }
      }
      const ready = await prepare(raw);
      state.current = { kind: next.kind, id: next.id || null, dataUrl: ready.dataUrl, natural: ready.natural };
      if (guess) {
        state.charId = guess.charId;
        if (guess.typeId) state.typeId = guess.typeId;
      }
    } catch (e) {
      fail('Не получилось взять картинку', e);
    }
    state.loading = false;
    await refreshExisting();
    if (!state.current && state.queue.length) pump();
  }

  function finishCurrent() {
    state.current = null;
    state.typeId = null;
    state.rec = null;
    pump();
  }

  // ---------- батчи ----------
  async function loadBatches(preferId) {
    state.batches = await core.listBatches();
    const sel = $('batchSelect');
    sel.innerHTML = '';
    for (const b of state.batches) sel.add(new Option(b.name, b.id));
    if (!state.batches.length) { state.batch = null; showView('Empty'); return; }
    const want = preferId || recall('batch');
    const pick = state.batches.find((b) => b.id === want) || state.batches[state.batches.length - 1];
    await selectBatch(pick.id);
    showView('Delivery');
  }

  async function selectBatch(id) {
    state.batch = await core.getBatch(id);
    state.rects = null;
    $('batchSelect').value = id;
    remember('batch', id);
    const cs = $('charSelect');
    cs.innerHTML = '';
    cs.add(new Option('— выбери персонажа —', ''));
    for (const ch of state.batch.chars) cs.add(new Option(ch.name, ch.id));
    const last = recall('char:' + id);
    state.charId = state.batch.chars.some((c) => c.id === last) ? last : null;
    $('setupTitle').textContent = state.batch.name;
    $('jiraBase').value = state.batch.jiraBase || '';
    await refreshExisting();
  }

  // ---------- форма ----------
  function buildChips() {
    for (const t of SGG.TYPES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.type = t.id;
      b.textContent = t.label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', async () => { state.typeId = t.id; await refreshExisting(); });
      $(t.primary ? 'typesPrimary' : 'typesSecondary').append(b);
    }
  }

  async function refreshExisting() {
    state.rec = null;
    const type = SGG.TYPE_BY_ID[state.typeId];
    if (state.batch && state.charId && type) {
      try {
        state.rec = await core.getRecord(state.batch.id, state.charId, type.id);
        if (type.primary) {
          const saved = state.rec.jira || (await core.getCharJira(state.batch.id, state.charId)) || '';
          $('jira').value = saved;
        }
      } catch (e) { fail('Не прочитал реестр', e); }
    }
    render();
  }

  function render() {
    const type = SGG.TYPE_BY_ID[state.typeId];
    const ch = state.batch && state.batch.chars.find((c) => c.id === state.charId);

    $('thumb').hidden = !state.current;
    $('dropHint').hidden = !!state.current;
    if (state.current) $('thumb').src = state.current.dataUrl;
    else $('thumb').removeAttribute('src');
    $('dropHint').firstElementChild.textContent = state.loading ? 'Беру картинку…' : 'Кинь картинку на доску';
    $('queueInfo').textContent = state.queue.length ? 'в очереди ещё ' + state.queue.length : '';

    $('charSelect').value = state.charId || '';
    document.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === state.typeId)));
    $('jiraField').hidden = !(type && type.primary);

    const last = state.rec && state.rec.card.length ? state.rec.card[state.rec.card.length - 1] : null;
    $('existing').hidden = !last;
    if (last) $('existingText').textContent = 'Сейчас на доске: v' + last.v + ' · ' + SGG.ddmm(last.at) + (last.by ? ' · ' + last.by : '');

    let route = '';
    if (ch && type) {
      route = 'Ляжет в колонку «' + ch.name + '» → ' + SGG.ROW_BY_KEY[type.row].label;
      route += type.deck ? ' и в «' + SGG.DECK_BY_KEY[type.deck].title + '».' : '. В общую деку не идёт.';
    }
    $('route').textContent = route;

    $('place').disabled = state.busy || !state.current || !ch || !type;
    $('skip').disabled = state.busy || !state.current;
    $('place').textContent = state.busy ? 'Раскладываю…' : 'Разложить';
  }

  async function doPlace() {
    if (state.busy || !state.current) return;
    state.busy = true;
    render();
    try {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      const res = await core.place({
        batch: state.batch, charId: state.charId, typeId: state.typeId,
        dataUrl: state.current.dataUrl, natural: state.current.natural,
        mode: state.rec && state.rec.card.length ? mode : 'add',
        jira: $('jira').value, userName: state.user.name,
        sourceItemId: state.current.kind === 'board' ? state.current.id : null,
      });
      state.lastImageId = res.cardImageId;
      remember('char:' + state.batch.id, state.charId);
      log(res.charName + ' · ' + res.typeLabel + ' v' + res.v + (res.replaced ? ' — заменил' : ' — добавил') + ' в колонке персонажа' + (res.deckTitle ? ' и в деке «' + res.deckTitle + '»' : ''), 'ok');
      for (const w of res.warnings) log(w, 'warn');
      document.querySelector('input[name="mode"][value="replace"]').checked = true;
      state.busy = false;
      finishCurrent();
      try { const it = await core.getItem(res.cardImageId); if (it) await board.viewport.zoomTo(it); } catch (e) { /* не критично */ }
    } catch (e) {
      state.busy = false;
      fail('Не разложил', e);
      render();
    }
  }

  // ---------- события доски ----------
  async function onItemsCreate(event) {
    const images = (event.items || []).filter((i) => i.type === 'image' && String(i.title || '').indexOf(SGG.MARK) !== 0);
    const mine = images.filter((i) => !state.user.id || !i.createdBy || i.createdBy === state.user.id);
    if (mine.length && state.batch) enqueue(mine.map((i) => ({ kind: 'board', id: i.id })));
  }

  async function takeSelected() {
    try {
      const sel = await board.getSelection();
      const images = sel.filter((i) => i.type === 'image' && String(i.title || '').indexOf(SGG.MARK) !== 0);
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
  buildChips();
  $('version').textContent = 'SGG Delivery Bot ' + SGG.VERSION + ' · песочница';

  $('toSetup').addEventListener('click', () => showView('Setup'));
  $('toDelivery').addEventListener('click', () => showView(state.batch ? 'Delivery' : 'Empty'));
  $('batchSelect').addEventListener('change', (e) => selectBatch(e.target.value).catch((err) => fail('Батч', err)));
  $('charSelect').addEventListener('change', async (e) => { state.charId = e.target.value || null; await refreshExisting(); });
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
      pump();
    } catch (e) { fail('Не построил батч', e); }
    btn.disabled = false;
  });

  $('saveSetup').addEventListener('click', async () => {
    try {
      state.batch.jiraBase = $('jiraBase').value.trim();
      await core.saveBatch(state.batch);
      log('Сохранил.', 'ok');
    } catch (e) { fail('Не сохранил', e); }
  });
  $('showBatch').addEventListener('click', async () => {
    try {
      const ids = Object.keys(state.batch.zones).filter((k) => k.indexOf('deck:') === 0).map((k) => state.batch.zones[k]);
      const items = (await Promise.all(ids.map(core.getItem))).filter(Boolean);
      if (items.length) await board.viewport.zoomTo(items);
    } catch (e) { fail('Не нашёл батч', e); }
  });
  $('newBatch').addEventListener('click', () => { showView('Empty'); $('toDelivery').hidden = false; });

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
    } catch (e) { fail('Не удалил', e); }
    btn.disabled = false;
    btn.textContent = 'Удалить батч с доски';
  });

  // ---------- старт ----------
  try {
    try { const u = await board.getUserInfo(); state.user = { id: u.id, name: u.name || '' }; } catch (e) { /* без identity:read работаем без имени */ }
    await loadBatches();
    board.ui.on('items:create', onItemsCreate);
    let data = null;
    try { data = await board.ui.getPanelData(); } catch (e) { /* открыли по иконке */ }
    if (data && Array.isArray(data.itemIds) && data.itemIds.length) enqueue(data.itemIds.map((id) => ({ kind: 'board', id })));
    else if (state.batch) {
      const sel = (await board.getSelection()).filter((i) => i.type === 'image' && String(i.title || '').indexOf(SGG.MARK) !== 0);
      if (sel.length) enqueue(sel.map((i) => ({ kind: 'board', id: i.id })));
    }
    render();
  } catch (e) {
    fail('Бот не запустился', e);
  }
})();
