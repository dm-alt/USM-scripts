// ==UserScript==
// @name         Front: Status Check for PEAs
// @namespace    https://github.com/dm-alt/USM-scripts
// @version      1.1
// @description  Two tables: Available(<4) and Busy(any). 
// @author       Danish Murad
// @license      MIT
// @homepageURL  https://github.com/dm-alt/USM-scripts
// @supportURL   https://github.com/dm-alt/USM-scripts/issues
// @match        https://us-mobile.frontapp.com/*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  const HOTKEY = { shiftKey: true, key: "B" };
  const COUNT_THRESHOLD = 4;

  const COLOR_MAP = {
    Busy:      ["#ffcc00","rgb(255, 204, 0)","rgb(252, 213, 53)","yellow"],
    Available: ["#30d158","#34c759","rgb(48, 209, 88)","rgb(52, 199, 89)","green"],
    Offline:   ["#ff3b30","#ff453a","rgb(255, 59, 48)","rgb(255, 69, 58)","red"],
  };

  GM_addStyle(`
    .tm-sum-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999999;
      display:flex;align-items:center;justify-content:center}
    .tm-sum-modal{background:#0f172a;color:#fff;width:760px;max-width:96vw;
      border-radius:14px;box-shadow:0 10px 35px rgba(0,0,0,.5);
      font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Arial;
      display:flex;flex-direction:column;max-height:88vh;cursor:default}
    .tm-sum-h{display:flex;justify-content:space-between;align-items:center;
      background:#1f2937;padding:12px 14px}
    .tm-sum-title{font-weight:600}
    .tm-sum-close{border:0;background:transparent;color:#ddd;font-size:18px;cursor:pointer}
    .tm-sum-actions{display:flex;gap:8px;padding:8px 14px;background:#0f172a;border-bottom:1px solid #1f2937}
    .tm-sum-btn{padding:8px 10px;border-radius:8px;border:1px solid #334155;background:#111827;color:#e5e7eb;cursor:pointer}
    .tm-sum-btn:hover{background:#0b1220}
    .tm-sum-content{padding:6px 14px 14px;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1 1 auto}
    .tm-sum-section{margin-top:12px}
    .tm-sum-sec-title{font-size:13px;color:#9ca3af;margin:0 0 6px}
    .tm-sum-table{width:100%;border-collapse:collapse}
    .tm-sum-table thead th{position:sticky;top:0;background:#0f172a;z-index:1;border-bottom:1px solid #1f2937}
    .tm-sum-table th,.tm-sum-table td{padding:8px 6px;border-bottom:1px solid #1f2937;font-size:13px}
    .tm-sum-badge{display:inline-block;min-width:22px;text-align:center;border-radius:9px;padding:2px 6px;background:#111827;border:1px solid #374151}
    .tm-sum-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid #374151;background:#111827}
    .tm-sum-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
    .tm-sum-empty{color:#94a3b8;font-style:italic}
    .tm-sum-f{display:flex;justify-content:space-between;color:#9ca3af;background:#0b1020;padding:8px 14px;font-size:12px}
  `);

  const colorToStatus = (color) => {
    if (!color) return null;
    const c = color.toLowerCase().trim();
    for (const [status, list] of Object.entries(COLOR_MAP)) {
      if (list.some(x => c.includes(x))) return status;
    }
    const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) {
      const [r,g,b] = m.slice(1).map(Number);
      if (g > 180 && r > 200 && b < 120) return "Busy";
      if (g > 140 && r < 120) return "Available";
      if (r > 180 && g < 120) return "Offline";
    }
    return null;
  };

  const normalizeStatus = (txt) => {
    if (!txt) return null;
    const s = txt.toLowerCase();
    if (s.includes("busy") || s.includes("away") || s.includes("do not disturb") || s.includes("dnd")) return "Busy";
    if (s.includes("available") || s.includes("online") || s.includes("active")) return "Available";
    if (s.includes("out of office") || s.includes("offline") || s.includes("off")) return "Offline";
    return null;
  };

  const teammateAnchors = () => Array.from(document.querySelectorAll('a[data-testid^="workspace-teammate-"]'));

  function readCount(anchor) {
    let span = anchor.querySelector('[class*="workspaceLineMore__StyledWorkspaceLineMoreBadgeDiv"] span');
    if (span?.textContent.trim()) return Number(span.textContent.trim()) || 0;

    const wrapper = anchor.closest('.tooltipCoordinator__StyledBlockWrapper-sc-b0d190d0-0, .tooltipCoordinator__StyledBlockWrapper');
    if (wrapper) {
      span = wrapper.querySelector('[class*="workspaceLineMore__StyledWorkspaceLineMoreBadgeDiv"] span');
      if (span?.textContent.trim()) return Number(span.textContent.trim()) || 0;

      const previewSibling = wrapper.previousElementSibling;
      if (previewSibling) {
        span = previewSibling.querySelector('[class*="workspaceLineMore__StyledWorkspaceLineMoreBadgeDiv"] span');
        if (span?.textContent.trim()) return Number(span.textContent.trim()) || 0;
      }
    }

    const parent = anchor.parentElement;
    if (parent) {
      span = parent.querySelector('[class*="workspaceLineMore__StyledWorkspaceLineMoreBadgeDiv"] span');
      if (span?.textContent.trim()) return Number(span.textContent.trim()) || 0;
    }
    return 0;
  }

  const readName = (anchor) => {
    const label = anchor.querySelector('[class*="navigationLineLabel__StyledLabelDiv"]') || anchor;
    return (label.textContent || "").trim().replace(/\s*\d+\s*$/, "");
  };

  function readStatus(anchor) {
    const sr = anchor.querySelector('.avatar__StyledAvatarDiv-sc-c490e117-0 + span.visuallyHidden__StyledWrapperSpan-sc-7f2f4ca0-0, .avatar__StyledAvatarDiv-sc-c490e117-0 .visuallyHidden__StyledWrapperSpan-sc-7f2f4ca0-0');
    let status = normalizeStatus(sr && sr.textContent);
    if (status) return status;

    const dot = anchor.querySelector('[class*="avatarBadgeStatus__StyledBadgeDiv"]');
    if (dot) {
      const st = getComputedStyle(dot);
      status = colorToStatus(st.backgroundColor || st.color || st.fill);
      if (status) return status;
    }
    return "Unknown";
  }

  function collect() {
    const rows = teammateAnchors();
    const items = rows.map(a => ({ name: readName(a), count: readCount(a), status: readStatus(a) }));
    const map = new Map();
    for (const it of items) {
      const prev = map.get(it.name);
      if (!prev || prev.count < it.count) map.set(it.name, it);
    }
    return Array.from(map.values());
  }

  const pillHTML = (status) => {
    const color = status === "Busy" ? "#FFCC00" : status === "Available" ? "#34C759" : "#9CA3AF";
    return `<span class="tm-sum-chip"><span class="tm-sum-dot" style="background:${color}"></span><span>${status}</span></span>`;
  };

  function makeTable(rows) {
    const table = document.createElement("table");
    table.className = "tm-sum-table";
    table.innerHTML = `<thead><tr><th style="text-align:left">Name</th><th>Status</th><th>Count</th></tr></thead>`;
    const tb = document.createElement("tbody");
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td"); td.colSpan = 3; td.className = "tm-sum-empty"; td.textContent = "None.";
      tr.appendChild(td); tb.appendChild(tr);
    } else {
      rows.forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${r.name}</td><td>${pillHTML(r.status)}</td><td><span class="tm-sum-badge">${r.count}</span></td>`;
        tb.appendChild(tr);
      });
    }
    table.appendChild(tb);
    return table;
  }

  let __prevOverflow = "";
  const lockPageScroll = (lock) => {
    if (lock) { __prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = "hidden"; }
    else { document.documentElement.style.overflow = __prevOverflow || ""; }
  };

  function showModal(availableLT4, busyAny) {
    const old = document.querySelector(".tm-sum-backdrop"); if (old) old.remove();

    lockPageScroll(true);

    const back = document.createElement("div");
    back.className = "tm-sum-backdrop";
    back.addEventListener("click", (e) => { if (e.target === back) close(); });

    const modal = document.createElement("div"); modal.className = "tm-sum-modal";

    const h = document.createElement("div"); h.className = "tm-sum-h";
    h.innerHTML = `<div class="tm-sum-title">Teammate Summary</div>`;
    const x = document.createElement("button"); x.className = "tm-sum-close"; x.textContent = "✕"; x.onclick = close;
    h.appendChild(x);

    const actions = document.createElement("div"); actions.className = "tm-sum-actions";
    const copyBtn = document.createElement("button"); copyBtn.className = "tm-sum-btn"; copyBtn.textContent = "Copy";
    copyBtn.onclick = () => {
      const lines = [
        "Available (<4):",
        ...availableLT4.map(i => `${i.name} — ${i.count}`),
        "",
        "Busy (any):",
        ...busyAny.map(i => `${i.name} — ${i.count}`)
      ];
      navigator.clipboard.writeText(lines.join("\n")).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      });
    };
    const refreshBtn = document.createElement("button"); refreshBtn.className = "tm-sum-btn"; refreshBtn.textContent = "Refresh"; refreshBtn.onclick = run;
    actions.append(copyBtn, refreshBtn);

    const content = document.createElement("div"); content.className = "tm-sum-content";

    const sec1 = document.createElement("div"); sec1.className = "tm-sum-section";
    sec1.innerHTML = `<div class="tm-sum-sec-title">Available (green) with &lt; ${COUNT_THRESHOLD}</div>`;
    sec1.appendChild(makeTable(availableLT4.sort((a,b)=>a.count-b.count || a.name.localeCompare(b.name))));

    const sec2 = document.createElement("div"); sec2.className = "tm-sum-section";
    sec2.innerHTML = `<div class="tm-sum-sec-title">Busy (yellow) — all</div>`;
    sec2.appendChild(makeTable(busyAny.sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name))));

    content.append(sec1, sec2);

    const f = document.createElement("div"); f.className = "tm-sum-f";
    f.innerHTML = `<span>Hotkey: Shift + B</span><span>Scroll inside this panel</span>`;

    modal.append(h, actions, content, f);
    back.appendChild(modal);
    document.body.appendChild(back);

    function close() {
      lockPageScroll(false);
      back.remove();
    }
    document.addEventListener("keydown", function esc(e){
      if (e.key === "Escape"){ close(); document.removeEventListener("keydown", esc); }
    }, { once:true });
  }

  function run() {
    const all = collect();
    const availableLT4 = all.filter(p => p.status === "Available" && p.count < COUNT_THRESHOLD);
    const busyAny      = all.filter(p => p.status === "Busy");
    showModal(availableLT4, busyAny);
  }

  window.addEventListener("keydown", (e) => {
    if (e.shiftKey === HOTKEY.shiftKey && e.key.toUpperCase() === HOTKEY.key.toUpperCase()) {
      e.preventDefault(); run();
    }
  });
  window.addEventListener("TM_SHOW_TEAM_SUMMARY", run);
})();
