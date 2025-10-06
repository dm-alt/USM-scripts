// ==UserScript==
// @name         Front Analytics – Hourly Stats for Chats
// @namespace    https://github.com/dm-alt/USM-scripts
// @version      1.7
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

  /* ----------------- tiny utils ----------------- */
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const log  = (...a)=>console.log('%c[Hourly]', 'color:#8cf', ...a);
  const warn = (...a)=>console.warn('%c[Hourly]', 'color:#fc8', ...a);

  const HOUR_LABELS_12 = Array.from({length:24}, (_,h)=>`${((h%12)||12)} ${h<12?'AM':'PM'}`);
  const fmtSec = (s)=>{ if (s==null || !isFinite(s)) return ''; s=Math.max(0,Math.round(s));
    const d=Math.floor(s/86400); s%=86400; const h=Math.floor(s/3600); s%=3600; const m=Math.floor(s/60); const ss=s%60;
    if (d) return `${d}d ${h}h ${m}m ${ss}s`; if (h) return `${h}h ${m}m ${ss}s`; if (m) return `${m}m ${ss}s`; return `${ss}s`; };
  const avg = xs=>{ const a=xs.filter(v=>v!=null && isFinite(v)); return a.length?a.reduce((p,c)=>p+c,0)/a.length:null; };
  const toCSV = rows=>rows.map(r=>r.map(v=>{ const s=String(v??''); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }).join(',')).join('\n');
  const download = (text,name)=>{ const b=new Blob([text],{type:'text/csv;charset=utf-8;'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(b); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();},0); };

  /* ----------------- UI sanity checks ----------------- */
  const parseUiDate=(el)=>{ if(!el) return null; const d=new Date(el.textContent.trim()); return isNaN(d)?null:d; };
  const selectedDateString=()=>{ const sEl=document.querySelector('[data-testid="selectedStartDate"], .dateRangeComboBox__StyledStartDate-sc-e0f4ce85-2');
    const d=parseUiDate(sEl)||new Date(); const yyyy=d.getFullYear(), mm=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${yyyy}-${mm}-${dd}`; };
  function isSameDayRange(){
    const sEl=document.querySelector('[data-testid="selectedStartDate"], .dateRangeComboBox__StyledStartDate-sc-e0f4ce85-2');
    const eEl=document.querySelector('[data-testid="selectedEndDate"], .dateRangeComboBox__StyledEndDate-sc-e0f4ce85-3');
    const sd=parseUiDate(sEl), ed=parseUiDate(eEl);
    if (sd && ed) return sd.toDateString()===ed.toDateString();
    return !!document.querySelector('.visx-axis-bottom tspan');
  }
  function isChatsOnly(){
    const chip = Array.from(document.querySelectorAll('[role="button"].front-hover-parent, .filterButton__StyledFilterButtonWrapperDiv-sc-a8dd426d-0'))
      .find(el=>el.querySelector('svg[data-testid^="inbox-01/filled/"]'));
    if (!chip) return false;
    const raw=(chip.innerText||chip.textContent||'').trim();
    const norm=raw.normalize('NFKC').replace(/[\s.\u2022\u200B\u200C\u200D\u2060]+/g,'').toLowerCase();
    window.__hourlyInboxText=raw;
    return norm.includes('ischats') && !/\bemail(s)?\b/i.test(raw);
  }

  /* ----------------- Robust metrics capture ----------------- */
  // Accept ANY metrics collection, not just "workload".
  const METRICS_RE = /\/anltcs\/metrics\/([^/]+)\/([0-9a-f]{64})/;
  const parseMetricsUrl = (urlStr)=>{
    const m = String(urlStr||'').match(METRICS_RE);
    if (!m) return null;
    const collection=m[1], uid=m[2];
    const metricsBase = String(urlStr).replace(/\/[0-9a-f]{64}(\?.*)?$/,'');
    const workloadBase = metricsBase.replace(/\/anltcs\/metrics\/[^/]+$/,'/anltcs/metrics/workload');
    return { collection, uid, metricsBase, workloadBase, url: String(urlStr) };
  };

  const tap = { last:null };
  (function installNetworkTap(){
    if (window.__hourlyTapInstalled) return; window.__hourlyTapInstalled=true;
    const remember=(url)=>{ const p=parseMetricsUrl(url); if (p) tap.last={...p, ts:Date.now()}; };
    try{
      const origFetch=window.fetch;
      if (origFetch) window.fetch=function(i,init){ const u=typeof i==='string'?i:(i&&i.url)||''; remember(u); return origFetch.apply(this,arguments); };
    }catch{}
    try{
      const X=window.XMLHttpRequest; if (X){
        window.XMLHttpRequest=function(){ const x=new X(); const o=x.open;
          x.open=function(method,url){ try{remember(url);}catch{} return o.apply(x,arguments); }; return x; };
      }
    }catch{}
  })();

  const latestMetricsPerf=()=>{ const list=[...performance.getEntriesByType('resource')].reverse();
    const hit=list.find(e=>METRICS_RE.test(e.name)); return hit?parseMetricsUrl(hit.name):null; };

  async function getContextOrWait(timeoutMs=30000){
    // 1) our taps
    if (tap.last) return tap.last;
    // 2) anything already in perf buffer?
    const perfNow=latestMetricsPerf(); if (perfNow) return perfNow;

    // 3) wait (buffered PO + polling tap/perf)
    return new Promise((resolve,reject)=>{
      const t0=performance.now();
      let po;
      const finish=(p)=>{ try{po&&po.disconnect();}catch{} resolve(p); };
      try{
        po=new PerformanceObserver((list)=>{
          for(const e of list.getEntries()){ const p=parseMetricsUrl(e.name); if (p) return finish(p); }
        });
        po.observe({entryTypes:['resource'], buffered:true});
      }catch{}

      const tick=()=>{
        if (tap.last) return finish(tap.last);
        const p=latestMetricsPerf(); if (p) return finish(p);
        if (performance.now()-t0>=timeoutMs) { try{po&&po.disconnect();}catch{} return reject(new Error('timeout waiting for workload request')); }
        setTimeout(tick,120);
      };
      warn('Tip: tweak any Analytics control once (date/metric)—I’ll latch onto the next metrics request.');
      tick();
    });
  }

  const getJob=(base,uid)=>fetch(`${base}/${uid}`,{credentials:'same-origin'}).then(r=>r.json());

  const createJob=async (workloadBase,payload)=>{
    const xsrf=(document.cookie.match(/(?:^|;\s*)front\.csrf=([^;]+)/)||[])[1]||'';
    const res=await fetch(workloadBase,{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','x-front-xsrf':xsrf}, body:JSON.stringify(payload)});
    if(!res.ok) throw new Error('Create job failed: '+res.status);
    const j=await res.json(); return j.jobUid||j.uid||j.id;
  };

  async function waitForJobParams(metricsBase, uid, timeout=20000){
    const t0=performance.now(); let last;
    while (performance.now()-t0<timeout){
      last=await getJob(metricsBase, uid);
      const p=last?.parameters||last;
      if(p?.period && p?.filters){
        const namespace = p.namespace || (metricsBase.match(/\/namespaces\/([^/]+)/)||[])[1] || '';
        return { period:p.period, filters:p.filters, namespace };
      }
      await sleep(200);
    }
    throw new Error('Could not read period/filters from observed job.');
  }

  /* ----------------- Interpret graph values as seconds ----------------- */
  function extract24Seconds(g){
    if(!g) return null;
    const out=Array(24).fill(null);
    const set=(h,v)=>{ if(h==null) return; const n=Number(v); if(isFinite(n)) out[h]=n; };
    const hFromLabel=(lab)=>{ const m=String(lab||'').trim().match(/^(\d{1,2})\s*(AM|PM)$/i); if(!m) return null; let h=(+m[1])%12; if(m[2].toUpperCase()==='PM') h+=12; return h; };
    const hFromTs=(ts)=>{ const d=new Date(ts); return isNaN(d)?null:d.getHours(); };

    if (Array.isArray(g.vals)){
      for (const r of g.vals) set(hFromLabel(r.label) ?? hFromTs(r.start ?? r.ts), r.v ?? r.value ?? r.y ?? r.avg);
    } else if (Array.isArray(g.values)){
      for (let i=0;i<g.values.length;i++){ const it=g.values[i];
        if (typeof it==='number') set(i,it);
        else set(hFromLabel(it.label) ?? hFromTs(it.start ?? it.ts) ?? i, it.v ?? it.value ?? it.y ?? it.avg);
      }
    } else if (Array.isArray(g.series)){
      const s=g.series[0]?.values||[];
      for (let i=0;i<s.length;i++){ const it=s[i];
        set(hFromLabel(it.label) ?? hFromTs(it.start ?? it.ts) ?? i, it.v ?? it.value ?? it.y ?? it.avg);
      }
    } else return null;
    return out;
  }

  async function getHourlySeries(){
    // Capture ANY metrics call, read its params, then post to workload.
    const ctx = await getContextOrWait(); // {collection, uid, metricsBase, workloadBase}
    const { period, filters, namespace } = await waitForJobParams(ctx.metricsBase, ctx.uid, 20000);

    const METRICS_NAMES = [
      'ticket_avg_resolution_time_graph',
      'response_graph',
      'first_response_graph'
    ];
    const payload = { namespace, reportType:'workload', period, filters, metrics:[], metricsWithOptions: METRICS_NAMES.map(name=>({name, uid:''})) };

    const ourUid = await createJob(ctx.workloadBase, payload);
    let job; for (let i=0;i<60;i++){ job=await getJob(ctx.workloadBase, ourUid); if (job.status==='done') break; await sleep(200); }
    if (!job || job.status!=='done') throw new Error('Analytics job did not complete in time.');

    const m = job.metrics||{};
    return {
      serRes:   extract24Seconds(m.ticket_avg_resolution_time_graph),
      serReply: extract24Seconds(m.response_graph),
      serFirst: extract24Seconds(m.first_response_graph),
      period, jobUid: ourUid, returnedKeys: Object.keys(m)
    };
  }

  /* ----------------- rows -> PNG (snapshot) ----------------- */
  async function rowsToPNGBlob(rows, {titleLines=[]}={}){
    const padX=8,rowH=28,headerH=30,outerPad=12,borderRadius=12,grid='#1e2030',headBorder='#2a2c3e',headerBg='#16161c',avgBg='#171929';
    const m=document.createElement('canvas').getContext('2d'); const mw=(f,s)=>{m.font=f; return Math.ceil(m.measureText(String(s)).width);};

    const cols=rows[0].length, widths=Array(cols).fill(0);
    for(let c=0;c<cols;c++) widths[c]=Math.max(mw('600 13px system-ui',rows[0][c]),...rows.slice(1).map(r=>mw('13px system-ui',r[c])))+padX*2;
    widths[0]=Math.max(widths[0],110); for(let c=1;c<cols;c++) widths[c]=Math.max(widths[c],140);
    const tableW=widths.reduce((a,b)=>a+b,0), bodyRows=rows.length-1, tableH=headerH+bodyRows*rowH;

    let titleH=0,titleW=0; if(titleLines.length){ titleW=Math.max(...titleLines.map((t,i)=>mw(i===0?'600 15px system-ui':'12px system-ui',t)))+padX*2; titleH=titleLines.length*20+6; }
    const cardW=Math.max(tableW,titleW), cardH=titleH+tableH, W=cardW+outerPad*2, H=cardH+outerPad*2, scale=Math.min(3,window.devicePixelRatio||2);
    const c=document.createElement('canvas'); c.width=Math.floor(W*scale); c.height=Math.floor(H*scale); const g=c.getContext('2d'); g.scale(scale,scale);

    // card
    g.fillStyle='#16161c'; const r=borderRadius;
    g.beginPath(); g.moveTo(outerPad+r,outerPad); g.arcTo(outerPad+cardW,outerPad,outerPad+cardW,outerPad+cardH,r);
    g.arcTo(outerPad+cardW,outerPad+cardH,outerPad,outerPad+cardH,r); g.arcTo(outerPad,outerPad+cardH,outerPad,outerPad,r);
    g.arcTo(outerPad,outerPad,outerPad+cardW,outerPad,r); g.closePath(); g.fill();

    // title
    let ty=outerPad+10;
    for(let i=0;i<titleLines.length;i++){ g.fillStyle='#fff'; g.font=(i===0?'600 15px system-ui':'12px system-ui'); g.textBaseline='top'; g.fillText(String(titleLines[i]),outerPad+padX,ty); ty+=20; }
    if (titleLines.length) ty += (6-10);

    // header & grid
    const top=outerPad+titleH;
    g.fillStyle=headerBg; g.fillRect(outerPad,top,cardW,headerH);
    g.fillStyle=headBorder; g.fillRect(outerPad,top+headerH-1,cardW,1);

    let y=top+headerH;
    for(let i=1;i<rows.length;i++,y+=rowH){ const isAvg=rows[i][0]==='Average'; if(isAvg){ g.fillStyle=avgBg; g.fillRect(outerPad,y,cardW,rowH); } g.fillStyle=grid; g.fillRect(outerPad,y+rowH-1,cardW,1); }
    let x=outerPad; g.fillStyle=grid; for(let cIdx=0;cIdx<cols-1;cIdx++){ x+=widths[cIdx]; g.fillRect(x,top,1,tableH); }

    g.fillStyle='#fff'; g.font='600 13px system-ui'; g.textBaseline='middle';
    x=outerPad; for(let cIdx=0;cIdx<cols;cIdx++){ g.fillText(String(rows[0][cIdx]), x+padX, top+headerH/2); x+=widths[cIdx]; }
    g.font='13px system-ui'; y=top+headerH+rowH/2;
    for(let i=1;i<rows.length;i++,y+=rowH){ x=outerPad; for(let cIdx=0;cIdx<cols;cIdx++){ g.fillText(String(rows[i][cIdx]??''), x+padX, y); x+=widths[cIdx]; } }

    return new Promise((resolve,reject)=>{ c.toBlob(b=>b?resolve(b):reject(new Error('toBlob failed')),'image/png',1); });
  }
  async function copyPNGToClipboard(blob){ if(!navigator.clipboard||!window.ClipboardItem) throw new Error('Clipboard image API not available.');
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]); }

  /* ----------------- Modal ----------------- */
  function openModal(){
    if (!isSameDayRange()) { alert('Please set the date range to a SINGLE DAY first.'); return; }
    if (!isChatsOnly())    { alert('Please set the inbox filter to “Is · Chats” first.\n\nSeen: ' + (window.__hourlyInboxText || '(no chip found)')); return; }

    const day = selectedDateString();
    const modal=document.createElement('div'); modal.id='hourly-stats-modal';
    modal.style.cssText='position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);backdrop-filter:saturate(120%) blur(2px);';
    modal.innerHTML=`
      <div style="min-width:420px;max-width:90vw;background:#16161c;border:1px solid #303244;color:#fff;border-radius:12px;padding:16px;box-shadow:0 10px 32px rgba(0,0,0,.5);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div style="font:600 15px system-ui;">Hourly “Workload over time”</div>
          <div id="hs-day" style="font:12px system-ui;opacity:.9;">Date: <b>${day}</b></div>
        </div>
        <div style="font:12px system-ui;opacity:.85;margin-bottom:12px;">Select hour range for the single day in view. Inbox must be <b>Chats</b>.</div>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
          <label>Start</label>
          <select id="hs-start" style="flex:1;background:#0f0f14;color:#fff;border:1px solid #2a2c3e;border-radius:8px;padding:6px;">
            ${HOUR_LABELS_12.map((lab,i)=>`<option value="${i}" ${i===10?'selected':''}>${lab}</option>`).join('')}
          </select>
          <label>End</label>
          <select id="hs-end" style="flex:1;background:#0f0f14;color:#fff;border:1px solid #2a2c3e;border-radius:8px;padding:6px;">
            ${HOUR_LABELS_12.map((lab,i)=>`<option value="${i}" ${i===18?'selected':''}>${lab}</option>`).join('')}
          </select>
          <button id="hs-run" style="padding:8px 12px;border-radius:8px;background:#6b7cff;color:#fff;border:none;cursor:pointer;">Show</button>
        </div>

        <div id="hs-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px;">
          <button id="hs-close"  style="padding:8px 10px;border-radius:8px;background:#2a2c3e;color:#fff;border:none;cursor:pointer;">Close</button>
          <button id="hs-export" style="padding:8px 10px;border-radius:8px;background:#2e8b57;color:#fff;border:none;cursor:pointer;" disabled>Export CSV</button>
          <button id="hs-snap"   style="padding:8px 10px;border-radius:8px;background:#37427a;color:#fff;border:none;cursor:pointer;" disabled>Take Snapshot</button>
        </div>

        <div id="hs-output" style="max-height:60vh;overflow:auto;border:1px solid #2a2c3e;border-radius:8px;padding:8px;background:#0f0f14;">
          <div style="opacity:.7;font:12px system-ui;">No data yet. Choose a range and click <b>Show</b>.</div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const startSel=modal.querySelector('#hs-start'), endSel=modal.querySelector('#hs-end');
    const btnRun=modal.querySelector('#hs-run'), btnExport=modal.querySelector('#hs-export'), btnSnap=modal.querySelector('#hs-snap');
    const btnClose=modal.querySelector('#hs-close'), out=modal.querySelector('#hs-output'), dayEl=modal.querySelector('#hs-day');

    let lastCSV='', lastFilename='', lastRows=null, lastTitleLines=[];
    btnClose.onclick=()=>modal.remove();
    btnExport.onclick=()=>{ if(lastCSV) download(lastCSV, lastFilename || 'front-hourly.csv'); };
    btnSnap.onclick=async()=>{ if(!lastRows) return; try{ btnSnap.disabled=true; btnSnap.textContent='Snapping…';
      const png=await rowsToPNGBlob(lastRows,{titleLines:lastTitleLines}); await copyPNGToClipboard(png); btnSnap.textContent='Copied!'; }
      catch(e){ console.error(e); alert('Could not copy snapshot to clipboard. '+(e&&e.message||e)); btnSnap.textContent='Take Snapshot'; }
      finally{ setTimeout(()=>{ btnSnap.disabled=false; btnSnap.textContent='Take Snapshot'; },900); } };

    btnRun.onclick=async()=>{
      const s=+startSel.value, e=+endSel.value; if(e<s){ alert('End hour must be after start hour.'); return; }
      const currentDay=selectedDateString(); dayEl.innerHTML=`Date: <b>${currentDay}</b>`;
      btnRun.disabled=true; btnRun.textContent='Loading…'; btnExport.disabled=true; btnSnap.disabled=true;
      out.innerHTML=`<div style="opacity:.8;font:12px system-ui;">Fetching data…</div>`;

      try{
        const { serRes, serReply, serFirst, period, jobUid, returnedKeys } = await getHourlySeries();

        const headers=['Hour','Resolution time (avg)','Reply time (avg)','First reply time (avg)'];
        const rows=[headers];
        for(let h=s; h<=e; h++){
          rows.push([HOUR_LABELS_12[h], fmtSec(serRes?serRes[h]:null), fmtSec(serReply?serReply[h]:null), fmtSec(serFirst?serFirst[h]:null)]);
        }
        rows.push(['Average', fmtSec(serRes?avg(serRes.slice(s,e+1)):null), fmtSec(serReply?avg(serReply.slice(s,e+1)):null), fmtSec(serFirst?avg(serFirst.slice(s,e+1)):null)]);

        out.innerHTML = `<div style="font:12px system-ui;opacity:.9;margin:4px 0 8px 2px;"><b>Date:</b> ${currentDay}</div>${buildTableHTML(rows)}`;

        lastRows=rows; lastCSV=toCSV([['Date',currentDay],[]].concat(rows));
        const sLab=HOUR_LABELS_12[s].replace(/\s/g,''); const eLab=HOUR_LABELS_12[e].replace(/\s/g,'');
        lastFilename=`front-hourly_${currentDay}_${sLab}-${eLab}.csv`;
        lastTitleLines=['Hourly “Workload over time” — Chats', `Date: ${currentDay}   •   Range: ${HOUR_LABELS_12[s]} – ${HOUR_LABELS_12[e]}`];

        btnExport.disabled=false; btnSnap.disabled=false;
        log('Displayed.', { jobUid, returnedKeys, period, day: currentDay });
      }catch(err){
        console.error(err);
        out.innerHTML=`<div style="color:#ffb4b4;font:12px system-ui;">Error: ${err && err.message || err}</div>`;
      }finally{
        btnRun.disabled=false; btnRun.textContent='Show';
      }
    };
  }

  const buildTableHTML=(rows)=>{
    const head=`<thead><tr>${rows[0].map(h=>`<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #2a2c3e;">${h}</th>`).join('')}</tr></thead>`;
    const body=rows.slice(1).map(r=>{
      const isAvg=r[0]==='Average';
      return `<tr${isAvg?' style="font-weight:600;background:#171929;"':''}>${r.map(c=>`<td style="padding:6px 8px;border-bottom:1px solid #1e2030;">${c}</td>`).join('')}</tr>`;
    }).join('');
    return `<table style="width:100%;border-collapse:collapse;font:13px system-ui;">${head}<tbody>${body}</tbody></table>`;
  };

  /* ----------------- page button ----------------- */
  function ensureButton(){
    if (document.getElementById('hourly-stats-modal-btn')) return;
    const anchor = Array.from(document.querySelectorAll('button,div,span')).find(el=>el.textContent.trim()==='All views');
    if (!anchor || !anchor.parentElement) return;
    const btn=document.createElement('button'); btn.id='hourly-stats-modal-btn'; btn.textContent='Hourly Stats (View)';
    btn.style.cssText='margin-left:8px;padding:8px 10px;border-radius:10px;background:#3d3f62;color:#fff;border:1px solid #555a7a;cursor:pointer;font:500 13px/1.1 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;';
    btn.addEventListener('mouseenter',()=>btn.style.background='#474a73'); btn.addEventListener('mouseleave',()=>btn.style.background='#3d3f62');
    btn.addEventListener('click',openModal); anchor.parentElement.appendChild(btn);
    log('button installed. Click “Hourly Stats (View)”.');
  }
  const obs=new MutationObserver(()=>ensureButton()); obs.observe(document.documentElement,{subtree:true,childList:true});
  ensureButton();

  // Console helper
  window.__frontHourlyShowNow = async (startHour=10,endHour=18)=>{
    openModal(); await sleep(30);
    const m=document.getElementById('hourly-stats-modal'); if(!m) return;
    m.querySelector('#hs-start').value=String(startHour); m.querySelector('#hs-end').value=String(endHour);
    m.querySelector('#hs-run').click();
  };
})();
