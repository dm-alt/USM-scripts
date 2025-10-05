// ==UserScript==
// @name         Front Analytics – Hourly Stats
// @namespace    https://github.com/dm-alt/USM-scripts
// @version      1.0
// @description  Modal view of hourly Resolution/Reply/First reply with averages. CSV export + snapshot-to-clipboard included.
// @author       Danish Murad
// @license      MIT
// @homepageURL  https://github.com/dm-alt/USM-scripts
// @supportURL   https://github.com/dm-alt/USM-scripts/issues
// @match        https://us-mobile.frontapp.com/analytics/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const log  = (...a)=>console.log('%c[Hourly]', 'color:#8cf', ...a);
  const warn = (...a)=>console.warn('%c[Hourly]', 'color:#fc8', ...a);

  const HOUR_LABELS_12 = Array.from({length:24}, (_,h)=>`${((h%12)||12)} ${h<12?'AM':'PM'}`);

  const fmtSec = (s)=>{
    if (s==null || !isFinite(s)) return '';
    s = Math.max(0, Math.round(s));
    const d=Math.floor(s/86400); s%=86400;
    const h=Math.floor(s/3600);  s%=3600;
    const m=Math.floor(s/60);    const ss=s%60;
    if (d) return `${d}d ${h}h ${m}m ${ss}s`;
    if (h) return `${h}h ${m}m ${ss}s`;
    if (m) return `${m}m ${ss}s`;
    return `${ss}s`;
  };
  const avg = xs=>{
    const a = xs.filter(v=>v!=null && isFinite(v));
    return a.length ? a.reduce((p,c)=>p+c,0)/a.length : null;
  };
  const toCSV = rows=>{
    const esc = v=>{
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    return rows.map(r=>r.map(esc).join(',')).join('\n');
  };
  const downloadCSV = (text, name)=>{
    const blob = new Blob([text], {type:'text/csv;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  function isSameDayRange() {
    const sEl = document.querySelector('[data-testid="selectedStartDate"], .dateRangeComboBox__StyledStartDate-sc-e0f4ce85-2');
    const eEl = document.querySelector('[data-testid="selectedEndDate"], .dateRangeComboBox__StyledEndDate-sc-e0f4ce85-3');
    const parse = el => { if(!el) return null; const d=new Date(el.textContent.trim()); return isNaN(d)?null:d; };
    const sd = parse(sEl), ed = parse(eEl);
    if (sd && ed) return sd.toDateString()===ed.toDateString();
    return !!document.querySelector('.visx-axis-bottom tspan'); // hourly axis present
  }
  function isChatsOnly(){
    const chip = Array.from(document.querySelectorAll(
      '[role="button"].front-hover-parent, .filterButton__StyledFilterButtonWrapperDiv-sc-a8dd426d-0'
    )).find(el => el.querySelector('svg[data-testid^="inbox-01/filled/"]'));
    if (!chip) return false;
    const raw = (chip.innerText||chip.textContent||'').trim();
    const norm = raw.normalize('NFKC').replace(/[\s.\u2022\u200B\u200C\u200D\u2060]+/g,'').toLowerCase();
    window.__hourlyInboxText = raw;
    return norm.includes('ischats') && !/\bemail(s)?\b/i.test(raw);
  }
  function findWorkloadSection(){
    const titleDiv = Array.from(document.querySelectorAll('div')).find(d=>d.textContent.trim()==='Workload over time');
    return titleDiv ? (titleDiv.closest('.reportSection__StyledReportSectionWrapperDiv-sc-6eb65dab-0') || titleDiv.closest('div')) : null;
  }

  async function chooseMetric(section, metricName) {
    let dd = section.querySelector('.reportSectionMetricSelectionDropdown__StyledDropdownBoxCoordinator-sc-6cafb1db-0');
    if (!dd) {
      const val = section.querySelector('[data-testid="dropdown-box-value"]');
      if (val) dd = val.closest('.dropdownBoxCoordinator__StyledWrapperDiv-sc-feda4c34-0') || val.parentElement;
    }
    if (!dd) return; 

    const opener = dd.querySelector('[role="button"]') || dd;
    opener.click(); await sleep(60);

    const panel = document.querySelector('[data-testid="dropdown"]');
    if (!panel) return;
    const opt = Array.from(panel.querySelectorAll('[role="option"]')).find(el=>el.textContent.trim()===metricName);
    if (!opt) return;
    opt.click(); await sleep(80);
  }

  const workloadRE = /\/anltcs\/metrics\/workload\/([0-9a-f]{64})/;

  function latestWorkloadEntry() {
    const perf = performance.getEntriesByType('resource');
    for (let i=perf.length-1;i>=0;i--) {
      const e = perf[i];
      const m = e.name.match(workloadRE);
      if (m) return { url: e.name, uid: m[1] };
    }
    return null;
  }

  async function waitForFreshWorkload(afterUid, timeout=10000) {
    const start = performance.now();
    try {
      const entry = await new Promise((resolve, reject)=>{
        const to = setTimeout(()=>{
          obs?.disconnect(); resolve(null);
        }, timeout);
        const obs = new PerformanceObserver((list)=>{
          for (const e of list.getEntries()) {
            const m = e.name.match(workloadRE);
            if (m && m[1] !== afterUid) {
              clearTimeout(to); obs.disconnect();
              resolve({ url: e.name, uid: m[1] });
              return;
            }
          }
        });
        obs.observe({ entryTypes: ['resource'] });
      });
      if (entry) return entry;
    } catch (_) { /* fall back below */ }

    while (performance.now() - start < timeout) {
      const cur = latestWorkloadEntry();
      if (cur && cur.uid !== afterUid) return cur;
      await sleep(120);
    }
    return null;
  }

  async function nudgeAndGetNewestContext() {
    const prev = latestWorkloadEntry();
    const prevUid = prev?.uid || null;

    try {
      const section = findWorkloadSection();
      if (section) {
        await chooseMetric(section, 'Resolution time (avg)');
      }
    } catch (_) {}

    const fresh = await waitForFreshWorkload(prevUid, 8000);
    if (!fresh) throw new Error('Could not detect a new workload job. Try changing the date once and click Show again.');
    const baseJobURL = fresh.url.replace(/\/[0-9a-f]{64}$/, '');
    return { baseJobURL, uid: fresh.uid };
  }

  const getJob = (baseJobURL, id) =>
    fetch(`${baseJobURL}/${id}`, {credentials:'same-origin'}).then(r=>r.json());

  const createJob = async (baseJobURL, payload) => {
    const xsrf = (document.cookie.match(/(?:^|;\s*)front\.csrf=([^;]+)/)||[])[1] || '';
    const res = await fetch(baseJobURL, {
      method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json','x-front-xsrf':xsrf},
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Create job failed: ' + res.status);
    const j = await res.json(); return j.jobUid || j.uid || j.id;
  };

  function dayFromPeriod(period) {
    const tz = period?.tz || 'UTC';
    const d  = new Date(period?.start || Date.now());
    const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
    return { day: fmt.format(d), tz };
  }

  function extract24(g) {
    if (!g || g.metric_type !== 'time_graph') return null;
    const out = Array(24).fill(null);
    if (Array.isArray(g.vals) && g.vals.length) {
      for (const row of g.vals) {
        const lab = (row.label||'').trim();
        const m = lab.match(/^(\d{1,2})\s*(AM|PM)$/i);
        let h = null;
        if (m) { h = (+m[1])%12; if (m[2].toUpperCase()==='PM') h+=12; }
        else if (row.start) { h = new Date(row.start).getHours(); }
        if (h!=null) out[h] = Number(row.v);
      }
      return out;
    }
    if (Array.isArray(g.values) && g.values.length>=24) {
      for (let h=0; h<24; h++) out[h] = Number(g.values[h]);
      return out;
    }
    return null;
  }

  async function getHourlySeriesFresh() {
    const { baseJobURL, uid } = await nudgeAndGetNewestContext();

    let job;
    for (let i=0;i<60;i++){ // ~12s worst-case
      job = await getJob(baseJobURL, uid);
      if (job.status === 'done') break;
      await sleep(200);
    }
    if (!job || job.status!=='done') throw new Error('Workload job did not complete.');
    const params = job.parameters || job;
    const { period, filters, namespace } = params;

    const METRIC_NAMES = [
      'ticket_avg_resolution_time_graph',
      'response_graph',
      'first_response_graph'
    ];
    const ourJobUid = await createJob(baseJobURL, {
      namespace, reportType:'workload', period, filters,
      metrics: [], metricsWithOptions: METRIC_NAMES.map(name=>({name, uid:''}))
    });

    let our;
    for (let i=0;i<60;i++){
      our = await getJob(baseJobURL, ourJobUid);
      if (our.status === 'done') break;
      await sleep(200);
    }
    if (!our || our.status!=='done') throw new Error('Graph job did not complete.');

    const m = our.metrics || {};
    const serRes   = extract24(m.ticket_avg_resolution_time_graph);
    const serReply = extract24(m.response_graph);
    const serFirst = extract24(m.first_response_graph);

    return { serRes, serReply, serFirst, period, returnedKeys: Object.keys(m) };
  }

  async function rowsToPNGBlob(rows, titleLines=[]) {
    const padX=8, rowH=28, headerH=30, outerPad=12, borderRadius=12, grid='#1e2030', headBorder='#2a2c3e';
    const m = document.createElement('canvas').getContext('2d');
    const mw = (f,s)=>{ m.font=f; return Math.ceil(m.measureText(String(s)).width); };

    const cols = rows[0].length;
    const widths = Array(cols).fill(0);
    for (let c=0;c<cols;c++){
      widths[c] = Math.max(mw('600 13px system-ui', rows[0][c]), ...rows.slice(1).map(r=>mw('13px system-ui', r[c]))) + padX*2;
    }
    widths[0] = Math.max(widths[0], 110); for(let c=1;c<cols;c++) widths[c]=Math.max(widths[c],140);

    const tableW = widths.reduce((a,b)=>a+b,0);
    const tableH = headerH + (rows.length-1)*rowH;

    let titleH = titleLines.length ? (titleLines.length*20 + 6) : 0;
    const cardW = tableW, cardH = titleH + tableH;
    const W = cardW + outerPad*2, H = cardH + outerPad*2;
    const scale = Math.min(3, window.devicePixelRatio||2);

    const c = document.createElement('canvas');
    c.width = Math.floor(W*scale); c.height = Math.floor(H*scale);
    const g = c.getContext('2d'); g.scale(scale, scale);

    // card
    g.fillStyle = '#16161c';
    const r = borderRadius;
    g.beginPath();
    g.moveTo(outerPad+r, outerPad);
    g.arcTo(outerPad+cardW, outerPad, outerPad+cardW, outerPad+cardH, r);
    g.arcTo(outerPad+cardW, outerPad+cardH, outerPad, outerPad+cardH, r);
    g.arcTo(outerPad, outerPad+cardH, outerPad, outerPad, r);
    g.arcTo(outerPad, outerPad, outerPad+cardW, outerPad, r);
    g.closePath(); g.fill();

    // title
    let ty = outerPad + 10;
    for (let i=0;i<titleLines.length;i++){
      g.fillStyle = '#fff';
      g.font = (i===0?'600 15px system-ui':'12px system-ui');
      g.textBaseline = 'top';
      g.fillText(String(titleLines[i]), outerPad+padX, ty); ty+=20;
    }
    if (titleLines.length) ty += (6-10);

    const top = outerPad + titleH;

    g.fillStyle = '#16161c'; g.fillRect(outerPad, top, cardW, headerH);
    g.fillStyle = headBorder; g.fillRect(outerPad, top+headerH-1, cardW, 1);

    let y = top + headerH;
    for (let i=1;i<rows.length;i++, y+=rowH){
      const isAvg = rows[i][0]==='Average';
      if (isAvg) { g.fillStyle = '#171929'; g.fillRect(outerPad, y, cardW, rowH); }
      g.fillStyle = grid; g.fillRect(outerPad, y+rowH-1, cardW, 1);
    }

    let x = outerPad; g.fillStyle = grid;
    for (let cIdx=0;cIdx<cols-1;cIdx++){ x+=widths[cIdx]; g.fillRect(x, top, 1, tableH); }

    g.fillStyle = '#fff'; g.font = '600 13px system-ui'; g.textBaseline = 'middle';
    x = outerPad;
    for (let cIdx=0;cIdx<cols;cIdx++){ g.fillText(String(rows[0][cIdx]), x+padX, top+headerH/2); x+=widths[cIdx]; }

    g.font = '13px system-ui';
    y = top + headerH + rowH/2;
    for (let i=1;i<rows.length;i++, y+=rowH){
      x = outerPad;
      for (let cIdx=0;cIdx<cols;cIdx++){ g.fillText(String(rows[i][cIdx]??''), x+padX, y); x+=widths[cIdx]; }
    }

    return new Promise((resolve, reject)=>{
      c.toBlob(b=>b?resolve(b):reject(new Error('toBlob failed')),'image/png',1);
    });
  }

  async function copyPNGToClipboard(blob){
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('Clipboard image API not available.');
    await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
  }

  function openModal(){
    if (!isSameDayRange()) { alert('Please set the date range to a SINGLE DAY first.'); return; }
    if (!isChatsOnly()) { alert('Please set the inbox filter to “Is · Chats” first.\n\nSeen: ' + (window.__hourlyInboxText || '(no chip found)')); return; }

    const modal = document.createElement('div');
    modal.id = 'hourly-stats-modal';
    modal.style.cssText = `position:fixed; inset:0; z-index:999999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.35); backdrop-filter:saturate(120%) blur(2px);`;
    modal.innerHTML = `
      <div style="min-width:460px; max-width:90vw; background:#16161c; border:1px solid #303244; color:#fff; border-radius:12px; padding:16px; box-shadow:0 10px 32px rgba(0,0,0,.5);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="font:600 15px system-ui;">Hourly “Workload over time” — Chats</div>
          <div id="hs-day" style="font:12px system-ui; opacity:.9;">Date: <b>—</b></div>
        </div>
        <div style="font:12px system-ui;opacity:.85;margin-bottom:12px;">Pick an hour range for the selected day.</div>
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

    let lastCSV = '', lastFilename = '', lastRows = null, lastTitle = [];

    btnClose.onclick = ()=> modal.remove();
    btnExport.onclick = ()=> lastCSV && downloadCSV(lastCSV, lastFilename || 'front-hourly.csv');

    btnSnap.onclick = async ()=>{
      if (!lastRows) return;
      try {
        btnSnap.disabled = true; btnSnap.textContent = 'Snapping…';
        const png = await rowsToPNGBlob(lastRows, lastTitle);
        await copyPNGToClipboard(png);
        btnSnap.textContent = 'Copied!';
      } catch (e) {
        console.error(e);
        alert('Could not copy snapshot to clipboard. ' + (e && e.message || e));
        btnSnap.textContent = 'Take Snapshot';
      } finally {
        setTimeout(()=>{ btnSnap.disabled=false; btnSnap.textContent='Take Snapshot'; }, 900);
      }
    };

    btnRun.onclick = async ()=>{
      const s = +startSel.value, e = +endSel.value;
      if (e < s) { alert('End hour must be after start hour.'); return; }

      btnRun.disabled = true; btnRun.textContent = 'Loading…';
      btnExport.disabled = true; btnSnap.disabled = true;
      out.innerHTML = `<div style="opacity:.8; font:12px system-ui;">Fetching data (fresh job)…</div>`;

      try {
        const { serRes, serReply, serFirst, period } = await getHourlySeriesFresh();
        const { day, tz } = dayFromPeriod(period);
        dayEl.innerHTML = `Date: <b>${day}</b> <span style="opacity:.8">(${tz})</span>`;

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
          fmtSec(serRes   ? avg(serRes.slice(s,e+1))   : null),
          fmtSec(serReply ? avg(serReply.slice(s,e+1)) : null),
          fmtSec(serFirst ? avg(serFirst.slice(s,e+1)) : null),
        ]);

        out.innerHTML = buildTableHTML(rows, day, tz);

        // CSV (include date header)
        lastRows = rows;
        const csvRows = [['Date', day, tz], []].concat(rows);
        lastCSV = toCSV(csvRows);
        const sLab = HOUR_LABELS_12[s].replace(/\s/g,'');
        const eLab = HOUR_LABELS_12[e].replace(/\s/g,'');
        lastFilename = `front-hourly_${day}_${sLab}-${eLab}.csv`;

        lastTitle = [
          'Hourly “Workload over time” — Chats',
          `Date: ${day} (${tz})   •   Range: ${HOUR_LABELS_12[s]} – ${HOUR_LABELS_12[e]}`
        ];

        btnExport.disabled = false;
        btnSnap.disabled = false;
      } catch (err) {
        console.error(err);
        out.innerHTML = `<div style="color:#ffb4b4; font:12px system-ui;">Error: ${err && err.message || err}</div>`;
      } finally {
        btnRun.disabled = false; btnRun.textContent = 'Show';
      }
    };
  }

  function buildTableHTML(rows, day, tz){
    const head = `<thead><tr>${rows[0].map(h=>`<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #2a2c3e;">${h}</th>`).join('')}</tr></thead>`;
    const body = rows.slice(1).map(r=>{
      const isAvg = r[0]==='Average';
      return `<tr${isAvg?' style="font-weight:600;background:#171929;"':''}>
        ${r.map(c=>`<td style="padding:6px 8px; border-bottom:1px solid #1e2030;">${c}</td>`).join('')}
      </tr>`;
    }).join('');
    return `<div style="font:12px system-ui; opacity:.9; margin:4px 0 8px 2px;"><b>Date:</b> ${day} <span style="opacity:.75">(${tz})</span></div>
      <table style="width:100%; border-collapse:collapse; font:13px system-ui;">${head}<tbody>${body}</tbody></table>`;
  }

  function ensureButton(){
    if (document.getElementById('hourly-stats-modal-btn')) return;
    const anchor = Array.from(document.querySelectorAll('button,div,span')).find(el=>el.textContent.trim()==='All views');
    if (!anchor || !anchor.parentElement) return;
    const btn = document.createElement('button');
    btn.id='hourly-stats-modal-btn';
    btn.textContent='Hourly Stats (View)';
    btn.style.cssText='margin-left:8px; padding:8px 10px; border-radius:10px; background:#3d3f62; color:#fff; border:1px solid #555a7a; cursor:pointer; font:500 13px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;';
    btn.addEventListener('mouseenter',()=>btn.style.background='#474a73');
    btn.addEventListener('mouseleave',()=>btn.style.background='#3d3f62');
    btn.addEventListener('click',openModal);
    anchor.parentElement.appendChild(btn);
    log('button installed. Click “Hourly Stats (View)”.');
  }
  const obs = new MutationObserver(()=>ensureButton());
  obs.observe(document.documentElement,{subtree:true,childList:true});
  ensureButton();

  window.__frontHourlyShowNow = async (startHour=10, endHour=18) => {
    openModal(); await sleep(30);
    const m = document.getElementById('hourly-stats-modal');
    if (!m) return;
    m.querySelector('#hs-start').value=String(startHour);
    m.querySelector('#hs-end').value=String(endHour);
    m.querySelector('#hs-run').click();
  };
})();
