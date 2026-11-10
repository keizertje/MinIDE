(() => {
  'use strict';

  const SKIP_DIRS = new Set(['.git', 'node_modules']);
  const SAVE_DEBOUNCE_MS = 800;
  const DISK_POLL_MS = 2000;
  const TREE_POLL_MS = 5000;
  const MAX_MATCHES = 5000;
  const MAX_MEASURED_LINES = 20000;
  const EDITOR_PADDING = 12;

  const PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const OPENERS = new Set(Object.keys(PAIRS));
  const CLOSERS = new Set(Object.values(PAIRS));

  const openBtn = document.getElementById('open-folder');
  const folderNameEl = document.getElementById('folder-name');
  const statusEl = document.getElementById('status');
  const filterEnabled = document.getElementById('filter-enabled');
  const filterMode = document.getElementById('filter-mode');
  const filterInput = document.getElementById('filter');
  const markInput = document.getElementById('mark-filter');
  const markColor = document.getElementById('mark-color');
  const treeEl = document.getElementById('tree');
  const fileBar = document.getElementById('file-bar');
  const overlay = document.getElementById('editor-overlay');
  const lineNumbersEl = document.getElementById('line-numbers');
  const editor = document.getElementById('editor');

  let rootHandle = null;
  let currentTree = [];
  let currentFile = null;
  let lastModified = null;
  let dirty = false;
  let saveTimer = null;
  let diskTimer = null;
  let treeTimer = null;
  let lastOverlayText = null;

  const expanded = new Set(['']);
  let selectedPath = null;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('mini-ide', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function persistHandle(handle) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'rootDir');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadPersistedHandle() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const rq = tx.objectStore('handles').get('rootDir');
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
  }

  async function ensurePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    try {
      return (await handle.requestPermission(opts)) === 'granted';
    } catch {
      return false;
    }
  }

  async function readTree(dirHandle, path) {
    const items = [];
    for await (const entry of dirHandle.entries()) {
      const name = entry[0];
      const handle = entry[1];
      if (handle.kind === 'directory') {
        if (SKIP_DIRS.has(name)) continue;
        const childPath = path + name + '/';
        const children = await readTree(handle, childPath);
        items.push({ name, kind: 'dir', path: childPath, handle, children });
      } else {
        items.push({ name, kind: 'file', path: path + name, handle });
      }
    }
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'nl');
    });
    return items;
  }

  function iconFor(item) {
    if (item.kind === 'dir') return expanded.has(item.path) ? '📂' : '📁';
    const dot = item.name.lastIndexOf('.');
    const ext = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
    const icons = {
      js: '📜', mjs: '📜', ts: '📘', html: '🌐', htm: '🌐', css: '🎨',
      json: '{ }', md: '📝', txt: '📄', py: '🐍',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', ico: '🖼️',
    };
    return icons[ext] || '📄';
  }

  function buildList(items) {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row' + (item.path === selectedPath ? ' selected' : '');

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = item.kind === 'dir' ? (expanded.has(item.path) ? '▾' : '▸') : '';

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = iconFor(item);

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.name;
      label.title = item.path;

      row.append(arrow, icon, label);
      li.appendChild(row);

      if (item.kind === 'dir') {
        row.addEventListener('click', () => {
          if (expanded.has(item.path)) expanded.delete(item.path);
          else expanded.add(item.path);
          renderTree();
        });
        if (expanded.has(item.path)) li.appendChild(buildList(item.children));
      } else {
        row.addEventListener('click', () => openFile(item));
      }
      ul.appendChild(li);
    }
    return ul;
  }

  function renderTree() {
    treeEl.textContent = '';
    treeEl.appendChild(buildList(currentTree));
  }

  async function refreshTree() {
    if (!rootHandle) return;
    try {
      currentTree = await readTree(rootHandle, '');
      renderTree();
    } catch (err) {
      console.error('Kon bestandsboom niet verversen:', err);
    }
  }

  function isBracket(ch) {
    return OPENERS.has(ch) || CLOSERS.has(ch);
  }

  function findMatchingBracket(text, pos) {
    const ch = text[pos];
    if (OPENERS.has(ch)) {
      const close = PAIRS[ch];
      let depth = 1;
      for (let i = pos + 1; i < text.length; i++) {
        if (text[i] === ch) depth++;
        else if (text[i] === close) {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }
    if (CLOSERS.has(ch)) {
      const open = Object.keys(PAIRS).find((k) => PAIRS[k] === ch);
      let depth = 1;
      for (let i = pos - 1; i >= 0; i--) {
        if (text[i] === ch) depth++;
        else if (text[i] === open) {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }
    return -1;
  }

  function bracketPairAtCursor() {
    const text = editor.value;
    const pos = editor.selectionStart;
    for (const p of [pos - 1, pos]) {
      if (p >= 0 && p < text.length && isBracket(text[p])) {
        const match = findMatchingBracket(text, p);
        if (match !== -1) return [p, match];
      }
    }
    return null;
  }

  function makeRegex(pattern, flags) {
    const R = window.Regex;
    if (R && typeof R.regex === 'function' && R.plugins && R.plugins.recursion) {
      const p = pattern.replace(/\(\?R\)(?!=)/g, '(?R=100)');
      const tag = R.regex({
        flags,
        plugins: [R.plugins.recursion],
        disable: { x: true, n: true, v: true },
        unicodeSetsPlugin: null,
      });
      const tpl = [p];
      tpl.raw = [p];
      return tag(tpl);
    }
    return new RegExp(pattern, flags);
  }

  function computeMatchRanges(text, pattern) {
    if (!pattern) return { ranges: [], error: null };
    let re;
    try {
      re = makeRegex(pattern, 'g');
    } catch (err) {
      return { ranges: [], error: err.message };
    }
    const ranges = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
      else re.lastIndex++;
      if (ranges.length >= MAX_MATCHES) break;
    }
    return { ranges, error: null };
  }

  function complementRanges(ranges, length) {
    const out = [];
    let pos = 0;
    for (const r of ranges) {
      if (r[0] > pos) out.push([pos, r[0]]);
      pos = Math.max(pos, r[1]);
    }
    if (pos < length) out.push([pos, length]);
    return out;
  }

  function computeHiddenRanges(text) {
    if (!filterEnabled.checked) return [];
    const res = computeMatchRanges(text, filterInput.value);
    if (res.error) {
      setStatus('Ongeldige verberg-regex: ' + res.error, 'warn');
      return [];
    }
    if (filterMode.value === 'hide-non-matches') return complementRanges(res.ranges, text.length);
    return res.ranges;
  }

  function computeMarkRanges(text) {
    const res = computeMatchRanges(text, markInput.value);
    if (res.error) setStatus('Ongeldige markeer-regex: ' + res.error, 'warn');
    return res.ranges;
  }

  function renderOverlay() {
    const text = editor.value;
    const hiddenRanges = computeHiddenRanges(text);
    const markRanges = computeMarkRanges(text);
    const pair = bracketPairAtCursor();

    const n = text.length;
    const hiddenFlag = new Uint8Array(n);
    for (const r of hiddenRanges) hiddenFlag.fill(1, r[0], r[1]);
    const markFlag = new Uint8Array(n);
    for (const r of markRanges) markFlag.fill(1, r[0], r[1]);
    const bracketFlag = new Uint8Array(n);
    if (pair) {
      bracketFlag[pair[0]] = 1;
      bracketFlag[pair[1]] = 1;
    }

    overlay.textContent = '';
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < n) {
      const h = hiddenFlag[i];
      const mk = markFlag[i];
      const b = bracketFlag[i];
      let j = i + 1;
      while (j < n && hiddenFlag[j] === h && markFlag[j] === mk && bracketFlag[j] === b) j++;
      const seg = text.slice(i, j);
      if (h || mk || b) {
        const span = document.createElement('span');
        const cls = [];
        if (h) cls.push('hidden');
        if (mk) cls.push('mark');
        if (b) cls.push('bracket');
        span.className = cls.join(' ');
        span.textContent = seg;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(seg));
      }
      i = j;
    }
    overlay.appendChild(frag);

    if (text !== lastOverlayText) {
      lastOverlayText = text;
      renderLineNumbers();
    }
    syncOverlayScroll();
  }

  function rowHeightPx() {
    const lh = parseFloat(getComputedStyle(overlay).lineHeight);
    return Number.isFinite(lh) ? lh : 21;
  }

  function locateInOverlay(index) {
    let remaining = index;
    const walk = (node) => {
      for (const child of node.childNodes) {
        const len = child.textContent.length;
        if (remaining <= len) {
          if (child.nodeType === 3) return { node: child, offset: remaining };
          const r = walk(child);
          if (r) return r;
        }
        remaining -= len;
      }
      return null;
    };
    return walk(overlay);
  }

  function renderLineNumbers() {
    const text = editor.value;
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    const inner = lineNumbersEl;
    inner.textContent = '';
    const frag = document.createDocumentFragment();
    const overlayRect = overlay.getBoundingClientRect();
    const rh = rowHeightPx();
    const canMeasure = starts.length <= MAX_MEASURED_LINES && typeof document.createRange === 'function';
    for (let k = 0; k < starts.length; k++) {
      let top = k * rh;
      if (canMeasure) {
        const loc = locateInOverlay(starts[k]);
        if (loc) {
          const range = document.createRange();
          range.setStart(loc.node, loc.offset);
          range.collapse(true);
          top = range.getBoundingClientRect().top - overlayRect.top + overlay.scrollTop;
        }
      }
      const div = document.createElement('div');
      div.className = 'line-number';
      div.textContent = String(k + 1);
      div.style.top = top + 'px';
      frag.appendChild(div);
    }
    inner.appendChild(frag);
    inner.style.height = overlay.scrollHeight + 'px';
  }

  function syncOverlayScroll() {
    const sbw = editor.offsetWidth - editor.clientWidth;
    const sbh = editor.offsetHeight - editor.clientHeight;
    overlay.style.paddingRight = EDITOR_PADDING + sbw + 'px';
    overlay.style.paddingBottom = EDITOR_PADDING + sbh + 'px';
    overlay.scrollTop = editor.scrollTop;
    overlay.scrollLeft = editor.scrollLeft;
    lineNumbersEl.style.transform = 'translateY(' + -editor.scrollTop + 'px)';
  }

  async function openFile(item) {
    if (dirty && currentFile) await saveCurrent();
    selectedPath = item.path;
    try {
      const file = await item.handle.getFile();
      const text = await file.text();
      currentFile = { path: item.path, handle: item.handle };
      lastModified = file.lastModified;
      if (text.includes('\u0000')) {
        editor.value = '';
        editor.disabled = true;
        fileBar.textContent = item.path + '  (binair bestand — bewerken niet ondersteund)';
        setStatus('Binair bestand geopend', 'warn');
      } else {
        dirty = false;
        editor.value = text;
        editor.disabled = false;
        fileBar.textContent = item.path;
        setStatus('Geopend', 'ok');
      }
      renderTree();
      renderOverlay();
      editor.focus();
    } catch (err) {
      console.error('Kon bestand niet openen:', err);
      setStatus('Kon bestand niet openen', 'warn');
    }
  }

  function onEdit() {
    dirty = true;
    setStatus('Niet-opgeslagen wijzigingen…', 'busy');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, SAVE_DEBOUNCE_MS);
    renderOverlay();
  }

  async function saveCurrent() {
    if (!currentFile || !dirty) return;
    clearTimeout(saveTimer);
    setStatus('Opslaan…', 'busy');
    try {
      const writable = await currentFile.handle.createWritable();
      await writable.write(editor.value);
      await writable.close();
      const file = await currentFile.handle.getFile();
      lastModified = file.lastModified;
      dirty = false;
      setStatus('Opgeslagen om ' + new Date().toLocaleTimeString('nl-NL'), 'ok');
    } catch (err) {
      console.error('Opslaan mislukt:', err);
      setStatus('Opslaan mislukt', 'warn');
    }
  }

  async function syncFromDisk() {
    if (!currentFile) return;
    try {
      const file = await currentFile.handle.getFile();
      if (file.lastModified !== lastModified) {
        if (!dirty) {
          const text = await file.text();
          if (!text.includes('\u0000')) editor.value = text;
          lastModified = file.lastModified;
          renderOverlay();
          setStatus('Gesynchroniseerd vanaf schijf om ' + new Date().toLocaleTimeString('nl-NL'), 'ok');
        } else {
          setStatus('Op schijf gewijzigd; lokale wijzigingen nog niet opgeslagen', 'warn');
        }
      }
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        setStatus('Bestand is op schijf verwijderd', 'warn');
      } else {
        console.error('Sync vanaf schijf mislukt:', err);
      }
    }
  }

  async function openFolder() {
    if (!('showDirectoryPicker' in window)) {
      setStatus('Deze browser ondersteunt map openen niet (gebruik Chrome of Edge)', 'warn');
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      if (err && err.name !== 'AbortError') console.error(err);
      return;
    }
    if (!(await ensurePermission(handle))) {
      setStatus('Geen lees-/schrijftoestemming voor deze map', 'warn');
      return;
    }
    await persistHandle(handle);
    await setRoot(handle);
  }

  async function setRoot(handle) {
    if (dirty && currentFile) await saveCurrent();
    rootHandle = handle;
    folderNameEl.textContent = '📁 ' + handle.name;
    expanded.clear();
    expanded.add('');
    selectedPath = null;
    currentFile = null;
    dirty = false;
    editor.value = '';
    editor.disabled = true;
    fileBar.textContent = 'Geen bestand geopend';
    setStatus('Map geopend', 'ok');
    await refreshTree();
    renderOverlay();
    clearInterval(diskTimer);
    clearInterval(treeTimer);
    diskTimer = setInterval(syncFromDisk, DISK_POLL_MS);
    treeTimer = setInterval(refreshTree, TREE_POLL_MS);
  }

  openBtn.addEventListener('click', openFolder);

  editor.addEventListener('input', onEdit);
  editor.addEventListener('scroll', syncOverlayScroll);
  editor.addEventListener('keyup', renderOverlay);
  editor.addEventListener('click', renderOverlay);
  editor.addEventListener('select', renderOverlay);

  filterEnabled.addEventListener('change', renderOverlay);
  filterMode.addEventListener('change', renderOverlay);
  filterInput.addEventListener('input', renderOverlay);
  markInput.addEventListener('input', renderOverlay);
  markColor.addEventListener('input', () => {
    overlay.style.setProperty('--mark-color', markColor.value);
  });

  window.addEventListener('resize', () => {
    renderLineNumbers();
    syncOverlayScroll();
  });

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'preserve');
      editor.dispatchEvent(new Event('input'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrent();
    }
  });

  overlay.style.setProperty('--mark-color', markColor.value || '#ffe58a');

  (async () => {
    try {
      const handle = await loadPersistedHandle();
      if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        await setRoot(handle);
      } else if (handle) {
        setStatus('Klik op "Map openen" om de map opnieuw te verbinden');
      }
    } catch (err) {
      console.error('Kon opgeslagen map niet herstellen:', err);
    }
  })();
})();
