'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

let pdfDoc = null;
let currentPage = 1;
let zoom = 1.0;
let darkPdf = false;
let handMode = false;
let rotation = 0;
let renderTasks = {};
let thumbTasks = {};
let scrollRaf = null;
let observer = null;
let customFontColor = '#ebdbb2';
let cachedFontRgb = { r: 235, g: 219, b: 178 };
let lang = navigator.language?.startsWith('es') ? 'es' : 'en';
let i18n = {};

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5.0;
const BATCH = 10;

async function runConcurrent(items, fn, limit = BATCH) {
  const iterator = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of iterator) await fn(item);
  });
  await Promise.all(workers);
}

// Search state
let searchResults = [];
let searchIndex = -1;
let searchHighlightEls = [];
let searchId = 0;

// Hand mode state
let handDragging = false;
let handStartX = 0, handStartY = 0;
let handScrollX = 0, handScrollY = 0;

// FS auto-hide
let fsHideTimer = null;

const hexToRgb = (() => {
  const cache = {};
  return (hex) => {
    if (cache[hex]) return cache[hex];
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    const result = m ? {
      r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16)
    } : { r: 212, g: 212, b: 216 };
    cache[hex] = result;
    return result;
  };
})();

const dom = {
  sidebar:       document.getElementById('sidebar'),
  viewerWrap:    document.getElementById('viewer-wrap'),
  dropZone:      document.getElementById('drop-zone'),
  pageInput:     document.getElementById('page-input'),
  pageInfo:      document.getElementById('page-info'),
  zoomDisplay:   document.getElementById('zoom-display'),

  pdfToggle:     document.getElementById('pdf-theme-toggle'),
  iconSun:       document.getElementById('theme-icon-sun'),
  iconMoon:      document.getElementById('theme-icon-moon'),
  colorSwatch:   document.getElementById('color-swatch'),
  colorPopup:    document.getElementById('color-popup'),
  fontColor:     document.getElementById('font-color'),
  fileInput:     document.getElementById('file-input'),
  openBtn:       document.getElementById('open-btn'),
  prevBtn:       document.getElementById('prev-btn'),
  nextBtn:       document.getElementById('next-btn'),
  zoomOut:       document.getElementById('zoom-out'),
  zoomIn:        document.getElementById('zoom-in'),
  rotateBtn:     document.getElementById('rotate-btn'),
  handBtn:       document.getElementById('hand-btn'),
  fsBtn:         document.getElementById('fs-btn'),
  pageThemeBtn:  document.getElementById('page-theme-btn'),
  helpBtn:       document.getElementById('help-btn'),
  helpModal:     document.getElementById('help-modal'),
  helpClose:     document.getElementById('help-close'),
  searchWrap:    document.getElementById('search-wrap'),
  searchInput:   document.getElementById('search-input'),
  searchPrev:    document.getElementById('search-prev'),
  searchNext:    document.getElementById('search-next'),
  searchCount:   document.getElementById('search-count'),
  progressFill:  document.getElementById('progress-fill'),
  langBtn:       document.getElementById('lang-btn'),
  langPopup:     document.getElementById('lang-popup')
};

