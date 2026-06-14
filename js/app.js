'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5.0;
const BATCH = 10;
const DROP_SVG = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
const MAX_PIXELS = 5_000_000; // threshold for applyDarkMode optimization

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

let pdfDoc = null;
let currentPage = 1;
let zoom = 1.0;
let darkPdf = false;
let handMode = false;
let rotation = 0;
let renderTasks = {};
let thumbTasks = {};
let customFontColor = '#ebdbb2';
let cachedFontRgb = { r: 235, g: 219, b: 178 };
let lang = navigator.language?.startsWith('es') ? 'es' : 'en';
let i18n = {};

// Search
let searchResults = [];
let searchIndex = -1;
let searchHighlightEls = [];
let searchId = 0;

// Hand mode
let handDragging = false;
let handStartX = 0, handStartY = 0;
let handScrollX = 0, handScrollY = 0;

// Zoom animation
let zoomAnimTimer = null;

// FS auto-hide
let fsHideTimer = null;

// Scroll throttling
let scrollRaf = null;

// IntersectionObserver for pages
let observer = null;

// Book mode
let bookMode = false;

// Mobile layout
let _mobileActive = false;

// ─────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────

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
  bookModeBtn:   document.getElementById('book-mode-btn'),
  langBtn:       document.getElementById('lang-btn'),
  langPopup:     document.getElementById('lang-popup'),
};

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

const hexToRgb = (() => {
  const cache = {};
  return (hex) => {
    if (cache[hex]) return cache[hex];
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    const result = m
      ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
      : { r: 212, g: 212, b: 216 };
    cache[hex] = result;
    return result;
  };
})();

async function runConcurrent(items, fn, limit = BATCH) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of it) await fn(item);
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────

const PdfDB = {
  db: null,
  async init() {
    if (this.db) return;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('NoirPDF', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('pdfs', { keyPath: 'id' });
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
    try { await PdfDB.save(file); return true; }
    catch (err) { console.warn('Error guardando PDF:', err); return false; }
  },
  async loadPdfFromStorage() {
    try { return await PdfDB.load(); } catch { return null; }
  },
  saveSettings(s) {
    try { localStorage.setItem('noirpdf-settings', JSON.stringify(s)); }
    catch (e) { console.warn('saveSettings falló:', e); }
  },
  loadSettings() {
    try { const d = localStorage.getItem('noirpdf-settings'); return d ? JSON.parse(d) : null; }
    catch { return null; }
  },
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
          darkPdf, currentPage, zoom, rotation, lang, bookMode,
          scrollPos: bookMode ? 0 : dom.viewerWrap?.scrollTop ?? 0
        });
      } catch (e) { console.warn('autoSave falló:', e); }
    }, 500);
  };
})();

// ─────────────────────────────────────────────
// PDF loading
// ─────────────────────────────────────────────

async function loadPdfFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try { pdfDoc = await pdfjsLib.getDocument(url).promise; }
  finally { URL.revokeObjectURL(url); }
  currentPage = 1; zoom = 1.0; rotation = 0;
  updateZoomDisplay();
  dom.pageInput.max = pdfDoc.numPages;
  dom.pageInfo.textContent = `/ ${pdfDoc.numPages}`;
  dom.pageInput.value = 1;
  buildViewer(); buildSidebar();
  renderPage(1);
}

async function loadPdf(file) {
  await loadPdfFromBlob(file);
  if (await Storage.savePdf(file)) autoSave();
}

