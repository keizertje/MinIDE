(() => {
  'use strict';

  const SKIP_DIRS = new Set(['.git', 'node_modules']);
  const SAVE_DEBOUNCE_MS = 800;
  const DISK_POLL_MS = 2000;
  const TREE_POLL_MS = 5000;

  const openBtn = document.getElementById('open-folder');
  const folderNameEl = document.getElementById('folder-name');
  const statusEl = document.getElementById('status');
  const treeEl = document.getElementById('tree');
  const fileBar = document.getElementById('file-bar');
  const editor = document.getElementById('editor');

  let rootHandle = null;
  let currentTree = [];
  let currentFile = null;
  let lastModified = null;
  let dirty = false;
  let saveTimer = null;
  let diskTimer = null;
  let treeTimer = null;

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
    clearInterval(diskTimer);
    clearInterval(treeTimer);
    diskTimer = setInterval(syncFromDisk, DISK_POLL_MS);
    treeTimer = setInterval(refreshTree, TREE_POLL_MS);
  }

  openBtn.addEventListener('click', openFolder);

  editor.addEventListener('input', onEdit);

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
