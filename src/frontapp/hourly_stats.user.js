// ==UserScript==
// @name         Front Analytics – Hourly Stats
// @namespace    https://github.com/dm-alt/USM-scripts
// @version      1.5
// @description  Modal view of hourly Resolution/Reply/First reply with averages. CSV export + snapshot-to-clipboard included.
// @author       Danish Murad
// @license      MIT
// @homepageURL  https://github.com/dm-alt/USM-scripts
// @supportURL   https://github.com/dm-alt/USM-scripts/issues
// @match        https://us-mobile.frontapp.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const log  = (...a) => console.log('%c[Hourly]', 'color:#8cf', ...a);
  const warn = (...a) => console.warn('%c[Hourly]', 'color:#fc8', ...a);

  const HOUR_LABELS_12 = Array.from({length:24}, (_,h)=>{
    const ampm = h<12?'AM':'PM'; const hh = (h%12)||12; return `${hh} ${ampm}`;
  });

  const fmtSec = (s) => {
    if (s == null || !isFinite(s)) return '';
    s = Math.max(0, Math.round(s));
    const d = Math.floor(s/86400); s%=86400;
    const h = Math.floor(s/3600);  s%=3600;
    const m = Math.floor(s/60);    const sec=s%60;
    if (d>0) return `${d}d ${h}h ${m}m ${sec}s`;
    if (h>0) return `${h}h ${m}m ${sec}s`;
    if (m>0) return `${m}m ${sec}s`;
    return `${sec}s`;
  };

  const avg = (arr) => {
    const xs = arr.filter(v => v!=null && isFinite(v));
    return xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : null;
  };

  const toCSV = (rows) => {
    const esc = (v) => {
      const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    return rows.map(r => r.map(esc).join(',')).join('\n');
  };

  const download = (text, name) => {
    const blob = new Blob([text], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  /* ---------- UI: date/inbox checks ---------- */
  const parseUiDate = (el) => { if (!el) return null; const d = new Date(el.textContent.trim()); return isNaN(d)?null:d; };
  const selectedDateString = () => {
    const sEl = document.querySelector('[data-testid="selectedStartDate"], .dateRangeComboBox__StyledStartDate-sc-e0f4ce85-2');
    const d = parseUiDate(sEl) || new Date();
    const yyyy=d.getFullYear(), mm=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  };
  function isSameDayRange() {
    const sEl = document.querySelector('[data-testid="selectedStartDate"], .dateRangeComboBox__StyledStartDate-sc-e0f4ce85-2');
    const eEl = document.querySelector('[data-testid="selectedEndDate"], .dateRangeComboBox__StyledEndDate-sc-e0f4ce85-3');
    const sd = parseUiDate(sEl), ed = parseUiDate(eEl);
    if (sd && ed) return sd.toDateString() === ed.toDateString();
    return !!document.querySelector('.visx-axis-bottom tspan');
  }
  function isChatsOnly() {
    const chip = Array.from(document.querySelectorAll(
      '[role="button"].front-hover-parent, .filterButton__StyledFilterButtonWrapperDiv-sc-a8dd426d-0'
    )).find(el => el.querySelector('svg[data-testid^="inbox-01/filled/"]'));
    if (!chip) return false;
    const raw = (chip.innerText || chip.textContent || '').trim();
    const norm = raw.normalize('NFKC').replace(/[\s.\u2022\u200B\u200C\u200D\u2060]+/g,'').toLowerCase();
    window.__hourlyInboxText = raw;
    return norm.includes('ischats') && !/\bemail(s)?\b/i.test(raw);
  }

  /* ---------- API-job helpers ---------- */
  const latestWorkloadPerf = () => {
    const hit = [...performance.getEntriesByType('resource')].reverse()
      .find(e => /\/anltcs\/metrics\/workload\/([0-9a-f]{64})/.test(e.name));
    if (!hit) return null;
    const m = hit.name.match(/\/anltcs\/metrics\/workload\/([0-9a-f]{64})/);
    return m ? { url: hit.name, uid: m[1] } : null;
  };

  async function getNamespaceAndBaseURLOrWait(timeoutMs=15000) {
    const found = latestWorkloadPerf();
    if (found) return { baseJobURL: found.url.replace(/\/[0-9a-f]{64}$/, '') };
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { obs && obs.disconnect(); reject(new Error('timeout waiting for workload request')); }, timeoutMs);
      let obs;
      try {
        obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (/\/anltcs\/metrics\/workload\/([0-9a-f]{64})/.test(e.name)) {
              clearTimeout(to); obs.disconnect();
              return resolve({ baseJobURL: e.name.replace(/\/[0-9a-f]{64}$/, '') });
            }
          }
        });
        obs.observe({ entryTypes: ['resource'] });
        warn('Flip the metric or date once — capturing workload context…');
      } catch { reject(new Error('PerformanceObserver not available')); }
    });
  }

  const getJob = (baseJobURL, id) =>
    fetch(`${baseJobURL}/${id}`, { credentials:'same-origin' }).then(r=>r.json());

  const createJob = async (baseJobURL, payload) => {
    const xsrf = (document.cookie.match(/(?:^|;\s*)front\.csrf=([^;]+)/)||[])[1] || '';
    const res = await fetch(baseJobURL, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type':'application/json', 'x-front-xsrf': xsrf },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Create job failed: ' + res.status);
    const j = await res.json(); return j.jobUid || j.uid || j.id;
  };

  // WAIT for the observed job to have usable parameters
  async function waitForJobParams(baseJobURL, uid, timeout=15000) {
    const t0 = performance.now();
    let last;
    while (performance.now() - t0 < timeout) {
      last = await getJob(baseJobURL, uid);
      const p = last?.parameters || last;
      if (p?.period && p?.filters) {
        const namespace = p.namespace || (baseJobURL.match(/\/namespaces\/([^/]+)/)||[])[1] || '';
        return { period: p.period, filters: p.filters, namespace };
      }
      await sleep(200);
    }
    throw new Error('Could not read period/filters from observed job.');
  }

  // Read params from the most recent workload request (after it’s ready)
  async function cloneParams(baseJobURL) {
    const perf = latestWorkloadPerf();
    if (!perf) throw new Error('No workload job observed. Flip metric/date once and try again.');
    return waitForJobParams(baseJobURL, perf.uid, 15000);
  }

  /* ---------- Always interpret metric values as SECONDS ---------- */
  function extract24Seconds(g) {
    if (!g) return null;
    const out = Array(24).fill(null);
    const set = (h, v) => { if (h==null) return; const n=Number(v); if (isFinite(n)) out[h]=n; };

    const hFromLabel = (lab)=>{
      const m = String(lab||'').trim().match(/^(\d{1,2})\s*(AM|PM)$/i);
      if (!m) return null;
      let h=(+m[1])%12; if (m[2].toUpperCase()==='PM') h+=12;
      return h;
    };
    const hFromTs = (ts)=>{ const d=new Date(ts); return isNaN(d)?null:d.getHours(); };

    if (Array.isArray(g.vals)) {
      for (const r of g.vals) set(hFromLabel(r.label) ?? hFromTs(r.start ?? r.ts), r.v ?? r.value ?? r.y ?? r.avg);
    } else if (Array.isArray(g.values)) {
      for (let i=0;i<g.values.length;i++){
        const it = g.values[i];
        if (typeof it === 'number') set(i, it);
        else set(hFromLabel(it.label) ?? hFromTs(it.start ?? it.ts) ?? i, it.v ?? it.value ?? it.y ?? it.avg);
      }
    } else if (Array.isArray(g.series)) {
      const s = g.series[0]?.values || [];
      for (let i=0;i<s.length;i++){
        const it=s[i];
        set(hFromLabel(it.label) ?? hFromTs(it.start ?? it.ts) ?? i, it.v ?? it.value ?? it.y ?? it.avg);
      }
    } else {
      return null;
    }
    return out;
  }

  async function getHourlySeries() {
    const { baseJobURL } = await getNamespaceAndBaseURLOrWait();
    const { period, filters, namespace } = await cloneParams(baseJobURL);
    const METRIC_NAMES = [
      'ticket_avg_resolution_time_graph',
      'response_graph',
      'first_response_graph'
    ];
    const payload = { namespace, reportType: 'workload', period, filters, metrics: [], metricsWithOptions: METRIC_NAMES.map(name => ({ name, uid: '' })) };
    const jobUid = await createJob(baseJobURL, payload);

    let job; for (let i=0;i<50;i++){ job = await getJob(baseJobURL, jobUid); if (job.status==='done') break; await sleep(200); }
    if (!job || job.status!=='done') throw new Error('Analytics job did not complete in time.');

    const m = job.metrics || {};
    const serRes   = extract24Seconds(m.ticket_avg_resolution_time_graph);
    const serReply = extract24Seconds(m.response_graph);
    const serFirst = extract24Seconds(m.first_response_graph);

    return { serRes, serReply, serFirst, period, jobUid, returnedKeys: Object.keys(m) };
  }

  /* ---------- rows->PNG (for snapshot) ---------- */
  async function rowsToPNGBlob(rows, opts={}) {
    const {
      titleLines = [],
      font = '13px -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial',
      headerFont = '600 13px -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial',
      titleFont = '600 15px -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial',
      subtitleFont = '12px -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial',
      card = '#16161c',
      grid = '#1e2030',
      headBorder = '#2a2c3e',
      headerBg = '#16161c',
      avgBg = '#171929',
      padX = 8,
      rowH = 28,
      headerH = 30,
      titleGap = 6,
      outerPad = 12,
      borderRadius = 12,
      scale = Math.min(3, (window.devicePixelRatio || 2))
    } = opts;

    const mCanvas = document.createElement('canvas');
    const mCtx = mCanvas.getContext('2d');
    const measure = (f, s) => { mCtx.font = f; return Math.ceil(mCtx.measureText(String(s)).width); };

    const cols = rows[0].length;
    const colWidths = Array(cols).fill(0);
    for (let c=0;c<cols;c++) {
      colWidths[c] = Math.max(
        measure(headerFont, rows[0][c]),
        ...rows.slice(1).map(r => measure(font, r[c]))
      ) + padX*2;
    }
    colWidths[0] = Math.max(colWidths[0], 110);
    for (let c=1;c<cols;c++) colWidths[c] = Math.max(colWidths[c], 140);

    const tableW = colWidths.reduce((a,b)=>a+b,0);
    const bodyRows = rows.length - 1;
    const tableH = headerH + bodyRows*rowH;

    let titleBlockH = 0, titleW = 0;
    if (titleLines.length) {
      titleW = Math.max(...titleLines.map((t,i)=>measure(i===0?titleFont:subtitleFont, t))) + padX*2;
      titleBlockH = titleLines.length * 20 + titleGap;
    }

    const cardW = Math.max(tableW, titleW);
    const cardH = titleBlockH + tableH;

    const W = cardW + outerPad*2;
    const H = cardH + outerPad*2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(W * scale);
    canvas.height = Math.floor(H * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = card;
    const r = borderRadius;
    ctx.beginPath();
    ctx.moveTo(outerPad+r, outerPad);
    ctx.arcTo(outerPad+cardW, outerPad, outerPad+cardW, outerPad+cardH, r);
    ctx.arcTo(outerPad+cardW, outerPad+cardH, outerPad, outerPad+cardH, r);
    ctx.arcTo(outerPad, outerPad+cardH, outerPad, outerPad, r);
    ctx.arcTo(outerPad, outerPad, outerPad+cardW, outerPad, r);
    ctx.closePath();
    ctx.fill();

    let ty = outerPad + 10;
    for (let i=0;i<titleLines.length;i++) {
      ctx.fillStyle = '#ffffff';
      ctx.font = (i===0 ? '600 15px system-ui' : '12px system-ui');
      ctx.textBaseline = 'top';
      ctx.fillText(String(titleLines[i]), outerPad + padX, ty);
      ty += 20;
    }
    if (titleLines.length) ty += (titleGap - 10);

    const tableTop = outerPad + titleBlockH;
    ctx.fillStyle = headerBg;
    ctx.fillRect(outerPad, tableTop, cardW, headerH);
    ctx.fillStyle = headBorder;
    ctx.fillRect(outerPad, tableTop + headerH - 1, cardW, 1);

    let y = tableTop + headerH;
    for (let i=1;i<rows.length;i++, y+=rowH) {
      const isAvg = rows[i][0] === 'Average';
      if (isAvg) {
        ctx.fillStyle = avgBg;
        ctx.fillRect(outerPad, y, cardW, rowH);
      }
      ctx.fillStyle = grid;
      ctx.fillRect(outerPad, y+rowH-1, cardW, 1);
    }

    let x = outerPad;
    ctx.fillStyle = grid;
    for (let c=0;c<cols-1;c++) {
      x += colWidths[c];
      ctx.fillRect(x, tableTop, 1, tableH);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 13px system-ui';
    ctx.textBaseline = 'middle';
    x = outerPad;
    for (let c=0;c<cols;c++) {
      ctx.fillText(String(rows[0][c]), x + padX, tableTop + headerH/2);
      x += colWidths[c];
    }

    ctx.font = '13px system-ui';
    y = tableTop + headerH + rowH/2;
    for (let i=1;i<rows.length;i++, y+=rowH) {
      x = outerPad;
      for (let c=0;c<cols;c++) {
        ctx.fillText(String(rows[i][c] ?? ''), x + padX, y);
        x += colWidths[c];
      }
    }

    return new Promise((resolve, reject)=>{
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png', 1);
    });
  }

  async function copyPNGToClipboard(pngBlob) {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('Clipboard image API not available.');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  }

  /* ---------- Modal ---------- */
  function openModal() {
    if (!isSameDayRange()) { alert('Please set the date range to a SINGLE DAY first.'); return; }
    if (!isChatsOnly()) { alert('Please set the inbox filter to “Is · Chats” first.\n\nSeen: ' + (window.__hourlyInboxText || '(no chip found)')); return; }

    const day = selectedDateString();

    const modal = document.createElement('div');
    modal.id = 'hourly-stats-modal';
    modal.style.cssText = `position:fixed; inset:0; z-index:999999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.35); backdrop-filter:saturate(120%) blur(2px);`;
    modal.innerHTML = `
      <div style="min-width:420px; max-width:90vw; background:#16161c; border:1px solid #303244; color:#fff; border-radius:12px; padding:16px; box-shadow:0 10px 32px rgba(0,0,0,.5);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="font:600 15px system-ui;">Hourly “Workload over time”</div>
          <div id="hs-day" style="font:12px system-ui; opacity:.9;">Date: <b>${day}</b></div>
        </div>
        <div style="font:12px system-ui;opacity:.85;margin-bottom:12px;">Select hour range for the single day in view. Inbox must be <b>Chats</b>.</div>
        <div style="display:flex; gap:12px; align-items:center; margin-bottom:12px;">
          <label>Start</label>
          <select id="hs-start" style="flex:1; background:#0f0f14; color:#fff; border:1px solid #2a2c3e; border-radius:8px; padding:6px;">
            ${HOUR_LABELS_12.map((lab,i)=>`<option value="${i}" ${i===10?'selected':''}>${lab}</option>`).join('')}
          </select>
          <label>End</label>
          <select id="hs-end" style="flex:1; background:#0f0f14; color:#fff; border:1px solid #2a2c3e; border-radius:8px; padding:6px;">
            ${HOUR_LABELS_12.map((lab,i)=>`<option value="${i}" ${i===18?'selected':''}>${lab}</option>`).join('')}
          </select>
          <button id="hs-run" style="padding:8px 12px; border-radius:8px; background:#6b7cff; color:#fff; border:none; cursor:pointer;">Show</button>
        </div>

        <div id="hs-actions" style="display:flex; gap:8px; justify-content:flex-end; margin-bottom:12px;">
          <button id="hs-close"  style="padding:8px 10px; border-radius:8px; background:#2a2c3e; color:#fff; border:none; cursor:pointer;">Close</button>
          <button id="hs-export" style="padding:8px 10px; border-radius:8px; background:#2e8b57; color:#fff; border:none; cursor:pointer;" disabled>Export CSV</button>
          <button id="hs-snap"   style="padding:8px 10px; border-radius:8px; background:#37427a; color:#fff; border:none; cursor:pointer;" disabled>Take Snapshot</button>
        </div>

        <div id="hs-output" style="max-height:60vh; overflow:auto; border:1px solid #2a2c3e; border-radius:8px; padding:8px; background:#0f0f14;">
          <div style="opacity:.7; font:12px system-ui;">No data yet. Choose a range and click <b>Show</b>.</div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const startSel = modal.querySelector('#hs-start');
    const endSel   = modal.querySelector('#hs-end');
    const btnRun   = modal.querySelector('#hs-run');
    const btnExport= modal.querySelector('#hs-export');
    const btnSnap  = modal.querySelector('#hs-snap');
    const btnClose = modal.querySelector('#hs-close');
    const out      = modal.querySelector('#hs-output');
    const dayEl    = modal.querySelector('#hs-day');

    let lastCSV = '';
    let lastFilename = '';
    let lastRows = null;
    let lastTitleLines = [];

    btnClose.onclick = ()=> modal.remove();

    btnExport.onclick = ()=>{
      if (!lastCSV) return;
      download(lastCSV, lastFilename || 'front-hourly.csv');
    };

    btnSnap.onclick = async ()=>{
      if (!lastRows) return;
      try {
        btnSnap.disabled = true; btnSnap.textContent = 'Snapping…';
        const png = await rowsToPNGBlob(lastRows, { titleLines: lastTitleLines });
        await copyPNGToClipboard(png);
        btnSnap.textContent = 'Copied!';
      } catch (e) {
        console.error(e);
        alert('Could not copy snapshot to clipboard. ' + (e && e.message || e));
        btnSnap.textContent = 'Take Snapshot';
      } finally {
        setTimeout(()=>{ btnSnap.disabled = false; btnSnap.textContent = 'Take Snapshot'; }, 900);
      }
    };

    btnRun.onclick = async ()=>{
      const s = +startSel.value, e = +endSel.value;
      if (e < s) { alert('End hour must be after start hour.'); return; }

      const currentDay = selectedDateString();
      dayEl.innerHTML = `Date: <b>${currentDay}</b>`;

      btnRun.disabled = true; btnRun.textContent = 'Loading…';
      btnExport.disabled = true; btnSnap.disabled = true;
      out.innerHTML = `<div style="opacity:.8; font:12px system-ui;">Fetching data…</div>`;

      try {
        const { serRes, serReply, serFirst, period, jobUid, returnedKeys } = await getHourlySeries();

        const headers = ['Hour','Resolution time (avg)','Reply time (avg)','First reply time (avg)'];
        const rows = [headers];
        for (let h=s; h<=e; h++) {
          rows.push([
            HOUR_LABELS_12[h],
            fmtSec(serRes   ? serRes[h]   : null),
            fmtSec(serReply ? serReply[h] : null),
            fmtSec(serFirst ? serFirst[h] : null),
          ]);
        }
        rows.push([
          'Average',
          fmtSec(serRes   ? avg(serRes.slice(s, e+1))   : null),
          fmtSec(serReply ? avg(serReply.slice(s, e+1)) : null),
          fmtSec(serFirst ? avg(serFirst.slice(s, e+1)) : null),
        ]);

        out.innerHTML = `
          <div style="font:12px system-ui; opacity:.9; margin:4px 0 8px 2px;">
            <b>Date:</b> ${currentDay}
          </div>
          ${buildTableHTML(rows)}
        `;

        lastRows = rows;
        const csvRows = [['Date', currentDay], []].concat(rows);
        lastCSV = toCSV(csvRows);

        const sLab = HOUR_LABELS_12[s].replace(/\s/g,'');
        const eLab = HOUR_LABELS_12[e].replace(/\s/g,'');
        lastFilename = `front-hourly_${currentDay}_${sLab}-${eLab}.csv`;

        lastTitleLines = [
          'Hourly “Workload over time” — Chats',
          `Date: ${currentDay}   •   Range: ${HOUR_LABELS_12[s]} – ${HOUR_LABELS_12[e]}`
        ];

        btnExport.disabled = false;
        btnSnap.disabled = false;

        log('Displayed.', { jobUid, returnedKeys, period, day: currentDay });
      } catch (err) {
        console.error(err);
        out.innerHTML = `<div style="color:#ffb4b4; font:12px system-ui;">Error: ${err && err.message || err}</div>`;
      } finally {
        btnRun.disabled = false; btnRun.textContent = 'Show';
      }
    };
  }

  /* ---------- HTML table for on-screen view ---------- */
  const buildTableHTML = (rows) => {
    const head = `
      <thead><tr>
        ${rows[0].map(h=>`<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #2a2c3e;">${h}</th>`).join('')}
      </tr></thead>`;
    const bodyRows = rows.slice(1).map(r=>{
      const isAvg = r[0] === 'Average';
      return `<tr${isAvg?' style="font-weight:600;background:#171929;"':''}>
        ${r.map(c=>`<td style="padding:6px 8px; border-bottom:1px solid #1e2030;">${c}</td>`).join('')}
      </tr>`;
    }).join('');
    return `<table style="width:100%; border-collapse:collapse; font:13px system-ui;">${head}<tbody>${bodyRows}</tbody></table>`;
  };

  /* ---------- Button on the page ---------- */
  function ensureButton() {
    if (document.getElementById('hourly-stats-modal-btn')) return;
    const allViews = Array.from(document.querySelectorAll('button,div,span'))
      .find(el => el.textContent.trim() === 'All views');
    if (!allViews || !allViews.parentElement) return;

    const btn = document.createElement('button');
    btn.id = 'hourly-stats-modal-btn';
    btn.textContent = 'Hourly Stats (View)';
    btn.style.cssText = `margin-left:8px; padding:8px 10px; border-radius:10px; background:#3d3f62; color:#fff; border:1px solid #555a7a; cursor:pointer; font:500 13px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;`;
    btn.addEventListener('mouseenter', ()=>btn.style.background='#474a73');
    btn.addEventListener('mouseleave', ()=>btn.style.background='#3d3f62');
    btn.addEventListener('click', openModal);
    allViews.parentElement.appendChild(btn);
    log('button installed. Click “Hourly Stats (View)”.');
  }

  const obs = new MutationObserver(()=>ensureButton());
  obs.observe(document.documentElement, {subtree:true, childList:true});
  ensureButton();

  // Console helper (opens modal and auto-runs)
  window.__frontHourlyShowNow = async (startHour=10, endHour=18) => {
    openModal(); await sleep(30);
    const modal = document.getElementById('hourly-stats-modal');
    if (!modal) return;
    modal.querySelector('#hs-start').value = String(startHour);
    modal.querySelector('#hs-end').value   = String(endHour);
    modal.querySelector('#hs-run').click();
  };
})();