async function restorePdfFromStorage(blob, settings) {
  settings = settings || {};
  bookMode = !!settings.bookMode;
  if (bookMode) dom.bookModeBtn?.classList.add('active');
  try {
    await loadPdfFromBlob(blob);
    if (settings.zoom) zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, settings.zoom));
    if (settings.rotation) { rotation = settings.rotation; rerenderAll(); }
    updateZoomDisplay();
    if (settings.currentPage > 0) {
      setTimeout(() => {
        goToPage(settings.currentPage);
        if (!bookMode && settings.scrollPos) dom.viewerWrap.scrollTop = settings.scrollPos;
      }, 300);
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

// ─────────────────────────────────────────────
// Viewer
// ─────────────────────────────────────────────

function createPageWrap(i) {
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = i;
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.id = `page-canvas-${i}`;
  wrap.appendChild(canvas);
  return wrap;
}

function showSpread(pageNum) {
  Object.values(renderTasks).forEach(t => { try { t.cancel(); } catch {} });
  renderTasks = {};
  const spreads = dom.viewerWrap.querySelectorAll('.book-spread');
  let target = null;
  for (const s of spreads) {
    const sp = parseInt(s.dataset.page);
    const match = sp <= pageNum && pageNum <= sp + 1;
    s.style.display = match ? '' : 'none';
    if (match) target = s;
  }
  if (!target) return;
  for (const w of target.querySelectorAll('.page-wrap')) {
    renderPage(parseInt(w.dataset.page));
  }
}

function buildViewer() {
  if (observer) { observer.disconnect(); observer = null; }
  dom.viewerWrap.innerHTML = '';
  clearHighlights();
  Object.values(renderTasks).forEach(t => t.cancel?.());
  renderTasks = {};

  const fragment = document.createDocumentFragment();

  if (bookMode) {
    for (let i = 1; i <= pdfDoc.numPages; i += 2) {
      const spread = document.createElement('div');
      spread.className = 'book-spread';
      spread.appendChild(createPageWrap(i));
      if (i + 1 <= pdfDoc.numPages) {
        spread.appendChild(createPageWrap(i + 1));
      }
      spread.dataset.page = i;
      fragment.appendChild(spread);
    }
  } else {
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      fragment.appendChild(createPageWrap(i));
    }
  }

  dom.viewerWrap.appendChild(fragment);

  if (bookMode) {
    dom.viewerWrap.style.overflow = 'hidden';
    showSpread(currentPage);
  } else {
    dom.viewerWrap.style.overflow = '';
    observer = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) renderPage(parseInt(e.target.dataset.page));
      }
    }, { root: dom.viewerWrap, rootMargin: '200px', threshold: 0 });
    for (const w of dom.viewerWrap.querySelectorAll('.page-wrap')) observer.observe(w);
  }
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
  const task = page.render({ canvasContext: off.getContext('2d'), viewport: hiRes });
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
  const w = canvas.width, h = canvas.height;
  // Skip if canvas is too large to avoid blocking the main thread
  if (w * h > MAX_PIXELS) return;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
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

// ─────────────────────────────────────────────
// Sidebar (thumbnails)
// ─────────────────────────────────────────────

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
  try { await task.promise; } catch (e) {
    if (e.name !== 'RenderingCancelledException') console.warn('Render error thumb p' + pageNum, e);
    return;
  }
  delete thumbTasks[pageNum];
  if (darkPdf) applyDarkMode(off);
  const canvas = document.getElementById(`thumb-${pageNum}`);
  if (!canvas) return;
  canvas.width = viewport.width; canvas.height = viewport.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
}

// ─────────────────────────────────────────────
// Page navigation
// ─────────────────────────────────────────────

