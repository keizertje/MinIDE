(() => {
  'use strict';

  const SKIP_DIRS = new Set(['.git', 'node_modules']);
  const SAVE_DEBOUNCE_MS = 800;
  const DISK_POLL_MS = 2000;
  const TREE_POLL_MS = 5000;
  const MAX_MEASURED_LINES = 20000;
  const EDITOR_PADDING = 12;
  const DEFAULT_MAX_MATCHES = 5000;
  const MIN_MAX_MATCHES = 100;
  const MAX_MAX_MATCHES = 1000000;
  const REGEX_ERROR_FADE_MS = 30000;
  const REGEX_ERROR_FADEOUT_MS = 1200;

  const LS_SECTIONS = 'mini-ide-sections';
  const LS_SETTINGS = 'mini-ide-settings';
  const LS_LAYOUT = 'mini-ide-layout';

  const PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const OPENERS = new Set(Object.keys(PAIRS));
  const CLOSERS = new Set(Object.values(PAIRS));

  const openBtn = document.getElementById('open-folder');
  const folderNameEl = document.getElementById('folder-name');
  const statusEl = document.getElementById('status');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPop = document.getElementById('settings-pop');
  const maxMatchesInput = document.getElementById('max-matches');
  const layoutEl = document.getElementById('layout');
  const sidebar = document.getElementById('sidebar');
  const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
  const resizerLeft = document.getElementById('resizer-left');
  const resizerRight = document.getElementById('resizer-right');
  const regexPanel = document.getElementById('regex-panel');
  const panelCollapseBtn = document.getElementById('panel-collapse-btn');
  const addSectionBtn = document.getElementById('add-section');
  const sectionsEl = document.getElementById('sections');
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
  let uidCounter = 0;

  function uid() {
    return 's' + Date.now().toString(36) + '-' + uidCounter++;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, lo, hi);
  }

  function loadJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // opslag kan mislukken (bijv. private mode); negeren
    }
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  // ---------- status: regex-errors direct weg bij wijziging, anders na 30s uitfaden ----------

  let regexErrorTimer = null;
  let regexErrorFadeTimer = null;

  function showRegexError(msg) {
    setStatus(msg, 'warn');
    statusEl.classList.remove('fade-out');
    clearTimeout(regexErrorTimer);
    clearTimeout(regexErrorFadeTimer);
    regexErrorTimer = setTimeout(() => {
      statusEl.classList.add('fade-out');
      regexErrorFadeTimer = setTimeout(() => {
        if (statusEl.className === 'warn' && statusEl.classList.contains('fade-out')) setStatus('', '');
      }, REGEX_ERROR_FADEOUT_MS);
    }, REGEX_ERROR_FADE_MS);
  }

  function clearRegexError() {
    clearTimeout(regexErrorTimer);
    clearTimeout(regexErrorFadeTimer);
    statusEl.classList.remove('fade-out');
    if (statusEl.className === 'warn') setStatus('', '');
  }

  // ---------- secties (regex-groepen) ----------

  let sections = loadJSON(LS_SECTIONS, null);
  if (!Array.isArray(sections) || sections.length === 0) {
    sections = [{
      id: uid(),
      name: 'Sectie 1',
      active: true,
      collapsed: false,
      bg: '#ffe58a',
      fg: '#000000',
      regexes: [],
    }];
  }

  function saveSections() {
    saveJSON(LS_SECTIONS, sections);
  }

  let settings = Object.assign({ maxMatches: DEFAULT_MAX_MATCHES }, loadJSON(LS_SETTINGS, {}));
  let maxMatches = clampInt(settings.maxMatches, MIN_MAX_MATCHES, MAX_MAX_MATCHES, DEFAULT_MAX_MATCHES);
  let layoutState = Object.assign({ left: 230, right: 260, leftVisible: true, panelVisible: true }, loadJSON(LS_LAYOUT, {}));
  let leftVisible = layoutState.leftVisible !== false;
  let panelVisible = layoutState.panelVisible !== false;

  let dragIndex = null;
  let dropTarget = null;

  function closestSection(node) {
    let n = node;
    while (n && n !== sectionsEl) {
      if (n.classList && n.classList.contains('section')) return n;
      n = n.parentNode;
    }
    return null;
  }

  function clearDropMarkers() {
    for (const child of sectionsEl.children) {
      if (child.classList) {
        child.classList.remove('drop-before');
        child.classList.remove('drop-after');
      }
    }
    dropTarget = null;
  }

  function renderSections() {
    sectionsEl.textContent = '';
    sections.forEach((s, si) => {
      const sec = document.createElement('div');
      sec.className = 'section' + (s.collapsed ? ' collapsed' : '') + (s.active ? '' : ' inactive');
      sec.draggable = false;

      const header = document.createElement('div');
      header.className = 'section-header';

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '⠿';
      grip.title = 'Slepen om de volgorde te veranderen';
      grip.addEventListener('mousedown', () => {
        sec.draggable = true;
      });

      sec.addEventListener('dragstart', (e) => {
        dragIndex = si;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(si)); } catch { /* negeer */ }
        }
        sec.classList.add('dragging');
      });
      sec.addEventListener('dragend', () => {
        sec.draggable = false;
        sec.classList.remove('dragging');
        dragIndex = null;
        clearDropMarkers();
      });

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = s.collapsed ? '▸' : '▾';
      arrow.title = 'Sectie open-/dichtklappen';

      const name = document.createElement('input');
      name.className = 'section-name';
      name.value = s.name;
      name.spellcheck = false;
      name.addEventListener('input', () => {
        s.name = name.value;
        saveSections();
      });
      name.addEventListener('click', (e) => e.stopPropagation());

      const active = document.createElement('input');
      active.type = 'checkbox';
      active.checked = s.active;
      active.title = 'Sectie actief / niet actief';
      active.addEventListener('change', () => {
        s.active = active.checked;
        saveSections();
        renderSections();
        renderOverlay();
      });
      active.addEventListener('click', (e) => e.stopPropagation());

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.textContent = '✕';
      del.title = 'Sectie verwijderen';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        sections.splice(si, 1);
        saveSections();
        renderSections();
        renderOverlay();
      });

      header.append(grip, arrow, name, active, del);
      header.addEventListener('click', () => {
        s.collapsed = !s.collapsed;
        saveSections();
        renderSections();
      });
      sec.appendChild(header);

      const colors = document.createElement('div');
      colors.className = 'section-colors';

      const bgLabel = document.createElement('label');
      bgLabel.textContent = 'achtergrond ';
      const bg = document.createElement('input');
      bg.type = 'color';
      bg.className = 'sec-bg';
      bg.value = s.bg;
      bg.title = 'Achtergrondkleur van matches';
      bg.addEventListener('input', () => {
        s.bg = bg.value;
        saveSections();
        renderOverlay();
      });

      const fgLabel = document.createElement('label');
      fgLabel.textContent = 'voorgrond ';
      const fg = document.createElement('input');
      fg.type = 'color';
      fg.className = 'sec-fg';
      fg.value = s.fg;
      fg.title = 'Voorgrondkleur van matches (wit = verbergen)';
      fg.addEventListener('input', () => {
        s.fg = fg.value;
        saveSections();
        renderOverlay();
      });

      bgLabel.appendChild(bg);
      fgLabel.appendChild(fg);
      colors.append(bgLabel, fgLabel);
      sec.appendChild(colors);

      const body = document.createElement('div');
      body.className = 'section-body';
      const list = document.createElement('div');
      list.className = 'regex-list';

      s.regexes.forEach((pattern, ri) => {
        const row = document.createElement('div');
        row.className = 'regex-row';
        const input = document.createElement('input');
        input.className = 'regex-input';
        input.placeholder = 'regex…';
        input.spellcheck = false;
        input.value = pattern;
        input.addEventListener('input', () => {
          clearRegexError();
          s.regexes[ri] = input.value;
          saveSections();
          renderOverlay();
        });
        const delR = document.createElement('button');
        delR.type = 'button';
        delR.className = 'icon-btn';
        delR.textContent = '✕';
        delR.title = 'Regex verwijderen';
        delR.addEventListener('click', () => {
          s.regexes.splice(ri, 1);
          saveSections();
          renderSections();
          renderOverlay();
        });
        row.append(input, delR);
        list.appendChild(row);
      });

      const addR = document.createElement('button');
      addR.type = 'button';
      addR.className = 'icon-btn add-regex';
      addR.textContent = '+ regex';
      addR.title = 'Regex toevoegen aan deze sectie';
      addR.addEventListener('click', () => {
        s.regexes.push('');
        saveSections();
        renderSections();
      });

      body.appendChild(list);
      body.appendChild(addR);
      sec.appendChild(body);

      sectionsEl.appendChild(sec);
    });
  }

  sectionsEl.addEventListener('dragover', (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const sec = closestSection(e.target);
    clearDropMarkers();
    if (!sec) return;
    const rect = sec.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    sec.classList.add(before ? 'drop-before' : 'drop-after');
    dropTarget = { sec, before };
  });

  sectionsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragIndex === null || !dropTarget) return;
    const targetSi = Array.from(sectionsEl.children).indexOf(dropTarget.sec);
    let to = targetSi + (dropTarget.before ? 0 : 1);
    const from = dragIndex;
    if (from < to) to--;
    if (from !== to && from >= 0 && to >= 0 && to <= sections.length) {
      const moved = sections.splice(from, 1)[0];
      sections.splice(to, 0, moved);
      saveSections();
      renderSections();
      renderOverlay();
    }
    dragIndex = null;
    clearDropMarkers();
  });

  addSectionBtn.addEventListener('click', () => {
    sections.push({
      id: uid(),
      name: 'Sectie ' + (sections.length + 1),
      active: true,
      collapsed: false,
      bg: '#ffe58a',
      fg: '#000000',
      regexes: [''],
    });
    saveSections();
    renderSections();
    renderOverlay();
  });

  // ---------- instellingen ----------

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPop.hidden = !settingsPop.hidden;
  });
  settingsPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    settingsPop.hidden = true;
  });

  maxMatchesInput.value = String(maxMatches);
  maxMatchesInput.addEventListener('input', () => {
    maxMatches = clampInt(maxMatchesInput.value, MIN_MAX_MATCHES, MAX_MAX_MATCHES, maxMatches);
    settings.maxMatches = maxMatches;
    saveJSON(LS_SETTINGS, settings);
    renderOverlay();
  });

  // ---------- layout: resizers + panelen inklappen ----------

  function setSidebarVisible(v, save) {
    leftVisible = v;
    sidebar.classList.toggle('collapsed', !v);
    resizerLeft.style.display = v ? '' : 'none';
    sidebarCollapseBtn.textContent = v ? '❮' : '❯';
    sidebarCollapseBtn.title = v ? 'Bestandenpaneel inklappen' : 'Bestandenpaneel uitklappen';
    if (save !== false) {
      layoutState.leftVisible = v;
      saveJSON(LS_LAYOUT, layoutState);
    }
    refreshEditorLayout();
  }

  function setPanelVisible(v, save) {
    panelVisible = v;
    regexPanel.classList.toggle('collapsed', !v);
    resizerRight.style.display = v ? '' : 'none';
    panelCollapseBtn.textContent = v ? '❯' : '❮';
    panelCollapseBtn.title = v ? 'Sectiepaneel inklappen' : 'Sectiepaneel uitklappen';
    if (save !== false) {
      layoutState.panelVisible = v;
      saveJSON(LS_LAYOUT, layoutState);
    }
    refreshEditorLayout();
  }

  sidebarCollapseBtn.addEventListener('click', () => setSidebarVisible(!leftVisible));
  panelCollapseBtn.addEventListener('click', () => setPanelVisible(!panelVisible));

  function applyLayout() {
    sidebar.style.width = clampInt(layoutState.left, 120, 600, 230) + 'px';
    regexPanel.style.width = clampInt(layoutState.right, 160, 600, 260) + 'px';
    setSidebarVisible(leftVisible, false);
    setPanelVisible(panelVisible, false);
  }

  function makeResizer(el, onMove) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => onMove(ev.clientX);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        refreshEditorLayout();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  makeResizer(resizerLeft, (clientX) => {
    if (!leftVisible) return;
    const rect = layoutEl.getBoundingClientRect();
    layoutState.left = clamp(Math.round(clientX - rect.left), 120, 600);
    sidebar.style.width = layoutState.left + 'px';
    saveJSON(LS_LAYOUT, layoutState);
  });

  makeResizer(resizerRight, (clientX) => {
    if (!panelVisible) return;
    const rect = layoutEl.getBoundingClientRect();
    layoutState.right = clamp(Math.round(rect.right - clientX), 160, 600);
    regexPanel.style.width = layoutState.right + 'px';
    saveJSON(LS_LAYOUT, layoutState);
  });

  // ---------- IndexedDB (map-handle onthouden) ----------

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

  // ---------- bestandsboom ----------

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

  // ---------- bracket matching ----------

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

  // ---------- regex engine (Regex+ met recursion-plugin, fallback native) ----------

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
      if (ranges.length >= maxMatches) break;
    }
    return { ranges, error: null };
  }

  function computeSectionIndex(text) {
    const n = text.length;
    const secIdx = new Int32Array(n).fill(-1);
    let firstError = null;
    sections.forEach((s, si) => {
      if (!s.active) return;
      for (const pattern of s.regexes) {
        const res = computeMatchRanges(text, pattern);
        if (res.error && !firstError) {
          firstError = 'Ongeldige regex in sectie "' + s.name + '": ' + res.error;
        }
        for (const r of res.ranges) {
          for (let i = r[0]; i < r[1]; i++) {
            if (secIdx[i] === -1) secIdx[i] = si;
          }
        }
      }
    });
    if (firstError) showRegexError(firstError);
    return secIdx;
  }

  // ---------- overlay ----------

  function renderOverlay() {
    const text = editor.value;
    const secIdx = computeSectionIndex(text);
    const pair = bracketPairAtCursor();

    const n = text.length;
    const bracketFlag = new Uint8Array(n);
    if (pair) {
      bracketFlag[pair[0]] = 1;
      bracketFlag[pair[1]] = 1;
    }

    overlay.textContent = '';
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < n) {
      const s = secIdx[i];
      const b = bracketFlag[i];
      let j = i + 1;
      while (j < n && secIdx[j] === s && bracketFlag[j] === b) j++;
      const seg = text.slice(i, j);
      if (s >= 0 || b) {
        const span = document.createElement('span');
        if (s >= 0 && sections[s]) {
          span.style.color = sections[s].fg;
          span.style.background = sections[s].bg;
        }
        if (b) span.classList.add('bracket');
        span.textContent = seg;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(seg));
      }
      i = j;
    }
    overlay.appendChild(frag);

    // Eerst scrollbar-compensatie + scroll toepassen: pas daarna is de
    // layout van de overlay definitief (breedte = die van de textarea),
    // en pas dan mogen de regelnummers gemeten worden.
    syncOverlayScroll();
    if (text !== lastOverlayText) {
      lastOverlayText = text;
      renderLineNumbers();
    }
  }

  function refreshEditorLayout() {
    lastOverlayText = null;
    renderOverlay();
  }

  function rowHeightPx() {
    const lh = parseFloat(getComputedStyle(overlay).lineHeight);
    return Number.isFinite(lh) ? lh : 21;
  }

  // Alle text-nodes van de overlay in documentvolgorde, met cumulatieve offset.
  function textNodeList() {
    const list = [];
    let cum = 0;
    const collect = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const len = child.textContent.length;
          list.push({ node: child, start: cum, len });
          cum += len;
        } else {
          collect(child);
        }
      }
    };
    collect(overlay);
    return { list, total: cum };
  }

  function posAt(list, total, index) {
    if (!list.length) return null;
    if (index >= total) {
      const last = list[list.length - 1];
      return { node: last.node, offset: last.len };
    }
    for (const t of list) {
      if (index <= t.start + t.len) return { node: t.node, offset: index - t.start };
    }
    const last = list[list.length - 1];
    return { node: last.node, offset: last.len };
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
    const nodes = canMeasure ? textNodeList() : { list: [], total: 0 };
    const list = nodes.list;
    const total = nodes.total;
    for (let k = 0; k < starts.length; k++) {
      // fallback: zelfde formule als een gemetene regel zonder wrap
      let top = EDITOR_PADDING + k * rh;
      if (canMeasure && list.length) {
        const s = starts[k];
        const range = document.createRange();
        let r = null;
        if (s < total) {
          // Selecteer het EERSTE teken van de regel — bij een lege regel is dat
          // de \n zelf. Een niet-ingeklapte range geeft altijd een echt rect
          // (een collapsed range vóór een \n geeft in browsers een lege rect).
          const a = posAt(list, total, s);
          const b = posAt(list, total, s + 1);
          if (a && b) {
            range.setStart(a.node, a.offset);
            range.setEnd(b.node, b.offset);
            const rects = range.getClientRects();
            if (rects && rects.length) r = rects[0];
          }
        } else {
          // laatste regel aan het einde van het bestand (s === total): caret
          // aan het einde — in pre-wrap staat die op de laatste (lege) regel
          const a = posAt(list, total, total);
          if (a) {
            range.setStart(a.node, a.offset);
            range.collapse(true);
            r = range.getBoundingClientRect();
          }
        }
        if (r && (r.height > 0 || r.width > 0)) {
          top = r.top - overlayRect.top + overlay.scrollTop;
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

  // ---------- bestanden ----------

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

  // ---------- events ----------

  openBtn.addEventListener('click', openFolder);

  editor.addEventListener('input', onEdit);
  editor.addEventListener('scroll', syncOverlayScroll);
  editor.addEventListener('keyup', renderOverlay);
  editor.addEventListener('click', renderOverlay);
  editor.addEventListener('select', renderOverlay);

  window.addEventListener('resize', refreshEditorLayout);

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

  // ---------- start ----------

  renderSections();
  applyLayout();
  renderOverlay();

  // Als het lettertype (laat) geladen is, kan de layoutMetrics wijzigen -> opnieuw meten.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => refreshEditorLayout());
  }

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