// IndexedDB para PDF grandes (localStorage solo para settings)
const PdfDB = {
  db: null,
  async init() {
    if (this.db) return;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('NoirPDF', 1);
      req.onupgradeneeded = (e) => { e.target.result.createObjectStore('pdfs', { keyPath: 'id' }); };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  },
  async save(blob) {
    await this.init();
    const tx = this.db.transaction('pdfs', 'readwrite');
    tx.objectStore('pdfs').put({
      id: 'current', blob, name: blob.name || 'document.pdf',
      size: blob.size, timestamp: Date.now()
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  },
  async load() {
    await this.init();
    const tx = this.db.transaction('pdfs', 'readonly');
    const req = tx.objectStore('pdfs').get('current');
    const data = await new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return data?.blob || null;
  },
  async remove() {
    await this.init();
    const tx = this.db.transaction('pdfs', 'readwrite');
    tx.objectStore('pdfs').delete('current');
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }
};

const Storage = {
  async savePdf(file) {
    try { await PdfDB.save(file); return true; } catch (err) {
      console.warn('Error guardando PDF:', err); return false;
    }
  },
  async loadPdfFromStorage() {
    try { return await PdfDB.load(); } catch { return null; }
  },
  saveSettings(s) { try { localStorage.setItem('noirpdf-settings', JSON.stringify(s)); } catch (e) { console.warn('saveSettings falló:', e); } },
  loadSettings() { try { const d = localStorage.getItem('noirpdf-settings'); return d ? JSON.parse(d) : null; } catch { return null; } },
  clearPdf() { PdfDB.remove().catch(() => {}); }
};

const autoSave = (() => {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        Storage.saveSettings({
          theme: document.documentElement.dataset.theme,
          fontColor: customFontColor,
          darkPdf, currentPage, zoom, rotation, lang,
          scrollPos: dom.viewerWrap?.scrollTop ?? 0
        });
      } catch (e) { console.warn('autoSave falló:', e); }
    }, 500);
  };
})();

async function loadPdfFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    pdfDoc = await pdfjsLib.getDocument(url).promise;
  } finally { URL.revokeObjectURL(url); }
  currentPage = 1; zoom = 1.0; rotation = 0;
  updateZoomDisplay();
  dom.pageInput.max = pdfDoc.numPages;
  dom.pageInfo.textContent = `/ ${pdfDoc.numPages}`;
  dom.pageInput.value = 1;
  buildViewer(); buildSidebar();
}

async function loadPdf(file) {
  await loadPdfFromBlob(file);
  if (await Storage.savePdf(file)) autoSave();
}

async function restorePdfFromStorage(blob, settings) {
  settings = settings || {};
  try {
    await loadPdfFromBlob(blob);
    if (settings.currentPage > 0) setTimeout(() => goToPage(settings.currentPage), 300);
    if (settings.zoom) zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, settings.zoom));
    if (settings.rotation) { rotation = settings.rotation; rerenderAll(); }
    updateZoomDisplay();
    if (settings.scrollPos) {
      setTimeout(() => { dom.viewerWrap.scrollTop = settings.scrollPos; }, 400);
    }
  } catch (err) {
    console.warn('Error restaurando PDF:', err); Storage.clearPdf();
  }
}

async function initializeFromStorage() {
  try { i18n = await (await fetch('i18n.json')).json(); } catch { i18n = {}; }
  const settings = Storage.loadSettings();
  if (settings?.lang && i18n[settings.lang]) lang = settings.lang;
  applyLanguage();
  if (settings.theme) {
    document.documentElement.dataset.theme = settings.theme;
    const isDark = settings.theme === 'dark';
    dom.iconSun.style.display = isDark ? 'none' : 'block';
    dom.iconMoon.style.display = isDark ? 'block' : 'none';
  }
  if (settings.fontColor) {
    customFontColor = settings.fontColor;
    dom.fontColor.value = settings.fontColor;
    dom.colorSwatch.style.background = settings.fontColor;
    cachedFontRgb = hexToRgb(customFontColor);
  }
  if (settings.darkPdf) { darkPdf = true; dom.pdfToggle.classList.add('dark-pdf'); }
  try { localStorage.removeItem('noirpdf-pdf'); } catch {}
  const pdfBlob = await Storage.loadPdfFromStorage();
  if (pdfBlob) restorePdfFromStorage(pdfBlob, settings);
}