function goToPage(num) {
  if (!pdfDoc) return;
  num = Math.max(1, Math.min(num, pdfDoc.numPages));
  currentPage = num; dom.pageInput.value = num;
  updateActiveThumbs(); autoSave();

  if (bookMode) {
    showSpread(num);
    return;
  } else {
    dom.viewerWrap.querySelector(`[data-page="${num}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function changePage(delta) {
  if (!pdfDoc) return;
  if (bookMode) {
    let spreadStart = currentPage % 2 === 0 ? currentPage - 1 : currentPage;
    if (spreadStart === 1 && delta < 0) return;
    let newPage = spreadStart + delta * 2;
    newPage = Math.max(1, Math.min(newPage, pdfDoc.numPages));
    goToPage(newPage);
  } else {
    goToPage(currentPage + delta);
  }
}

function onViewerScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    if (!pdfDoc) return;
    updateProgress();

    if (bookMode) return;
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
  if (bookMode) {
    const pct = (currentPage / pdfDoc.numPages) * 100;
    dom.progressFill.style.width = Math.min(pct, 100) + '%';
  } else {
    const scrollTop = dom.viewerWrap.scrollTop;
    const scrollHeight = dom.viewerWrap.scrollHeight - dom.viewerWrap.clientHeight;
    const pct = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
    dom.progressFill.style.width = Math.min(pct, 100) + '%';
  }
}

function updateActiveThumbs() {
  for (const item of dom.sidebar.querySelectorAll('.thumb-item')) {
    item.classList.toggle('active', parseInt(item.dataset.page) === currentPage);
  }
  dom.sidebar.querySelector('.thumb-item.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ─────────────────────────────────────────────
// Zoom
// ─────────────────────────────────────────────

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
  const wraps = bookMode
    ? [...dom.viewerWrap.querySelectorAll('.book-spread')]
        .filter(s => s.style.display !== 'none')
        .reduce((a, s) => a.concat([...s.querySelectorAll('.page-wrap')]), [])
    : [...dom.viewerWrap.querySelectorAll('.page-wrap')];
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
  if (bookMode) {
    showSpread(currentPage);
  } else if (observer) {
    for (const w of dom.viewerWrap.querySelectorAll('.page-wrap')) {
      observer.unobserve(w); observer.observe(w);
    }
    renderPage(currentPage);
  }
}

// ─────────────────────────────────────────────
// PDF manipulation
// ─────────────────────────────────────────────

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

function toggleBookMode() {
  bookMode = !bookMode;
  dom.bookModeBtn?.classList.toggle('active', bookMode);
  if (!pdfDoc) return;
  const prev = currentPage;
  dom.viewerWrap.scrollTop = 0;
  dom.viewerWrap.scrollLeft = 0;
  buildViewer();
  if (bookMode) {
    currentPage = prev;
    dom.pageInput.value = prev;
    updateActiveThumbs();
    autoSave();
  } else {
    currentPage = prev;
    dom.pageInput.value = prev;
    updateActiveThumbs(); autoSave();
    const target = dom.viewerWrap.querySelector(`[data-page="${prev}"]`);
    if (target) {
      if (observer) { observer.disconnect(); observer = null; }
      dom.viewerWrap.scrollTop = target.offsetTop;
      renderPage(prev).then(() => {
        const updated = dom.viewerWrap.querySelector(`[data-page="${prev}"]`);
        if (updated) {
          updated.scrollIntoView({ block: 'start' });
          if (currentPage !== prev) {
            currentPage = prev;
            dom.pageInput.value = prev;
            updateActiveThumbs();
          }
        }
        observer = new IntersectionObserver(entries => {
          for (const e of entries) {
            if (e.isIntersecting) renderPage(parseInt(e.target.dataset.page));
          }
        }, { root: dom.viewerWrap, rootMargin: '200px', threshold: 0 });
        for (const w of dom.viewerWrap.querySelectorAll('.page-wrap')) observer.observe(w);
        requestAnimationFrame(() => {
          const el = dom.viewerWrap.querySelector(`[data-page="${prev}"]`);
          if (el) el.scrollIntoView({ block: 'start' });
        });
      });
    }
  }
}

function togglePageTheme() {
  const html = document.documentElement;
  const isDark = html.dataset.theme === 'dark';
  html.dataset.theme = isDark ? 'light' : 'dark';
  dom.iconSun.style.display = isDark ? 'block' : 'none';
  dom.iconMoon.style.display = isDark ? 'none' : 'block';
  autoSave();
}

// ─────────────────────────────────────────────
// Download / Export / Close
// ─────────────────────────────────────────────

async function downloadPdf() {
  if (!pdfDoc) return;
  const blob = await Storage.loadPdfFromStorage();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = blob.name || 'documento.pdf';
  a.click(); URL.revokeObjectURL(url);
}

function exportPng() {
  if (!pdfDoc) return;
  const canvas = document.getElementById(`page-canvas-${currentPage}`);
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = `pagina-${currentPage}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

async function closePdf() {
  if (!pdfDoc) return;
  Object.values(renderTasks).forEach(t => { try { t.cancel(); } catch {} });
  Object.values(thumbTasks).forEach(t => t.cancel?.());
  renderTasks = {}; thumbTasks = {};
  clearHighlights();
  pdfDoc = null; currentPage = 1; zoom = 1.0; rotation = 0; bookMode = false;
  dom.bookModeBtn?.classList.remove('active');
  dom.viewerWrap.style.overflow = '';
  dom.viewerWrap.innerHTML = `<div id="drop-zone">${DROP_SVG}<p data-i18n="dropzone">Click or drag a PDF here</p><small data-i18n="dropzoneSub">Supports local PDF files</small></div>`;
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

// ─────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────

function toggleSearch() {
  dom.searchWrap.classList.toggle('active');
  if (dom.searchWrap.classList.contains('active')) dom.searchInput.focus();
  else clearHighlights();
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
        results.push({ pageNum: p, x: t[4] + charW * idx, y: t[5] - h, w: charW * q.length, h });
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
  if (results.length === 0) { dom.searchCount.textContent = '0/0'; return; }

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
  for (const el of searchHighlightEls) el.classList.remove('search-active');
  if (searchHighlightEls[idx]) searchHighlightEls[idx].classList.add('search-active');
  goToPage(searchResults[idx].pageNum);
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

// ─────────────────────────────────────────────
// Hand mode
// ─────────────────────────────────────────────

function toggleHandMode() {
  handMode = !handMode;
  document.body.classList.toggle('hand-mode', handMode);
  dom.handBtn.classList.toggle('active', handMode);
}

// ─────────────────────────────────────────────
// Fullscreen
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Language
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Help modal
// ─────────────────────────────────────────────

function toggleHelp() { dom.helpModal.classList.toggle('open'); }

// ─────────────────────────────────────────────
// Mobile layout
// ─────────────────────────────────────────────

function updateMobileLayout() {
  const isMobile = window.innerWidth <= 768;
  const bar = document.getElementById('mobile-bottom-bar');
  const toolbar = document.getElementById('toolbar');
  if (!bar || !toolbar) return;
  if (isMobile === _mobileActive) return;
  _mobileActive = isMobile;

  const sections = bar.querySelectorAll('.bar-section');
  if (!sections.length) return;

  const movable = [
    { el: document.querySelector('.split-btn'), section: 0 },
    { el: document.getElementById('prev-btn'), section: 0 },
    { el: document.getElementById('page-input'), section: 0 },
    { el: document.getElementById('page-info'), section: 0 },
    { el: document.getElementById('next-btn'), section: 0 },
    { el: document.getElementById('search-wrap'), section: 0 },
    { el: document.getElementById('zoom-out'), section: 1 },
    { el: document.getElementById('zoom-display'), section: 1 },
    { el: document.getElementById('zoom-in'), section: 1 },
    { el: document.getElementById('rotate-btn'), section: 1 },
    { el: document.getElementById('pdf-theme-wrap'), section: 1 },
    { el: document.querySelector('.color-picker'), section: 1 },
    { el: document.querySelector('.lang-picker'), section: 2 },
    { el: document.getElementById('page-theme-btn'), section: 2 },
    { el: document.getElementById('help-btn'), section: 2 },
  ].filter(x => x.el);

  if (isMobile) {
    for (const { el, section } of movable) {
      if (el.parentNode === toolbar) sections[section].appendChild(el);
    }
    requestAnimationFrame(() => {
      const wrap = bar.querySelector('.bar-sections');
      if (wrap) { wrap.scrollLeft = wrap.offsetWidth; updateBarDots(); }
    });
  } else {
    const fileInput = document.getElementById('file-input');
    const groups = [
      { get: () => document.querySelector('.split-btn'), group: 0 },
      { get: () => document.getElementById('prev-btn'), group: 0 },
      { get: () => document.getElementById('page-input'), group: 0 },
      { get: () => document.getElementById('page-info'), group: 0 },
      { get: () => document.getElementById('next-btn'), group: 0 },
      { get: () => document.getElementById('search-wrap'), group: 0 },
      { get: () => document.getElementById('zoom-out'), group: 1 },
      { get: () => document.getElementById('zoom-display'), group: 1 },
      { get: () => document.getElementById('zoom-in'), group: 1 },
      { get: () => document.getElementById('rotate-btn'), group: 1 },
      { get: () => document.getElementById('pdf-theme-wrap'), group: 1 },
      { get: () => document.querySelector('.color-picker'), group: 1 },
      { get: () => document.querySelector('.lang-picker'), group: 2 },
      { get: () => document.getElementById('page-theme-btn'), group: 2 },
      { get: () => document.getElementById('help-btn'), group: 2 },
    ];

    for (const { get, group } of groups) {
      const el = get();
      if (!el || (el.parentNode !== bar && !el.closest('.bar-section'))) continue;
      if (group === 0) {
        if (fileInput?.parentNode === toolbar) toolbar.insertBefore(el, fileInput.nextSibling);
        else toolbar.prepend(el);
      } else if (group === 1) {
        const ref = document.querySelector('.lang-picker');
        if (ref?.parentNode === toolbar) toolbar.insertBefore(el, ref);
        else toolbar.appendChild(el);
      } else {
        const ref = document.getElementById('fs-btn');
        if (ref?.parentNode === toolbar) toolbar.insertBefore(el, ref);
        else toolbar.appendChild(el);
      }
    }
  }
}

function updateBarDots() {
  const wrap = document.querySelector('.bar-sections');
  const dots = document.querySelectorAll('.bar-dot');
  if (!wrap || !dots.length) return;
  const idx = Math.round(wrap.scrollLeft / wrap.offsetWidth);
  dots.forEach((d, i) => d.classList.toggle('active', i === idx));
}

// ─────────────────────────────────────────────
// Event bindings
// ─────────────────────────────────────────────

// ── File operations ──
dom.fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) loadPdf(f).catch(err => console.warn('Error loading PDF:', err));
});
dom.openBtn.addEventListener('click', () => dom.fileInput.click());
dom.dropZone.addEventListener('click', () => dom.fileInput.click());

// Open PDF split dropdown
const openArrow = document.getElementById('open-arrow');
const openDropdown = document.getElementById('open-dropdown');
openArrow?.addEventListener('click', e => { e.stopPropagation(); openDropdown?.classList.toggle('open'); });
document.getElementById('dropdown-download')?.addEventListener('click', () => { openDropdown?.classList.remove('open'); downloadPdf(); });
document.getElementById('dropdown-export')?.addEventListener('click', () => { openDropdown?.classList.remove('open'); exportPng(); });
document.getElementById('dropdown-close')?.addEventListener('click', () => { openDropdown?.classList.remove('open'); closePdf(); });
document.addEventListener('click', e => { if (!e.target.closest('.split-btn')) openDropdown?.classList.remove('open'); });

// Drag & drop
dom.viewerWrap.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone?.classList.add('drag-over'); });
dom.viewerWrap.addEventListener('dragleave', () => dom.dropZone?.classList.remove('drag-over'));
dom.viewerWrap.addEventListener('drop', e => {
  e.preventDefault(); dom.dropZone?.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f?.type === 'application/pdf') loadPdf(f);
});

