document.addEventListener('DOMContentLoaded', function(){
  'use strict';

  // close legal modals on backdrop click or Escape
  document.querySelectorAll('.legal-modal').forEach(function(m){
    m.addEventListener('click', function(e){ if(e.target === m) m.style.display = 'none'; });
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){
      document.querySelectorAll('.legal-modal').forEach(function(m){ m.style.display = 'none'; });
    }
  });

  let dataset = [];       // array of row objects
  let columns = [];        // [{name, type, stats}]
  let sortState = {col:null, dir:1};
  let chartInstance = null;
  let currentHistoryId = null; // history entry the active session should keep updating, if any

  // Resolution multipliers used only while rasterizing for PNG/PDF export, so
  // downloaded files look sharp (retina-grade) even on a standard display —
  // independent of the on-screen chart's own devicePixelRatio.
  const CHART_EXPORT_SCALE = 3;     // Chart.js canvas devicePixelRatio while capturing
  const DOM_EXPORT_SCALE = 3;       // html2canvas scale for pictogram/scatter-matrix
  const DASHBOARD_EXPORT_SCALE = 2; // extra backing-store multiplier for the composite dashboard canvas

  const $ = id => document.getElementById(id);
  const tray = $('tray'), fileInput = $('fileInput'), browseBtn = $('browseBtn');
  const errBox = $('err'), readeouts = $('readeouts'), main = $('main');
  const statusDot = $('statusDot'), statusText = $('statusText');
  const fileMeta = $('fileMeta'), previewPanel = $('previewPanel');

  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

  // ---------- history (localStorage) ----------
  const HISTORY_KEY = 'readeout.history.v1';
  const HISTORY_MAX_ENTRIES = 15;
  const HISTORY_MAX_DATASET_CHARS = 1_500_000; // ~1.5MB of JSON; larger datasets are kept as metadata-only

  let historyAvailable = true;
  try{
    const t = '__readeout_probe__';
    localStorage.setItem(t, '1'); localStorage.removeItem(t);
  } catch(e){ historyAvailable = false; }

  function debounce(fn, wait){
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  }

  function loadHistory(){
    if(!historyAvailable) return [];
    try{
      const raw = localStorage.getItem(HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch(e){ return []; }
  }

  function saveHistory(list){
    if(!historyAvailable) return false;
    try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); return true; }
    catch(e){ return false; } // quota exceeded or serialization failure
  }

  function currentChartSettings(){
    return {
      chartType: $('chartType').value, xCol: $('xCol').value, yCol: $('yCol').value,
      binsCol: $('binsCol').value, valueCol: $('valueCol').value, goalInput: $('goalInput').value,
      is3D: is3D, showTrend: showTrend
    };
  }

  // Saves the just-loaded dataset as a new history entry. Datasets under ~1.5MB of
  // JSON are stored in full so they can be reopened later; larger ones are kept as
  // metadata only (filename/size/date) since localStorage has a small total quota
  // shared across all entries. If saving still fails (quota exceeded even after
  // capping entry count), oldest entries are dropped until it fits.
  function pushHistoryEntry(file){
    if(!historyAvailable || !dataset.length) return;
    const list = loadHistory();
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      filename: (file && file.name) || 'dataset',
      savedAt: Date.now(),
      rows: dataset.length,
      cols: columns.length,
      dataset: null,
      tooLarge: false,
      settings: currentChartSettings()
    };
    const json = JSON.stringify(dataset);
    if(json.length <= HISTORY_MAX_DATASET_CHARS){
      entry.dataset = dataset;
    } else {
      entry.tooLarge = true;
    }
    list.unshift(entry);
    while(list.length > HISTORY_MAX_ENTRIES) list.pop();
    let ok = saveHistory(list);
    while(!ok && list.length > 1){ list.pop(); ok = saveHistory(list); }
    if(!ok && list.length === 1 && list[0].dataset){
      list[0].dataset = null; list[0].tooLarge = true;
      ok = saveHistory(list);
    }
    currentHistoryId = ok ? entry.id : null;
    renderHistoryPanel();
  }

  // Keeps the active session's saved chart settings (type/axes/3D/etc.) in sync as
  // the person tweaks the chart, so reopening it later restores the same view.
  function updateCurrentHistorySettings(){
    if(!historyAvailable || !currentHistoryId) return;
    const list = loadHistory();
    const idx = list.findIndex(e => e.id === currentHistoryId);
    if(idx === -1) return;
    list[idx].settings = currentChartSettings();
    saveHistory(list);
  }
  const debouncedSaveSettings = debounce(updateCurrentHistorySettings, 500);

  function deleteHistoryEntry(id){
    const list = loadHistory().filter(e => e.id !== id);
    saveHistory(list);
    if(currentHistoryId === id) currentHistoryId = null;
    renderHistoryPanel();
  }

  function clearHistoryAll(){
    if(!confirm('Clear all saved sessions? This cannot be undone.')) return;
    try{ localStorage.removeItem(HISTORY_KEY); } catch(e){}
    currentHistoryId = null;
    renderHistoryPanel();
  }

  function fmtHistDate(ts){
    const d = new Date(ts);
    return d.toLocaleDateString(undefined,{month:'short', day:'numeric'}) + ' · ' +
      d.toLocaleTimeString(undefined,{hour:'2-digit', minute:'2-digit'});
  }

  function renderHistoryPanel(){
    const box = $('historyList'), badge = $('historyBadge'), countEl = $('historyCount');
    if(!historyAvailable){
      box.innerHTML = '<div class="hist-empty">Local storage isn\'t available in this browser (private/incognito mode may block it), so sessions can\'t be saved here.</div>';
      badge.textContent = ''; countEl.textContent = '';
      return;
    }
    const list = loadHistory();
    badge.textContent = list.length ? String(list.length) : '';
    countEl.textContent = list.length ? `(${list.length})` : '';
    if(!list.length){
      box.innerHTML = '<div class="hist-empty">No saved sessions yet — analyze a file and it\'ll show up here.</div>';
      return;
    }
    box.innerHTML = list.map(e => `
      <div class="hist-row">
        <div class="hist-main">
          <div class="hist-name">${escapeHtml(e.filename)}</div>
          <div class="hist-meta">${e.rows.toLocaleString()} rows · ${e.cols} cols · ${escapeHtml((e.settings && e.settings.chartType) || '—')} · ${fmtHistDate(e.savedAt)}${e.tooLarge ? ' · <span class="hist-warn">metadata only</span>' : ''}</div>
        </div>
        <div class="hist-actions">
          <button type="button" class="btn ghost small hist-open" data-id="${e.id}" ${e.tooLarge ? 'disabled title="Too large to restore locally — re-upload the file"' : ''}>Open</button>
          <button type="button" class="btn ghost small hist-del" data-id="${e.id}" title="Delete">✕</button>
        </div>
      </div>
    `).join('') + '<button type="button" class="btn ghost small" id="clearHistoryBtn" style="margin-top:2px;width:100%;">Clear history</button>';

    box.querySelectorAll('.hist-open').forEach(btn => btn.addEventListener('click', () => openHistoryEntry(btn.dataset.id)));
    box.querySelectorAll('.hist-del').forEach(btn => btn.addEventListener('click', () => deleteHistoryEntry(btn.dataset.id)));
    const clearBtn = $('clearHistoryBtn');
    if(clearBtn) clearBtn.addEventListener('click', clearHistoryAll);
  }

  // Reopens a saved session: loads its stored dataset, re-runs the full analysis
  // pipeline, then re-applies the chart type/axis/3D settings it was left on.
  function openHistoryEntry(id){
    const list = loadHistory();
    const entry = list.find(e => e.id === id);
    if(!entry || !entry.dataset || !entry.dataset.length){
      showErr('This session\'s data was too large to store locally — please re-upload the file.');
      return;
    }
    showErr('');
    dataset = entry.dataset;
    showFileMeta({ name: entry.filename, size: JSON.stringify(dataset).length }, true);
    previewPanel.style.display = 'none';
    renderPreview();
    analyze();

    const s = entry.settings;
    if(s){
      const typeSel = $('chartType');
      if([...typeSel.options].some(o => o.value === s.chartType)) typeSel.value = s.chartType;
      updateAxisOptions();
      if(s.xCol && [...$('xCol').options].some(o => o.value === s.xCol)) $('xCol').value = s.xCol;
      if(s.yCol && [...$('yCol').options].some(o => o.value === s.yCol)) $('yCol').value = s.yCol;
      if(s.binsCol) $('binsCol').value = s.binsCol;
      if(s.valueCol && [...$('valueCol').options].some(o => o.value === s.valueCol)) $('valueCol').value = s.valueCol;
      if(s.goalInput) $('goalInput').value = s.goalInput;
      is3D = !!s.is3D;
      update3DAvailability();
      if(is3D && !$('toggle3D').disabled) $('toggle3D').classList.add('active');
      showTrend = !!s.showTrend;
      updateTrendAvailability();
      if(showTrend && !$('toggleTrend').disabled) $('toggleTrend').classList.add('active');
      updateZoomAvailability();
      renderChart();
      renderChipRow();
      updateColorPanelMode();
      renderColorSwatches();
    }

    // Move this entry to the top (most-recently-opened) and keep tracking it.
    const rest = list.filter(e => e.id !== id);
    entry.savedAt = Date.now();
    rest.unshift(entry);
    saveHistory(rest);
    currentHistoryId = id;
    renderHistoryPanel();
    $('historyPanel').classList.remove('open');
  }

  // ---------- file intake ----------
  browseBtn.addEventListener('click', () => {
    fileInput.value = '';      // allow re-selecting the same file to re-trigger change
    fileInput.click();
  });
  fileInput.addEventListener('change', e => { if(e.target.files[0]) handleFile(e.target.files[0]); });

  ['dragenter','dragover'].forEach(evt => tray.addEventListener(evt, e => {
    e.preventDefault(); e.stopPropagation(); tray.classList.add('drag');
  }));
  ['dragleave','drop'].forEach(evt => tray.addEventListener(evt, e => {
    e.preventDefault(); e.stopPropagation(); tray.classList.remove('drag');
  }));
  tray.addEventListener('drop', e => { if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  $('historyBtn').addEventListener('click', () => {
    renderHistoryPanel();
    $('historyPanel').classList.toggle('open');
  });
  $('closeHistoryBtn').addEventListener('click', () => $('historyPanel').classList.remove('open'));
  renderHistoryPanel(); // populate the badge count on page load

  $('resetBtn').addEventListener('click', () => {
    dataset = []; columns = [];
    labelColors = {};
    tableFilter = null;
    currentHistoryId = null;
    activeView = 'single';
    $('viewTabSingle').classList.add('active');
    $('viewTabDashboard').classList.remove('active');
    $('singleChartView').style.display = '';
    $('dashboardView').style.display = 'none';
    main.style.display = 'none';
    readeouts.style.display = 'none';
    previewPanel.style.display = 'none';
    fileMeta.style.display = 'none';
    fileMeta.innerHTML = '';
    $('chartHint').textContent = '';
    statusDot.style.background = 'var(--amber)'; statusDot.style.boxShadow='0 0 10px var(--amber)';
    statusText.textContent = 'NO SIGNAL'; statusText.classList.remove('live');
    fileInput.value = '';
    showErr('');
  });

  function showErr(msg){
    if(!msg){ errBox.style.display='none'; errBox.textContent=''; return; }
    errBox.style.display='block'; errBox.textContent = '⚠ ' + msg;
  }

  function fmtBytes(n){
    if(n < 1024) return n + ' B';
    if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(1) + ' MB';
  }

  function showFileMeta(file, ok){
    fileMeta.style.display = 'flex';
    fileMeta.innerHTML = `
      <span class="chip-file"><span class="fdot" style="background:${ok?'var(--teal)':'var(--danger)'}"></span>
        ${escapeHtml(file.name)} <span class="fsize">· ${fmtBytes(file.size)}</span>
      </span>`;
  }

  // ---------- validation ----------
  function validateFile(file){
    const nameLower = file.name.toLowerCase();
    const isCSV = nameLower.endsWith('.csv') || file.type === 'text/csv';
    const isJSON = nameLower.endsWith('.json') || file.type === 'application/json';

    if(!isCSV && !isJSON){
      return 'Unsupported file type. Please upload a .csv or .json file.';
    }
    if(file.size === 0){
      return 'This file is empty.';
    }
    if(file.size > MAX_FILE_BYTES){
      return `File is too large (${fmtBytes(file.size)}). Max size is ${fmtBytes(MAX_FILE_BYTES)}.`;
    }
    return null;
  }

  function handleFile(file){
    showErr('');
    previewPanel.style.display = 'none';
    currentHistoryId = null; // this is a fresh upload, not a reopened session

    const validationError = validateFile(file);
    if(validationError){
      showFileMeta(file, false);
      showErr(validationError);
      return;
    }
    showFileMeta(file, true);

    const reader = new FileReader();
    reader.onload = e => {
      try{
        const text = e.target.result;
        const isJSON = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
        dataset = isJSON ? parseJSON(text) : parseCSV(text);
        if(!dataset.length) throw new Error('No rows found in file.');
        renderPreview();
        analyze();
        pushHistoryEntry(file);
      } catch(err){
        showFileMeta(file, false);
        showErr(err.message || 'Could not parse this file.');
      }
    };
    reader.onerror = () => { showFileMeta(file, false); showErr('Could not read the file.'); };
    reader.readAsText(file);
  }

  // ---------- preview ----------
  function renderPreview(){
    const names = Object.keys(dataset[0]).slice(0, 8);
    const sample = dataset.slice(0, 5);
    $('previewHead').innerHTML = names.map(n => `<th>${escapeHtml(n)}</th>`).join('');
    $('previewBody').innerHTML = sample.map(r =>
      '<tr>' + names.map(n => `<td>${escapeHtml(r[n] ?? '')}</td>`).join('') + '</tr>'
    ).join('');
    $('previewCount').textContent = `First ${sample.length} of ${dataset.length.toLocaleString()} rows` +
      (Object.keys(dataset[0]).length > names.length ? ` · first ${names.length} columns` : '');
    previewPanel.style.display = 'block';
  }

  // ---------- parsers ----------
  function parseJSON(text){
    let data;
    try{
      data = JSON.parse(text);
    } catch(e){
      throw new Error('Invalid JSON — could not parse file.');
    }
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
    if(!arr) throw new Error('JSON must be an array of objects, or an object with a "data" array.');
    if(!arr.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))){
      throw new Error('Each JSON array item must be an object (key/value pairs).');
    }
    return arr;
  }

  function parseCSV(text){
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for(let i=0;i<text.length;i++){
      const c = text[i], next = text[i+1];
      if(inQuotes){
        if(c === '"' && next === '"'){ field += '"'; i++; }
        else if(c === '"'){ inQuotes = false; }
        else { field += c; }
      } else {
        if(c === '"'){ inQuotes = true; }
        else if(c === ','){ row.push(field); field=''; }
        else if(c === '\n'){ row.push(field); rows.push(row); row=[]; field=''; }
        else if(c === '\r'){ /* skip */ }
        else { field += c; }
      }
    }
    if(field.length || row.length){ row.push(field); rows.push(row); }
    const filtered = rows.filter(r => r.some(f => f.trim() !== ''));
    if(filtered.length < 2) throw new Error('CSV needs a header row and at least one data row.');
    const headers = filtered[0].map(h => h.trim());
    return filtered.slice(1).map(r => {
      const obj = {};
      headers.forEach((h,i) => obj[h] = r[i] !== undefined ? r[i].trim() : '');
      return obj;
    });
  }

  // ---------- analysis ----------
  function inferType(values){
    const nonEmpty = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    if(!nonEmpty.length) return 'empty';
    const numCount = nonEmpty.filter(v => !isNaN(parseFloat(v)) && isFinite(v)).length;
    if(numCount / nonEmpty.length > 0.85) return 'number';
    const dateCount = nonEmpty.filter(v => !isNaN(Date.parse(v)) && isNaN(parseFloat(v))).length;
    if(dateCount / nonEmpty.length > 0.85) return 'date';
    return 'text';
  }

  function computeStats(values, type){
    const nonEmpty = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    const missing = values.length - nonEmpty.length;
    if(type === 'number'){
      const nums = nonEmpty.map(Number).filter(n => !isNaN(n));
      const sum = nums.reduce((a,b)=>a+b,0);
      const mean = nums.length ? sum/nums.length : 0;
      const sorted = [...nums].sort((a,b)=>a-b);
      const median = sorted.length ? (sorted.length%2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2) : 0;
      const variance = nums.length ? nums.reduce((a,b)=>a+Math.pow(b-mean,2),0)/nums.length : 0;
      return {
        min: nums.length?Math.min(...nums):0, max: nums.length?Math.max(...nums):0,
        mean, median, std: Math.sqrt(variance), missing, count: nonEmpty.length
      };
    }
    const unique = new Set(nonEmpty.map(String));
    return { unique: unique.size, missing, count: nonEmpty.length };
  }

  function fmt(n){
    if(typeof n !== 'number' || isNaN(n)) return '—';
    if(Math.abs(n) >= 1000) return n.toLocaleString(undefined,{maximumFractionDigits:1});
    return Number.isInteger(n) ? n.toString() : n.toFixed(2);
  }

  // ---------- auto-generated insight captions ----------
  // Each chart branch can surface up to a few plain-English readouts, computed
  // fresh from whatever that branch already knows (no separate data pass).
  // Every insight gets its own "Export" checkbox so the person can choose
  // which ones travel with the PNG/PDF download; unchecked ones stay on
  // screen but are left out of exports.
  let insightSelections = [];

  function setInsightCaptions(list){
    const el = $('insightCaption');
    if(!el) return;
    const items = (list || []).filter(Boolean);
    if(!items.length){
      el.style.display = 'none'; el.innerHTML = ''; el.classList.remove('ic-anim');
      el.dataset.items = ''; insightSelections = [];
      return;
    }

    const prevItems = el.dataset.items ? JSON.parse(el.dataset.items) : [];
    const changed = JSON.stringify(prevItems) !== JSON.stringify(items);
    el.dataset.items = JSON.stringify(items);
    insightSelections = items.map(() => true);

    const head = items.length > 1
      ? '<div class="insight-caption-head">Insights — tick to include in export</div>' : '';
    const rows = items.map((text, i) => `
      <div class="ic-row" data-ic-row="${i}">
        <span class="ic-ic">◆</span>
        <span class="ic-text">${escapeHtml(text)}</span>
        <label class="ic-check"><input type="checkbox" data-ic-idx="${i}" checked> Export</label>
      </div>`).join('');
    el.innerHTML = head + rows;
    el.style.display = 'flex';

    el.querySelectorAll('input[data-ic-idx]').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.getAttribute('data-ic-idx'), 10);
        insightSelections[idx] = cb.checked;
        const row = el.querySelector(`.ic-row[data-ic-row="${idx}"]`);
        if(row) row.classList.toggle('ic-off', !cb.checked);
      });
    });

    if(changed){
      el.classList.remove('ic-anim');
      void el.offsetWidth; // restart the animation even if it was already showing
      el.classList.add('ic-anim');
    }
  }

  // Returns just the insight text strings currently ticked "Export" — used by
  // the PNG/PDF export functions so the download only includes what the
  // person chose to keep.
  function currentInsightCaptionTexts(){
    const el = $('insightCaption');
    if(!el || el.style.display === 'none' || !el.dataset.items) return [];
    const items = JSON.parse(el.dataset.items);
    return items.filter((_, i) => insightSelections[i] !== false);
  }

  function corrStrength(r){
    const a = Math.abs(r);
    if(a >= 0.7) return 'strong';
    if(a >= 0.4) return 'moderate';
    if(a >= 0.2) return 'weak';
    return 'very weak';
  }

  // Used specifically when the person switches chart TYPE (not every axis/color
  // tweak) so that the swap reads as a deliberate transition instead of a hard
  // cut — the old chart fades/shrinks out, the new one (with Chart.js's own
  // built-in construction animation) grows back in.
  let chartSwitchTimer = null;
  function renderChartWithTransition(){
    const box = $('chartBox');
    if(!box){ renderChart(); return; }
    box.classList.add('is-switching');
    clearTimeout(chartSwitchTimer);
    chartSwitchTimer = setTimeout(() => {
      renderChart();
      requestAnimationFrame(() => { box.classList.remove('is-switching'); });
    }, 160);
  }

  function analyze(){
    tableFilter = null;
    const names = Object.keys(dataset[0]);
    columns = names.map(name => {
      const values = dataset.map(r => r[name]);
      const type = inferType(values);
      return { name, type, stats: computeStats(values, type) };
    });

    renderReadeouts();
    renderColCards();
    renderTable();
    setupChartControls();
    renderChart();
    if(activeView === 'dashboard') renderDashboardGrid();

    main.style.display = 'block';
    readeouts.style.display = 'grid';
    statusDot.style.background = 'var(--teal)'; statusDot.style.boxShadow='0 0 10px var(--teal)';
    statusText.textContent = 'SIGNAL LOCKED'; statusText.classList.add('live');
  }

  function renderReadeouts(){
    const numericCols = columns.filter(c => c.type === 'number');
    const cards = [
      {label:'Rows', value: dataset.length, unit:''},
      {label:'Columns', value: columns.length, unit:''},
      {label:'Numeric fields', value: numericCols.length, unit:'', accent:'teal'},
    ];
    if(numericCols.length){
      const top = numericCols[0];
      cards.push({label: top.name + ' avg', value: fmt(top.stats.mean), unit:''});
      cards.push({label: top.name + ' range', value: fmt(top.stats.min)+'–'+fmt(top.stats.max), unit:''});
    }
    const totalMissing = columns.reduce((a,c)=>a+c.stats.missing,0);
    cards.push({label:'Missing values', value: totalMissing, unit:'', accent: totalMissing? '' : 'teal'});

    readeouts.innerHTML = cards.map(c => `
      <div class="readeout">
        <div class="label">${c.label}</div>
        <div class="value ${c.accent==='teal'?'teal':''}">${c.value}<span class="unit">${c.unit}</span></div>
      </div>
    `).join('');
  }

  function renderColCards(){
    $('colsGrid').innerHTML = columns.map(c => {
      let lines = '';
      if(c.type === 'number'){
        lines = `
          <div class="stat-line"><span>Mean</span><span>${fmt(c.stats.mean)}</span></div>
          <div class="stat-line"><span>Median</span><span>${fmt(c.stats.median)}</span></div>
          <div class="stat-line"><span>Std dev</span><span>${fmt(c.stats.std)}</span></div>
          <div class="stat-line"><span>Min / Max</span><span>${fmt(c.stats.min)} / ${fmt(c.stats.max)}</span></div>
        `;
      } else {
        lines = `<div class="stat-line"><span>Unique</span><span>${c.stats.unique}</span></div>`;
      }
      lines += `<div class="stat-line"><span>Missing</span><span>${c.stats.missing}</span></div>`;
      return `<div class="col-card">
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="type">${c.type}</div>
        ${lines}
      </div>`;
    }).join('');
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // ---------- table ----------
  // Applies the current click-to-filter (if any) — set by clicking a bar, pie
  // slice, or stacked/histogram segment on the chart above — to a row set.
  function applyTableFilter(rows){
    if(!tableFilter) return rows;
    return rows.filter(r => tableFilter.test(r));
  }

  function setTableFilter(col, value, label){
    tableFilter = {
      col, value, label,
      test: r => String(r[col] ?? '—') === value
    };
    renderTable();
  }

  // Range filter used for histogram bins: matches numeric rows falling within [lo, hi]
  // (or [lo, hi) when inclusiveHi is false — used for every bin except the last, so
  // values don't get double-counted across adjacent bins).
  function setTableRangeFilter(col, lo, hi, label, inclusiveHi){
    tableFilter = {
      col, lo, hi, label,
      test: r => { const v = parseFloat(r[col]); return !isNaN(v) && v >= lo && (inclusiveHi ? v <= hi : v < hi); }
    };
    renderTable();
  }

  function clearTableFilter(){
    tableFilter = null;
    renderTable();
  }

  function renderFilterChip(){
    const chip = $('tableFilterChip');
    if(!tableFilter){ chip.style.display = 'none'; chip.innerHTML = ''; return; }
    chip.style.display = 'inline-flex';
    chip.innerHTML = `Filtered: ${escapeHtml(tableFilter.label)} <button type="button" class="fc-clear" title="Clear filter">✕</button>`;
    chip.querySelector('.fc-clear').addEventListener('click', clearTableFilter);
  }

  function renderTable(){
    const names = columns.map(c => c.name);
    $('tableHead').innerHTML = names.map(n =>
      `<th data-col="${escapeHtml(n)}">${escapeHtml(n)}${sortState.col===n ? `<span class="arrow">${sortState.dir>0?'↑':'↓'}</span>` : ''}</th>`
    ).join('');

    let rows = applyTableFilter(dataset);
    if(sortState.col){
      const colType = columns.find(c=>c.name===sortState.col)?.type;
      rows.sort((a,b) => {
        let av = a[sortState.col], bv = b[sortState.col];
        if(colType === 'number'){ av = parseFloat(av)||0; bv = parseFloat(bv)||0; return (av-bv)*sortState.dir; }
        return String(av).localeCompare(String(bv)) * sortState.dir;
      });
    }
    const display = rows.slice(0, 200);
    $('tableBody').innerHTML = display.map(r =>
      '<tr>' + names.map(n => `<td>${escapeHtml(r[n] ?? '')}</td>`).join('') + '</tr>'
    ).join('');

    const countMsg = tableFilter
      ? `Showing ${display.length.toLocaleString()} of ${rows.length.toLocaleString()} filtered rows (${dataset.length.toLocaleString()} total)`
      : `Showing ${display.length.toLocaleString()} of ${dataset.length.toLocaleString()} rows`;
    $('rowCountTop').textContent = countMsg;
    $('rowCountBottom').textContent = countMsg;
    renderFilterChip();

    document.querySelectorAll('#tableHead th').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        sortState.dir = (sortState.col === col) ? sortState.dir * -1 : 1;
        sortState.col = col;
        renderTable();
      });
    });
  }


  // ---------- chart ----------
  let controlsBound = false;
  function setupChartControls(){
    $('chartType').addEventListener('change', () => { clearTableFilter(); updateAxisOptions(); renderChartWithTransition(); renderChipRow(); updateColorPanelMode(); renderColorSwatches(); update3DAvailability(); updateTrendAvailability(); updateZoomAvailability(); debouncedSaveSettings(); });
    $('xCol').addEventListener('change', () => { clearTableFilter(); renderChart(); renderColorSwatches(); debouncedSaveSettings(); });
    $('yCol').addEventListener('change', () => { clearTableFilter(); renderChart(); debouncedSaveSettings(); });
    $('binsCol').addEventListener('change', () => { renderChart(); debouncedSaveSettings(); });
    $('valueCol').addEventListener('change', () => { renderChart(); debouncedSaveSettings(); });

    updateAxisOptions(true);
    renderChipRow();

    // These controls persist across dataset reloads (their targets don't get recreated),
    // so only bind them once to avoid stacking duplicate handlers.
    if(!controlsBound){
      controlsBound = true;
      $('exportPngBtn').addEventListener('click', exportChartPng);
      $('exportPdfBtn').addEventListener('click', exportChartPdf);
      $('exportHtmlBtn').addEventListener('click', exportChartHtml);
      $('colorsBtn').addEventListener('click', () => {
        $('colorPanel').classList.toggle('open');
      });
      $('resetColorsBtn').addEventListener('click', () => {
        customPalette = DEFAULT_PALETTE.slice();
        heatColors = { low: DEFAULT_HEAT.low, high: DEFAULT_HEAT.high };
        labelColors = {};
        renderColorSwatches();
        renderChart();
      });
      // Color dragging and digit-by-digit typing can fire many events a second;
      // debouncing these avoids re-aggregating the whole dataset on every tick
      // (the chart itself already animates smoothly between the settled states).
      const debouncedRenderChart = debounce(renderChart, 60);
      $('heatLow').addEventListener('input', () => { heatColors.low = $('heatLow').value; debouncedRenderChart(); });
      $('heatHigh').addEventListener('input', () => { heatColors.high = $('heatHigh').value; debouncedRenderChart(); });
      $('goalInput').addEventListener('input', () => { debouncedRenderChart(); debouncedSaveSettings(); });
      document.querySelectorAll('.mini-chip').forEach(chip => {
        chip.addEventListener('click', () => { $('exportBg').value = chip.dataset.bg; });
      });
      $('toggle3D').addEventListener('click', () => {
        if($('toggle3D').disabled) return;
        is3D = !is3D;
        $('toggle3D').classList.toggle('active', is3D);
        renderChart();
        debouncedSaveSettings();
      });
      $('toggleTrend').addEventListener('click', () => {
        if($('toggleTrend').disabled) return;
        showTrend = !showTrend;
        $('toggleTrend').classList.toggle('active', showTrend);
        renderChart();
        debouncedSaveSettings();
      });
      $('resetZoomBtn').addEventListener('click', () => {
        if(chartInstance && typeof chartInstance.resetZoom === 'function') chartInstance.resetZoom();
      });
    }
    renderColorSwatches();
    updateColorPanelMode();
    update3DAvailability();
    updateTrendAvailability();
    updateZoomAvailability();
  }

  // 3D is only a meaningful visual for chart types with discrete flat shapes
  // (bars, pie/donut slices) — disable the toggle otherwise and turn it off
  // so switching to e.g. a line chart doesn't leave a stale, inert 3D state.
  function update3DAvailability(){
    const supported = ['bar','histogram','pie','doughnut','stacked','overlap','gauge'].includes($('chartType').value);
    const btn = $('toggle3D');
    btn.disabled = !supported;
    if(!supported){ is3D = false; btn.classList.remove('active'); }
  }

  // Trend overlay only makes sense on line/area charts (a moving average drawn
  // over the plotted series) — disable the toggle otherwise and clear stale state.
  function updateTrendAvailability(){
    const supported = ['line','area'].includes($('chartType').value);
    const btn = $('toggleTrend');
    btn.disabled = !supported;
    if(!supported){ showTrend = false; btn.classList.remove('active'); }
  }

  // Chart types with a meaningful continuous/dense axis benefit from zoom & pan
  // (bar/line/area/histogram/stacked group along a category or bin axis; scatter/
  // bubble spread points across two numeric axes). Others (pie, gauge, radar, the
  // matrix-based charts, pictogram) don't have an axis to zoom into.
  const ZOOM_TYPES = ['bar','line','area','histogram','stacked','overlap','scatter','bubble'];
  function updateZoomAvailability(){
    const supported = ZOOM_TYPES.includes($('chartType').value);
    $('resetZoomBtn').disabled = !supported;
  }

  // Builds the chartjs-plugin-zoom config for a given chart type: wheel-scroll and
  // pinch to zoom, click-and-drag (with Ctrl/Cmd, so it doesn't fight normal chart
  // clicks used for click-to-filter) to pan. Category axes (bar/stacked/histogram)
  // only zoom along X, since Y is just the aggregated value; scatter/bubble zoom
  // freely on both axes.
  function zoomOptionsFor(type){
    if(!ZOOM_TYPES.includes(type)) return undefined;
    const mode = (type === 'scatter' || type === 'bubble') ? 'xy' : 'x';
    return {
      pan: { enabled: true, mode, modifierKey: 'ctrl' },
      zoom: {
        wheel: { enabled: true }, pinch: { enabled: true },
        drag: { enabled: false }, mode
      }
    };
  }

  // Per-group mean/median/count, used both to plot the bar/line value (mean) and
  // to show the fuller picture in the tooltip on hover rather than just one number.
  function computeGroupStats(values){
    if(!values.length) return { mean:0, median:0, count:0 };
    const sorted = [...values].sort((a,b)=>a-b);
    const sum = values.reduce((a,b)=>a+b,0);
    const mean = sum / values.length;
    const median = sorted.length % 2
      ? sorted[(sorted.length-1)/2]
      : (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2;
    return { mean, median, count: values.length };
  }

  // Short contextual hint shown under the chart, since the click-to-filter and
  // zoom/pan interactions aren't otherwise discoverable from the UI alone.
  function updateChartHint(type){
    const hints = {
      bar: 'Click a bar to filter the table below · scroll to zoom, Ctrl/Cmd-drag to pan',
      stacked: 'Click a segment to filter the table below · scroll to zoom, Ctrl/Cmd-drag to pan',
      overlap: 'Click a bar to filter the table below · scroll to zoom, Ctrl/Cmd-drag to pan',
      pie: 'Click a slice to filter the table below',
      doughnut: 'Click a slice to filter the table below',
      histogram: 'Click a bar to filter the table below · scroll to zoom, Ctrl/Cmd-drag to pan',
      line: 'Scroll to zoom, Ctrl/Cmd-drag to pan',
      area: 'Scroll to zoom, Ctrl/Cmd-drag to pan',
      scatter: 'Scroll to zoom, Ctrl/Cmd-drag to pan',
      bubble: 'Scroll to zoom, Ctrl/Cmd-drag to pan'
    };
    $('chartHint').textContent = hints[type] || '';
  }

  // Returns the current category labels for chart types that color each category
  // individually (bar / pie / donut / pictogram), so the color panel can show one
  // named swatch per "info" instead of generic numbered slots. Returns null for
  // chart types that use a single series color or an index-cycled palette instead.
  function getPaletteLabels(){
    const type = $('chartType').value;
    const xCol = $('xCol').value;
    if(!dataset.length || !xCol) return null;
    if(type === 'bar' || type === 'radar' || type === 'boxplot'){
      const seen = new Set();
      dataset.forEach(r => seen.add(String(r[xCol] ?? '—')));
      return [...seen].slice(0, type === 'radar' ? 6 : 30);
    }
    if(type === 'pie' || type === 'doughnut' || type === 'pictogram'){
      const counts = {};
      dataset.forEach(r => { const k = String(r[xCol] ?? '—'); counts[k] = (counts[k]||0)+1; });
      return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(e=>e[0]);
    }
    if(type === 'stacked' || type === 'overlap'){
      const yCol = $('yCol').value;
      if(!yCol) return null;
      const counts = {};
      dataset.forEach(r => { const k = String(r[yCol] ?? '—'); counts[k] = (counts[k]||0)+1; });
      return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,12).map(e=>e[0]);
    }
    return null; // line, area, scatter, histogram, heatmap, bubble, gauge
  }

  // Builds the swatch inputs in the color panel. When the active chart colors
  // each category individually (bar/pie/donut/pictogram), shows one named swatch
  // per category plus an "All" swatch to paint every category at once. Otherwise
  // falls back to the original 8 indexed palette slots (used to cycle colors for
  // line/scatter/histogram, and as the base fallback palette everywhere).
  function renderColorSwatches(){
    const box = $('colorSwatches');
    const labels = getPaletteLabels();

    if(labels && labels.length){
      box.innerHTML = `
        <div class="swatch">
          <button type="button" class="color-chip" id="applyAllColor" data-color="${customPalette[0]}"></button>
          <span>All</span>
        </div>` + labels.map((label, i) => {
        const color = labelColors[label] || paletteColor(i);
        const short = label.length > 9 ? label.slice(0,8) + '…' : label;
        return `
        <div class="swatch">
          <button type="button" class="color-chip" data-label="${escapeHtml(label)}" data-color="${color}"></button>
          <span title="${escapeHtml(label)}">${escapeHtml(short)}</span>
        </div>`;
      }).join('');

      initColorChip($('applyAllColor'), (hex) => {
        labels.forEach(l => { labelColors[l] = hex; });
        box.querySelectorAll('.color-chip[data-label]').forEach(chip => {
          chip.dataset.color = hex; chip.style.background = hex;
        });
        renderChart();
      });
      box.querySelectorAll('.color-chip[data-label]').forEach(chip => {
        initColorChip(chip, (hex) => {
          labelColors[chip.dataset.label] = hex;
          renderChart();
        });
      });
    } else {
      // Line/area/scatter/histogram each render as ONE visual series, so a single
      // clearly-labeled swatch is all that actually does anything — no dead controls.
      const type = $('chartType').value;
      const singleLabel = type === 'histogram' ? 'Bars' : (type === 'scatter' || type === 'scattermatrix') ? 'Points' :
        type === 'bubble' ? 'Bubbles' : type === 'gauge' ? 'Gauge' : 'Line';
      const color = labelColors.__single__ || customPalette[0];
      box.innerHTML = `
        <div class="swatch">
          <button type="button" class="color-chip" id="singleColor" data-color="${color}"></button>
          <span>${singleLabel}</span>
        </div>`;
      initColorChip($('singleColor'), (hex) => {
        labelColors.__single__ = hex;
        renderChart();
      });
    }

    $('heatLow').value = heatColors.low;
    $('heatHigh').value = heatColors.high;
  }

  // Heatmap uses a two-color gradient instead of the categorical palette, so
  // swap which swatch controls are shown depending on the active chart type.
  function updateColorPanelMode(){
    const type = $('chartType').value;
    const isHeatmap = (type === 'heatmap' || type === 'corrheatmap');
    $('colorSwatches').style.display = isHeatmap ? 'none' : 'flex';
    $('heatColorRow').classList.toggle('show', isHeatmap);
  }

  // ---------- Export folder (File System Access API) ----------
  // Lets the person pick one dedicated folder; every PNG/PDF export afterward
  // writes straight into it instead of landing in the browser's default
  // Downloads folder. The chosen folder handle is remembered in IndexedDB so
  // it survives a page reload — the browser still requires a quick, silent
  // permission re-check each session. Falls back to a normal `<a download>`
  // (browser's default Downloads location) when the API isn't supported
  // (Firefox, Safari) or no folder has been chosen yet.
  let exportDirHandle = null;
  const supportsFSAccess = typeof window.showDirectoryPicker === 'function';

  function idbOpen(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('readeout-fs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function updateExportFolderLabel(){
    const label = exportDirHandle ? exportDirHandle.name : 'Downloads (default)';
    document.querySelectorAll('.exportFolderLabel').forEach(el => { el.textContent = label; });
  }

  // On load, silently reuse a previously-chosen folder if permission is
  // still granted — no prompt, no click required.
  async function restoreExportDir(){
    if(!supportsFSAccess) return;
    try{
      const handle = await idbGet('exportDir');
      if(!handle) return;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if(perm === 'granted'){ exportDirHandle = handle; updateExportFolderLabel(); }
    }catch(e){ /* stored handle no longer valid — ignore, stays on default */ }
  }

  async function chooseExportFolder(){
    if(!supportsFSAccess){
      showErr("This browser doesn't support choosing a folder — exports will save to your default Downloads location instead.");
      return;
    }
    try{
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      exportDirHandle = handle;
      await idbSet('exportDir', handle);
      updateExportFolderLabel();
    }catch(e){ /* person cancelled the folder picker */ }
  }

  // Writes a Blob straight into the chosen export folder. Falls back to a
  // standard anchor-tag download (browser's default Downloads location) if no
  // folder is set, permission was denied, or the API call fails for any reason.
  async function saveExportBlob(blob, filename){
    if(exportDirHandle){
      try{
        let perm = await exportDirHandle.queryPermission({ mode: 'readwrite' });
        if(perm !== 'granted') perm = await exportDirHandle.requestPermission({ mode: 'readwrite' });
        if(perm === 'granted'){
          const fileHandle = await exportDirHandle.getFileHandle(filename, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        }
      }catch(e){ /* fall through to standard download below */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function dataUrlToBlob(dataUrl){
    const [meta, b64] = dataUrl.split(',');
    const mime = meta.match(/:(.*?);/)[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  $('chooseExportFolderBtn').addEventListener('click', chooseExportFolder);
  $('chooseExportFolderBtnDash').addEventListener('click', chooseExportFolder);
  restoreExportDir();

  // ---------- PNG export ----------
  // Canvas-based charts (bar/line/pie/etc + heatmap) export directly via Chart.js's
  // toBase64Image(). The pictogram is plain DOM (icons + labels), so it's rasterized
  // with html2canvas instead. Either way the result saves as a single PNG file.
  // True if a hex color is light enough that dark text/gridlines should be used on it.
  function isLightColor(hex){
    const {r,g,b} = hexToRgb(hex);
    return (0.299*r + 0.587*g + 0.114*b) > 165;
  }

  // Rasterizes the current chart onto the given background color and returns a
  // Promise resolving to a flattened <canvas>. Shared by PNG and PDF export so
  // both formats always show exactly what's on screen. Canvas-based charts
  // (bar/line/pie/etc + heatmap) are captured directly via Chart.js's own canvas;
  // the pictogram is plain DOM (icons + labels), so it's rasterized with
  // html2canvas instead.
  function captureChartCanvas(bg){
    const type = $('chartType').value;
    const light = isLightColor(bg);

    if(type === 'pictogram'){
      if(typeof html2canvas !== 'function') return Promise.reject(new Error('Export library failed to load.'));
      const target = $('pictogramBox');
      if(!target || !target.children.length) return Promise.reject(new Error('Nothing to export yet.'));
      const textColor = light ? '#14151C' : '#E9E7E2';
      const dimColor = light ? '#5B6169' : '#8B909B';
      return html2canvas(target, {
        backgroundColor: bg, scale: DOM_EXPORT_SCALE,
        onclone: doc => {
          doc.querySelectorAll('.picto-label .name').forEach(el => { el.style.color = textColor; });
          doc.querySelectorAll('.picto-count, .picto-legend').forEach(el => { el.style.color = dimColor; });
        }
      });
    }

    if(type === 'scattermatrix'){
      if(typeof html2canvas !== 'function') return Promise.reject(new Error('Export library failed to load.'));
      const target = $('scatterMatrixBox');
      if(!target || !target.children.length) return Promise.reject(new Error('Nothing to export yet.'));
      const textColor = light ? '#14151C' : '#E9E7E2';
      return html2canvas(target, {
        backgroundColor: bg, scale: DOM_EXPORT_SCALE,
        onclone: doc => {
          doc.querySelectorAll('.sm-diag').forEach(el => { el.style.color = textColor; });
        }
      });
    }

    if(!chartInstance) return Promise.reject(new Error('Nothing to export yet.'));

    // Chart.js is themed for a dark canvas by default (gray text/gridlines). On a
    // light export background those would be nearly invisible, so temporarily
    // recolor them, capture, then rebuild the chart to restore the normal on-screen
    // dark theme — simpler and less error-prone than manually reverting each option.
    if(light){
      const o = chartInstance.options;
      if(o.plugins && o.plugins.legend && o.plugins.legend.labels) o.plugins.legend.labels.color = '#14151C';
      if(o.scales && o.scales.x && o.scales.x.ticks) o.scales.x.ticks.color = '#3A3F47';
      if(o.scales && o.scales.y && o.scales.y.ticks) o.scales.y.ticks.color = '#3A3F47';
      if(o.scales && o.scales.x && o.scales.x.grid) o.scales.x.grid.color = '#D8DCE3';
      if(o.scales && o.scales.y && o.scales.y.grid) o.scales.y.grid.color = '#D8DCE3';
      if(o.plugins && o.plugins.gaugeLabel){ o.plugins.gaugeLabel.text = '#14151C'; o.plugins.gaugeLabel.dim = '#5B6169'; }
      chartInstance.update('none');
    }

    // Temporarily render the chart's own canvas at a higher devicePixelRatio so
    // the exported file is sharp (retina-grade) regardless of the screen it's
    // being viewed on. Chart.js re-lays-out the backing store at the new pixel
    // density on resize(); the on-screen CSS size is unaffected.
    const prevDpr = chartInstance.options.devicePixelRatio;
    chartInstance.options.devicePixelRatio = CHART_EXPORT_SCALE;
    chartInstance.resize();

    // Chart.js renders on a transparent canvas by default; flatten onto the chosen
    // background first so the exported image isn't see-through/black in viewers.
    const src = chartInstance.canvas;
    const flat = document.createElement('canvas');
    flat.width = src.width; flat.height = src.height;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = bg;
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(src, 0, 0);

    // Restore normal on-screen resolution and (if applicable) theme colors.
    chartInstance.options.devicePixelRatio = prevDpr;
    chartInstance.resize();
    if(light) renderChart(); // restore the normal dark on-screen styling

    return Promise.resolve(flat);
  }

  // Draws the currently-selected insight caption(s) as a bulleted list beneath
  // the chart image, returning a new flattened canvas. Word-wraps each insight
  // to the chart's width. If nothing's selected, the original canvas passes through.
  function composeCaptionCanvas(chartCanvas, bg, captionTexts){
    const items = (captionTexts || []).filter(Boolean);
    if(!items.length) return chartCanvas;
    const light = isLightColor(bg);
    const textColor = light ? '#14151C' : '#E9E7E2';
    const dividerColor = light ? '#D8DCE3' : '#262B33';
    const accent = '#5FD4C0';
    const w = chartCanvas.width;
    const scale = w / 900; // scales font/padding relative to a 900px baseline width
    const fontSize = Math.max(17, Math.round(22 * scale));
    const padX = Math.round(26 * scale);
    const padY = Math.round(16 * scale);
    const iconGap = Math.round(22 * scale);
    const lineHeight = Math.round(fontSize * 1.4);
    const itemGap = Math.round(fontSize * 0.55);

    const measure = document.createElement('canvas').getContext('2d');
    const font = `500 ${fontSize}px Arial, sans-serif`;
    measure.font = font;
    const maxTextWidth = w - padX*2 - iconGap;

    const wrapped = items.map(text => {
      const words = text.split(' ');
      const lines = [];
      let cur = '';
      words.forEach(word => {
        const test = cur ? cur + ' ' + word : word;
        if(measure.measureText(test).width > maxTextWidth && cur){ lines.push(cur); cur = word; }
        else cur = test;
      });
      if(cur) lines.push(cur);
      return lines;
    });

    const totalLines = wrapped.reduce((a,l) => a + l.length, 0);
    const barHeight = padY*2 + totalLines*lineHeight + (wrapped.length - 1)*itemGap;

    const out = document.createElement('canvas');
    out.width = w; out.height = chartCanvas.height + barHeight;
    const octx = out.getContext('2d');
    octx.fillStyle = bg;
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(chartCanvas, 0, 0);

    octx.strokeStyle = dividerColor;
    octx.lineWidth = Math.max(1, Math.round(scale));
    octx.beginPath();
    octx.moveTo(0, chartCanvas.height + 0.5);
    octx.lineTo(w, chartCanvas.height + 0.5);
    octx.stroke();

    octx.textBaseline = 'alphabetic';
    let y = chartCanvas.height + padY + fontSize*0.85;
    wrapped.forEach(lines => {
      octx.fillStyle = accent;
      octx.font = `700 ${Math.round(fontSize*0.95)}px Arial, sans-serif`;
      octx.fillText('◆', padX, y);
      octx.fillStyle = textColor;
      octx.font = font;
      lines.forEach((line, i) => { octx.fillText(line, padX + iconGap, y + i*lineHeight); });
      y += lines.length*lineHeight + itemGap;
    });

    return out;
  }

  function exportChartPng(){
    const type = $('chartType').value;
    const btn = $('exportPngBtn');
    const bg = ($('exportBg') && $('exportBg').value) || '#171B22';
    const prevLabel = btn.innerHTML;

    const filename = () => {
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return `readeout-${type}-${stamp}.png`;
    };
    // Visible confirmation that the file actually saved, instead of leaving the
    // person to go check their downloads folder to find out.
    const showSuccess = () => {
      btn.innerHTML = '<span class="btn-ic">✓</span> Exported';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = prevLabel; }, 1700);
    };

    btn.disabled = true; btn.innerHTML = '<span class="btn-ic">…</span> Exporting';
    captureChartCanvas(bg).then(canvas => {
      const composed = composeCaptionCanvas(canvas, bg, currentInsightCaptionTexts());
      return saveExportBlob(dataUrlToBlob(composed.toDataURL('image/png')), filename());
    }).then(showSuccess).catch(err => {
      showErr((err && err.message) || 'Could not export this chart as PNG.');
      btn.disabled = false; btn.innerHTML = prevLabel;
    });
  }

  // ---------- PDF export ----------
  // Wraps the same rasterized chart image used for PNG export into a single-page
  // PDF sized to the chart's own aspect ratio, with a small header (chart type +
  // axis fields + timestamp). Deliberately just the visualization — no data table
  // or stats page — since this tool's export is meant for sharing a chart, not
  // the underlying data.
  function exportChartPdf(){
    const type = $('chartType').value;
    const btn = $('exportPdfBtn');
    const bg = ($('exportBg') && $('exportBg').value) || '#171B22';
    const prevLabel = btn.innerHTML;

    const jsPDFLib = window.jspdf && window.jspdf.jsPDF;
    if(!jsPDFLib){ showErr('PDF export library failed to load.'); return; }

    const filename = () => {
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return `readeout-${type}-${stamp}.pdf`;
    };
    const showSuccess = () => {
      btn.innerHTML = '<span class="btn-ic">✓</span> Exported';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = prevLabel; }, 1700);
    };

    btn.disabled = true; btn.innerHTML = '<span class="btn-ic">…</span> Exporting';

    captureChartCanvas(bg).then(canvas => {
      const light = isLightColor(bg);
      const margin = 28, headerH = 54;
      const imgRatio = canvas.width / canvas.height;

      // Page sized to the chart's own aspect ratio (wide charts get a landscape
      // page, tall/square ones portrait) instead of forcing a fixed Letter/A4
      // shape and leaving awkward blank margins around the image.
      const pageW = imgRatio >= 1 ? 700 : 500;
      const imgW = pageW - margin*2;
      const imgH = imgW / imgRatio;

      // The insight caption(s) are added as real vector text (not baked into
      // the image), so they stay crisp and selectable. Only insights still
      // ticked "Export" are included. Word-wrap first so we know how much
      // extra page height to reserve.
      const captionItems = currentInsightCaptionTexts();
      const capFontSize = 10.5, capLineHeight = 15, capPadTop = 16, capPadBottom = 20, capItemGap = 8;
      const measureDoc = new jsPDFLib({ unit: 'pt', format: [pageW, 1000] });
      measureDoc.setFont('helvetica', 'normal');
      measureDoc.setFontSize(capFontSize);
      const wrappedCaptions = captionItems.map(t => measureDoc.splitTextToSize(t, imgW - 18));
      const totalCapLines = wrappedCaptions.reduce((a,l) => a + l.length, 0);
      const captionBlockH = wrappedCaptions.length
        ? (capPadTop + totalCapLines*capLineHeight + (wrappedCaptions.length - 1)*capItemGap + capPadBottom)
        : 0;

      const pageH = Math.round(headerH + imgH + captionBlockH + margin*2);

      const doc = new jsPDFLib({
        orientation: pageW >= pageH ? 'landscape' : 'portrait',
        unit: 'pt',
        format: [pageW, pageH]
      });

      const bgRgb = hexToRgb(bg);
      doc.setFillColor(bgRgb.r, bgRgb.g, bgRgb.b);
      doc.rect(0, 0, pageW, pageH, 'F');

      const textRgb = hexToRgb(light ? '#14151C' : '#E9E7E2');
      const dimRgb = hexToRgb(light ? '#5B6169' : '#8B909B');

      doc.setFont('courier', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(textRgb.r, textRgb.g, textRgb.b);
      doc.text('READEOUT', margin, margin + 10);

      const usesAutoNumeric = (type === 'corrheatmap' || type === 'scattermatrix');
      const xCol = usesAutoNumeric ? '' : $('xCol').value;
      const yCol = usesAutoNumeric ? '' : $('yCol').value;
      const subtitle = [type, xCol, yCol].filter(Boolean).join('  ·  ');
      doc.setFont('courier', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(dimRgb.r, dimRgb.g, dimRgb.b);
      doc.text(subtitle, margin, margin + 25);
      doc.text(new Date().toLocaleString(), pageW - margin, margin + 10, { align: 'right' });

      doc.addImage(canvas.toDataURL('image/png'), 'PNG', margin, headerH, imgW, imgH);

      if(wrappedCaptions.length){
        const capY0 = headerH + imgH;
        const dividerRgb = hexToRgb(light ? '#D8DCE3' : '#262B33');
        doc.setDrawColor(dividerRgb.r, dividerRgb.g, dividerRgb.b);
        doc.setLineWidth(0.75);
        doc.line(margin, capY0, pageW - margin, capY0);

        const accentRgb = hexToRgb('#5FD4C0');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(capFontSize);
        doc.setTextColor(textRgb.r, textRgb.g, textRgb.b);

        let y = capY0 + capPadTop + 8;
        wrappedCaptions.forEach(lines => {
          doc.setFillColor(accentRgb.r, accentRgb.g, accentRgb.b);
          doc.circle(margin + 4, y - 3, 3, 'F');
          doc.setTextColor(textRgb.r, textRgb.g, textRgb.b);
          lines.forEach((line, i) => { doc.text(line, margin + 16, y + i*capLineHeight); });
          y += lines.length*capLineHeight + capItemGap;
        });
      }

      return saveExportBlob(doc.output('blob'), filename());
    }).then(showSuccess).catch(err => {
      showErr((err && err.message) || 'Could not export this chart as PDF.');
      btn.disabled = false; btn.innerHTML = prevLabel;
    });
  }

  // ---------- HTML export ----------
  // A small, human-readable name for each chart type — used to title HTML
  // exports (and reusable anywhere else a plain label is needed).
  const CHART_TYPE_LABELS = {
    bar:'Bar', line:'Line', area:'Area', scatter:'Scatter', histogram:'Histogram',
    pie:'Pie', doughnut:'Donut', heatmap:'Heatmap', pictogram:'Pictogram', radar:'Radar',
    bubble:'Bubble', boxplot:'Box plot', gauge:'Gauge', stacked:'Stacked bar', overlap:'Overlapping bar',
    corrheatmap:'Correlation heatmap', scattermatrix:'Scatter matrix'
  };
  function escapeHtmlText(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Builds a fully self-contained HTML document — the chart image embedded as a
  // base64 data URL (no external files/fonts/scripts needed) plus the insight
  // captions as real, selectable text. Opens in any browser, shareable as a
  // single file, and needs Readeout itself only to have produced it.
  // ---------- Live (interactive + animated) HTML export ----------
  // Instead of flattening a chart to a PNG and wrapping it in a page, this pulls
  // the *live* Chart.js config off an already-rendered instance — resolving any
  // per-point scriptable styling (used by the heatmap/correlation matrix) against
  // what actually got drawn — strips out anything that can't survive JSON (click
  // handlers, tooltip callback functions), and re-hydrates it in the exported
  // file with Chart.js loaded fresh from a CDN. The result is a real chart:
  // hover tooltips, legend toggling, scroll-zoom/ctrl-drag-pan where the app
  // enables it, and the same entrance animation the on-screen chart used.
  function chartConfigForExport(inst){
    const cfg = inst.config;
    const type = (cfg.type && cfg.type.toString) ? cfg.type : cfg.type;
    const datasets = (cfg.data.datasets || []).map((ds, dsi) => {
      const meta = inst.getDatasetMeta(dsi);
      const clone = {};
      Object.keys(ds).forEach(k => {
        if(typeof ds[k] === 'function'){
          // Per-element scriptable color (the heatmap/corr-matrix cells) — read the
          // already-resolved value straight off each rendered element instead of
          // trying to serialize the function itself.
          if((k === 'backgroundColor' || k === 'borderColor') && meta && meta.data && meta.data.length){
            clone[k] = meta.data.map(el => (el && el.options && el.options[k]) || undefined);
          }
          // width/height (matrix cell sizing) are intentionally dropped here — the
          // export page re-adds an equivalent generic sizing function of its own.
        } else {
          clone[k] = ds[k];
        }
      });
      return clone;
    });
    const data = JSON.parse(JSON.stringify({ labels: cfg.data.labels, datasets }));
    const options = JSON.parse(JSON.stringify(cfg.options || {}, (k, v) => typeof v === 'function' ? undefined : v));
    return { type, data, options };
  }

  // Shared helper/plugin source, copied verbatim into every live export so the
  // page has no dependency on this app's own script — pseudo3d + valueLabels are
  // registered globally exactly like the main app does, and stay inert (their
  // own `enabled` guard) on any chart that didn't ask for them. gaugeLabel is a
  // generic rebuild of the app's gauge center-label plugin, driven purely by the
  // label1/label2/text/dim fields already baked into that chart's own options.
  const LIVE_EXPORT_HELPERS_JS = `
    function fmt(n){
      if(typeof n !== 'number' || isNaN(n)) return '—';
      if(Math.abs(n) >= 1000) return n.toLocaleString(undefined,{maximumFractionDigits:1});
      return Number.isInteger(n) ? n.toString() : n.toFixed(2);
    }
    function hexToRgb(hex){
      if(typeof hex !== 'string') return {r:139,g:144,b:155};
      const h = hex.replace('#','');
      const n = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
      const num = parseInt(n, 16);
      return { r:(num>>16)&255, g:(num>>8)&255, b:num&255 };
    }
    function shadeColor(hex, amt){
      if(typeof hex !== 'string' || hex[0] !== '#') return hex;
      const {r,g,b} = hexToRgb(hex);
      const clamp = v => Math.max(0, Math.min(255, v));
      return \`rgb(\${clamp(r+amt)},\${clamp(g+amt)},\${clamp(b+amt)})\`;
    }
    const pseudo3dPlugin = {
      id: 'pseudo3d',
      beforeDatasetsDraw(chart, args, opts){
        if(!opts || !opts.enabled) return;
        const type = chart.config.type;
        if(type !== 'pie' && type !== 'doughnut') return;
        const ctx = chart.ctx, depth = opts.depth || 18;
        const meta = chart.getDatasetMeta(0);
        if(!meta || !meta.data) return;
        meta.data.forEach(arc => {
          const { x, y, startAngle, endAngle, outerRadius } = arc;
          const color = (arc.options && arc.options.backgroundColor) || '#8B909B';
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y + depth, outerRadius, startAngle, endAngle, false);
          ctx.arc(x, y, outerRadius, endAngle, startAngle, true);
          ctx.closePath();
          ctx.fillStyle = shadeColor(color, -55);
          ctx.fill();
          ctx.restore();
        });
      },
      afterDatasetsDraw(chart, args, opts){
        if(!opts || !opts.enabled) return;
        if(chart.config.type !== 'bar') return;
        const ctx = chart.ctx, depth = opts.depth || 10;
        chart.data.datasets.forEach((_, dsIndex) => {
          const meta = chart.getDatasetMeta(dsIndex);
          if(!meta || !meta.data) return;
          meta.data.forEach(bar => {
            const { x, width } = bar;
            const top = bar.y, bottom = bar.base;
            const left = x - width/2, right = x + width/2;
            if(bottom <= top) return;
            const color = (bar.options && bar.options.backgroundColor) || '#8B909B';
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(right, top); ctx.lineTo(right+depth, top-depth);
            ctx.lineTo(right+depth, bottom-depth); ctx.lineTo(right, bottom);
            ctx.closePath(); ctx.fillStyle = shadeColor(color, -45); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(left, top); ctx.lineTo(right, top);
            ctx.lineTo(right+depth, top-depth); ctx.lineTo(left+depth, top-depth);
            ctx.closePath(); ctx.fillStyle = shadeColor(color, 30); ctx.fill();
            ctx.restore();
          });
        });
      }
    };
    const valueLabelsPlugin = {
      id: 'valueLabels',
      afterDatasetsDraw(chart, args, opts){
        if(!opts || !opts.enabled) return;
        const type = chart.config.type, ctx = chart.ctx;
        ctx.save();
        if(type === 'pie' || type === 'doughnut'){
          const meta = chart.getDatasetMeta(0);
          const data = (chart.data.datasets[0]||{}).data || [];
          if(!meta || !meta.data){ ctx.restore(); return; }
          const total = data.reduce((a,b)=>a+(typeof b==='number'?b:0),0);
          ctx.font = "700 10px 'IBM Plex Mono', monospace";
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          meta.data.forEach((arc,i) => {
            const val = data[i];
            if(val == null || arc.circumference === 0) return;
            const angle = (arc.startAngle+arc.endAngle)/2;
            const radius = (arc.innerRadius+arc.outerRadius)/2;
            const x = arc.x + Math.cos(angle)*radius, y = arc.y + Math.sin(angle)*radius;
            const pct = total ? Math.round((val/total)*100) : 0;
            const label = opts.showPercent ? \`\${fmt(val)} (\${pct}%)\` : fmt(val);
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,12,16,0.7)';
            ctx.strokeText(label, x, y);
            ctx.fillStyle = '#F4F1EA';
            ctx.fillText(label, x, y);
          });
        } else if(type === 'bar'){
          ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
          ctx.fillStyle = '#C7CBD1'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          chart.data.datasets.forEach((ds,dsIndex) => {
            const meta = chart.getDatasetMeta(dsIndex);
            if(!meta || meta.hidden) return;
            meta.data.forEach((bar,i) => {
              const val = ds.data[i];
              if(val == null || bar.y == null) return;
              ctx.fillText(fmt(val), bar.x, Math.min(bar.y, bar.base)-4);
            });
          });
        } else if(type === 'line'){
          ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
          ctx.fillStyle = '#C7CBD1'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          chart.data.datasets.forEach((ds,dsIndex) => {
            const meta = chart.getDatasetMeta(dsIndex);
            if(!meta || meta.hidden) return;
            meta.data.forEach((pt,i) => {
              const val = ds.data[i];
              if(val == null || pt.y == null) return;
              ctx.fillText(fmt(val), pt.x, pt.y-6);
            });
          });
        }
        ctx.restore();
      }
    };
    const gaugeLabelPlugin = {
      id: 'gaugeLabel',
      afterDraw(chart){
        const g = chart.options.plugins && chart.options.plugins.gaugeLabel;
        if(!g) return;
        const meta = chart.getDatasetMeta(0);
        if(!meta.data.length) return;
        const { x: cx, y: cy } = meta.data[0];
        const c = chart.ctx;
        c.save();
        c.textAlign = 'center';
        c.fillStyle = g.text || '#E9E7E2';
        c.font = "700 26px 'IBM Plex Mono', monospace";
        c.fillText(g.label1 || '', cx, cy+14);
        c.fillStyle = g.dim || '#8B909B';
        c.font = "12px 'IBM Plex Mono', monospace";
        c.fillText(g.label2 || '', cx, cy+34);
        c.restore();
      }
    };
    Chart.register(pseudo3dPlugin, valueLabelsPlugin, gaugeLabelPlugin);
    if(window.ChartBoxPlot){ Chart.register(window.ChartBoxPlot.BoxPlotController, window.ChartBoxPlot.BoxAndWiskers); }
    // Generic replacement for the matrix (heatmap/correlation heatmap) cell
    // sizing functions, which can't survive JSON — derived the same way the app
    // computes them, just reading the category count off the scale labels
    // instead of a closed-over array.
    function matrixCellSize(chart, axis){
      const scale = chart.options.scales && chart.options.scales[axis];
      const n = (scale && scale.labels || []).length || 1;
      const area = chart.chartArea;
      if(!area) return 10;
      return (axis === 'x' ? area.width : area.height) / n - 2;
    }
    function hydrateChart(spec, canvas){
      const config = JSON.parse(JSON.stringify(spec));
      if(config.type === 'matrix'){
        config.data.datasets.forEach(ds => {
          ds.width = ({chart}) => matrixCellSize(chart, 'x');
          ds.height = ({chart}) => matrixCellSize(chart, 'y');
        });
        config.options.plugins = config.options.plugins || {};
        config.options.plugins.tooltip = config.options.plugins.tooltip || {};
        config.options.plugins.tooltip.callbacks = { label: c =>
          \`\${c.raw.x} / \${c.raw.y}: \${typeof c.raw.v === 'number' ? fmt(c.raw.v) : (c.raw.v==null?'n/a':c.raw.v)}\`
        };
      } else if(config.type !== 'boxplot'){
        config.options.plugins = config.options.plugins || {};
        if(!config.options.plugins.tooltip) config.options.plugins.tooltip = {};
        if(!config.options.plugins.tooltip.callbacks){
          config.options.plugins.tooltip.callbacks = { label: c => {
            const v = (c.parsed && typeof c.parsed.y === 'number') ? c.parsed.y
              : (typeof c.parsed === 'number' ? c.parsed : c.raw);
            const label = c.dataset && c.dataset.label;
            const shown = typeof v === 'number' ? fmt(v) : v;
            return label ? \`\${label}: \${shown}\` : \`\${shown}\`;
          } };
        }
      }
      return new Chart(canvas.getContext('2d'), config);
    }
  `;

  // Builds the full standalone page for one or more live charts. panels is an
  // array of { title, spec: {type,data,options}, insights }.
  function buildLiveExportHtml({ pageTitle, bg, panels }){
    const light = isLightColor(bg);
    const textColor = light ? '#14151C' : '#E9E7E2';
    const dimColor = light ? '#5B6169' : '#8B909B';
    const borderColor = light ? '#D8DCE3' : '#262B33';
    const panelBg = light ? '#F1F3F6' : '#171B22';
    const accent = '#5FD4C0';
    const multi = panels.length > 1;

    const cards = panels.map((p, i) => {
      const items = (p.insights || []).filter(Boolean)
        .map(t => `<li><span class="dot">◆</span><span>${escapeHtmlText(t)}</span></li>`).join('');
      const needsZoomHint = p.spec.options && p.spec.options.plugins && p.spec.options.plugins.zoom;
      return `
      <div class="card" style="animation-delay:${i * 90}ms">
        <h2>${escapeHtmlText(p.title)}</h2>
        <div class="chart-frame"><canvas id="c${i}"></canvas></div>
        ${needsZoomHint ? '<div class="zoomhint">Scroll to zoom &middot; Ctrl+drag to pan &middot; double-click to reset</div>' : ''}
        ${items ? `<div class="insights"><h3>Insights</h3><ul>${items}</ul></div>` : ''}
      </div>`;
    }).join('');

    const specsJson = JSON.stringify(panels.map(p => p.spec));

    // Only pull in the plugin bundles a given export actually uses — most
    // exports are plain bar/line/pie charts and have no business paying for
    // the matrix/boxplot/zoom/hammer bundles. `defer` lets all of them fetch
    // in parallel without blocking parsing, same as the main app does.
    const types = panels.map(p => p.spec.type);
    const needsMatrix = types.includes('matrix');
    const needsBoxplot = types.includes('boxplot');
    const needsZoom = panels.some(p => p.spec.options && p.spec.options.plugins && p.spec.options.plugins.zoom);
    const scriptTags = [
      '<script defer src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"><\/script>',
      needsMatrix && '<script defer src="https://cdn.jsdelivr.net/npm/chartjs-chart-matrix@2.0.1/dist/chartjs-chart-matrix.min.js"><\/script>',
      needsBoxplot && '<script defer src="https://cdn.jsdelivr.net/npm/@sgratzl/chartjs-chart-boxplot@4.4.4/build/index.umd.min.js"><\/script>',
      needsZoom && '<script defer src="https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"><\/script>',
      needsZoom && '<script defer src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"><\/script>'
    ].filter(Boolean).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtmlText(pageTitle)} — Readeout export</title>
${scriptTags}
<style>
  :root{ color-scheme: ${light ? 'light' : 'dark'}; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:${bg}; color:${textColor}; font-family:-apple-system,'Segoe UI',Arial,sans-serif; padding:36px 20px 60px; }
  .wrap{ max-width:${multi ? '1180px' : '900px'}; margin:0 auto; }
  header{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:22px; }
  h1{ font-size:19px; margin:0; font-weight:800; display:flex; align-items:center; gap:8px; }
  .dot-live{ width:8px; height:8px; border-radius:50%; background:${accent}; box-shadow:0 0 8px ${accent}; animation:pulse 1.8s ease-in-out infinite; flex-shrink:0; }
  .meta{ font-family:'Courier New',monospace; font-size:11px; color:${dimColor}; letter-spacing:0.02em; }
  .grid{ display:grid; grid-template-columns:${multi ? 'repeat(auto-fit, minmax(420px, 1fr))' : '1fr'}; gap:20px; }
  .card{ border:1px solid ${borderColor}; border-radius:6px; background:${panelBg}; padding:18px 18px 16px; opacity:0; animation:rise .5s ease forwards; }
  .card h2{ font-size:14px; margin:0 0 12px; font-weight:700; }
  .chart-frame{ position:relative; height:${multi ? '300px' : '420px'}; }
  .zoomhint{ margin-top:8px; font-size:10.5px; color:${dimColor}; font-family:'Courier New',monospace; }
  .insights{ margin-top:16px; padding-top:14px; border-top:1px solid ${borderColor}; }
  .insights h3{ font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:${dimColor}; margin:0 0 8px; font-weight:700; }
  .insights ul{ list-style:none; margin:0; padding:0; }
  .insights li{ font-size:13px; line-height:1.55; margin-bottom:6px; display:flex; gap:8px; }
  .insights .dot{ color:${accent}; flex-shrink:0; }
  footer{ margin-top:26px; font-size:11px; color:${dimColor}; font-family:'Courier New',monospace; }
  @keyframes rise{ from{ opacity:0; transform:translateY(10px); } to{ opacity:1; transform:translateY(0); } }
  @keyframes pulse{ 0%,100%{ opacity:1; } 50%{ opacity:0.35; } }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1><span class="dot-live"></span>${escapeHtmlText(pageTitle)}</h1>
      <div class="meta">READEOUT &middot; LIVE EXPORT &middot; ${escapeHtmlText(new Date().toLocaleString())}</div>
    </header>
    <div class="grid">${cards}</div>
    <footer>Generated with Readeout — this page is a fully live, self-contained chart (hover, legend toggle, zoom/pan where enabled). No data was uploaded anywhere; everything renders locally in your browser.</footer>
  </div>
<script>
${LIVE_EXPORT_HELPERS_JS}
  const specs = ${specsJson};
  window.addEventListener('DOMContentLoaded', () => {
    specs.forEach((spec, i) => {
      const canvas = document.getElementById('c'+i);
      if(canvas) hydrateChart(spec, canvas);
    });
  });
<\/script>
</body>
</html>`;
  }

  function buildStandaloneChartHtml({ title, bg, imageDataUrl, insights }){
    const light = isLightColor(bg);
    const textColor = light ? '#14151C' : '#E9E7E2';
    const dimColor = light ? '#5B6169' : '#8B909B';
    const borderColor = light ? '#D8DCE3' : '#262B33';
    const accent = '#5FD4C0';
    const items = (insights || []).filter(Boolean)
      .map(t => `<li><span class="dot">◆</span><span>${escapeHtmlText(t)}</span></li>`).join('');
    const safeTitle = escapeHtmlText(title);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle} — Readeout export</title>
<style>
  :root{ color-scheme: ${light ? 'light' : 'dark'}; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:${bg}; color:${textColor}; font-family:-apple-system,'Segoe UI',Arial,sans-serif; padding:36px 20px; }
  .wrap{ max-width:900px; margin:0 auto; }
  h1{ font-size:19px; margin:0 0 4px; font-weight:800; }
  .meta{ font-family:'IBM Plex Mono','Courier New',monospace; font-size:11px; color:${dimColor}; letter-spacing:0.02em; margin-bottom:20px; }
  .chart-frame{ border:1px solid ${borderColor}; border-radius:6px; overflow:hidden; background:${bg}; opacity:0; transform:scale(0.98); animation:rise .55s ease forwards; }
  .chart-frame img{ display:block; width:100%; height:auto; }
  .insights{ margin-top:18px; padding-top:16px; border-top:1px solid ${borderColor}; opacity:0; animation:fadeIn .5s ease .25s forwards; }
  .insights h2{ font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:${dimColor}; margin:0 0 10px; font-weight:700; }
  .insights ul{ list-style:none; margin:0; padding:0; }
  .insights li{ font-size:13.5px; line-height:1.6; margin-bottom:8px; display:flex; gap:10px; }
  .insights .dot{ color:${accent}; flex-shrink:0; }
  footer{ margin-top:28px; font-size:11px; color:${dimColor}; font-family:'IBM Plex Mono','Courier New',monospace; }
  @keyframes rise{ from{ opacity:0; transform:scale(0.98) translateY(8px); } to{ opacity:1; transform:scale(1) translateY(0); } }
  @keyframes fadeIn{ from{ opacity:0; } to{ opacity:1; } }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${safeTitle}</h1>
    <div class="meta">READEOUT &middot; ${escapeHtmlText(new Date().toLocaleString())}</div>
    <div class="chart-frame"><img src="${imageDataUrl}" alt="${safeTitle}"></div>
    ${items ? `<div class="insights"><h2>Insights</h2><ul>${items}</ul></div>` : ''}
    <footer>Generated with Readeout — runs entirely in the browser, no data leaves your device.</footer>
  </div>
</body>
</html>`;
  }

  function exportChartHtml(){
    const type = $('chartType').value;
    const btn = $('exportHtmlBtn');
    const bg = ($('exportBg') && $('exportBg').value) || '#171B22';
    const prevLabel = btn.innerHTML;

    const xCol = $('xCol').value, yCol = $('yCol').value;
    const needsY = (type !== 'pie' && type !== 'doughnut' && type !== 'histogram' && type !== 'pictogram');
    const title = `${CHART_TYPE_LABELS[type] || type} — ${xCol}${needsY && yCol ? ` vs ${yCol}` : ''}`;

    const filename = () => {
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return `readeout-${type}-${stamp}.html`;
    };
    const showSuccess = () => {
      btn.innerHTML = '<span class="btn-ic">✓</span> Exported';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = prevLabel; }, 1700);
    };

    btn.disabled = true; btn.innerHTML = '<span class="btn-ic">…</span> Exporting';

    const isDomBased = (type === 'pictogram' || type === 'scattermatrix');
    const finish = htmlPromise => htmlPromise.then(html =>
      saveExportBlob(new Blob([html], { type: 'text/html' }), filename())
    ).then(showSuccess).catch(err => {
      showErr((err && err.message) || 'Could not export this chart as HTML.');
      btn.disabled = false; btn.innerHTML = prevLabel;
    });

    if(isDomBased || !chartInstance){
      // Pictogram and scatter-matrix are built straight from DOM, not a single
      // Chart.js instance, so there's no live config to lift — fall back to the
      // (now gently animated) static snapshot for these two.
      finish(captureChartCanvas(bg).then(canvas => buildStandaloneChartHtml({
        title, bg, imageDataUrl: canvas.toDataURL('image/png'), insights: currentInsightCaptionTexts()
      })));
    } else {
      finish(Promise.resolve(buildLiveExportHtml({
        pageTitle: title, bg,
        panels: [{ title, spec: chartConfigForExport(chartInstance), insights: currentInsightCaptionTexts() }]
      })));
    }
  }


  // Rebuilds the X/Y/value column selects based on what the current chart type needs,
  // and toggles selects on/off for chart types that don't use them.
  function updateAxisOptions(isInit){
    const type = $('chartType').value;
    const xSel = $('xCol'), ySel = $('yCol'), binsSel = $('binsCol'), valSel = $('valueCol'), goalSel = $('goalInput');
    const prevX = xSel.value, prevY = ySel.value, prevVal = valSel.value;

    const numericCols = columns.filter(c => c.type === 'number');
    const catCols = columns.filter(c => c.type !== 'number'); // text/date columns, best for grouping

    // Histogram/scatter/bubble operate on numeric columns on the X axis.
    const needsNumericX = (type === 'scatter' || type === 'histogram' || type === 'bubble');
    const isHeatmap = (type === 'heatmap');
    const isPictogram = (type === 'pictogram');
    const isRadar = (type === 'radar');
    const isGauge = (type === 'gauge');
    const isStacked = (type === 'stacked');
    const isOverlap = (type === 'overlap');
    const isTwoCatBar = isStacked || isOverlap;
    const isBoxplot = (type === 'boxplot');
    const isCorrHeatmap = (type === 'corrheatmap');
    const isScatterMatrix = (type === 'scattermatrix');
    const isRadial = (type === 'pie' || type === 'doughnut');
    // Correlation heatmap and scatter matrix both work across every numeric column
    // automatically (no single X/Y pair to pick), so they hide all the axis controls.
    const usesAutoNumeric = isCorrHeatmap || isScatterMatrix;
    // Radar groups rows into one line per category (X) and plots all numeric columns as
    // spokes, so it doesn't use a Y column. Gauge distills to a single overall metric (Y)
    // and doesn't need a grouping column at all, so it hides X instead.
    const usesX = !isGauge && !usesAutoNumeric;
    const usesY = (type !== 'pie' && type !== 'doughnut' && type !== 'histogram' && !isPictogram && !isRadar && !usesAutoNumeric);
    const usesBins = (type === 'histogram');
    // Pie/donut group by X the same way heatmap/stacked bar do, so they share the
    // same value-column control: "Record count" (plain occurrence count) or sum
    // of a chosen numeric column — this is the third control the two chart types
    // were missing.
    const usesValue = (isHeatmap || isTwoCatBar || isRadial);
    const usesGoal = isGauge;

    // X axis: heatmap/pictogram/stacked/boxplot/radar all group by a category, so prefer
    // non-numeric columns when available.
    let xOptions;
    if(isHeatmap || isPictogram || isTwoCatBar || isBoxplot || isRadar){
      xOptions = catCols.length ? catCols : columns;
    } else {
      xOptions = needsNumericX ? (numericCols.length ? numericCols : columns) : columns;
    }
    xSel.innerHTML = xOptions.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');

    // Y axis: heatmap/stacked need a second categorical column; other chart types want numeric.
    const yOptions = (isHeatmap || isTwoCatBar) ? (catCols.length ? catCols : columns) : (numericCols.length ? numericCols : columns);
    ySel.innerHTML = yOptions.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');

    // Value column (heatmap/stacked): numeric fields to aggregate, plus a record-count
    // fallback so these charts still work on datasets with no numeric column.
    const valOptions = [{name:'__count__', label:'Record count'}, ...numericCols.map(c => ({name:c.name, label:c.name}))];
    valSel.innerHTML = valOptions.map(o => `<option value="${escapeHtml(o.name)}">${escapeHtml(o.label)}</option>`).join('');

    if(isInit){
      const firstText = columns.find(c => c.type !== 'number');
      xSel.value = needsNumericX ? (numericCols[0]?.name || columns[0]?.name) : (firstText ? firstText.name : columns[0]?.name);
      if(numericCols[0]) ySel.value = numericCols[0].name;
    } else {
      xSel.value = xOptions.some(c => c.name === prevX) ? prevX : xOptions[0]?.name;
      ySel.value = yOptions.some(c => c.name === prevY) ? prevY : yOptions[0]?.name;
    }

    // Heatmap/stacked need two *distinct* categorical columns — if X and Y landed on the
    // same column (e.g. switching over from a chart type that used Y differently), bump Y
    // to the next available categorical column automatically.
    if((isHeatmap || isTwoCatBar) && yOptions.length > 1 && ySel.value === xSel.value){
      const alt = yOptions.find(c => c.name !== xSel.value);
      if(alt) ySel.value = alt.name;
    }

    valSel.value = valOptions.some(o => o.name === prevVal) ? prevVal : (numericCols[0] ? numericCols[0].name : '__count__');

    xSel.style.display = usesX ? '' : 'none';
    xSel.disabled = !usesX;
    ySel.style.display = usesY ? '' : 'none';
    ySel.disabled = !usesY;
    binsSel.style.display = usesBins ? '' : 'none';
    binsSel.disabled = !usesBins;
    valSel.style.display = usesValue ? '' : 'none';
    valSel.disabled = !usesValue;
    goalSel.style.display = usesGoal ? '' : 'none';
    goalSel.disabled = !usesGoal;

    // Gauge needs a sensible starting target — seed it once from the data (a "nice"
    // number a bit above the max) rather than leaving it blank, but never clobber a
    // value the person has already typed in.
    if(usesGoal && !goalSel.value && ySel.value){
      const nums = dataset.map(r => parseFloat(r[ySel.value])).filter(v => !isNaN(v));
      if(nums.length) goalSel.value = niceRound(Math.max(...nums) * 1.15);
    }
  }

  function renderChipRow(){
    const types = [
      {v:'bar', l:'Bar'}, {v:'line', l:'Line'}, {v:'area', l:'Area'}, {v:'scatter', l:'Scatter'},
      {v:'histogram', l:'Histogram'}, {v:'pie', l:'Pie'}, {v:'doughnut', l:'Donut'},
      {v:'heatmap', l:'Heatmap'}, {v:'pictogram', l:'Pictogram'}, {v:'radar', l:'Radar'},
      {v:'bubble', l:'Bubble'}, {v:'boxplot', l:'Box plot'}, {v:'gauge', l:'Gauge'},
      {v:'stacked', l:'Stacked bar'}, {v:'overlap', l:'Overlapping bar'}, {v:'corrheatmap', l:'Correlation heatmap'},
      {v:'scattermatrix', l:'Scatter matrix'}
    ];
    $('chipRow').innerHTML = types.map(t =>
      `<div class="chip ${$('chartType').value===t.v?'active':''}" data-type="${t.v}">${t.l}</div>`
    ).join('');
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $('chartType').value = chip.dataset.type;
        clearTableFilter();
        updateAxisOptions();
        renderChart();
        renderChipRow();
        updateColorPanelMode();
        renderColorSwatches();
        update3DAvailability();
        updateTrendAvailability();
        updateZoomAvailability();
      });
    });
  }

  const DEFAULT_PALETTE = ['#F2A93B', '#5FD4C0', '#8B7FD9', '#E0665A', '#6FA8DC', '#D98BD0', '#7DDE9C', '#E0B15A', '#4FC3E8', '#C77DFF', '#F27B7B', '#9CCC65', '#FF8A3D', '#E8C547', '#5C7CFA', '#FB7185', '#C97B4A', '#94A3B8'];

  // ---- custom color popover: 12 preset swatches + a free-text hex/name box ----
  const PRESET_SWATCHES = ['#F2A93B','#5FD4C0','#8B7FD9','#E0665A','#6FA8DC','#D98BD0','#7DDE9C','#E0B15A','#4FC3E8','#C77DFF','#F27B7B','#9CCC65'];

  const _colorProbe = document.createElement('div');
  function resolveColorValue(value){
    if(!value) return null;
    value = value.trim();
    _colorProbe.style.color = '';
    _colorProbe.style.color = value;
    if(!_colorProbe.style.color) return null;
    document.body.appendChild(_colorProbe);
    const rgb = getComputedStyle(_colorProbe).color;
    document.body.removeChild(_colorProbe);
    const m = rgb.match(/[\d.]+/g);
    if(!m || m.length < 3) return null;
    return '#' + m.slice(0,3).map(n => Math.round(+n).toString(16).padStart(2,'0')).join('');
  }

  let _cpopEl = null, _cpopCloseHandler = null;
  function closeColorPopover(){
    if(_cpopEl){ _cpopEl.classList.remove('show'); }
    if(_cpopCloseHandler){ document.removeEventListener('pointerdown', _cpopCloseHandler, true); _cpopCloseHandler = null; }
  }

  function initColorChip(chip, onChange){
    chip.style.background = chip.dataset.color;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPopover(chip, chip.dataset.color, (hex) => {
        chip.dataset.color = hex;
        chip.style.background = hex;
        onChange(hex);
      });
    });
  }

  function openColorPopover(anchorEl, currentColor, onPick){
    if(!_cpopEl){
      _cpopEl = document.createElement('div');
      _cpopEl.className = 'cpop';
      document.body.appendChild(_cpopEl);
    }
    const pop = _cpopEl;
    const wasOpenOnSameAnchor = pop.classList.contains('show') && pop._anchor === anchorEl;
    closeColorPopover();
    if(wasOpenOnSameAnchor) return;

    pop._anchor = anchorEl;
    pop.innerHTML = `
      <div class="cpop-grid">
        ${PRESET_SWATCHES.map(c => `<button type="button" class="cpop-swatch${c.toLowerCase()===String(currentColor).toLowerCase()?' active':''}" style="background:${c}" data-hex="${c}" title="${c}"></button>`).join('')}
      </div>
      <div class="cpop-input-row">
        <span class="cpop-dot" id="cpopDot" style="background:${currentColor}"></span>
        <input type="text" id="cpopInput" placeholder="hex or color name" value="${currentColor}" autocomplete="off" spellcheck="false">
      </div>
      <div class="cpop-hint" id="cpopHint">e.g. #5FD4C0 or "coral"</div>`;

    pop.querySelectorAll('.cpop-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        onPick(btn.dataset.hex);
        closeColorPopover();
      });
    });

    const input = pop.querySelector('#cpopInput');
    const dot = pop.querySelector('#cpopDot');
    const hint = pop.querySelector('#cpopHint');
    const debouncedPick = debounce(hex => onPick(hex), 120);
    const tryApply = (immediate) => {
      const hex = resolveColorValue(input.value);
      if(hex){
        dot.style.background = hex;
        hint.textContent = hex.toUpperCase();
        hint.classList.remove('err');
        if(immediate) onPick(hex); else debouncedPick(hex);
      } else if(input.value.trim()) {
        hint.textContent = "can't recognize that color";
        hint.classList.add('err');
      }
    };
    input.addEventListener('input', () => tryApply(false));
    input.addEventListener('keydown', e => { if(e.key === 'Enter'){ tryApply(true); closeColorPopover(); } });

    pop.classList.add('show');
    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if(top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    setTimeout(() => { input.focus({preventScroll:true}); }, 0);
    _cpopCloseHandler = (e) => { if(!pop.contains(e.target) && e.target !== anchorEl) closeColorPopover(); };
    document.addEventListener('pointerdown', _cpopCloseHandler, true);
  }
  const DEFAULT_HEAT = { low: '#171B22', high: '#F2A93B' };
  let customPalette = DEFAULT_PALETTE.slice();
  let heatColors = { low: DEFAULT_HEAT.low, high: DEFAULT_HEAT.high };
  let labelColors = {}; // per-category color overrides, keyed by category label string
  let is3D = false; // pseudo-3D extrusion toggle, applies to bar/histogram/pie/donut
  let showTrend = false; // moving-average trend overlay toggle, applies to line/area
  let matrixCharts = []; // Chart.js instances backing the scatter-matrix grid (one canvas each)
  let tableFilter = null; // { col, value, label } — set by clicking a bar/slice/segment; filters the raw-data table below

  // Default color for the i-th category. Uses the curated palette first, then
  // generates further distinct hues (golden-angle spacing) so categories never
  // run out of visually distinct default colors — users can still override any
  // individual one via the named swatches.
  function paletteColor(i){
    if(i < customPalette.length) return customPalette[i];
    const hue = (i * 137.508) % 360;
    return hslToHex(hue, 65, 60);
  }

  // Standard HSL -> hex conversion so generated colors are valid <input type="color"> values.
  function hslToHex(h, s, l){
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }

  function hexToRgb(hex){
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : { r:0, g:0, b:0 };
  }

  function hexToRgba(hex, alpha){
    const {r,g,b} = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Lightens (positive amt) or darkens (negative amt) a hex color, used to shade
  // the extruded side/top faces drawn by the pseudo3d plugin below.
  function shadeColor(hex, amt){
    if(typeof hex !== 'string' || hex[0] !== '#') return hex;
    const {r,g,b} = hexToRgb(hex);
    const clamp = v => Math.max(0, Math.min(255, v));
    return `rgb(${clamp(r+amt)},${clamp(g+amt)},${clamp(b+amt)})`;
  }

  // A lightweight Chart.js plugin that fakes a 3D-extruded look by drawing extra
  // shaded faces around the flat shapes Chart.js already renders — a right + top
  // face per bar, or an outer "cylinder wall" per pie/donut slice — rather than
  // pulling in a full 3D rendering engine. Enabled per-chart via
  // options.plugins.pseudo3d = { enabled, depth }.
  const pseudo3dPlugin = {
    id: 'pseudo3d',
    // Pie/donut walls need to sit BEHIND the flat slices, so they're drawn before
    // Chart.js draws its own datasets.
    beforeDatasetsDraw(chart, args, opts){
      if(!opts || !opts.enabled) return;
      const type = chart.config.type;
      if(type !== 'pie' && type !== 'doughnut') return;
      const ctx = chart.ctx;
      const depth = opts.depth || 18;
      const meta = chart.getDatasetMeta(0);
      if(!meta || !meta.data) return;
      meta.data.forEach(arc => {
        const { x, y, startAngle, endAngle, outerRadius } = arc;
        const color = (arc.options && arc.options.backgroundColor) || '#8B909B';
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y + depth, outerRadius, startAngle, endAngle, false);
        ctx.arc(x, y, outerRadius, endAngle, startAngle, true);
        ctx.closePath();
        ctx.fillStyle = shadeColor(color, -55);
        ctx.fill();
        ctx.restore();
      });
    },
    // Bar right/top faces need to sit ON TOP of the flat bar, extending past its
    // right and top edges, so they're drawn after Chart.js draws its own datasets.
    // Loops every dataset (not just the first) so stacked bars get a face on each
    // segment, not only the bottom-most one.
    afterDatasetsDraw(chart, args, opts){
      if(!opts || !opts.enabled) return;
      const type = chart.config.type;
      if(type !== 'bar') return;
      const ctx = chart.ctx;
      const depth = opts.depth || 10;
      chart.data.datasets.forEach((_, dsIndex) => {
        const meta = chart.getDatasetMeta(dsIndex);
        if(!meta || !meta.data) return;
        meta.data.forEach(bar => {
          const { x, width } = bar;
          const top = bar.y, bottom = bar.base;
          const left = x - width / 2, right = x + width / 2;
          if(bottom <= top) return; // zero-height bar, nothing to extrude
          const color = (bar.options && bar.options.backgroundColor) || '#8B909B';
          const sideColor = shadeColor(color, -45);
          const topColor = shadeColor(color, 30);

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(right, top);
          ctx.lineTo(right + depth, top - depth);
          ctx.lineTo(right + depth, bottom - depth);
          ctx.lineTo(right, bottom);
          ctx.closePath();
          ctx.fillStyle = sideColor;
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(right, top);
          ctx.lineTo(right + depth, top - depth);
          ctx.lineTo(left + depth, top - depth);
          ctx.closePath();
          ctx.fillStyle = topColor;
          ctx.fill();
          ctx.restore();
        });
      });
    }
  };
  Chart.register(pseudo3dPlugin);

  // Draws the underlying numeric value straight onto a chart — the on-canvas
  // equivalent of hovering for a tooltip. Dashboard cards opt in per-card via
  // options.plugins.valueLabels = { enabled, showPercent }; pie/donut also use
  // showPercent to append a "(NN%)" share alongside the raw count.
  const valueLabelsPlugin = {
    id: 'valueLabels',
    afterDatasetsDraw(chart, args, opts){
      if(!opts || !opts.enabled) return;
      const type = chart.config.type;
      const ctx = chart.ctx;
      ctx.save();
      if(type === 'pie' || type === 'doughnut'){
        const meta = chart.getDatasetMeta(0);
        const data = (chart.data.datasets[0] || {}).data || [];
        if(!meta || !meta.data) { ctx.restore(); return; }
        const total = data.reduce((a,b) => a + (typeof b === 'number' ? b : 0), 0);
        ctx.font = "700 10px 'IBM Plex Mono', monospace";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        meta.data.forEach((arc, i) => {
          const val = data[i];
          if(val == null || arc.circumference === 0) return;
          const angle = (arc.startAngle + arc.endAngle) / 2;
          const radius = (arc.innerRadius + arc.outerRadius) / 2;
          const x = arc.x + Math.cos(angle) * radius;
          const y = arc.y + Math.sin(angle) * radius;
          const pct = total ? Math.round((val/total)*100) : 0;
          const label = opts.showPercent ? `${fmt(val)} (${pct}%)` : fmt(val);
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,12,16,0.7)';
          ctx.strokeText(label, x, y);
          ctx.fillStyle = '#F4F1EA';
          ctx.fillText(label, x, y);
        });
      } else if(type === 'bar'){
        ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
        ctx.fillStyle = '#C7CBD1';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        chart.data.datasets.forEach((ds, dsIndex) => {
          const meta = chart.getDatasetMeta(dsIndex);
          if(!meta || meta.hidden) return;
          meta.data.forEach((bar, i) => {
            const val = ds.data[i];
            if(val == null || bar.y == null) return;
            const y = Math.min(bar.y, bar.base) - 4;
            ctx.fillText(fmt(val), bar.x, y);
          });
        });
      } else if(type === 'line'){
        ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
        ctx.fillStyle = '#C7CBD1';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        chart.data.datasets.forEach((ds, dsIndex) => {
          const meta = chart.getDatasetMeta(dsIndex);
          if(!meta || meta.hidden) return;
          meta.data.forEach((pt, i) => {
            const val = ds.data[i];
            if(val == null || pt.y == null) return;
            ctx.fillText(fmt(val), pt.x, pt.y - 6);
          });
        });
      }
      ctx.restore();
    }
  };
  Chart.register(valueLabelsPlugin);

  // Box plot chart type is provided by the @sgratzl/chartjs-chart-boxplot UMD build,
  // which (unlike chartjs-chart-matrix) doesn't self-register — it exposes its
  // controllers on window.ChartBoxPlot for us to register explicitly.
  if(window.ChartBoxPlot){
    Chart.register(window.ChartBoxPlot.BoxPlotController, window.ChartBoxPlot.BoxAndWiskers);
  }

  // Resolved color for chart types that render as one visual series
  // (line/area/scatter/histogram) — the single swatch in the color panel.
  function singleColor(){
    return labelColors.__single__ || customPalette[0];
  }

  function destroyMatrixCharts(){
    matrixCharts.forEach(c => { try{ c.destroy(); }catch(e){} });
    matrixCharts = [];
  }

  // Pearson correlation coefficient between two numeric columns, using only rows
  // where both values are present and numeric. Returns null if there isn't enough
  // paired data (fewer than 2 points, or one column has zero variance) to compute it.
  function pearsonCorrelation(colA, colB){
    const pairs = [];
    dataset.forEach(r => {
      const a = parseFloat(r[colA]), b = parseFloat(r[colB]);
      if(!isNaN(a) && !isNaN(b)) pairs.push([a,b]);
    });
    if(pairs.length < 2) return null;
    const n = pairs.length;
    const meanA = pairs.reduce((s,p)=>s+p[0],0)/n;
    const meanB = pairs.reduce((s,p)=>s+p[1],0)/n;
    let cov = 0, varA = 0, varB = 0;
    pairs.forEach(([a,b]) => { cov += (a-meanA)*(b-meanB); varA += (a-meanA)**2; varB += (b-meanB)**2; });
    if(varA === 0 || varB === 0) return null;
    return cov / Math.sqrt(varA * varB);
  }

  function renderChart(){
    const type = $('chartType').value;
    const xCol = $('xCol').value;
    const yCol = $('yCol').value;
    const valCol = $('valueCol').value;
    const needsY = (type !== 'pie' && type !== 'doughnut' && type !== 'histogram' && type !== 'pictogram');
    if(!xCol || (needsY && !yCol)){ setInsightCaptions([]); return; }

    const canvasEl = $('chart'), pictoEl = $('pictogramBox'), smEl = $('scatterMatrixBox');

    if(type === 'pictogram'){
      canvasEl.style.display = 'none';
      pictoEl.style.display = 'block';
      smEl.classList.remove('show'); smEl.innerHTML = '';
      destroyMatrixCharts();
      updateChartHint(type);
      if(chartInstance){ chartInstance.destroy(); chartInstance = null; }
      renderPictogram(xCol);
      const pictoCounts = {};
      dataset.forEach(r => { const k = String(r[xCol] ?? '—'); pictoCounts[k] = (pictoCounts[k]||0)+1; });
      const pictoEntries = Object.entries(pictoCounts).sort((a,b)=>b[1]-a[1]);
      const pictoTotal = pictoEntries.reduce((a,e)=>a+e[1],0);
      if(pictoEntries.length){
        const [topLabel, topCount] = pictoEntries[0];
        const pct = pictoTotal ? Math.round((topCount/pictoTotal)*100) : 0;
        const insights = [`"${topLabel}" is the most common ${xCol}, appearing in ${pct}% of records.`];
        if(pictoEntries.length > 1){
          insights.push(`${pictoEntries.length} distinct ${xCol} values recorded, spanning ${topCount.toLocaleString()} down to ${pictoEntries[pictoEntries.length-1][1].toLocaleString()} records each.`);
        }
        setInsightCaptions(insights);
      } else setInsightCaptions([]);
      return;
    }

    if(type === 'scattermatrix'){
      canvasEl.style.display = 'none';
      pictoEl.style.display = 'none'; pictoEl.innerHTML = '';
      updateChartHint(type);
      if(chartInstance){ chartInstance.destroy(); chartInstance = null; }
      renderScatterMatrix();
      const smNumericCols = columns.filter(c => c.type === 'number').slice(0,5);
      let smBest = null, smWorst = null;
      for(let i=0;i<smNumericCols.length;i++){
        for(let j=i+1;j<smNumericCols.length;j++){
          const r = pearsonCorrelation(smNumericCols[i].name, smNumericCols[j].name);
          if(r === null) continue;
          if(!smBest || Math.abs(r) > Math.abs(smBest.r)) smBest = { a: smNumericCols[i].name, b: smNumericCols[j].name, r };
          if(!smWorst || Math.abs(r) < Math.abs(smWorst.r)) smWorst = { a: smNumericCols[i].name, b: smNumericCols[j].name, r };
        }
      }
      const smInsights = [];
      if(smBest) smInsights.push(`Strongest relationship: ${smBest.a} and ${smBest.b} (${corrStrength(smBest.r)} ${smBest.r >= 0 ? 'positive' : 'negative'}, r=${smBest.r.toFixed(2)}).`);
      if(smWorst && smWorst !== smBest) smInsights.push(`Weakest relationship: ${smWorst.a} and ${smWorst.b} (r=${smWorst.r.toFixed(2)}).`);
      setInsightCaptions(smInsights);
      return;
    }

    canvasEl.style.display = 'block';
    pictoEl.style.display = 'none';
    pictoEl.innerHTML = '';
    smEl.classList.remove('show'); smEl.innerHTML = '';
    destroyMatrixCharts();
    updateChartHint(type);

    const ctx = $('chart').getContext('2d');
    if(chartInstance) chartInstance.destroy();

    const isRadial = (type === 'pie' || type === 'doughnut');
    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const commonOpts = {
      responsive:true, maintainAspectRatio:false,
      animation: prefersReducedMotion ? false : { duration: 380, easing: 'easeOutQuad' },
      resizeDelay: 80,
      plugins:{
        legend:{ labels:{ color:'#8B909B', font:{family:"'IBM Plex Mono', monospace", size:11} } },
        zoom: zoomOptionsFor(type)
      },
      scales: isRadial ? {} : {
        x:{ ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:10} }, grid:{ color:'#1D2129' } },
        y:{ ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:10} }, grid:{ color:'#1D2129' } }
      }
    };

    if(type === 'heatmap'){
      // Aggregate value/count into an X-category × Y-category grid, capped for readability.
      const CAP = 25;
      const xCats = [...new Set(dataset.map(r => String(r[xCol] ?? '—')))].slice(0, CAP);
      const yCats = [...new Set(dataset.map(r => String(r[yCol] ?? '—')))].slice(0, CAP);
      const cellMap = {};
      dataset.forEach(r => {
        const xk = String(r[xCol] ?? '—'), yk = String(r[yCol] ?? '—');
        if(!xCats.includes(xk) || !yCats.includes(yk)) return;
        const key = xk + '||' + yk;
        if(!cellMap[key]) cellMap[key] = { x: xk, y: yk, sum: 0, count: 0 };
        if(valCol === '__count__'){
          cellMap[key].count++;
        } else {
          const v = parseFloat(r[valCol]);
          if(!isNaN(v)){ cellMap[key].sum += v; cellMap[key].count++; }
        }
      });
      const cells = Object.values(cellMap).map(c => ({
        x: c.x, y: c.y,
        v: valCol === '__count__' ? c.count : (c.count ? c.sum / c.count : 0)
      }));
      if(!cells.length) return;
      const vals = cells.map(c => c.v);
      const vMin = Math.min(...vals), vMax = Math.max(...vals);
      const heatColor = v => {
        const t = vMax > vMin ? (v - vMin) / (vMax - vMin) : 0.5;
        const c1 = hexToRgb(heatColors.low), c2 = hexToRgb(heatColors.high);
        const r=Math.round(c1.r+(c2.r-c1.r)*t), g=Math.round(c1.g+(c2.g-c1.g)*t), b=Math.round(c1.b+(c2.b-c1.b)*t);
        return `rgb(${r},${g},${b})`;
      };
      chartInstance = new Chart(ctx, {
        type: 'matrix',
        data:{ datasets:[{
          label: valCol === '__count__' ? 'Record count' : `${valCol} (avg)`,
          data: cells,
          backgroundColor: c => heatColor(c.raw.v),
          borderWidth: 1, borderColor: '#0A0C10',
          width: ({chart}) => (chart.chartArea ? chart.chartArea.width / xCats.length - 2 : 10),
          height: ({chart}) => (chart.chartArea ? chart.chartArea.height / yCats.length - 2 : 10)
        }]},
        options:{
          responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{ display:false },
            tooltip:{ callbacks:{ label: c => `${c.raw.x} / ${c.raw.y}: ${fmt(c.raw.v)}` } }
          },
          scales:{
            x:{ type:'category', labels:xCats, offset:true, grid:{display:false},
              ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:10}, maxRotation:45 } },
            y:{ type:'category', labels:yCats, offset:true, grid:{display:false},
              ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:10} } }
          }
        }
      });
      const heatTop = cells.reduce((a,b) => (b.v > a.v ? b : a), cells[0]);
      const heatBottom = cells.reduce((a,b) => (b.v < a.v ? b : a), cells[0]);
      const heatUnit = v => valCol === '__count__' ? `${fmt(v)} records` : `avg ${valCol} of ${fmt(v)}`;
      const heatInsights = [`Highest concentration: ${heatTop.x} × ${heatTop.y} with ${heatUnit(heatTop.v)}.`];
      if(heatBottom !== heatTop && cells.length > 1){
        heatInsights.push(`Lowest concentration: ${heatBottom.x} × ${heatBottom.y} with ${heatUnit(heatBottom.v)}.`);
      }
      setInsightCaptions(heatInsights);
      return;
    }

    if(type === 'corrheatmap'){
      // Correlation matrix across every numeric column (capped for readability),
      // reusing the same low/high gradient controls as the categorical heatmap.
      const CAP = 12;
      const numericCols = columns.filter(c => c.type === 'number').slice(0, CAP);
      if(numericCols.length < 2){
        showErr('Need at least 2 numeric columns to compute correlations.');
        return;
      }
      showErr('');
      const names = numericCols.map(c => c.name);
      const cells = [];
      names.forEach((rowName, yi) => {
        names.forEach((colName, xi) => {
          const r = (rowName === colName) ? 1 : pearsonCorrelation(colName, rowName);
          cells.push({ x: colName, y: rowName, v: (r === null ? null : r) });
        });
      });
      const heatColor = v => {
        if(v === null) return '#1D2129';
        const t = (v + 1) / 2; // map -1..1 -> 0..1
        const c1 = hexToRgb(heatColors.low), c2 = hexToRgb(heatColors.high);
        const rr=Math.round(c1.r+(c2.r-c1.r)*t), gg=Math.round(c1.g+(c2.g-c1.g)*t), bb=Math.round(c1.b+(c2.b-c1.b)*t);
        return `rgb(${rr},${gg},${bb})`;
      };
      chartInstance = new Chart(ctx, {
        type: 'matrix',
        data:{ datasets:[{
          label: 'Correlation',
          data: cells,
          backgroundColor: c => heatColor(c.raw.v),
          borderWidth: 1, borderColor: '#0A0C10',
          width: ({chart}) => (chart.chartArea ? chart.chartArea.width / names.length - 2 : 10),
          height: ({chart}) => (chart.chartArea ? chart.chartArea.height / names.length - 2 : 10)
        }]},
        options:{
          responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{ display:false },
            tooltip:{ callbacks:{ label: c => `${c.raw.x} × ${c.raw.y}: ${c.raw.v === null ? 'n/a' : c.raw.v.toFixed(2)}` } }
          },
          scales:{
            x:{ type:'category', labels:names, offset:true, grid:{display:false},
              ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:10}, maxRotation:45 } },
            y:{ type:'category', labels:names, offset:true, grid:{display:false},
              ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:10} } }
          }
        },
        plugins:[{
          id:'corrLabels',
          afterDatasetsDraw(chart){
            const meta = chart.getDatasetMeta(0);
            const c = chart.ctx;
            c.save();
            c.textAlign = 'center'; c.textBaseline = 'middle';
            c.font = "600 10px 'IBM Plex Mono', monospace";
            meta.data.forEach((el, i) => {
              const v = cells[i].v;
              c.fillStyle = (v !== null && Math.abs(v) > 0.55) ? '#0A0C10' : '#8B909B';
              c.fillText(v === null ? '—' : v.toFixed(2), el.x, el.y);
            });
            c.restore();
          }
        }]
      });
      let corrBest = null, corrWorst = null;
      cells.forEach(c => {
        if(c.x === c.y || c.v === null) return;
        if(!corrBest || Math.abs(c.v) > Math.abs(corrBest.v)) corrBest = c;
        if(!corrWorst || Math.abs(c.v) < Math.abs(corrWorst.v)) corrWorst = c;
      });
      const corrInsights = [];
      if(corrBest) corrInsights.push(`Strongest relationship: ${corrBest.x} and ${corrBest.y} (${corrStrength(corrBest.v)} ${corrBest.v >= 0 ? 'positive' : 'negative'}, r=${corrBest.v.toFixed(2)}).`);
      if(corrWorst && corrWorst !== corrBest) corrInsights.push(`Weakest relationship: ${corrWorst.x} and ${corrWorst.y} (r=${corrWorst.v.toFixed(2)}).`);
      setInsightCaptions(corrInsights);
      return;
    }

    if(type === 'histogram'){
      const values = dataset.map(r => parseFloat(r[xCol])).filter(v => !isNaN(v));
      if(!values.length) return;
      const bins = parseInt($('binsCol').value, 10) || 12;
      const min = Math.min(...values), max = Math.max(...values);
      const span = (max - min) || 1;
      const width = span / bins;
      const counts = new Array(bins).fill(0);
      values.forEach(v => {
        let idx = Math.floor((v - min) / width);
        if(idx >= bins) idx = bins - 1;
        if(idx < 0) idx = 0;
        counts[idx]++;
      });
      const labels = counts.map((_, i) => {
        const lo = min + i*width, hi = min + (i+1)*width;
        return `${fmtAxis(lo)}–${fmtAxis(hi)}`;
      });
      const binEdges = counts.map((_, i) => [min + i*width, min + (i+1)*width]);
      chartInstance = new Chart(ctx, {
        type: 'bar',
        data:{ labels, datasets:[{
          label: `Frequency of ${xCol}`, data: counts,
          backgroundColor: singleColor(),
          borderColor: singleColor(),
          borderWidth:1, categoryPercentage:1.0, barPercentage:1.0
        }]},
        options: {
          ...commonOpts,
          scales: { ...commonOpts.scales, x:{ ...commonOpts.scales.x, ticks:{...commonOpts.scales.x.ticks, maxRotation:45, minRotation:0} } },
          layout: is3D ? { padding: { top: 14, right: 14 } } : undefined,
          plugins: {
            ...commonOpts.plugins,
            pseudo3d: { enabled: is3D, depth: 10 },
            tooltip: { callbacks: { label: c => {
              const pct = values.length ? Math.round((c.parsed.y/values.length)*100) : 0;
              return [`Count: ${c.parsed.y.toLocaleString()}`, `Share: ${pct}%`];
            } } }
          },
          onClick: (evt, elements) => {
            if(!elements.length) return;
            const i = elements[0].index;
            const [lo, hi] = binEdges[i];
            setTableRangeFilter(xCol, lo, hi, `${xCol} in ${labels[i]}`, i === binEdges.length - 1);
          }
        }
      });
      const maxIdx = counts.indexOf(Math.max(...counts));
      const histPct = values.length ? Math.round((counts[maxIdx]/values.length)*100) : 0;
      const histInsights = [`Most ${xCol} values fall between ${labels[maxIdx]} (${histPct}% of records).`];
      histInsights.push(`${xCol} ranges from ${fmtAxis(min)} to ${fmtAxis(max)} across ${values.length.toLocaleString()} values.`);
      setInsightCaptions(histInsights);
      return;
    }

    if(type === 'scatter'){
      const points = dataset.map(r => ({x: parseFloat(r[xCol]), y: parseFloat(r[yCol])}))
        .filter(p => !isNaN(p.x) && !isNaN(p.y));
      chartInstance = new Chart(ctx, {
        type:'scatter',
        data:{ datasets:[{ label:`${yCol} vs ${xCol}`, data: points, backgroundColor: singleColor() }] },
        options: commonOpts
      });
      const scatR = points.length >= 2 ? pearsonCorrelation(xCol, yCol) : null;
      const scatInsights = [];
      if(scatR !== null){
        const s = corrStrength(scatR);
        scatInsights.push(`${s.charAt(0).toUpperCase()+s.slice(1)} ${scatR >= 0 ? 'positive' : 'negative'} relationship between ${xCol} and ${yCol} (r=${scatR.toFixed(2)}).`);
      }
      if(points.length){
        const xs = points.map(p=>p.x), ys = points.map(p=>p.y);
        scatInsights.push(`${points.length.toLocaleString()} points plotted — ${xCol} spans ${fmtAxis(Math.min(...xs))} to ${fmtAxis(Math.max(...xs))}.`);
      }
      setInsightCaptions(scatInsights);
      return;
    }

    if(type === 'bubble'){
      // Third dimension (bubble size) comes from the value column; falls back to a
      // uniform size if the person picked "record count" instead of a numeric field.
      const sizeCol = valCol;
      const useCount = (sizeCol === '__count__');
      const raw = dataset.map(r => ({
        x: parseFloat(r[xCol]), y: parseFloat(r[yCol]),
        s: useCount ? 1 : parseFloat(r[sizeCol])
      })).filter(p => !isNaN(p.x) && !isNaN(p.y) && !isNaN(p.s));
      if(!raw.length) return;
      const sizes = raw.map(p => p.s);
      const minS = Math.min(...sizes), maxS = Math.max(...sizes);
      const spanS = (maxS - minS) || 1;
      const points = raw.map(p => ({ x: p.x, y: p.y, r: 4 + ((p.s - minS) / spanS) * 22 }));
      const label = useCount ? `${yCol} vs ${xCol}` : `${yCol} vs ${xCol} (size: ${sizeCol})`;
      chartInstance = new Chart(ctx, {
        type:'bubble',
        data:{ datasets:[{ label, data: points, backgroundColor: hexToRgba(singleColor(), 0.55), borderColor: singleColor() }] },
        options: commonOpts
      });
      const bubBiggest = raw.reduce((a,b) => (b.s > a.s ? b : a), raw[0]);
      const bubSizeLabel = useCount ? 'record count' : sizeCol;
      setInsightCaptions([
        `Largest ${bubSizeLabel} at ${xCol}=${fmt(bubBiggest.x)}, ${yCol}=${fmt(bubBiggest.y)}.`,
        `${raw.length.toLocaleString()} points plotted, sized by ${bubSizeLabel}.`
      ]);
      return;
    }

    if(type === 'boxplot'){
      if(!window.Chart || !Chart.registry.controllers.get('boxplot')){
        showErr('Box plot library failed to load.'); return;
      }
      const groups = {};
      dataset.forEach(r => {
        const k = String(r[xCol] ?? '—');
        const v = parseFloat(r[yCol]);
        if(!isNaN(v)) (groups[k] = groups[k] || []).push(v);
      });
      let labels = Object.keys(groups).filter(k => groups[k].length);
      if(labels.length > 20) labels = labels.slice(0, 20);
      const boxColors = labels.map((k, i) => labelColors[k] || paletteColor(i));
      chartInstance = new Chart(ctx, {
        type:'boxplot',
        data:{ labels, datasets:[{
          label: `${yCol} distribution`,
          data: labels.map(k => groups[k]),
          backgroundColor: boxColors.map(c => hexToRgba(c, 0.3)),
          borderColor: boxColors, borderWidth:1.5,
          outlierColor: '#E0665A', itemRadius: 2
        }]},
        options: { ...commonOpts, plugins: { ...commonOpts.plugins, legend:{ display:false } } }
      });
      if(labels.length){
        let bpBestLabel = labels[0], bpBestMedian = -Infinity;
        let bpWorstLabel = labels[0], bpWorstMedian = Infinity;
        const medianOf = k => {
          const vals = groups[k].slice().sort((a,b)=>a-b);
          const mid = Math.floor(vals.length/2);
          return vals.length % 2 ? vals[mid] : (vals[mid-1]+vals[mid])/2;
        };
        labels.forEach(k => {
          const median = medianOf(k);
          if(median > bpBestMedian){ bpBestMedian = median; bpBestLabel = k; }
          if(median < bpWorstMedian){ bpWorstMedian = median; bpWorstLabel = k; }
        });
        const bpInsights = [`"${bpBestLabel}" has the highest median ${yCol} at ${fmt(bpBestMedian)}.`];
        if(bpWorstLabel !== bpBestLabel) bpInsights.push(`"${bpWorstLabel}" has the lowest median ${yCol} at ${fmt(bpWorstMedian)}.`);
        setInsightCaptions(bpInsights);
      } else setInsightCaptions([]);
      return;
    }

    if(type === 'radar'){
      const metricCols = columns.filter(c => c.type === 'number').slice(0, 8);
      if(!metricCols.length) return;
      const groups = {};
      dataset.forEach(r => {
        const k = String(r[xCol] ?? '—');
        if(!groups[k]) groups[k] = metricCols.map(() => ({ sum:0, count:0 }));
        metricCols.forEach((c, i) => {
          const v = parseFloat(r[c.name]);
          if(!isNaN(v)){ groups[k][i].sum += v; groups[k][i].count++; }
        });
      });
      let cats = Object.keys(groups);
      if(cats.length > 6) cats = cats.slice(0, 6); // more than a handful of overlapping lines gets unreadable
      const datasets = cats.map((k, i) => {
        const color = labelColors[k] || paletteColor(i);
        return {
          label: k,
          data: groups[k].map(g => g.count ? g.sum / g.count : 0),
          backgroundColor: hexToRgba(color, 0.15),
          borderColor: color, pointBackgroundColor: color, borderWidth:2
        };
      });
      chartInstance = new Chart(ctx, {
        type:'radar',
        data:{ labels: metricCols.map(c => c.name), datasets },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ labels:{ color:'#8B909B', font:{family:"'IBM Plex Mono', monospace", size:11} } } },
          scales:{ r:{
            angleLines:{ color:'#1D2129' }, grid:{ color:'#1D2129' },
            pointLabels:{ color:'#8B909B', font:{family:"'IBM Plex Mono', monospace", size:10} },
            ticks:{ color:'#565C68', backdropColor:'transparent' }
          }}
        }
      });
      if(cats.length){
        let radarBestCat = cats[0], radarBestAvg = -Infinity;
        let radarWorstCat = cats[0], radarWorstAvg = Infinity;
        cats.forEach(k => {
          const vals = groups[k].filter(x => x.count).map(x => x.sum / x.count);
          const avg = vals.length ? vals.reduce((a,b)=>a+b,0) / vals.length : null;
          if(avg === null) return;
          if(avg > radarBestAvg){ radarBestAvg = avg; radarBestCat = k; }
          if(avg < radarWorstAvg){ radarWorstAvg = avg; radarWorstCat = k; }
        });
        const radarInsights = [`"${radarBestCat}" scores highest on average across the plotted metrics.`];
        if(radarWorstCat !== radarBestCat) radarInsights.push(`"${radarWorstCat}" scores lowest on average across the plotted metrics.`);
        setInsightCaptions(radarInsights);
      } else setInsightCaptions([]);
      return;
    }

    if(type === 'stacked'){
      const isCount = (valCol === '__count__');
      const xCats = [...new Set(dataset.map(r => String(r[xCol] ?? '—')))].slice(0, 30);
      const yCats = [...new Set(dataset.map(r => String(r[yCol] ?? '—')))].slice(0, 12);
      const sums = {};
      yCats.forEach(y => { sums[y] = {}; });
      dataset.forEach(r => {
        const xk = String(r[xCol] ?? '—'), yk = String(r[yCol] ?? '—');
        if(!xCats.includes(xk) || !yCats.includes(yk)) return;
        const v = isCount ? 1 : parseFloat(r[valCol]);
        if(!isNaN(v)) sums[yk][xk] = (sums[yk][xk] || 0) + v;
      });
      const colTotals = {};
      xCats.forEach(xk => { colTotals[xk] = yCats.reduce((a,yk) => a + (sums[yk][xk] || 0), 0); });
      const datasets = yCats.map((yk, i) => ({
        label: yk,
        data: xCats.map(xk => sums[yk][xk] || 0),
        backgroundColor: labelColors[yk] || paletteColor(i)
      }));
      chartInstance = new Chart(ctx, {
        type:'bar',
        data:{ labels: xCats, datasets },
        options: {
          ...commonOpts,
          scales:{
            x:{ ...commonOpts.scales.x, stacked:true },
            y:{ ...commonOpts.scales.y, stacked:true }
          },
          layout: is3D ? { padding: { top: 14, right: 14 } } : undefined,
          plugins: {
            ...commonOpts.plugins,
            pseudo3d: { enabled: is3D, depth: 10 },
            tooltip: { callbacks: { label: c => {
              const xk = xCats[c.dataIndex];
              const total = colTotals[xk] || 0;
              const pct = total ? Math.round((c.parsed.y/total)*100) : 0;
              return [`${c.dataset.label}: ${fmt(c.parsed.y)}`, `Share of ${xk}: ${pct}%`];
            } } }
          },
          onClick: (evt, elements) => {
            if(!elements.length) return;
            const el = elements[0];
            const xk = xCats[el.index], yk = datasets[el.datasetIndex].label;
            tableFilter = {
              col: xCol, value: null, label: `${xCol} = ${xk} & ${yCol} = ${yk}`,
              test: r => String(r[xCol] ?? '—') === xk && String(r[yCol] ?? '—') === yk
            };
            renderTable();
          }
        }
      });
      if(xCats.length){
        const stkTopX = xCats.reduce((a,b) => (colTotals[b] > colTotals[a] ? b : a), xCats[0]);
        let stkTopY = null, stkTopYVal = -Infinity;
        yCats.forEach(yk => { const v = sums[yk][stkTopX] || 0; if(v > stkTopYVal){ stkTopYVal = v; stkTopY = yk; } });
        const grandTotal = xCats.reduce((a,xk) => a + (colTotals[xk] || 0), 0);
        setInsightCaptions([
          `"${stkTopX}" leads with a total of ${fmt(colTotals[stkTopX])}, driven mostly by ${stkTopY}.`,
          `${xCats.length} categories of ${xCol} sum to ${fmt(grandTotal)} total.`
        ]);
      } else setInsightCaptions([]);
      return;
    }

    if(type === 'overlap'){
      // Same two-category shape as stacked bar, but each series is drawn as its
      // own full-width bar layered on top of the others (semi-transparent so the
      // overlap itself is visible) instead of segmented on top of each other.
      const isCount = (valCol === '__count__');
      const xCats = [...new Set(dataset.map(r => String(r[xCol] ?? '—')))].slice(0, 30);
      const yCats = [...new Set(dataset.map(r => String(r[yCol] ?? '—')))].slice(0, 12);
      const sums = {};
      yCats.forEach(y => { sums[y] = {}; });
      dataset.forEach(r => {
        const xk = String(r[xCol] ?? '—'), yk = String(r[yCol] ?? '—');
        if(!xCats.includes(xk) || !yCats.includes(yk)) return;
        const v = isCount ? 1 : parseFloat(r[valCol]);
        if(!isNaN(v)) sums[yk][xk] = (sums[yk][xk] || 0) + v;
      });
      // Draw the largest series first (further back) and smallest last (front) so
      // every bar stays at least partly visible through the transparency, no
      // matter how the values compare.
      const yTotals = {};
      yCats.forEach(yk => { yTotals[yk] = xCats.reduce((a,xk) => a + (sums[yk][xk] || 0), 0); });
      const drawOrder = [...yCats].sort((a,b) => yTotals[b] - yTotals[a]);
      const datasets = yCats.map((yk, i) => {
        const base = labelColors[yk] || paletteColor(i);
        return {
          label: yk,
          data: xCats.map(xk => sums[yk][xk] || 0),
          backgroundColor: hexToRgba(base, 0.6),
          borderColor: base,
          borderWidth: 1.5,
          grouped: false,
          barPercentage: 0.92,
          categoryPercentage: 0.85,
          order: drawOrder.indexOf(yk)
        };
      });
      chartInstance = new Chart(ctx, {
        type:'bar',
        data:{ labels: xCats, datasets },
        options: {
          ...commonOpts,
          scales:{
            x:{ ...commonOpts.scales.x, stacked:false },
            y:{ ...commonOpts.scales.y, stacked:false }
          },
          layout: is3D ? { padding: { top: 14, right: 14 } } : undefined,
          plugins: {
            ...commonOpts.plugins,
            pseudo3d: { enabled: is3D, depth: 10 }
          },
          onClick: (evt, elements) => {
            if(!elements.length) return;
            const el = elements[0];
            const xk = xCats[el.index], yk = datasets[el.datasetIndex].label;
            tableFilter = {
              col: xCol, value: null, label: `${xCol} = ${xk} & ${yCol} = ${yk}`,
              test: r => String(r[xCol] ?? '—') === xk && String(r[yCol] ?? '—') === yk
            };
            renderTable();
          }
        }
      });
      if(xCats.length && yCats.length){
        const peakY = yCats.reduce((a,b) => (yTotals[b] > yTotals[a] ? b : a), yCats[0]);
        let peakX = xCats[0], peakVal = -Infinity;
        xCats.forEach(xk => { const v = sums[peakY][xk] || 0; if(v > peakVal){ peakVal = v; peakX = xk; } });
        setInsightCaptions([
          `"${peakY}" has the highest overall total (${fmt(yTotals[peakY])}), peaking at "${peakX}" with ${fmt(peakVal)}.`,
          `${yCats.length} overlapping series plotted across ${xCats.length} categories of ${xCol}.`
        ]);
      } else setInsightCaptions([]);
      return;
    }

    if(type === 'gauge'){
      const metricCol = yCol;
      const nums = dataset.map(r => parseFloat(r[metricCol])).filter(v => !isNaN(v));
      if(!nums.length) return;
      const avg = nums.reduce((a,b) => a+b, 0) / nums.length;
      let goal = parseFloat($('goalInput').value);
      if(isNaN(goal) || goal <= 0) goal = niceRound(Math.max(...nums) * 1.15) || 1;
      const pct = Math.max(0, Math.min(1, avg / goal));
      const color = singleColor();
      const label1 = fmt(avg), label2 = `of ${fmt(goal)} goal · ${Math.round(pct*100)}%`;
      chartInstance = new Chart(ctx, {
        type:'doughnut',
        data:{ labels:['Achieved','Remaining'], datasets:[{
          data:[pct, 1-pct], backgroundColor:[color, '#1D2129'], borderWidth:0
        }]},
        options:{
          responsive:true, maintainAspectRatio:false,
          circumference:180, rotation:270, cutout:'75%',
          layout:{ padding:{ bottom: 30 } },
          plugins:{
            legend:{ display:false }, tooltip:{ enabled:false },
            pseudo3d:{ enabled: is3D, depth: 14 },
            // Colors live in options (rather than being hardcoded in the plugin below)
            // so exportChartPng can swap them for a light background the same way it
            // already does for legend/tick colors, then restore them on the next render.
            // label1/label2 are duplicated in here too (not just closed over below) so
            // the live HTML export can rebuild this exact plugin from JSON alone.
            gaugeLabel:{ text:'#E9E7E2', dim:'#8B909B', label1, label2 }
          }
        },
        plugins:[{
          id:'gaugeLabel',
          afterDraw(chart){
            const meta = chart.getDatasetMeta(0);
            if(!meta.data.length) return;
            // Anchor to the arc's actual center rather than the canvas edge, so the
            // label sits right under the ring regardless of canvas size or export dims.
            const { x: cx, y: cy } = meta.data[0];
            const colors = (chart.options.plugins && chart.options.plugins.gaugeLabel) || { text:'#E9E7E2', dim:'#8B909B' };
            const c = chart.ctx;
            c.save();
            c.textAlign = 'center';
            c.fillStyle = colors.text;
            c.font = "700 26px 'IBM Plex Mono', monospace";
            c.fillText(label1, cx, cy + 14);
            c.fillStyle = colors.dim;
            c.font = "12px 'IBM Plex Mono', monospace";
            c.fillText(label2, cx, cy + 34);
            c.restore();
          }
        }]
      });

      setInsightCaptions([
        `Currently at ${Math.round(pct*100)}% of goal — ${fmt(avg)} average ${metricCol} against a target of ${fmt(goal)}.`,
        `Based on ${nums.length.toLocaleString()} data points.`
      ]);
      return;
    }

    if(isRadial){
      const isCount = (valCol === '__count__');
      const sums = {};
      dataset.forEach(r => {
        const k = String(r[xCol] ?? '—');
        if(isCount){
          sums[k] = (sums[k]||0) + 1;
        } else {
          const v = parseFloat(r[valCol]);
          if(!isNaN(v)) sums[k] = (sums[k]||0) + v;
        }
      });
      const totalCount = Object.values(sums).reduce((a,v) => a + v, 0);
      const entries = Object.entries(sums).sort((a,b)=>b[1]-a[1]).slice(0,10);
      const sliceColors = entries.map((e,i) => labelColors[e[0]] || paletteColor(i));
      const seriesLabel = isCount ? 'Record count' : `Sum of ${valCol}`;
      chartInstance = new Chart(ctx, {
        type: type,
        data:{ labels: entries.map(e=>e[0]), datasets:[{ label: seriesLabel, data: entries.map(e=>e[1]), backgroundColor: sliceColors }] },
        options: {
          ...commonOpts,
          layout: is3D ? { padding: { bottom: 22 } } : undefined,
          plugins: {
            ...commonOpts.plugins,
            pseudo3d: { enabled: is3D, depth: 18 },
            tooltip: { callbacks: { label: c => {
              const val = c.parsed;
              const pct = totalCount ? Math.round((val/totalCount)*100) : 0;
              return [isCount ? `Count: ${val.toLocaleString()}` : `${valCol}: ${fmt(val)}`, `Share: ${pct}%`];
            } } }
          },
          onClick: (evt, elements) => {
            if(!elements.length) return;
            const label = entries[elements[0].index][0];
            setTableFilter(xCol, label, `${xCol} = ${label}`);
          }
        }
      });
      if(entries.length){
        const [radTopLabel, radTopVal] = entries[0];
        const radPct = totalCount ? Math.round((radTopVal/totalCount)*100) : 0;
        const radUnit = isCount ? 'of records' : `of total ${valCol}`;
        const radInsights = [`"${radTopLabel}" is the largest share of ${xCol} at ${radPct}% ${radUnit}.`];
        if(entries.length > 2){
          const top3 = entries.slice(0,3).reduce((a,e)=>a+e[1],0);
          const top3Pct = totalCount ? Math.round((top3/totalCount)*100) : 0;
          radInsights.push(`The top 3 ${xCol} values together account for ${top3Pct}% ${radUnit}.`);
        } else if(entries.length === 2){
          const [lowLabel, lowVal] = entries[1];
          const lowPct = totalCount ? Math.round((lowVal/totalCount)*100) : 0;
          radInsights.push(`"${lowLabel}" makes up the remaining ${lowPct}%.`);
        }
        setInsightCaptions(radInsights);
      } else setInsightCaptions([]);
      return;
    }

    // bar / line: aggregate y by x (mean), cap categories for readability
    const groups = {};
    dataset.forEach(r => {
      const k = String(r[xCol] ?? '—');
      const v = parseFloat(r[yCol]);
      if(!groups[k]) groups[k] = [];
      if(!isNaN(v)) groups[k].push(v);
    });
    let labels = Object.keys(groups);
    if(labels.length > 30) labels = labels.slice(0,30);
    const groupStats = labels.map(k => computeGroupStats(groups[k]));
    const values = groupStats.map(s => s.mean);

    // 'area' is rendered as a filled line chart under the hood
    const chartJsType = (type === 'area') ? 'line' : type;
    const isBarChart = (chartJsType === 'bar');
    const barColors = labels.map((k, i) => labelColors[k] || paletteColor(i));
    const fillRgb = hexToRgb(singleColor());
    const fillColor = `rgba(${fillRgb.r},${fillRgb.g},${fillRgb.b},0.20)`;
    const mainDataset = {
      label: `${yCol} (avg by ${xCol})`, data: values,
      backgroundColor: isBarChart ? barColors : fillColor,
      borderColor: isBarChart ? barColors : singleColor(), borderWidth:2,
      pointBackgroundColor: singleColor(), tension:0.25, fill: (type==='line' || type==='area')
    };
    const chartDatasets = [mainDataset];

    // Trend overlay: a simple moving average over the plotted series, drawn as a
    // thin dashed line on top so the underlying shape stays visible underneath it.
    if(showTrend && (type === 'line' || type === 'area') && values.length >= 3){
      chartDatasets.push({
        label: 'Trend (moving avg)',
        data: movingAverage(values, trendWindow(values.length)),
        borderColor: hexToRgba(TREND_COLOR, 0.9), backgroundColor: 'transparent',
        borderWidth: 2, borderDash: [6,4], pointRadius: 0, tension: 0.3, fill: false
      });
    }

    chartInstance = new Chart(ctx, {
      type: chartJsType,
      data:{ labels, datasets: chartDatasets },
      options: {
        ...commonOpts,
        layout: (is3D && isBarChart) ? { padding: { top: 14, right: 14 } } : undefined,
        plugins: {
          ...commonOpts.plugins,
          pseudo3d: { enabled: is3D && isBarChart, depth: 10 },
          tooltip: { callbacks: { label: c => {
            if(c.dataset.label && c.dataset.label.indexOf('Trend') === 0) return `Trend: ${fmt(c.parsed.y)}`;
            const s = groupStats[c.dataIndex];
            if(!s) return `${fmt(c.parsed.y)}`;
            // A bar backed by a single record has mean === median by definition,
            // so showing all three lines is just noise — collapse to one line.
            // Mean/median/count only earns its keep once a bar is a real aggregate.
            if(s.count <= 1) return `${yCol}: ${fmt(s.mean)}`;
            return [`Mean: ${fmt(s.mean)}`, `Median: ${fmt(s.median)}`, `Count: ${s.count}`];
          } } }
        },
        onClick: isBarChart ? (evt, elements) => {
          if(!elements.length) return;
          const label = labels[elements[0].index];
          setTableFilter(xCol, label, `${xCol} = ${label}`);
        } : undefined
      }
    });

    if(values.length){
      const avg = values.reduce((a,b)=>a+b,0) / values.length;
      let peakIdx = 0, lowIdx = 0;
      values.forEach((v,i) => {
        if(v > values[peakIdx]) peakIdx = i;
        if(v < values[lowIdx]) lowIdx = i;
      });
      const peakVal = values[peakIdx];
      const diffPct = avg ? Math.round(((peakVal - avg) / Math.abs(avg)) * 100) : 0;
      const barInsights = [];
      if(Math.abs(diffPct) < 1){
        barInsights.push(`${yCol} is fairly even across ${xCol} — ${labels[peakIdx]} leads narrowly at ${fmt(peakVal)}.`);
      } else {
        const dir = diffPct >= 0 ? 'above' : 'below';
        barInsights.push(`${xCol} "${labels[peakIdx]}" has the highest average ${yCol} at ${fmt(peakVal)}, ${Math.abs(diffPct)}% ${dir} the overall average.`);
      }
      if(lowIdx !== peakIdx && labels.length > 1){
        barInsights.push(`${xCol} "${labels[lowIdx]}" has the lowest average ${yCol} at ${fmt(values[lowIdx])}.`);
      }
      setInsightCaptions(barInsights);
    } else setInsightCaptions([]);
  }

  // A dedicated, fixed color for the trend overlay so it always reads as "trend"
  // regardless of whatever color the person picked for the main series.
  const TREND_COLOR = '#E9E7E2';

  // Picks a moving-average window that scales with series length: wide enough to
  // smooth out noise, narrow enough to still show real movement (roughly 1/6th of
  // the points, clamped between 2 and 9).
  function trendWindow(n){
    return Math.max(2, Math.min(9, Math.round(n / 6)));
  }

  // Centered simple moving average. Edge points (where a full window isn't
  // available) use whatever partial window fits, so the trend line still spans
  // the full width of the chart instead of stopping short at each end.
  function movingAverage(values, window){
    const half = Math.floor(window / 2);
    return values.map((_, i) => {
      const lo = Math.max(0, i - half), hi = Math.min(values.length - 1, i + half);
      const slice = values.slice(lo, hi + 1);
      return slice.reduce((a,b)=>a+b, 0) / slice.length;
    });
  }

  // ---------- pictogram (isotype chart) ----------
  // Renders category counts as rows of icons, where each icon represents a rounded
  // "nice" unit (1, 2, 5, 10, 20, 50...) so the row lengths stay readable regardless of scale.
  function renderPictogram(xCol){
    const box = $('pictogramBox');
    const counts = {};
    dataset.forEach(r => { const k = String(r[xCol] ?? '—'); counts[k] = (counts[k]||0)+1; });
    const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 10);
    if(!entries.length){ box.innerHTML = '<div class="picto-empty">No data to display.</div>'; return; }

    const maxCount = Math.max(...entries.map(e => e[1]));
    const targetIconsPerRow = 40;
    const unit = niceRound(Math.max(1, maxCount / targetIconsPerRow));

    const rows = entries.map(([label, count], i) => {
      const color = labelColors[label] || paletteColor(i);
      const fullIcons = Math.floor(count / unit);
      const remainder = (count % unit) / unit;
      let icons = '';
      for(let k = 0; k < fullIcons; k++){
        icons += `<span class="picto-icon" style="background:${color}"></span>`;
      }
      if(remainder > 0.04){
        icons += `<span class="picto-icon partial"><span class="fill" style="width:${Math.round(remainder*100)}%;background:${color}"></span></span>`;
      }
      return `<div class="picto-row">
        <div class="picto-label"><span class="name">${escapeHtml(label)}</span><span class="picto-count">${count.toLocaleString()}</span></div>
        <div class="picto-icons">${icons}</div>
      </div>`;
    }).join('');

    box.innerHTML = rows + `<div class="picto-legend">Each icon ≈ ${unit.toLocaleString()} record${unit === 1 ? '' : 's'} · grouped by "${escapeHtml(xCol)}"</div>`;
  }

  // ---------- scatter matrix ----------
  // Renders an N×N grid of small pairwise scatter plots across every numeric column
  // (capped to keep each cell readable), with the column name on the diagonal —
  // a quick way to eyeball which pairs of variables are worth a closer look.
  function renderScatterMatrix(){
    const box = $('scatterMatrixBox');
    destroyMatrixCharts();
    const CAP = 5;
    const numericCols = columns.filter(c => c.type === 'number').slice(0, CAP);
    if(numericCols.length < 2){
      box.classList.add('show');
      box.style.gridTemplateColumns = '1fr';
      box.innerHTML = '<div class="sm-empty">Need at least 2 numeric columns for a scatter matrix.</div>';
      return;
    }
    showErr('');
    const names = numericCols.map(c => c.name);
    const n = names.length;
    box.classList.add('show');
    box.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    box.innerHTML = '';
    const color = singleColor();
    const ptColor = hexToRgba(color, 0.6);

    names.forEach((rowName, ri) => {
      names.forEach((colName, ci) => {
        const cell = document.createElement('div');
        if(ri === ci){
          cell.className = 'sm-cell sm-diag';
          cell.textContent = rowName;
          box.appendChild(cell);
          return;
        }
        cell.className = 'sm-cell';
        const canvas = document.createElement('canvas');
        cell.appendChild(canvas);
        box.appendChild(cell);
        const points = dataset.map(r => ({ x: parseFloat(r[colName]), y: parseFloat(r[rowName]) }))
          .filter(p => !isNaN(p.x) && !isNaN(p.y));
        const inst = new Chart(canvas.getContext('2d'), {
          type: 'scatter',
          data:{ datasets:[{ data: points, backgroundColor: ptColor, pointRadius: 2, pointHoverRadius: 3 }] },
          options:{
            responsive:true, maintainAspectRatio:false, animation:false,
            plugins:{ legend:{ display:false }, tooltip:{ enabled:false } },
            scales:{
              x:{ display:false }, y:{ display:false }
            }
          }
        });
        matrixCharts.push(inst);
      });
    });
  }

  // Rounds up to a "nice" number (1, 2, 5, 10, 20, 50...) for pictogram icon scaling.
  function niceRound(n){
    if(n <= 1) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(n)));
    const norm = n / pow;
    let nice;
    if(norm <= 1) nice = 1; else if(norm <= 2) nice = 2; else if(norm <= 5) nice = 5; else nice = 10;
    return nice * pow;
  }

  // Compact axis-label formatter for histogram bin edges
  function fmtAxis(n){
    if(Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
    return (Math.round(n*100)/100).toString();
  }

  // ================= Dashboard =================
  // A second, independent view: a grid of self-contained chart cards the person
  // builds themselves (pick type + columns per card). Card *settings* (not the
  // dataset) persist in localStorage so a dashboard layout survives a reload —
  // same spirit as the History feature, but scoped to chart configuration only.
  const DASHBOARD_KEY = 'readeout.dashboard.v1';
  // Kept to a solid, general-purpose subset of the full chart-type list — the
  // handful of types (heatmap, correlation heatmap, gauge, stacked/overlapping
  // bar, pictogram, scatter matrix) that need a third axis or a bespoke DOM
  // widget stay single-chart-only for now.
  const DASH_CHART_TYPES = [
    {v:'bar', l:'Bar'}, {v:'line', l:'Line'}, {v:'area', l:'Area'},
    {v:'scatter', l:'Scatter'}, {v:'histogram', l:'Histogram'},
    {v:'pie', l:'Pie'}, {v:'doughnut', l:'Donut'},
    {v:'radar', l:'Radar'}, {v:'boxplot', l:'Box plot'}
  ];

  let dashboardCards = loadDashboardCards();
  let dashboardChartInstances = {};
  let activeView = 'single';

  function loadDashboardCards(){
    if(!historyAvailable) return [];
    try{
      const raw = localStorage.getItem(DASHBOARD_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch(e){ return []; }
  }

  function saveDashboardCards(){
    if(!historyAvailable) return;
    try{
      const slim = dashboardCards.map(c => ({ id:c.id, type:c.type, x:c.x, y:c.y, is3D:!!c.is3D, showValues:c.showValues, colors:c.colors || {} }));
      localStorage.setItem(DASHBOARD_KEY, JSON.stringify(slim));
    } catch(e){}
  }

  function dashId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  function cardUsesY(type){ return !(type === 'pie' || type === 'doughnut' || type === 'histogram' || type === 'radar'); }
  function card3DSupported(type){ return ['bar','histogram','pie','doughnut'].includes(type); }
  // Chart types where a raw number can be drawn directly on the chart without
  // just cluttering it (scatter/boxplot/radar/heatmap are left to their tooltips).
  function valueLabelsSupported(type){ return ['pie','doughnut','bar','histogram','line','area'].includes(type); }
  // Pie/donut default ON (that's the gap being fixed here); other supported
  // types default OFF and are opt-in via the toolbar toggle.
  function cardShowsValues(card){
    if(!valueLabelsSupported(card.type)) return false;
    if(card.type === 'pie' || card.type === 'doughnut') return card.showValues !== false;
    return !!card.showValues;
  }
  function cardXOptions(type){
    const numericCols = columns.filter(c => c.type === 'number');
    const catCols = columns.filter(c => c.type !== 'number');
    if(type === 'scatter' || type === 'histogram') return numericCols.length ? numericCols : columns;
    // Pie/donut just count occurrences of whatever's picked, so — same as the
    // single-chart view — any column (numeric or not) is a valid grouping key.
    if(type === 'pie' || type === 'doughnut') return columns;
    return catCols.length ? catCols : columns;
  }
  function cardYOptions(){
    const numericCols = columns.filter(c => c.type === 'number');
    return numericCols.length ? numericCols : columns;
  }

  function defaultCardConfig(){
    const xOpts = cardXOptions('bar'), yOpts = cardYOptions();
    return { id: dashId(), type: 'bar', x: (xOpts[0] && xOpts[0].name) || '', y: (yOpts[0] && yOpts[0].name) || '', is3D: false, colors: {} };
  }

  function addDashboardCard(){
    if(!columns.length) return;
    dashboardCards.push(defaultCardConfig());
    saveDashboardCards();
    renderDashboardGrid();
  }

  function removeDashboardCard(id){
    dashboardCards = dashboardCards.filter(c => c.id !== id);
    if(dashboardChartInstances[id]){ try{ dashboardChartInstances[id].destroy(); }catch(e){} delete dashboardChartInstances[id]; }
    delete dashboardInsightSelections[id];
    saveDashboardCards();
    renderDashboardGrid();
  }

  function clearDashboard(){
    if(!dashboardCards.length) return;
    if(!confirm('Remove every chart from this dashboard? This cannot be undone.')) return;
    Object.values(dashboardChartInstances).forEach(c => { try{ c.destroy(); }catch(e){} });
    dashboardChartInstances = {};
    dashboardInsightSelections = {};
    dashboardCards = [];
    saveDashboardCards();
    renderDashboardGrid();
  }

  function dashTypeOptionsHtml(selected){
    return DASH_CHART_TYPES.map(t => `<option value="${t.v}" ${t.v===selected?'selected':''}>${t.l}</option>`).join('');
  }
  function dashColOptionsHtml(cols, selected){
    return cols.map(c => `<option value="${escapeHtml(c.name)}" ${c.name===selected?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  }

  function cardTemplate(card){
    const xOpts = cardXOptions(card.type);
    if(!xOpts.some(c => c.name === card.x)) card.x = (xOpts[0] && xOpts[0].name) || '';
    const yOpts = cardYOptions();
    if(cardUsesY(card.type) && !yOpts.some(c => c.name === card.y)) card.y = (yOpts[0] && yOpts[0].name) || '';
    const supports3D = card3DSupported(card.type);
    if(!supports3D) card.is3D = false;
    const supportsValues = valueLabelsSupported(card.type);
    const showsValues = cardShowsValues(card);
    return `
      <div class="dash-card" data-id="${card.id}">
        <div class="dash-card-head">
          <select class="dcType">${dashTypeOptionsHtml(card.type)}</select>
          <select class="dcX">${dashColOptionsHtml(xOpts, card.x)}</select>
          <select class="dcY" style="${cardUsesY(card.type) ? '' : 'display:none;'}">${dashColOptionsHtml(yOpts, card.y)}</select>
        </div>
        <div class="dash-card-toolbar">
          <button type="button" class="dash-icon-btn dcColors" title="Customize this chart's colors">◐ Colors</button>
          <button type="button" class="dash-icon-btn dc3D${card.is3D ? ' active' : ''}" title="Toggle 3D chart style" ${supports3D ? '' : 'disabled'}>▦ 3D</button>
          <button type="button" class="dash-icon-btn dcValues${showsValues ? ' active' : ''}" title="Toggle numeric value labels on the chart" ${supportsValues ? '' : 'disabled'}># Values</button>
          <button type="button" class="dash-icon-btn dcExportPng" title="Export this chart as PNG">⭳ PNG</button>
          <button type="button" class="dash-icon-btn dcExportPdf" title="Export this chart as PDF">⭳ PDF</button>
          <button type="button" class="dash-icon-btn dcExportHtml" title="Export this chart as a standalone HTML file">⭳ HTML</button>
          <button type="button" class="dash-remove" title="Remove chart">✕</button>
        </div>
        <div class="dash-color-panel">
          <div class="color-panel-head">
            <span>Series colors</span>
            <button type="button" class="btn ghost small dcResetColors">Reset defaults</button>
          </div>
          <div class="color-swatches"></div>
        </div>
        <div class="dash-card-body"><canvas></canvas></div>
        <div class="dash-insight"></div>
      </div>`;
  }

  function wireCard(card){
    const el = document.querySelector(`.dash-card[data-id="${card.id}"]`);
    if(!el) return;
    el.querySelector('.dcType').addEventListener('change', e => {
      card.type = e.target.value;
      saveDashboardCards();
      renderDashboardGrid(); // Y visibility / valid X-column set can change with type
    });
    el.querySelector('.dcX').addEventListener('change', e => {
      card.x = e.target.value; saveDashboardCards(); renderDashboardCardChart(card);
    });
    const yEl = el.querySelector('.dcY');
    if(yEl) yEl.addEventListener('change', e => {
      card.y = e.target.value; saveDashboardCards(); renderDashboardCardChart(card);
    });
    const btn3D = el.querySelector('.dc3D');
    if(btn3D && !btn3D.disabled){
      btn3D.addEventListener('click', () => {
        card.is3D = !card.is3D;
        btn3D.classList.toggle('active', card.is3D);
        saveDashboardCards();
        renderDashboardCardChart(card);
      });
    }
    const btnValues = el.querySelector('.dcValues');
    if(btnValues && !btnValues.disabled){
      btnValues.addEventListener('click', () => {
        card.showValues = !cardShowsValues(card);
        btnValues.classList.toggle('active', card.showValues);
        saveDashboardCards();
        renderDashboardCardChart(card);
      });
    }
    el.querySelector('.dash-remove').addEventListener('click', () => removeDashboardCard(card.id));
    el.querySelector('.dcExportPng').addEventListener('click', () => exportCardPng(card));
    el.querySelector('.dcExportPdf').addEventListener('click', () => exportCardPdf(card));
    el.querySelector('.dcExportHtml').addEventListener('click', () => exportCardHtml(card));

    const colorPanel = el.querySelector('.dash-color-panel');
    const btnColors = el.querySelector('.dcColors');
    if(btnColors && colorPanel){
      btnColors.addEventListener('click', () => {
        const willOpen = !colorPanel.classList.contains('open');
        colorPanel.classList.toggle('open', willOpen);
        btnColors.classList.toggle('active', willOpen);
        if(willOpen) renderCardColorSwatches(card, colorPanel);
      });
    }
    const resetColorsBtn = el.querySelector('.dcResetColors');
    if(resetColorsBtn){
      resetColorsBtn.addEventListener('click', () => {
        card.colors = {};
        saveDashboardCards();
        renderDashboardCardChart(card);
        if(colorPanel) renderCardColorSwatches(card, colorPanel);
      });
    }
  }

  // Which labels/categories the color panel should offer swatches for, based
  // on what's actually plotted right now (read straight off the live Chart.js
  // instance so it always matches the current data — no duplicated grouping
  // logic to keep in sync). Returns null for single-series chart types
  // (line/area/scatter/histogram/boxplot), which get one flat swatch instead.
  function cardColorTargets(card){
    const inst = dashboardChartInstances[card.id];
    if(!inst || !inst.data) return null;
    if(card.type === 'pie' || card.type === 'doughnut') return (inst.data.labels || []).slice();
    if(card.type === 'radar') return (inst.data.datasets || []).map(d => d.label);
    if(card.type === 'bar') return (inst.data.labels || []).slice();
    return null;
  }

  // Per-card color accessors — a card with no overrides falls back to the same
  // index-based default palette the dashboard always used.
  function cardAccentColor(card, colorIndex){
    return (card.colors && card.colors.single) || paletteColor(colorIndex);
  }
  function cardCatColor(card, label, i){
    return (card.colors && card.colors.byLabel && card.colors.byLabel[label]) || paletteColor(i);
  }

  function renderCardColorSwatches(card, panel){
    const box = panel.querySelector('.color-swatches');
    if(!box) return;
    const labels = cardColorTargets(card);
    if(labels && labels.length){
      box.innerHTML = `
        <div class="swatch">
          <button type="button" class="color-chip" data-all="1" data-color="${paletteColor(0)}"></button>
          <span>All</span>
        </div>` + labels.map((label, i) => {
        const color = cardCatColor(card, label, i);
        const short = String(label).length > 9 ? String(label).slice(0,8) + '…' : String(label);
        return `
        <div class="swatch">
          <button type="button" class="color-chip" data-label="${escapeHtml(String(label))}" data-color="${color}"></button>
          <span title="${escapeHtml(String(label))}">${escapeHtml(short)}</span>
        </div>`;
      }).join('');

      initColorChip(box.querySelector('.color-chip[data-all]'), (hex) => {
        card.colors = card.colors || {}; card.colors.byLabel = card.colors.byLabel || {};
        labels.forEach(l => { card.colors.byLabel[l] = hex; });
        box.querySelectorAll('.color-chip[data-label]').forEach(chip => { chip.dataset.color = hex; chip.style.background = hex; });
        saveDashboardCards();
        renderDashboardCardChart(card);
      });
      box.querySelectorAll('.color-chip[data-label]').forEach(chip => {
        initColorChip(chip, (hex) => {
          card.colors = card.colors || {}; card.colors.byLabel = card.colors.byLabel || {};
          card.colors.byLabel[chip.dataset.label] = hex;
          saveDashboardCards();
          renderDashboardCardChart(card);
        });
      });
    } else {
      const singleLabel = card.type === 'histogram' ? 'Bars' : card.type === 'scatter' ? 'Points' :
        card.type === 'boxplot' ? 'Boxes' : 'Line';
      const color = (card.colors && card.colors.single) || paletteColor(0);
      box.innerHTML = `
        <div class="swatch">
          <button type="button" class="color-chip" data-color="${color}"></button>
          <span>${singleLabel}</span>
        </div>`;
      initColorChip(box.querySelector('.color-chip'), (hex) => {
        card.colors = card.colors || {};
        card.colors.single = hex;
        saveDashboardCards();
        renderDashboardCardChart(card);
      });
    }
  }

  function renderDashboardGrid(){
    const grid = $('dashboardGrid'), empty = $('dashboardEmpty');
    if(!grid || !empty) return;
    if(!columns.length){
      grid.innerHTML = '';
      empty.style.display = 'block';
      empty.innerHTML = 'Load a dataset to start building a dashboard.';
      return;
    }
    if(!dashboardCards.length){
      grid.innerHTML = '';
      empty.style.display = 'block';
      empty.innerHTML = 'No charts yet — tap <strong>+ Add chart</strong> to build your dashboard. Charts and their settings are saved automatically in this browser.';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = dashboardCards.map(cardTemplate).join('');
    dashboardCards.forEach(card => { wireCard(card); renderDashboardCardChart(card); });
  }

  // Which insight lines are ticked "include in export" per card, keyed by card id.
  // Missing entry / length mismatch (chart type just changed) defaults to "all on".
  let dashboardInsightSelections = {};

  function renderDashboardCardChart(card){
    const el = document.querySelector(`.dash-card[data-id="${card.id}"]`);
    if(!el) return;
    const canvas = el.querySelector('canvas'), insightEl = el.querySelector('.dash-insight');
    if(dashboardChartInstances[card.id]){ try{ dashboardChartInstances[card.id].destroy(); }catch(e){} delete dashboardChartInstances[card.id]; }
    const idx = dashboardCards.indexOf(card);
    const built = buildDashboardChartConfig(card, idx < 0 ? 0 : idx);
    if(!built){ insightEl.innerHTML = ''; insightEl.dataset.items = ''; insightEl.appendChild(Object.assign(document.createElement('div'), { className:'dash-insight-item', textContent:'Not enough data for this chart yet.' })); return; }
    dashboardChartInstances[card.id] = new Chart(canvas.getContext('2d'), built.config);
    const items = (Array.isArray(built.insight) ? built.insight : [built.insight]).filter(Boolean);
    insightEl.dataset.items = JSON.stringify(items);
    let sel = dashboardInsightSelections[card.id];
    if(!sel || sel.length !== items.length) sel = dashboardInsightSelections[card.id] = items.map(() => true);
    const head = items.length > 1 ? '<div class="dash-insight-head">Insights — tick to include in export</div>' : '';
    insightEl.innerHTML = head + items.map((t, i) => `
      <label class="dash-insight-item${sel[i] ? '' : ' di-off'}">
        <input type="checkbox" data-di-idx="${i}" ${sel[i] ? 'checked' : ''}>
        <span>${escapeHtml(t)}</span>
      </label>`).join('');
    insightEl.querySelectorAll('input[data-di-idx]').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.getAttribute('data-di-idx'), 10);
        dashboardInsightSelections[card.id][i] = cb.checked;
        cb.closest('.dash-insight-item').classList.toggle('di-off', !cb.checked);
      });
    });
  }

  // The full set of insight lines for a card, regardless of export selection —
  // used to know how many exist / reset selections when the chart changes.
  function cardInsightItems(id){
    const el = document.querySelector(`.dash-card[data-id="${id}"] .dash-insight`);
    if(!el || !el.dataset.items) return [];
    try{ return JSON.parse(el.dataset.items); } catch(e){ return []; }
  }

  // Only the lines currently ticked "include in export" — what PNG/PDF/composite
  // exports should actually use.
  function cardSelectedInsightItems(id){
    const items = cardInsightItems(id);
    const sel = dashboardInsightSelections[id];
    if(!sel) return items;
    return items.filter((_, i) => sel[i] !== false);
  }

  // Builds a Chart.js config + one-line insight for a single dashboard card.
  // Deliberately simpler than the single-chart engine above (no color pickers,
  // 3D toggle, trend overlay, or click-to-filter) — each card is a compact,
  // self-contained readout.
  function buildDashboardChartConfig(card, colorIndex){
    const type = card.type, xCol = card.x, yCol = card.y;
    if(!xCol || !dataset.length) return null;
    const accent = cardAccentColor(card, colorIndex);
    const baseOpts = {
      responsive:true, maintainAspectRatio:false,
      animation:{ duration:280, easing:'easeOutQuad' },
      plugins:{ legend:{ display:false } }
    };
    const axisOpts = {
      scales:{
        x:{ ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:9}, maxRotation:40 }, grid:{ color:'#1D2129' } },
        y:{ ticks:{ color:'#565C68', font:{family:"'IBM Plex Mono', monospace", size:9} }, grid:{ color:'#1D2129' } }
      }
    };
    const legendBottom = { legend:{ display:true, position:'bottom', labels:{ color:'#8B909B', font:{family:"'IBM Plex Mono', monospace", size:9}, boxWidth:10 } } };

    if(type === 'pie' || type === 'doughnut'){
      const counts = {};
      dataset.forEach(r => { const k = String(r[xCol] ?? '—'); counts[k] = (counts[k]||0)+1; });
      const allEntries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
      const entries = allEntries.slice(0,8);
      if(!entries.length) return null;
      const total = entries.reduce((a,e)=>a+e[1],0);
      const [topLabel, topCount] = entries[0];
      const pct = total ? Math.round((topCount/total)*100) : 0;
      const showsValues = cardShowsValues(card);
      const insight = [`"${topLabel}" leads ${xCol} at ${pct}% of records (${topCount.toLocaleString()} of ${total.toLocaleString()}).`];
      insight.push(`${allEntries.length} distinct ${xCol} values${allEntries.length > entries.length ? `, top ${entries.length} shown` : ''}.`);
      if(entries.length > 1){
        const [runnerLabel, runnerCount] = entries[1];
        const runnerPct = total ? Math.round((runnerCount/total)*100) : 0;
        insight.push(`Runner-up: "${runnerLabel}" at ${runnerPct}%.`);
      }
      return {
        config:{ type, data:{ labels: entries.map(e=>e[0]), datasets:[{ data: entries.map(e=>e[1]), backgroundColor: entries.map((e,i)=>cardCatColor(card, e[0], i)) }] },
          options:{ ...baseOpts,
            layout: card.is3D ? { padding:{ bottom: 34 } } : undefined,
            plugins:{ ...legendBottom, pseudo3d:{ enabled: !!card.is3D, depth: 10 },
              valueLabels:{ enabled: showsValues, showPercent: true } } } },
        insight
      };
    }

    if(type === 'radar'){
      const metricCols = columns.filter(c => c.type === 'number').slice(0,6);
      if(!metricCols.length) return null;
      const groups = {};
      dataset.forEach(r => {
        const k = String(r[xCol] ?? '—');
        if(!groups[k]) groups[k] = metricCols.map(() => ({sum:0,count:0}));
        metricCols.forEach((c,i) => { const v = parseFloat(r[c.name]); if(!isNaN(v)){ groups[k][i].sum += v; groups[k][i].count++; } });
      });
      const cats = Object.keys(groups).slice(0,4);
      if(!cats.length) return null;
      const datasets = cats.map((k,i) => {
        const color = cardCatColor(card, k, i);
        return { label:k, data: groups[k].map(g => g.count ? g.sum/g.count : 0), backgroundColor: hexToRgba(color,0.15), borderColor: color, pointBackgroundColor: color, borderWidth:1.5 };
      });
      let best = cats[0], bestAvg = -Infinity, worst = cats[0], worstAvg = Infinity;
      cats.forEach(k => {
        const vals = groups[k].filter(x => x.count).map(x => x.sum/x.count);
        const avg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
        if(avg !== null && avg > bestAvg){ bestAvg = avg; best = k; }
        if(avg !== null && avg < worstAvg){ worstAvg = avg; worst = k; }
      });
      const insight = [`"${best}" scores highest on average across the plotted metrics.`];
      if(worst !== best) insight.push(`"${worst}" scores lowest on average.`);
      insight.push(`Comparing ${cats.length} of ${Object.keys(groups).length} ${xCol} groups across ${metricCols.length} metrics.`);
      return {
        config:{ type:'radar', data:{ labels: metricCols.map(c=>c.name), datasets },
          options:{ responsive:true, maintainAspectRatio:false, plugins: legendBottom,
            scales:{ r:{ angleLines:{ color:'#1D2129' }, grid:{ color:'#1D2129' }, pointLabels:{ color:'#8B909B', font:{size:9} }, ticks:{ color:'#565C68', backdropColor:'transparent', font:{size:8} } } } } },
        insight
      };
    }

    if(type === 'histogram'){
      const values = dataset.map(r => parseFloat(r[xCol])).filter(v => !isNaN(v));
      if(!values.length) return null;
      const bins = 10;
      const min = Math.min(...values), max = Math.max(...values);
      const span = (max-min) || 1, width = span/bins;
      const counts = new Array(bins).fill(0);
      values.forEach(v => { let idx = Math.floor((v-min)/width); if(idx>=bins) idx=bins-1; if(idx<0) idx=0; counts[idx]++; });
      const labels = counts.map((_,i) => `${fmtAxis(min+i*width)}–${fmtAxis(min+(i+1)*width)}`);
      const maxIdx = counts.indexOf(Math.max(...counts));
      const pct = values.length ? Math.round((counts[maxIdx]/values.length)*100) : 0;
      const showsValues = cardShowsValues(card);
      const insight = [`Most ${xCol} values fall in ${labels[maxIdx]} (${pct}% of records).`];
      insight.push(`${xCol} ranges from ${fmtAxis(min)} to ${fmtAxis(max)} across ${values.length.toLocaleString()} values.`);
      return {
        config:{ type:'bar', data:{ labels, datasets:[{ data:counts, backgroundColor:accent, borderColor:accent, borderWidth:1, categoryPercentage:1, barPercentage:1 }] },
          options:{ ...baseOpts, ...axisOpts,
            layout: card.is3D ? { padding:{ top: 10, right: 10 } } : undefined,
            plugins:{ ...baseOpts.plugins, pseudo3d:{ enabled: !!card.is3D, depth: 8 }, valueLabels:{ enabled: showsValues } } } },
        insight
      };
    }

    if(!yCol) return null;

    if(type === 'scatter'){
      const points = dataset.map(r => ({x:parseFloat(r[xCol]), y:parseFloat(r[yCol])})).filter(p => !isNaN(p.x) && !isNaN(p.y));
      if(!points.length) return null;
      const r = points.length >= 2 ? pearsonCorrelation(xCol, yCol) : null;
      const xs = points.map(p=>p.x);
      const insight = [r !== null
        ? `${corrStrength(r).charAt(0).toUpperCase()+corrStrength(r).slice(1)} ${r>=0?'positive':'negative'} relationship (r=${r.toFixed(2)}).`
        : `${points.length.toLocaleString()} points plotted.`];
      insight.push(`${points.length.toLocaleString()} points — ${xCol} spans ${fmtAxis(Math.min(...xs))} to ${fmtAxis(Math.max(...xs))}.`);
      return {
        config:{ type:'scatter', data:{ datasets:[{ label:`${yCol} vs ${xCol}`, data: points, backgroundColor: accent }] }, options:{ ...baseOpts, ...axisOpts } },
        insight
      };
    }

    if(type === 'boxplot'){
      if(!window.Chart || !Chart.registry.controllers.get('boxplot')) return null;
      const groups = {};
      dataset.forEach(r => { const k = String(r[xCol] ?? '—'); const v = parseFloat(r[yCol]); if(!isNaN(v)) (groups[k] = groups[k]||[]).push(v); });
      const labels = Object.keys(groups).filter(k => groups[k].length).slice(0,12);
      if(!labels.length) return null;
      const medianOf = k => { const vals = groups[k].slice().sort((a,b)=>a-b); const mid = Math.floor(vals.length/2); return vals.length%2 ? vals[mid] : (vals[mid-1]+vals[mid])/2; };
      let best = labels[0], bestMed = -Infinity, worst = labels[0], worstMed = Infinity;
      labels.forEach(k => { const m = medianOf(k); if(m > bestMed){ bestMed = m; best = k; } if(m < worstMed){ worstMed = m; worst = k; } });
      const insight = [`"${best}" has the highest median ${yCol} at ${fmt(bestMed)}.`];
      if(worst !== best) insight.push(`"${worst}" has the lowest median ${yCol} at ${fmt(worstMed)}.`);
      return {
        config:{ type:'boxplot', data:{ labels, datasets:[{ data: labels.map(k=>groups[k]), backgroundColor: hexToRgba(accent,0.3), borderColor: accent, borderWidth:1.5, outlierColor:'#E0665A', itemRadius:2 }] },
          options:{ ...baseOpts, ...axisOpts } },
        insight
      };
    }

    // bar / line / area — mean of y grouped by x
    const groups = {};
    dataset.forEach(r => { const k = String(r[xCol] ?? '—'); const v = parseFloat(r[yCol]); if(!groups[k]) groups[k]=[]; if(!isNaN(v)) groups[k].push(v); });
    let labels = Object.keys(groups);
    if(labels.length > 20) labels = labels.slice(0,20);
    if(!labels.length) return null;
    const values = labels.map(k => computeGroupStats(groups[k]).mean);
    const chartJsType = type === 'area' ? 'line' : type;
    const isBar = chartJsType === 'bar';
    const barColors = isBar ? labels.map((k,i) => cardCatColor(card, k, i)) : null;
    const fillRgb = hexToRgb(accent);
    let best = labels[0], bestVal = -Infinity, worst = labels[0], worstVal = Infinity;
    values.forEach((v,i) => { if(v > bestVal){ bestVal = v; best = labels[i]; } if(v < worstVal){ worstVal = v; worst = labels[i]; } });
    const overallAvg = values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;
    const showsValues = cardShowsValues(card);
    const insight = [`"${best}" has the highest average ${yCol} at ${fmt(bestVal)}.`];
    if(worst !== best) insight.push(`"${worst}" has the lowest average ${yCol} at ${fmt(worstVal)}.`);
    insight.push(`Overall average ${yCol} across ${labels.length} ${xCol} groups: ${fmt(overallAvg)}.`);
    return {
      config:{ type: chartJsType, data:{ labels, datasets:[{ label:yCol, data: values,
        backgroundColor: isBar ? barColors : `rgba(${fillRgb.r},${fillRgb.g},${fillRgb.b},0.2)`,
        borderColor: isBar ? barColors : accent, borderWidth:2, pointBackgroundColor: accent, pointRadius: isBar?0:2, tension:0.25, fill: (type==='line'||type==='area') }] },
        options:{ ...baseOpts, ...axisOpts,
          layout: (card.is3D && isBar) ? { padding:{ top: 10, right: 10 } } : undefined,
          plugins:{ ...baseOpts.plugins, pseudo3d:{ enabled: !!(card.is3D && isBar), depth: 8 }, valueLabels:{ enabled: showsValues } } } },
      insight
    };
  }

  // ---------- Dashboard export ----------
  function getDashExportBg(){
    const el = $('dashExportBg');
    return (el && el.value) || '#171B22';
  }

  function cardTitle(card){
    const typeLabel = (DASH_CHART_TYPES.find(t => t.v === card.type) || {}).l || card.type;
    const yPart = cardUsesY(card.type) && card.y ? ` vs ${card.y}` : '';
    return `${typeLabel} — ${card.x}${yPart}`;
  }

  // Chart.js renders on a transparent canvas; flatten onto a solid background
  // first so exported images/PDFs aren't see-through in other viewers.
  function flattenCanvas(srcCanvas, bg){
    const flat = document.createElement('canvas');
    flat.width = srcCanvas.width; flat.height = srcCanvas.height;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = bg; fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(srcCanvas, 0, 0);
    return flat;
  }

  // Dashboard cards are themed for a dark canvas (gray text/gridlines) by default.
  // On a light export background those would be nearly invisible, so temporarily
  // recolor the instance's own text/grid options, run the capture, then restore —
  // same approach as the single-chart exporter above.
  function withExportRecolor(inst, bg, captureFn){
    const light = isLightColor(bg);
    if(!light) return captureFn();
    const o = inst.options;
    const saved = [];
    const setColor = (obj, key, val) => { if(obj && obj[key] !== undefined){ saved.push([obj, key, obj[key]]); obj[key] = val; } };
    if(o.plugins && o.plugins.legend && o.plugins.legend.labels) setColor(o.plugins.legend.labels, 'color', '#14151C');
    if(o.scales){
      ['x','y','r'].forEach(ax => {
        const scale = o.scales[ax];
        if(!scale) return;
        if(scale.ticks) setColor(scale.ticks, 'color', '#3A3F47');
        if(scale.grid) setColor(scale.grid, 'color', '#D8DCE3');
        if(scale.angleLines) setColor(scale.angleLines, 'color', '#D8DCE3');
        if(scale.pointLabels) setColor(scale.pointLabels, 'color', '#3A3F47');
      });
    }
    inst.update('none');
    const result = captureFn();
    saved.forEach(([obj, key, val]) => { obj[key] = val; });
    inst.update('none');
    return result;
  }

  // Combines the devicePixelRatio bump (sharper backing store), the light-theme
  // recolor, and the transparent->solid flatten into one step, used by every
  // dashboard-card and composite export below so files stay crisp at any zoom.
  function captureHiResFlat(inst, bg){
    const prevDpr = inst.options.devicePixelRatio;
    inst.options.devicePixelRatio = CHART_EXPORT_SCALE;
    inst.resize();
    const flat = withExportRecolor(inst, bg, () => flattenCanvas(inst.canvas, bg));
    inst.options.devicePixelRatio = prevDpr;
    inst.resize();
    return flat;
  }

  function runExport(btn, fn){
    if(!btn) { fn(); return; }
    const prevLabel = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="btn-ic">…</span> Exporting';
    Promise.resolve().then(fn).then(() => {
      btn.innerHTML = '<span class="btn-ic">✓</span> Exported';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = prevLabel; }, 1700);
    }).catch(err => {
      showErr((err && err.message) || 'Could not export this chart.');
      btn.disabled = false; btn.innerHTML = prevLabel;
    });
  }

  function downloadDataUrl(dataUrl, filename){
    return saveExportBlob(dataUrlToBlob(dataUrl), filename);
  }

  function exportCardPng(card){
    const el = document.querySelector(`.dash-card[data-id="${card.id}"]`);
    const btn = el ? el.querySelector('.dcExportPng') : null;
    runExport(btn, () => {
      const inst = dashboardChartInstances[card.id];
      if(!inst) throw new Error('Nothing to export yet.');
      const bg = getDashExportBg();
      const flat = captureHiResFlat(inst, bg);
      const composed = composeCaptionCanvas(flat, bg, cardSelectedInsightItems(card.id));
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return downloadDataUrl(composed.toDataURL('image/png'), `readeout-${card.type}-${stamp}.png`);
    });
  }

  function exportCardPdf(card){
    const el = document.querySelector(`.dash-card[data-id="${card.id}"]`);
    const btn = el ? el.querySelector('.dcExportPdf') : null;
    runExport(btn, () => {
      const inst = dashboardChartInstances[card.id];
      if(!inst) throw new Error('Nothing to export yet.');
      const jsPDFLib = window.jspdf && window.jspdf.jsPDF;
      if(!jsPDFLib) throw new Error('PDF export library failed to load.');

      const bg = getDashExportBg();
      const light = isLightColor(bg);
      const flat = captureHiResFlat(inst, bg);
      const insightItems = cardSelectedInsightItems(card.id);
      const margin = 28, headerH = 48;
      const imgRatio = flat.width / flat.height;
      const pageW = imgRatio >= 1 ? 620 : 460;
      const imgW = pageW - margin*2;
      const imgH = imgW / imgRatio;

      const capFontSize = 10.5, capLineHeight = 15, itemGap = 6;
      const measureDoc = new jsPDFLib({ unit:'pt', format:[pageW, 1000] });
      measureDoc.setFont('helvetica','normal'); measureDoc.setFontSize(capFontSize);
      const wrappedItems = insightItems.map(text => measureDoc.splitTextToSize(text, imgW - 18));
      const totalLines = wrappedItems.reduce((a,l) => a + l.length, 0);
      const capH = totalLines ? (16 + totalLines*capLineHeight + (wrappedItems.length-1)*itemGap + 16) : 0;
      const pageH = Math.round(headerH + imgH + capH + margin*2);

      const doc = new jsPDFLib({ orientation: pageW >= pageH ? 'landscape' : 'portrait', unit:'pt', format:[pageW, pageH] });
      const bgRgb = hexToRgb(bg);
      doc.setFillColor(bgRgb.r, bgRgb.g, bgRgb.b); doc.rect(0, 0, pageW, pageH, 'F');

      const textRgb = hexToRgb(light ? '#14151C' : '#E9E7E2'), dimRgb = hexToRgb(light ? '#5B6169' : '#8B909B');
      doc.setFont('courier','bold'); doc.setFontSize(13); doc.setTextColor(textRgb.r, textRgb.g, textRgb.b);
      doc.text('READEOUT', margin, margin + 10);
      doc.setFont('courier','normal'); doc.setFontSize(9); doc.setTextColor(dimRgb.r, dimRgb.g, dimRgb.b);
      doc.text(cardTitle(card), margin, margin + 25);
      doc.text(new Date().toLocaleString(), pageW - margin, margin + 10, { align:'right' });

      doc.addImage(flat.toDataURL('image/png'), 'PNG', margin, headerH, imgW, imgH);

      if(totalLines){
        const capY0 = headerH + imgH;
        const dividerRgb = hexToRgb(light ? '#D8DCE3' : '#262B33');
        doc.setDrawColor(dividerRgb.r, dividerRgb.g, dividerRgb.b); doc.setLineWidth(0.75);
        doc.line(margin, capY0, pageW - margin, capY0);
        const accentRgb = hexToRgb('#5FD4C0');
        doc.setFont('helvetica','normal'); doc.setFontSize(capFontSize); doc.setTextColor(textRgb.r, textRgb.g, textRgb.b);
        let y = capY0 + 24;
        wrappedItems.forEach(lines => {
          doc.setFillColor(accentRgb.r, accentRgb.g, accentRgb.b);
          doc.circle(margin + 4, y - 3, 3, 'F');
          doc.setTextColor(textRgb.r, textRgb.g, textRgb.b);
          lines.forEach((line, i) => doc.text(line, margin + 16, y + i*capLineHeight));
          y += lines.length*capLineHeight + itemGap;
        });
      }

      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return saveExportBlob(doc.output('blob'), `readeout-${card.type}-${stamp}.pdf`);
    });
  }

  function exportCardHtml(card){
    const el = document.querySelector(`.dash-card[data-id="${card.id}"]`);
    const btn = el ? el.querySelector('.dcExportHtml') : null;
    runExport(btn, () => {
      const inst = dashboardChartInstances[card.id];
      if(!inst) throw new Error('Nothing to export yet.');
      const bg = getDashExportBg();
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      const html = buildLiveExportHtml({
        pageTitle: cardTitle(card), bg,
        panels: [{ title: cardTitle(card), spec: chartConfigForExport(inst), insights: cardSelectedInsightItems(card.id) }]
      });
      return saveExportBlob(new Blob([html], { type: 'text/html' }), `readeout-${card.type}-${stamp}.html`);
    });
  }

  // Stitches every card's current chart + insight into one composite canvas,
  // laid out in the same 2-column grid rhythm as the on-screen dashboard.
  function buildDashboardCompositeCanvas(bg){
    const cards = dashboardCards.filter(c => dashboardChartInstances[c.id]);
    if(!cards.length) return null;

    const light = isLightColor(bg);
    const textColor = light ? '#14151C' : '#E9E7E2';
    const dimColor = light ? '#5B6169' : '#8B909B';
    const panelColor = light ? '#F1F3F6' : '#171B22';
    const borderColor = light ? '#D8DCE3' : '#262B33';
    const accent = '#5FD4C0';
    const cols = cards.length === 1 ? 1 : 2;
    const tileW = 640, chartH = 320, pad = 20, titleH = 30, gap = 20, headerH = 64;
    const insightFontSize = 15, insightLineHeight = 20;

    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `500 ${insightFontSize}px Arial, sans-serif`;
    const maxTextW = tileW - pad*2 - 18;

    const itemGap = 8;
    const tiles = cards.map(card => {
      const inst = dashboardChartInstances[card.id];
      const insightItems = cardSelectedInsightItems(card.id);
      const wrappedItems = insightItems.map(text => {
        const words = text.split(' ');
        const lines = []; let cur = '';
        words.forEach(w => {
          const test = cur ? cur + ' ' + w : w;
          if(measure.measureText(test).width > maxTextW && cur){ lines.push(cur); cur = w; } else cur = test;
        });
        if(cur) lines.push(cur);
        return lines;
      });
      const totalLines = wrappedItems.reduce((a,l) => a + l.length, 0);
      const insightH = totalLines ? (totalLines*insightLineHeight + (wrappedItems.length-1)*itemGap + 20) : 8;
      const flatCanvas = captureHiResFlat(inst, bg);
      return { card, flatCanvas, wrappedItems, tileH: titleH + chartH + insightH + pad*2 };
    });

    const rows = Math.ceil(tiles.length / cols);
    const rowHeights = [];
    for(let r = 0; r < rows; r++){
      rowHeights.push(Math.max(...tiles.slice(r*cols, r*cols+cols).map(t => t.tileH)));
    }
    const totalW = cols*tileW + (cols+1)*gap;
    const totalH = headerH + rowHeights.reduce((a,b)=>a+b,0) + (rows+1)*gap;

    // Back the composite canvas with extra pixel density so headers, titles,
    // and insight text stay crisp — everything below is still drawn in the
    // same logical totalW x totalH coordinate space, just at a higher DPI.
    const out = document.createElement('canvas');
    out.width = totalW * DASHBOARD_EXPORT_SCALE; out.height = totalH * DASHBOARD_EXPORT_SCALE;
    const ctx = out.getContext('2d');
    ctx.scale(DASHBOARD_EXPORT_SCALE, DASHBOARD_EXPORT_SCALE);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, totalW, totalH);

    ctx.fillStyle = textColor;
    ctx.font = `700 20px 'Courier New', monospace`;
    ctx.fillText('READEOUT — DASHBOARD', gap, 32);
    ctx.fillStyle = dimColor;
    ctx.font = `12px 'Courier New', monospace`;
    ctx.fillText(`${cards.length} chart${cards.length===1?'':'s'} · ${new Date().toLocaleString()}`, gap, 50);

    let y = headerH + gap;
    for(let r = 0; r < rows; r++){
      let x = gap;
      const rowTiles = tiles.slice(r*cols, r*cols+cols);
      const rh = rowHeights[r];
      rowTiles.forEach(t => {
        ctx.fillStyle = panelColor;
        ctx.fillRect(x, y, tileW, rh);
        ctx.strokeStyle = borderColor; ctx.lineWidth = 1;
        ctx.strokeRect(x+0.5, y+0.5, tileW-1, rh-1);

        ctx.fillStyle = textColor;
        ctx.font = `600 15px Arial, sans-serif`;
        ctx.fillText(cardTitle(t.card), x+pad, y+pad+11);

        const cw = tileW - pad*2;
        ctx.drawImage(t.flatCanvas, x+pad, y+titleH+pad-6, cw, chartH);

        if(t.wrappedItems.length){
          let iy = y + titleH + chartH + pad + 6;
          t.wrappedItems.forEach(lines => {
            ctx.fillStyle = accent;
            ctx.font = `700 14px Arial, sans-serif`;
            ctx.fillText('◆', x+pad, iy);
            ctx.fillStyle = dimColor;
            ctx.font = `${insightFontSize}px Arial, sans-serif`;
            lines.forEach((line, i) => ctx.fillText(line, x+pad+18, iy + i*insightLineHeight));
            iy += lines.length*insightLineHeight + itemGap;
          });
        }
        x += tileW + gap;
      });
      y += rh + gap;
    }
    return out;
  }

  function exportDashboardPng(){
    runExport($('exportDashboardPngBtn'), () => {
      const bg = getDashExportBg();
      const canvas = buildDashboardCompositeCanvas(bg);
      if(!canvas) throw new Error('Add at least one chart to export.');
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return downloadDataUrl(canvas.toDataURL('image/png'), `readeout-dashboard-${stamp}.png`);
    });
  }

  function exportDashboardPdf(){
    runExport($('exportDashboardPdfBtn'), () => {
      const jsPDFLib = window.jspdf && window.jspdf.jsPDF;
      if(!jsPDFLib) throw new Error('PDF export library failed to load.');
      const bg = getDashExportBg();
      const canvas = buildDashboardCompositeCanvas(bg);
      if(!canvas) throw new Error('Add at least one chart to export.');

      const margin = 24;
      const imgRatio = canvas.width / canvas.height;
      const pageW = 760;
      const imgW = pageW - margin*2;
      const imgH = imgW / imgRatio;
      const pageH = imgH + margin*2;

      const doc = new jsPDFLib({ orientation: pageW >= pageH ? 'landscape' : 'portrait', unit:'pt', format:[pageW, pageH] });
      const bgRgb = hexToRgb(bg);
      doc.setFillColor(bgRgb.r, bgRgb.g, bgRgb.b); doc.rect(0, 0, pageW, pageH, 'F');
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, imgW, imgH);

      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      return saveExportBlob(doc.output('blob'), `readeout-dashboard-${stamp}.pdf`);
    });
  }

  function exportDashboardHtml(){
    runExport($('exportDashboardHtmlBtn'), () => {
      const bg = getDashExportBg();
      const cards = dashboardCards.filter(c => dashboardChartInstances[c.id]);
      if(!cards.length) throw new Error('Add at least one chart to export.');
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      // Each card keeps its own live, animated Chart.js instance in the export —
      // laid out in the same responsive grid as the on-screen dashboard, rather
      // than being flattened into one static composite image.
      const panels = cards.map(card => ({
        title: cardTitle(card),
        spec: chartConfigForExport(dashboardChartInstances[card.id]),
        insights: cardSelectedInsightItems(card.id)
      }));
      const html = buildLiveExportHtml({ pageTitle: 'Readeout — Dashboard', bg, panels });
      return saveExportBlob(new Blob([html], { type: 'text/html' }), `readeout-dashboard-${stamp}.html`);
    });
  }

  function setActiveView(view){
    activeView = view;
    $('viewTabSingle').classList.toggle('active', view === 'single');
    $('viewTabDashboard').classList.toggle('active', view === 'dashboard');
    $('singleChartView').style.display = view === 'single' ? '' : 'none';
    $('dashboardView').style.display = view === 'dashboard' ? '' : 'none';
    if(view === 'dashboard') renderDashboardGrid();
  }

  $('viewTabSingle').addEventListener('click', () => setActiveView('single'));
  $('viewTabDashboard').addEventListener('click', () => setActiveView('dashboard'));
  $('addChartBtn').addEventListener('click', addDashboardCard);
  $('clearDashboardBtn').addEventListener('click', clearDashboard);
  $('exportDashboardPngBtn').addEventListener('click', exportDashboardPng);
  $('exportDashboardPdfBtn').addEventListener('click', exportDashboardPdf);
  $('exportDashboardHtmlBtn').addEventListener('click', exportDashboardHtml);
  document.querySelectorAll('#dashExportBgRow .mini-chip').forEach(chip => {
    chip.addEventListener('click', () => { $('dashExportBg').value = chip.dataset.dashBg; });
  });

});

  // Register the PWA service worker (offline caching, installability).
  // Requires being served over HTTPS or localhost — silently no-ops otherwise.
  if('serviceWorker' in navigator){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('Readeout: service worker registration failed', err);
      });
    });
  }