function buildViewer() {
  if (observer) { observer.disconnect(); observer = null; }
  dom.viewerWrap.innerHTML = '';
  clearHighlights();
  Object.values(renderTasks).forEach(t => t.cancel?.());
  renderTasks = {};

  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = i;
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.id = `page-canvas-${i}`;
    wrap.appendChild(canvas);
    fragment.appendChild(wrap);
  }
  dom.viewerWrap.appendChild(fragment);

  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) renderPage(parseInt(e.target.dataset.page));
    }
  }, { root: dom.viewerWrap, rootMargin: '200px', threshold: 0 });

  for (const w of dom.viewerWrap.querySelectorAll('.page-wrap')) observer.observe(w);
  queueMicrotask(() => renderPage(1));
}

async function renderPage(pageNum) {
  if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;
  if (renderTasks[pageNum]) { try { renderTasks[pageNum].cancel(); } catch {} delete renderTasks[pageNum]; }

  const page = await pdfDoc.getPage(pageNum);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: zoom, rotation });
  const hiRes = dpr > 1 ? page.getViewport({ scale: zoom * dpr, rotation }) : viewport;

  const off = document.createElement('canvas');
  off.width = hiRes.width; off.height = hiRes.height;
  const offCtx = off.getContext('2d');

  const task = page.render({ canvasContext: offCtx, viewport: hiRes });
  renderTasks[pageNum] = task;

  try { await task.promise; } catch (e) {
    if (e.name !== 'RenderingCancelledException') console.warn('Render error p' + pageNum, e);
    return;
  }
  delete renderTasks[pageNum];
  if (darkPdf) applyDarkMode(off);

  const canvas = document.getElementById(`page-canvas-${pageNum}`);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  canvas.width = hiRes.width; canvas.height = hiRes.height;
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  wrap.style.width = viewport.width + 'px';
  wrap.style.height = viewport.height + 'px';
  canvas.getContext('2d').drawImage(off, 0, 0);
}

function applyDarkMode(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const bgR = 40, bgG = 40, bgB = 40;
  const { r: tcR, g: tcG, b: tcB } = cachedFontRgb;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const t = 1 - lum / 255;
    d[i] = bgR + t * (tcR - bgR);
    d[i + 1] = bgG + t * (tcG - bgG);
    d[i + 2] = bgB + t * (tcB - bgB);
  }
  ctx.putImageData(img, 0, 0);
}

async function buildSidebar() {
  Object.values(thumbTasks).forEach(t => t.cancel?.());
  thumbTasks = {}; dom.sidebar.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === 1 ? ' active' : '');
    item.dataset.page = i;
    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-canvas'; canvas.id = `thumb-${i}`;
    const label = document.createElement('span');
    label.className = 'thumb-label'; label.textContent = i;
    item.append(canvas, label); fragment.appendChild(item);
  }
  dom.sidebar.appendChild(fragment);
  const pages = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
  runConcurrent(pages, renderThumb);
}

async function renderThumb(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 140 / base.width });
  const off = document.createElement('canvas');
  off.width = viewport.width; off.height = viewport.height;
  const task = page.render({ canvasContext: off.getContext('2d'), viewport });
  thumbTasks[pageNum] = task;
  try { await task.promise; } catch (e) { if (e.name !== 'RenderingCancelledException') return; }
  delete thumbTasks[pageNum];
  if (darkPdf) applyDarkMode(off);
  const canvas = document.getElementById(`thumb-${pageNum}`);
  if (!canvas) return;
  canvas.width = viewport.width; canvas.height = viewport.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
}