// ── Sidebar (thumbnails) ──
dom.sidebar.addEventListener('click', e => {
  const item = e.target.closest('.thumb-item');
  if (item) goToPage(parseInt(item.dataset.page));
});

// ── Page navigation ──
dom.prevBtn.addEventListener('click', () => changePage(-1));
dom.nextBtn.addEventListener('click', () => changePage(1));
dom.pageInput.addEventListener('change', () => goToPage(parseInt(dom.pageInput.value) || 1));
dom.pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') goToPage(parseInt(dom.pageInput.value) || 1); });

// ── Zoom ──
dom.zoomOut.addEventListener('click', () => changeZoom(-0.15));
dom.zoomIn.addEventListener('click', () => changeZoom(0.15));

// ── View controls ──
dom.rotateBtn.addEventListener('click', rotatePage);
dom.bookModeBtn?.addEventListener('click', toggleBookMode);
dom.handBtn.addEventListener('click', toggleHandMode);
dom.fsBtn.addEventListener('click', toggleFS);

// ── PDF customization ──
dom.pdfToggle.addEventListener('click', togglePdfTheme);
dom.pageThemeBtn.addEventListener('click', togglePageTheme);

// Color picker
dom.colorSwatch.addEventListener('click', e => { e.stopPropagation(); dom.colorPopup.classList.toggle('open'); });
dom.colorPopup.addEventListener('click', e => {
  const swat = e.target.closest('.cp-swat');
  if (!swat) return;
  if (swat.dataset.c === 'custom') { dom.fontColor.click(); return; }
  dom.colorSwatch.style.background = swat.dataset.c;
  dom.colorPopup.classList.remove('open');
  changeFontColor(swat.dataset.c);
});
dom.fontColor.addEventListener('change', () => {
  const color = dom.fontColor.value;
  dom.colorSwatch.style.background = color;
  dom.colorPopup.classList.remove('open');
  changeFontColor(color);
});
document.addEventListener('click', e => { if (!e.target.closest('.color-picker')) dom.colorPopup.classList.remove('open'); });

// ── Language ──
dom.langBtn.addEventListener('click', e => { e.stopPropagation(); dom.langPopup.classList.toggle('open'); });
dom.langPopup.addEventListener('click', e => {
  const opt = e.target.closest('.lang-opt');
  if (opt) setLang(opt.dataset.lang);
});
document.addEventListener('click', e => { if (!e.target.closest('.lang-picker')) dom.langPopup.classList.remove('open'); });

// ── Help ──
dom.helpBtn.addEventListener('click', toggleHelp);
dom.helpModal.addEventListener('click', e => { if (e.target === dom.helpModal) dom.helpModal.classList.remove('open'); });
dom.helpClose.addEventListener('click', () => dom.helpModal.classList.remove('open'));

// ── Search ──
dom.searchInput.addEventListener('input', () => searchText(dom.searchInput.value));
dom.searchPrev.addEventListener('click', prevResult);
dom.searchNext.addEventListener('click', nextResult);
dom.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') e.shiftKey ? prevResult() : nextResult();
  if (e.key === 'Escape') { toggleSearch(); dom.searchInput.blur(); }
});

// ── Viewer scroll ──
dom.viewerWrap.addEventListener('scroll', onViewerScroll, { passive: true });

// ── Hand mode events ──
dom.viewerWrap.addEventListener('mousedown', e => {
  if (!handMode) return;
  handDragging = true;
  handStartX = e.clientX; handStartY = e.clientY;
  handScrollX = dom.viewerWrap.scrollLeft; handScrollY = dom.viewerWrap.scrollTop;
  e.preventDefault();
});
document.addEventListener('mousemove', e => {
  if (!handDragging) return;
  dom.viewerWrap.scrollLeft = handScrollX - (e.clientX - handStartX);
  dom.viewerWrap.scrollTop = handScrollY - (e.clientY - handStartY);
});
document.addEventListener('mouseup', () => { handDragging = false; });