function goToPage(num) {
  if (!pdfDoc) return;
  num = Math.max(1, Math.min(num, pdfDoc.numPages));
  currentPage = num; dom.pageInput.value = num;
  updateActiveThumbs(); autoSave();
  dom.viewerWrap.querySelector(`[data-page="${num}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function changePage(delta) { goToPage(currentPage + delta); }

let zoomAnimTimer = null;

function changeZoom(delta) {
  if (!pdfDoc) return;
  const oldZoom = zoom;
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta));
  updateZoomDisplay(); autoSave();
  animateZoom(oldZoom);
}

function animateZoom(oldZoom) {
  if (zoom / oldZoom === 1) { rerenderAll(); return; }
  if (zoomAnimTimer) { clearTimeout(zoomAnimTimer); zoomAnimTimer = null; }

  const wraps = [...dom.viewerWrap.querySelectorAll('.page-wrap')];
  wraps.forEach(w => w.classList.add('zoom-anim'));
  if (wraps.length) void wraps[0].offsetWidth;

  rerenderAll();

  zoomAnimTimer = setTimeout(() => {
    zoomAnimTimer = null;
    wraps.forEach(w => w.classList.remove('zoom-anim'));
  }, 250);
}

function updateZoomDisplay() {
  dom.zoomDisplay.textContent = Math.round(zoom * 100) + '%';
}

function rerenderAll() {
  clearHighlights();
  Object.values(renderTasks).forEach(t => { try { t.cancel(); } catch {} });
  renderTasks = {};
  if (!observer) return;
  for (const w of dom.viewerWrap.querySelectorAll('.page-wrap')) {
    observer.unobserve(w); observer.observe(w);
  }
  renderPage(currentPage);
}

function rotatePage() {
  if (!pdfDoc) return;
  rotation = (rotation + 90) % 360;
  autoSave(); rerenderAll();
  dom.rotateBtn.classList.add('active');
  setTimeout(() => dom.rotateBtn.classList.remove('active'), 400);
}

function changeFontColor(color) {
  customFontColor = color; cachedFontRgb = hexToRgb(color);
  autoSave(); if (!pdfDoc) return;
  rerenderAll();
  const pages = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
  runConcurrent(pages, renderThumb);
}

function togglePdfTheme() {
  darkPdf = !darkPdf;
  dom.pdfToggle.classList.toggle('dark-pdf', darkPdf);
  autoSave(); if (!pdfDoc) return;
  rerenderAll();
  const pages = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
  runConcurrent(pages, renderThumb);
}

function togglePageTheme() {
  const html = document.documentElement;
  const isDark = html.dataset.theme === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  dom.iconSun.style.display = isDark ? 'block' : 'none';
  dom.iconMoon.style.display = isDark ? 'none' : 'block';
  autoSave();
}

function applyLanguage() {
  const t = i18n && i18n[lang];
  if (!t) return;
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (t[key]) el.textContent = t[key];
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const key = el.dataset.i18nTitle;
    if (t[key]) el.title = t[key];
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder;
    if (t[key]) el.placeholder = t[key];
  }
  dom.langBtn.textContent = t.langLabel;
  for (const opt of document.querySelectorAll('.lang-opt')) {
    opt.classList.toggle('active', opt.dataset.lang === lang);
  }
}

function setLang(newLang) {
  if (!i18n[newLang]) return;
  lang = newLang;
  applyLanguage();
  dom.langPopup.classList.remove('open');
  autoSave();
}

function toggleFS() {
  const entering = !document.body.classList.contains('fs');
  document.body.classList.toggle('fs');
  dom.fsBtn.classList.toggle('active');
  if (entering) {
    const hint = document.getElementById('fs-hint');
    hint.classList.add('visible');
    clearTimeout(hint._timer);
    hint._timer = setTimeout(() => hint.classList.remove('visible'), 2000);
  }
}

// FS auto-hide toolbar
const toolbarEl = document.getElementById('toolbar');
dom.viewerWrap.addEventListener('mousemove', () => {
  if (!document.body.classList.contains('fs')) return;
  toolbarEl.classList.add('fs-show');
  clearTimeout(fsHideTimer);
  fsHideTimer = setTimeout(() => toolbarEl.classList.remove('fs-show'), 2000);
});

function onViewerScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    if (!pdfDoc) return;
    updateProgress();
    const wraps = dom.viewerWrap.querySelectorAll('.page-wrap');
    let best = 1, bestDist = Infinity;
    const mid = dom.viewerWrap.scrollTop + dom.viewerWrap.clientHeight / 2;
    for (const w of wraps) {
      const center = w.offsetTop + w.offsetHeight / 2;
      const dist = Math.abs(center - mid);
      if (dist < bestDist) { bestDist = dist; best = parseInt(w.dataset.page); }
    }
    if (best !== currentPage) { currentPage = best; dom.pageInput.value = best; updateActiveThumbs(); autoSave(); }
  });
}

function updateProgress() {
  if (!pdfDoc) return;
  const scrollTop = dom.viewerWrap.scrollTop;
  const scrollHeight = dom.viewerWrap.scrollHeight - dom.viewerWrap.clientHeight;
  const pct = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
  dom.progressFill.style.width = Math.min(pct, 100) + '%';
}

function updateActiveThumbs() {
  for (const item of dom.sidebar.querySelectorAll('.thumb-item')) {
    item.classList.toggle('active', parseInt(item.dataset.page) === currentPage);
  }
  dom.sidebar.querySelector('.thumb-item.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Hand mode ──────────────────────────────
function toggleHandMode() {
  handMode = !handMode;
  document.body.classList.toggle('hand-mode', handMode);
  dom.handBtn.classList.toggle('active', handMode);
}

dom.viewerWrap.addEventListener('mousedown', e => {
  if (!handMode) return;
  handDragging = true;
  handStartX = e.clientX;
  handStartY = e.clientY;
  handScrollX = dom.viewerWrap.scrollLeft;
  handScrollY = dom.viewerWrap.scrollTop;
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!handDragging) return;
  const dx = e.clientX - handStartX;
  const dy = e.clientY - handStartY;
  dom.viewerWrap.scrollLeft = handScrollX - dx;
  dom.viewerWrap.scrollTop = handScrollY - dy;
});
document.addEventListener('mouseup', () => { handDragging = false; });

dom.viewerWrap.addEventListener('touchstart', e => {
  if (!handMode || e.touches.length !== 1) return;
  handDragging = true;
  handStartX = e.touches[0].clientX;
  handStartY = e.touches[0].clientY;
  handScrollX = dom.viewerWrap.scrollLeft;
  handScrollY = dom.viewerWrap.scrollTop;
  e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', e => {
  if (!handDragging || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - handStartX;
  const dy = e.touches[0].clientY - handStartY;
  dom.viewerWrap.scrollLeft = handScrollX - dx;
  dom.viewerWrap.scrollTop = handScrollY - dy;
}, { passive: false });
document.addEventListener('touchend', () => { handDragging = false; });

// ── Download ───────────────────────────────
async function downloadPdf() {
  if (!pdfDoc) return;
  const blob = await Storage.loadPdfFromStorage();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = blob.name || 'documento.pdf';
  a.click(); URL.revokeObjectURL(url);
}

// ── Export PNG ─────────────────────────────
function exportPng() {
  if (!pdfDoc) return;
  const canvas = document.getElementById(`page-canvas-${currentPage}`);
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = `pagina-${currentPage}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// ── Close PDF ──────────────────────────────
async function closePdf() {
  if (!pdfDoc) return;
  Object.values(renderTasks).forEach(t => { try { t.cancel(); } catch {} });
  Object.values(thumbTasks).forEach(t => t.cancel?.());
  renderTasks = {}; thumbTasks = {};
  clearHighlights();
  pdfDoc = null; currentPage = 1; zoom = 1.0; rotation = 0;
  dom.viewerWrap.innerHTML = `<div id="drop-zone">
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
    <p data-i18n="dropzone">Click or drag a PDF here</p>
    <small data-i18n="dropzoneSub">Supports local PDF files</small>
  </div>`;
  dom.sidebar.innerHTML = '';
  dom.pageInput.value = 1; dom.pageInput.max = 1;
  dom.pageInfo.textContent = '/ 0';
  dom.progressFill.style.width = '0%';
  updateZoomDisplay();
  dom.dropZone = document.getElementById('drop-zone');
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  Storage.clearPdf();
  autoSave();
}

// ── Help modal ─────────────────────────────
function toggleHelp() {
  dom.helpModal.classList.toggle('open');
}

// ── Search ─────────────────────────────────
function toggleSearch() {
  dom.searchWrap.classList.toggle('active');
  if (dom.searchWrap.classList.contains('active')) {
    dom.searchInput.focus();
  } else {
    clearHighlights();
  }
}

function clearHighlights() {
  for (const el of searchHighlightEls) el.remove();
  searchHighlightEls = [];
  searchResults = [];
  searchIndex = -1;
  dom.searchCount.textContent = '';
}

async function searchText(query) {
  const id = ++searchId;
  clearHighlights();
  if (!query || !pdfDoc) { dom.searchCount.textContent = ''; return; }
  if (id !== searchId) return;

  const q = query.toLowerCase();
  const results = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: zoom, rotation });
    const yScale = Math.hypot(vp.transform[1], vp.transform[3]);

    for (const item of tc.items) {
      const s = item.str;
      if (!s) continue;
      const sl = s.toLowerCase();
      let idx = 0;
      while ((idx = sl.indexOf(q, idx)) !== -1) {
        const charW = item.width / s.length;
        const t = pdfjsLib.Util.transform(vp.transform, item.transform);
        const h = (item.height || 12) * yScale;
        const x = t[4] + charW * idx;
        const y = t[5] - h;

        results.push({ pageNum: p, x, y, w: charW * q.length, h });
        idx += q.length;
      }
    }

    if (p % BATCH === 0 || p === pdfDoc.numPages) {
      await new Promise(r => setTimeout(r, 0));
      dom.searchCount.textContent = results.length > 0 ? `... ${results.length}` : `... 0`;
    }
  }

  if (id !== searchId) { clearHighlights(); return; }
  searchResults = results;
  if (results.length === 0) {
    dom.searchCount.textContent = '0/0';
    return;
  }

  // Create highlight elements
  for (const r of results) {
    if (id !== searchId) { clearHighlights(); return; }
    const wrap = dom.viewerWrap.querySelector(`[data-page="${r.pageNum}"]`);
    if (!wrap) continue;
    const hl = document.createElement('div');
    hl.className = 'search-highlight';
    hl.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${Math.max(r.w,4)}px;height:${Math.max(r.h,4)}px;`;
    wrap.appendChild(hl);
    searchHighlightEls.push(hl);
  }

  if (id !== searchId) { clearHighlights(); return; }
  searchIndex = 0;
  updateSearchCount();
  goToSearchResult(0);
}

function updateSearchCount() {
  dom.searchCount.textContent = searchResults.length > 0
    ? `${searchIndex + 1}/${searchResults.length}` : '0/0';
}

function goToSearchResult(idx) {
  if (idx < 0 || idx >= searchResults.length) return;
  searchIndex = idx;
  // Remove active from all
  for (const el of searchHighlightEls) el.classList.remove('search-active');
  // Mark active
  if (searchHighlightEls[idx]) searchHighlightEls[idx].classList.add('search-active');
  // Scroll to page
  const r = searchResults[idx];
  goToPage(r.pageNum);
  updateSearchCount();
}

function nextResult() {
  if (searchResults.length === 0) return;
  goToSearchResult((searchIndex + 1) % searchResults.length);
}

function prevResult() {
  if (searchResults.length === 0) return;
  goToSearchResult((searchIndex - 1 + searchResults.length) % searchResults.length);
}

// ── Init ───────────────────────────────────
dom.iconMoon.style.display = 'block';
dom.iconSun.style.display = 'none';
initializeFromStorage().catch(e => console.warn('initializeFromStorage falló:', e));
updateMobileLayout();

// ── Events ─────────────────────────────────
const menuBtn = document.getElementById('menu-btn');
menuBtn?.addEventListener('click', () => document.body.classList.toggle('menu-open'));
// Close mobile menu when clicking outside toolbar, bottom bar, or menu button
document.addEventListener('click', e => {
  if (!document.body.classList.contains('menu-open')) return;
  if (e.target.closest('#toolbar') || e.target.closest('#mobile-bottom-bar') || e.target.closest('#menu-btn')) return;
  document.body.classList.remove('menu-open');
});

dom.fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) loadPdf(f).catch(err => console.warn('Error loading PDF:', err));
});
dom.openBtn.addEventListener('click', () => dom.fileInput.click());
dom.dropZone.addEventListener('click', () => dom.fileInput.click());
// Open PDF split dropdown
const openArrow = document.getElementById('open-arrow');
const openDropdown = document.getElementById('open-dropdown');
openArrow?.addEventListener('click', e => {
  e.stopPropagation();
  openDropdown?.classList.toggle('open');
});
document.getElementById('dropdown-download')?.addEventListener('click', () => {
  openDropdown?.classList.remove('open');
  downloadPdf();
});
document.getElementById('dropdown-export')?.addEventListener('click', () => {
  openDropdown?.classList.remove('open');
  exportPng();
});
document.getElementById('dropdown-close')?.addEventListener('click', () => {
  openDropdown?.classList.remove('open');
  closePdf();
});
document.addEventListener('click', e => {
  if (!e.target.closest('.split-btn')) openDropdown?.classList.remove('open');
});

dom.viewerWrap.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone?.classList.add('drag-over'); });
dom.viewerWrap.addEventListener('dragleave', () => dom.dropZone?.classList.remove('drag-over'));
dom.viewerWrap.addEventListener('drop', e => {
  e.preventDefault(); dom.dropZone?.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f?.type === 'application/pdf') loadPdf(f);
});

dom.sidebar.addEventListener('click', e => {
  const item = e.target.closest('.thumb-item');
  if (item) goToPage(parseInt(item.dataset.page));
});

dom.prevBtn.addEventListener('click', () => changePage(-1));
dom.nextBtn.addEventListener('click', () => changePage(1));
dom.pageInput.addEventListener('change', () => goToPage(parseInt(dom.pageInput.value) || 1));
dom.pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') goToPage(parseInt(dom.pageInput.value) || 1); });

dom.zoomOut.addEventListener('click', () => changeZoom(-0.15));
dom.zoomIn.addEventListener('click', () => changeZoom(0.15));

dom.rotateBtn.addEventListener('click', rotatePage);
dom.handBtn.addEventListener('click', toggleHandMode);
dom.langBtn.addEventListener('click', e => { e.stopPropagation(); dom.langPopup.classList.toggle('open'); });
dom.langPopup.addEventListener('click', e => {
  const opt = e.target.closest('.lang-opt');
  if (opt) setLang(opt.dataset.lang);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.lang-picker')) dom.langPopup.classList.remove('open');
});
dom.fsBtn.addEventListener('click', toggleFS);
dom.helpBtn.addEventListener('click', toggleHelp);
dom.helpModal.addEventListener('click', e => { if (e.target === dom.helpModal) dom.helpModal.classList.remove('open'); });
dom.helpClose.addEventListener('click', () => dom.helpModal.classList.remove('open'));
dom.viewerWrap.addEventListener('scroll', onViewerScroll, { passive: true });
dom.pdfToggle.addEventListener('click', togglePdfTheme);
dom.pageThemeBtn.addEventListener('click', togglePageTheme);

// Color picker
dom.colorSwatch.addEventListener('click', e => { e.stopPropagation(); dom.colorPopup.classList.toggle('open'); });
dom.colorPopup.addEventListener('click', e => {
  const swat = e.target.closest('.cp-swat');
  if (!swat) return;
  if (swat.dataset.c === 'custom') { dom.fontColor.click(); return; }
  const color = swat.dataset.c;
  dom.colorSwatch.style.background = color;
  dom.colorPopup.classList.remove('open');
  changeFontColor(color);
});
dom.fontColor.addEventListener('change', () => {
  const color = dom.fontColor.value;
  dom.colorSwatch.style.background = color;
  dom.colorPopup.classList.remove('open');
  changeFontColor(color);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.color-picker')) dom.colorPopup.classList.remove('open');
});

// Search events
dom.searchInput.addEventListener('input', () => searchText(dom.searchInput.value));
dom.searchPrev.addEventListener('click', prevResult);
dom.searchNext.addEventListener('click', nextResult);
dom.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') e.shiftKey ? prevResult() : nextResult();
  if (e.key === 'Escape') { toggleSearch(); dom.searchInput.blur(); }
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target !== dom.pageInput) return;

  // Navigation
  if (e.target !== dom.pageInput) {
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': changePage(1); return;
      case 'ArrowLeft':  case 'ArrowUp':   changePage(-1); return;
    }
  }

  switch (e.key) {
    case '+': changeZoom(0.15); break;
    case '-': changeZoom(-0.15); break;
    case 'f': case 'F':
      if (!e.ctrlKey && !e.metaKey) toggleFS();
      break;
    case 'h': case 'H': toggleHandMode(); break;
    case '?': toggleHelp(); break;
    case 'Escape':
      if (document.body.classList.contains('fs')) toggleFS();
      if (dom.helpModal.classList.contains('open')) dom.helpModal.classList.remove('open');
      break;
  }

  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case '=': e.preventDefault(); changeZoom(0.15); break;
      case '-': e.preventDefault(); changeZoom(-0.15); break;
      case '0': e.preventDefault(); zoom = 1; updateZoomDisplay(); autoSave(); rerenderAll(); break;
      case 'f': case 'F': e.preventDefault(); toggleSearch(); break;
      case 'r': case 'R': e.preventDefault(); rotatePage(); break;
    }
  }
});

dom.viewerWrap.addEventListener('wheel', e => {
  if (e.ctrlKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 0.1 : -0.1); }
}, { passive: false });

// ── Mobile layout ──────────────────────────
function updateMobileLayout() {
  const isMobile = window.innerWidth <= 768;
  const bar = document.getElementById('mobile-bottom-bar');
  const toolbar = document.getElementById('toolbar');
  if (!bar || !toolbar) return;

  const mobileEls = [
    document.getElementById('zoom-out'),
    document.getElementById('zoom-display'),
    document.getElementById('zoom-in'),
    document.getElementById('rotate-btn'),
    document.getElementById('pdf-theme-wrap'),
    document.querySelector('.color-picker')
  ].filter(Boolean);

  if (isMobile) {
    if (mobileEls.some(el => el.parentNode === toolbar)) {
      for (const el of mobileEls) {
        if (el.parentNode === toolbar) bar.appendChild(el);
      }
    }
  } else {
    if (mobileEls.some(el => el.parentNode === bar)) {
      const zoomRef = document.getElementById('search-wrap');
      const pickerRef = document.querySelector('.lang-picker');
      for (const el of mobileEls) {
        if (el.parentNode !== bar) continue;
        const isZoomGroup = ['zoom-out','zoom-display','zoom-in','rotate-btn'].includes(el.id);
        const ref = isZoomGroup ? zoomRef : pickerRef;
        if (ref && ref.parentNode === toolbar) toolbar.insertBefore(el, ref);
      }
    }
  }
}
window.addEventListener('resize', updateMobileLayout);

window.addEventListener('beforeunload', () => {
  try {
    Storage.saveSettings({
      theme: document.documentElement.dataset.theme,
      fontColor: customFontColor,
      darkPdf, currentPage, zoom, rotation, lang,
      scrollPos: dom.viewerWrap?.scrollTop ?? 0
    });
  } catch (e) { console.warn('beforeunload save falló:', e); }
});