dom.viewerWrap.addEventListener('touchstart', e => {
  if (!handMode || e.touches.length !== 1) return;
  handDragging = true;
  handStartX = e.touches[0].clientX; handStartY = e.touches[0].clientY;
  handScrollX = dom.viewerWrap.scrollLeft; handScrollY = dom.viewerWrap.scrollTop;
  e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', e => {
  if (!handDragging || e.touches.length !== 1) return;
  dom.viewerWrap.scrollLeft = handScrollX - (e.touches[0].clientX - handStartX);
  dom.viewerWrap.scrollTop = handScrollY - (e.touches[0].clientY - handStartY);
}, { passive: false });
document.addEventListener('touchend', () => { handDragging = false; });

// ── FS auto-hide toolbar ──
dom.viewerWrap.addEventListener('mousemove', () => {
  if (!document.body.classList.contains('fs')) return;
  const toolbarEl = document.getElementById('toolbar');
  if (!toolbarEl) return;
  toolbarEl.classList.add('fs-show');
  clearTimeout(fsHideTimer);
  fsHideTimer = setTimeout(() => toolbarEl.classList.remove('fs-show'), 2000);
});

// ── Ctrl+scroll zoom ──
dom.viewerWrap.addEventListener('wheel', e => {
  if (e.ctrlKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 0.1 : -0.1); }
}, { passive: false });

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  const inInput = e.target.tagName === 'INPUT' && e.target !== dom.pageInput;
  if (inInput && e.key !== 'Escape') return;

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
    case 'b': case 'B': toggleBookMode(); break;
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

// ── Mobile layout events ──
updateMobileLayout();
window.addEventListener('resize', updateMobileLayout);
document.querySelector('.bar-sections')?.addEventListener('scroll', updateBarDots, { passive: true });

// ── Save on close ──
window.addEventListener('beforeunload', () => {
  try {
    Storage.saveSettings({
      theme: document.documentElement.dataset.theme,
      fontColor: customFontColor,
      darkPdf, currentPage, zoom, rotation, lang, bookMode,
      scrollPos: bookMode ? 0 : dom.viewerWrap?.scrollTop ?? 0
    });
  } catch (e) { console.warn('beforeunload save falló:', e); }
});

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────

dom.iconMoon.style.display = 'block';
dom.iconSun.style.display = 'none';
initializeFromStorage().catch(e => console.warn('initializeFromStorage falló:', e));
