/* =========================================================================
   Dashboard ยอดขายร้านอาหาร — บ้านโฮม
   ดึงข้อมูลสดจาก Google Sheet (POS export) ผ่าน Google Visualization API
   โดยโหลดเป็น <script> tag (JSONP) แทนการใช้ fetch() ตรงๆ เพื่อเลี่ยงปัญหา
   CORS ที่ endpoint นี้อาจเจอได้ (ไม่ต้องมี backend / API key — ชีตต้องแชร์
   เป็น "ทุกคนที่มีลิงก์-ดูได้")
   ========================================================================= */

const CONFIG = {
  // ---- Google Sheet ที่เป็นฐานข้อมูล ----
  SHEET_ID: "1h-_POlaVm6SIykAp5yz1vZjsJp3WPtRn-PDvkzo4Nzg",

  // ---- ชื่อแท็บชีต 3 แท็บ ต้องตรงกับที่ Export จาก POS เป๊ะๆ ----
  // ถ้าการดึงข้อมูลด้วยชื่อชีตใช้ไม่ได้ (เช่น เจอ banner แจ้งเตือนด้านบน)
  // ให้เปิดชีตแต่ละแท็บใน Google Sheets แล้วคัดลอกเลข gid จาก URL
  // (ส่วนที่อยู่หลัง #gid=) มาใส่ในช่อง gid ด้านล่างแทน
  TABS: {
    items:  { name: "salebyproduct",                    gid: null },
    bills:  { name: "ยอดขายแยกตามบิล",                   gid: null },
    hourly: { name: "ยอดขายตามสินค้ารายชั่วโมง",          gid: null },
  },

  // ---- หมวดสินค้าที่ถือว่าเป็น "รีสอร์ท/ห้องพัก" ให้ตัดออกจากยอดร้านอาหาร ----
  RESORT_CATEGORIES: ["รีสอร์ท", "ห้องพัก พูลวิลล่า"],

  // ---- ช่วงเวลาแบ่งมื้ออาหาร (ปรับได้ตามเวลาเปิด-ปิดร้านจริง) ----
  MEAL_PERIODS: [
    { key: "breakfast", label: "เช้า (08-11 น.)",     start: 8,  end: 11 },
    { key: "lunch",      label: "กลางวัน (11-14 น.)",  start: 11, end: 14 },
    { key: "afternoon",  label: "บ่าย (14-17 น.)",     start: 14, end: 17 },
    { key: "evening",    label: "เย็น (17-20 น.)",     start: 17, end: 20 },
    { key: "night",      label: "ค่ำ (20-23 น.)",      start: 20, end: 23 },
  ],

  AUTO_REFRESH_MINUTES: 10,
};

/* ========================================================================
   Utilities
   ======================================================================== */
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtBaht = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
};
const fmtCompact = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return fmtInt(n);
};
const pad2 = (n) => String(n).padStart(2, "0");
const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const WEEKDAY_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const WEEKDAY_TH_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // จันทร์ -> อาทิตย์

function parseNum(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseHourFromTimeField(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  // "HH:MM" or "HH:MM:SS" or "HH:MM:SS AM/PM"
  let m = s.match(/^(\d{1,2}):(\d{2})(:(\d{2}))?\s*(AM|PM|am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const ampm = m[5] ? m[5].toUpperCase() : null;
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h % 24;
  }
  // Decimal day-fraction (e.g. 0.4604166667) that Sheets sometimes exports for time-only cells
  const f = parseFloat(s);
  if (!isNaN(f) && f >= 0 && f < 1) return Math.floor(f * 24);
  return null;
}

/* ========================================================================
   Data fetching — Google Visualization API, loaded via a <script> tag
   (JSONP-style) instead of fetch(). A plain fetch()/XHR to the gviz CSV
   endpoint can hit a browser CORS error in some setups (Google sometimes
   serves the response via a cross-origin redirect that lacks CORS headers).
   A <script src="..."> load is NOT subject to that restriction at all, so
   this route works reliably regardless of hosting (GitHub Pages, local
   server, etc.) as long as the sheet is shared as "Anyone with the link –
   Viewer".
   ======================================================================== */
let __jsonpSeq = 0;
function fetchGvizTable(tabConfig) {
  return new Promise((resolve, reject) => {
    const cbName = `__gvizCb_${++__jsonpSeq}_${Date.now()}`;
    const base = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq`;
    const locator = (tabConfig.gid !== null && tabConfig.gid !== undefined && tabConfig.gid !== "")
      ? `gid=${encodeURIComponent(tabConfig.gid)}`
      : `sheet=${encodeURIComponent(tabConfig.name)}`;
    const url = `${base}?tqx=out:json;responseHandler:${cbName}&${locator}&_t=${Date.now()}`;

    const script = document.createElement("script");
    let done = false;

    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("หมดเวลารอข้อมูลจาก Google Sheets (โหลดนานเกิน 15 วินาที) — ตรวจสอบอินเทอร์เน็ต หรือสิทธิ์การแชร์ชีต"));
    }, 15000);

    function cleanup() {
      clearTimeout(timeoutId);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cbName] = (resp) => {
      if (done) return;
      done = true;
      cleanup();
      if (!resp) { reject(new Error("ไม่ได้รับข้อมูลจาก Google Sheets")); return; }
      if (resp.status === "error") {
        const detail = (resp.errors && resp.errors[0] && (resp.errors[0].detailed_message || resp.errors[0].message)) || "ไม่ทราบสาเหตุ";
        reject(new Error(`Google Sheets ตอบกลับว่าผิดพลาด: ${detail}`));
        return;
      }
      resolve(resp.table);
    };

    script.src = url;
    script.async = true;
    script.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("โหลดสคริปต์จาก Google Sheets ไม่สำเร็จ (เครือข่ายผิดพลาด หรือ Sheet ID ไม่ถูกต้อง)"));
    };
    document.head.appendChild(script);
  });
}

// ---- gviz cell helpers (อ่านค่าจาก table.rows[i].c[j].v ตามตำแหน่งคอลัมน์) ----
function gcell(row, idx) {
  const c = row && row.c && row.c[idx];
  return c ? c.v : null;
}
function gStr(row, idx) {
  const v = gcell(row, idx);
  return v === null || v === undefined ? "" : String(v).trim();
}
function gNum(row, idx) {
  const v = gcell(row, idx);
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  return parseNum(v);
}
function gDateISO(row, idx) {
  const v = gcell(row, idx);
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    const m = v.match(/^Date\((\d+),(\d+),(\d+)/);
    if (m) return `${m[1]}-${pad2(+m[2] + 1)}-${pad2(+m[3])}`; // gviz month is 0-based
    return v.slice(0, 10);
  }
  return "";
}
function gHour(row, idx) {
  const v = gcell(row, idx);
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v[0]; // gviz "timeofday" -> [h, m, s, ms]
  if (typeof v === "number") return v >= 0 && v < 1 ? Math.floor(v * 24) : Math.floor(v) % 24;
  if (typeof v === "string") return parseHourFromTimeField(v);
  return null;
}

const diagnostics = [];
function pushDiag(msg) { diagnostics.push(msg); }

/* ------------------------------------------------------------------------
   โหลดและทำความสะอาดข้อมูลทั้ง 3 ชีต
   ------------------------------------------------------------------------ */
let DATA = { items: [], bills: [], hourly: [], minDate: null, maxDate: null };

async function loadAllData() {
  diagnostics.length = 0;
  if (CHART_SETUP_ERROR) pushDiag(CHART_SETUP_ERROR);
  setSyncState("loading", "กำลังโหลดข้อมูล…");

  const [itemsTable, billsTable, hourlyTable] = await Promise.all([
    fetchGvizTable(CONFIG.TABS.items).catch((e) => { pushDiag(`โหลดชีตสินค้า (${CONFIG.TABS.items.name}) ไม่สำเร็จ: ${e.message}`); return null; }),
    fetchGvizTable(CONFIG.TABS.bills).catch((e) => { pushDiag(`โหลดชีตบิล (${CONFIG.TABS.bills.name}) ไม่สำเร็จ: ${e.message}`); return null; }),
    fetchGvizTable(CONFIG.TABS.hourly).catch((e) => { pushDiag(`โหลดชีตรายชั่วโมง (${CONFIG.TABS.hourly.name}) ไม่สำเร็จ: ${e.message}`); return null; }),
  ]);

  DATA.items = itemsTable ? cleanItems(itemsTable.rows || []) : [];
  DATA.bills = billsTable ? cleanBills(billsTable.rows || []) : [];
  DATA.hourly = hourlyTable ? cleanHourly(hourlyTable.rows || []) : [];

  // ---- schema sanity checks (จับกรณีดึงชีตผิดแท็บ/จำนวนคอลัมน์ไม่ตรง) ----
  if (itemsTable && (itemsTable.cols || []).length < 14) {
    pushDiag(`ชีตสินค้า (${CONFIG.TABS.items.name}) มีจำนวนคอลัมน์น้อยกว่าที่คาดไว้ (${(itemsTable.cols || []).length}) — ตรวจสอบชื่อแท็บ/gid ใน CONFIG`);
  }
  if (billsTable && (billsTable.cols || []).length < 20) {
    pushDiag(`ชีตบิล (${CONFIG.TABS.bills.name}) มีจำนวนคอลัมน์น้อยกว่าที่คาดไว้ (${(billsTable.cols || []).length}) — ตรวจสอบชื่อแท็บ/gid ใน CONFIG`);
  }
  if (hourlyTable && (hourlyTable.cols || []).length < 34) {
    pushDiag(`ชีตรายชั่วโมง (${CONFIG.TABS.hourly.name}) มีจำนวนคอลัมน์น้อยกว่าที่คาดไว้ (${(hourlyTable.cols || []).length}) — ตรวจสอบชื่อแท็บ/gid ใน CONFIG`);
  }

  // ---- ช่วงวันที่ที่มีข้อมูลจริง ----
  const allDates = [...DATA.items.map((r) => r.date), ...DATA.bills.map((r) => r.date)].filter(Boolean).sort();
  DATA.minDate = allDates.length ? allDates[0] : toISODate(new Date());
  DATA.maxDate = allDates.length ? allDates[allDates.length - 1] : toISODate(new Date());

  renderDiagnostics();
  if (!itemsTable && !billsTable && !hourlyTable) {
    setSyncState("err", "โหลดข้อมูลไม่สำเร็จ — ดูรายละเอียดด้านบน");
    return false;
  }
  setSyncState("ok", `อัปเดตล่าสุด ${new Date().toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}`);
  return true;
}

// ชีตสินค้า (salebyproduct) — คอลัมน์ตามตำแหน่ง:
// 0 วันที่, 1 รหัสสินค้า, 2 ชื่อสินค้า, 3 กลุ่ม, 4 หมวดสินค้า, 5 ต้นทุนเฉลี่ย, 6 ราคาขายเฉลี่ย,
// 7 กำไรเฉลี่ย, 8 จำนวนการขาย, 9 ยอดก่อนลด, 10 ต้นทุน, 11 ส่วนลดสินค้า, 12 ราคาสุทธิ, 13 กำไร, 14 สาขา
function cleanItems(rows) {
  return rows
    .map((r) => ({
      date: gDateISO(r, 0),
      name: gStr(r, 2),
      category: gStr(r, 4),
      qty: gNum(r, 8),
      grossBeforeDiscount: gNum(r, 9),
      discount: gNum(r, 11),
      net: gNum(r, 12),
      profit: gNum(r, 13),
    }))
    .filter((r) => r.date && r.name);
}

// ชีตบิล (ยอดขายแยกตามบิล) — คอลัมน์ตามตำแหน่ง (0-based):
// 0 วันที่ชำระเงิน, 1 เวลาที่ชำระเงิน, 19 รวมสุทธิ, 22 ประเภทการสั่ง, 24 ประเภทการชำระเงิน, 29 จำนวนลูกค้า
function cleanBills(rows) {
  return rows
    .map((r) => ({
      date: gDateISO(r, 0),
      hour: gHour(r, 1),
      net: gNum(r, 19),
      customers: gNum(r, 29) || 1,
      orderType: gStr(r, 22) || "ไม่ระบุ",
      paymentType: gStr(r, 24) || "ไม่ระบุ",
    }))
    .filter((r) => r.date && r.paymentType !== "Void All");
}

// ชีตรายชั่วโมง: 10 คอลัมน์คงที่ + 24 คอลัมน์ชั่วโมง (0-23) + สาขา — อ้างอิงด้วยตำแหน่ง
function cleanHourly(rows) {
  return rows
    .map((r) => {
      const name = gStr(r, 1);
      const category = gStr(r, 3);
      if (!name) return null;
      const hours = [];
      for (let h = 0; h < 24; h++) hours.push(gNum(r, 10 + h));
      return { name, category, hours };
    })
    .filter(Boolean);
}

/* ========================================================================
   Filter state
   ======================================================================== */
let currentRange = { start: null, end: null }; // ISO strings

function inRange(dateStr) {
  return dateStr >= currentRange.start && dateStr <= currentRange.end;
}

function setRange(start, end) {
  currentRange.start = start;
  currentRange.end = end;
  document.getElementById("startDate").value = start;
  document.getElementById("endDate").value = end;
  const d1 = new Date(start), d2 = new Date(end);
  const days = Math.round((d2 - d1) / 86400000) + 1;
  document.getElementById("rangeLabel").textContent =
    `แสดงข้อมูล ${start} ถึง ${end} (${days} วัน)`;
}

function previousRange() {
  const d1 = new Date(currentRange.start), d2 = new Date(currentRange.end);
  const days = Math.round((d2 - d1) / 86400000) + 1;
  const prevEnd = addDays(d1, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { start: toISODate(prevStart), end: toISODate(prevEnd) };
}

/* ========================================================================
   Aggregations
   ======================================================================== */
function isRestaurant(category) { return !CONFIG.RESORT_CATEGORIES.includes(category); }

function computeCore(range) {
  const items = DATA.items.filter((r) => r.date >= range.start && r.date <= range.end);
  const bills = DATA.bills.filter((r) => r.date >= range.start && r.date <= range.end);

  const restaurantItems = items.filter((r) => isRestaurant(r.category));
  const resortItems = items.filter((r) => !isRestaurant(r.category));

  const restaurantRevenue = restaurantItems.reduce((s, r) => s + r.net, 0);
  const restaurantDiscount = restaurantItems.reduce((s, r) => s + r.discount, 0);
  const resortRevenue = resortItems.reduce((s, r) => s + r.net, 0);
  const daysInRange = Math.round((new Date(range.end) - new Date(range.start)) / 86400000) + 1;
  const avgDailyRevenue = daysInRange ? restaurantRevenue / daysInRange : 0;

  const billCount = bills.length;
  const billNetTotal = bills.reduce((s, r) => s + r.net, 0);
  const avgPerBill = billCount ? billNetTotal / billCount : 0;
  const avgCustomers = billCount ? bills.reduce((s, r) => s + r.customers, 0) / billCount : 0;

  const topByRevenue = {};
  const topByQty = {};
  const itemCategory = {};
  restaurantItems.forEach((r) => {
    topByRevenue[r.name] = (topByRevenue[r.name] || 0) + r.net;
    topByQty[r.name] = (topByQty[r.name] || 0) + r.qty;
    itemCategory[r.name] = r.category;
  });
  const topItemName = Object.keys(topByRevenue).sort((a, b) => topByRevenue[b] - topByRevenue[a])[0] || "—";

  return {
    restaurantItems, resortItems, bills,
    restaurantRevenue, restaurantDiscount, resortRevenue, avgDailyRevenue, daysInRange,
    billCount, billNetTotal, avgPerBill, avgCustomers,
    topByRevenue, topByQty, itemCategory, topItemName,
    topItemQty: topByQty[topItemName] || 0,
  };
}

function pctDelta(cur, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/* ========================================================================
   Chart.js shared styling
   ======================================================================== */
function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

function baseGridColor() { return cssVar("--gridline"); }
function baseTextColor() { return cssVar("--text-secondary"); }
function baseMutedColor() { return cssVar("--text-muted"); }

// ป้องกันไม่ให้ทั้งหน้าเว็บพังเงียบๆ ถ้า CDN ของ Chart.js โหลดไม่สำเร็จ (เช่น
// ถูกบล็อกโดยเน็ตเวิร์ก/ตัวบล็อกโฆษณา หรือลิงก์เสีย) — ถ้าเกิดกรณีนี้ ให้ตัวเว็บ
// ยังคงดึงข้อมูลและแสดง KPI/ตารางได้ตามปกติ เพียงแต่ไม่มีกราฟ พร้อมแจ้งเตือนชัดเจน
const CHART_LIB_OK = typeof Chart !== "undefined";
let CHART_SETUP_ERROR = null; // เก็บไว้เผื่อ diagnostics array ถูกล้างไปแล้วตอนที่ error นี้เกิด (สคริปต์นี้รันก่อน loadAllData() เสมอ)
if (CHART_LIB_OK) {
  try {
    Chart.register(ChartDataLabels);
    Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Thai', sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.datalabels.display = false; // เปิดเฉพาะจุดที่ต้องการ
  } catch (e) {
    CHART_SETUP_ERROR = `ตั้งค่า Chart.js ไม่สำเร็จ: ${e.message}`;
  }
} else {
  CHART_SETUP_ERROR = "โหลดไลบรารี Chart.js จาก CDN ไม่สำเร็จ — กราฟจะไม่แสดง แต่ตัวเลข KPI และตารางยังใช้งานได้ปกติ ลองรีเฟรชหน้าเว็บอีกครั้ง หรือตรวจสอบว่ามีตัวบล็อกโฆษณา/เน็ตเวิร์กบล็อก cdn.jsdelivr.net อยู่หรือไม่";
}

function tooltipBase() {
  return {
    backgroundColor: cssVar("--surface-1"),
    titleColor: cssVar("--text-primary"),
    bodyColor: cssVar("--text-primary"),
    borderColor: cssVar("--border"),
    borderWidth: 1,
    padding: 10,
    titleFont: { weight: "600", size: 12 },
    bodyFont: { size: 12 },
    boxPadding: 4,
    displayColors: true,
  };
}

function commonScales(extra) {
  return Object.assign({
    x: {
      grid: { display: false },
      ticks: { color: baseMutedColor() },
      border: { color: cssVar("--baseline") },
    },
    y: {
      beginAtZero: true,
      grid: { color: baseGridColor(), drawTicks: false },
      border: { display: false },
      ticks: {
        color: baseMutedColor(),
        callback: (v) => fmtCompact(v),
        maxTicksLimit: 6,
      },
    },
  }, extra || {});
}

const charts = {}; // name -> Chart instance

function destroyChart(name) {
  if (charts[name]) { charts[name].destroy(); delete charts[name]; }
}

// เผื่อ CDN ของ Chart.js โหลดไม่สำเร็จ: แสดงข้อความแทนกราฟ แต่ไม่ทำให้หน้าเว็บพัง
// (ตัวเลข KPI และปุ่ม "แสดงตาราง" ใต้กราฟยังใช้งานได้ตามปกติ)
function safeNewChart(canvasEl, config) {
  if (!CHART_LIB_OK) {
    const wrap = canvasEl && canvasEl.parentElement;
    if (wrap && !wrap.querySelector(".chart-unavailable-note")) {
      const note = document.createElement("div");
      note.className = "chart-unavailable-note";
      note.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;text-align:center;padding:12px;";
      note.textContent = "กราฟไม่พร้อมใช้งาน (โหลด Chart.js จาก CDN ไม่สำเร็จ) — ดูตัวเลขได้จากปุ่ม \"แสดงตาราง\" ด้านล่าง";
      wrap.appendChild(note);
    }
    return { destroy() {}, update() {} };
  }
  return new Chart(canvasEl, config);
}

/* ========================================================================
   Render: KPI cards
   ======================================================================== */
function deltaHtml(delta, invert) {
  if (delta === null) return `<div class="delta flat">— เทียบช่วงก่อนหน้าไม่ได้ (ไม่มีข้อมูล)</div>`;
  const up = invert ? delta < 0 : delta > 0;
  const flat = Math.abs(delta) < 0.05;
  const cls = flat ? "flat" : (up ? "up" : "down");
  const arrow = flat ? "→" : (delta > 0 ? "▲" : "▼");
  return `<div class="delta ${cls}">${arrow} ${Math.abs(delta).toFixed(1)}% เทียบช่วงก่อนหน้า</div>`;
}

function renderKPIs(cur, prev) {
  const el = document.getElementById("kpiGrid");
  el.innerHTML = `
    <div class="kpi">
      <div class="label">ยอดขายร้านอาหาร</div>
      <div class="value">${fmtBaht(cur.restaurantRevenue)} <small>บาท</small></div>
      ${deltaHtml(pctDelta(cur.restaurantRevenue, prev.restaurantRevenue))}
      <div class="foot">ตัดยอดรีสอร์ท/ห้องพักออกแล้ว</div>
    </div>
    <div class="kpi">
      <div class="label">ยอดขายเฉลี่ยต่อวัน</div>
      <div class="value">${fmtBaht(cur.avgDailyRevenue)} <small>บาท</small></div>
      ${deltaHtml(pctDelta(cur.avgDailyRevenue, prev.avgDailyRevenue))}
      <div class="foot">เฉพาะร้านอาหาร เฉลี่ยจาก ${cur.daysInRange} วันที่เลือก</div>
    </div>
    <div class="kpi">
      <div class="label">จำนวนบิล</div>
      <div class="value">${fmtInt(cur.billCount)} <small>บิล</small></div>
      ${deltaHtml(pctDelta(cur.billCount, prev.billCount))}
      <div class="foot">รวมทุกบิลจาก POS (ร้านอาหาร+รีสอร์ท ไม่นับบิล Void)</div>
    </div>
    <div class="kpi">
      <div class="label">ยอดขายเฉลี่ยต่อบิล</div>
      <div class="value">${fmtBaht(cur.avgPerBill)} <small>บาท</small></div>
      ${deltaHtml(pctDelta(cur.avgPerBill, prev.avgPerBill))}
      <div class="foot">รวมทุกบิลจาก POS (ร้านอาหาร+รีสอร์ท)</div>
    </div>
    <div class="kpi">
      <div class="label">เมนูขายดีที่สุด</div>
      <div class="value" style="font-size:18px; line-height:1.3;">${escapeHtml(cur.topItemName)}</div>
      <div class="foot">ขายได้ ${fmtInt(cur.topItemQty)} รายการ ในช่วงที่เลือก</div>
    </div>
    <div class="kpi">
      <div class="label">ลูกค้าเฉลี่ยต่อบิล</div>
      <div class="value">${cur.avgCustomers.toFixed(1)} <small>คน</small></div>
      <div class="foot">จากรายงานบิล (ทุกบิล)</div>
    </div>
    <div class="kpi">
      <div class="label">ส่วนลดที่ให้ลูกค้า</div>
      <div class="value">${fmtBaht(cur.restaurantDiscount)} <small>บาท</small></div>
      <div class="foot">เฉพาะรายการร้านอาหาร</div>
    </div>
    <div class="kpi muted">
      <div class="label">ยอดขายรีสอร์ท (บริบทเทียบ)</div>
      <div class="value">${fmtBaht(cur.resortRevenue)} <small>บาท</small></div>
      <div class="foot">ไม่รวมในยอดร้านอาหารด้านบน</div>
    </div>
  `;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ========================================================================
   Render: Daily trend (line, restaurant vs resort context)
   ======================================================================== */
function renderDaily(range) {
  const byDate = {};
  DATA.items.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (!byDate[r.date]) byDate[r.date] = { restaurant: 0, resort: 0 };
    if (isRestaurant(r.category)) byDate[r.date].restaurant += r.net;
    else byDate[r.date].resort += r.net;
  });
  const dates = Object.keys(byDate).sort();
  const restaurantSeries = dates.map((d) => byDate[d].restaurant);
  const resortSeries = dates.map((d) => byDate[d].resort);
  const labels = dates.map((d) => d.slice(5)); // MM-DD

  destroyChart("daily");
  const ctx = document.getElementById("chartDaily");
  charts.daily = safeNewChart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "ร้านอาหาร",
          data: restaurantSeries,
          borderColor: cssVar("--series-1"),
          backgroundColor: cssVar("--series-1") + "1A",
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHitRadius: 12,
          pointBackgroundColor: cssVar("--series-1"),
          pointBorderColor: cssVar("--surface-1"),
          pointBorderWidth: 2,
          borderWidth: 2,
          fill: true,
          tension: 0.25,
        },
        {
          label: "รีสอร์ท (บริบท)",
          data: resortSeries,
          borderColor: baseMutedColor(),
          backgroundColor: "transparent",
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 12,
          borderWidth: 2,
          borderDash: [4, 3],
          fill: false,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "end", labels: { color: baseTextColor(), boxWidth: 14, boxHeight: 2 } },
        tooltip: Object.assign(tooltipBase(), {
          callbacks: {
            title: (items) => dates[items[0].dataIndex],
            label: (item) => `${item.dataset.label}: ${fmtBaht(item.raw)} บาท`,
          },
        }),
        datalabels: { display: false },
      },
      scales: commonScales(),
    },
  });
  renderTableView("tblDaily", ["วันที่", "ร้านอาหาร (บาท)", "รีสอร์ท (บาท)"],
    dates.map((d, i) => [d, fmtBaht(restaurantSeries[i]), fmtBaht(resortSeries[i])]));
}

/* ========================================================================
   Render: Top items (horizontal bar)
   ======================================================================== */
let topMode = "revenue";
function renderTopItems(cur) {
  const src = topMode === "revenue" ? cur.topByRevenue : cur.topByQty;
  const entries = Object.entries(src).sort((a, b) => b[1] - a[1]).slice(0, 10).reverse();
  const labels = entries.map((e) => e[0]);
  const values = entries.map((e) => e[1]);

  destroyChart("top");
  const ctx = document.getElementById("chartTopItems");
  charts.top = safeNewChart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: cssVar("--seq-450"),
        borderRadius: { topRight: 4, bottomRight: 4, topLeft: 0, bottomLeft: 0 },
        borderSkipped: false,
        barThickness: 16,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), {
          callbacks: {
            label: (item) => topMode === "revenue" ? `${fmtBaht(item.raw)} บาท` : `${fmtInt(item.raw)} รายการ`,
          },
        }),
        datalabels: {
          display: true,
          anchor: "end", align: "right", clamp: true,
          color: baseTextColor(),
          font: { size: 11 },
          formatter: (v) => topMode === "revenue" ? fmtCompact(v) : fmtInt(v),
        },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: baseGridColor() }, ticks: { color: baseMutedColor(), callback: (v) => fmtCompact(v) }, border: { display: false } },
        y: { grid: { display: false }, ticks: { color: baseTextColor(), font: { size: 11.5 } }, border: { color: cssVar("--baseline") } },
      },
    },
  });
  renderTableView("tblTop", ["เมนู", "ยอดขาย (บาท)", "จำนวน"],
    entries.slice().reverse().map(([name]) => [name, fmtBaht(cur.topByRevenue[name] || 0), fmtInt(cur.topByQty[name] || 0)]));
}

/* ========================================================================
   Render: Category breakdown (horizontal bar, sorted desc)
   ======================================================================== */
function renderCategory(cur) {
  const byCat = {};
  cur.restaurantItems.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + r.net; });
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 12).reverse();
  const labels = entries.map((e) => e[0]);
  const values = entries.map((e) => e[1]);

  destroyChart("category");
  const ctx = document.getElementById("chartCategory");
  charts.category = safeNewChart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: cssVar("--series-2"), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: false, barThickness: 16 }] },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { label: (item) => `${fmtBaht(item.raw)} บาท` } }),
        datalabels: { display: true, anchor: "end", align: "right", clamp: true, color: baseTextColor(), font: { size: 11 }, formatter: (v) => fmtCompact(v) },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: baseGridColor() }, ticks: { color: baseMutedColor(), callback: (v) => fmtCompact(v) }, border: { display: false } },
        y: { grid: { display: false }, ticks: { color: baseTextColor(), font: { size: 11.5 } }, border: { color: cssVar("--baseline") } },
      },
    },
  });
  renderTableView("tblCategory", ["หมวดสินค้า", "ยอดขาย (บาท)"], entries.slice().reverse().map(([n, v]) => [n, fmtBaht(v)]));
}

/* ========================================================================
   Render: Hourly (all POS, respects filter)
   ======================================================================== */
function renderHourAll(range) {
  const hours = new Array(24).fill(0);
  DATA.bills.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (r.hour === null) return;
    hours[r.hour] += r.net;
  });
  const labels = hours.map((_, h) => `${pad2(h)}`);

  destroyChart("hourAll");
  charts.hourAll = safeNewChart(document.getElementById("chartHourAll"), {
    type: "bar",
    data: { labels, datasets: [{ data: hours, backgroundColor: cssVar("--seq-450"), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", barThickness: 14 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { title: (items) => `${items[0].label}:00 น.`, label: (item) => `${fmtBaht(item.raw)} บาท` } }),
      },
      scales: commonScales(),
    },
  });
  renderTableView("tblHourAll", ["ชั่วโมง", "ยอดขาย (บาท)"], hours.map((v, h) => [`${pad2(h)}:00`, fmtBaht(v)]));
}

/* ========================================================================
   Render: Meal periods (all POS, respects filter)
   ======================================================================== */
function renderMeal(range) {
  const hours = new Array(24).fill(0);
  DATA.bills.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (r.hour === null) return;
    hours[r.hour] += r.net;
  });
  const values = CONFIG.MEAL_PERIODS.map((p) => {
    let sum = 0;
    for (let h = p.start; h < p.end; h++) sum += hours[h % 24];
    return sum;
  });
  const labels = CONFIG.MEAL_PERIODS.map((p) => p.label);

  destroyChart("meal");
  charts.meal = safeNewChart(document.getElementById("chartMeal"), {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: cssVar("--series-5"), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", barThickness: 30 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { label: (item) => `${fmtBaht(item.raw)} บาท` } }),
        datalabels: { display: true, anchor: "end", align: "top", color: baseTextColor(), font: { size: 11 }, formatter: (v) => fmtCompact(v) },
      },
      scales: commonScales(),
    },
  });
  renderTableView("tblMeal", ["มื้อ", "ยอดขาย (บาท)"], labels.map((l, i) => [l, fmtBaht(values[i])]));
}

/* ========================================================================
   Render: Restaurant-only hourly pattern (static, whole period, by qty)
   ======================================================================== */
function renderHourRestaurant() {
  const hours = new Array(24).fill(0);
  DATA.hourly.forEach((r) => {
    if (!isRestaurant(r.category)) return;
    r.hours.forEach((v, h) => { hours[h] += v; });
  });
  const labels = hours.map((_, h) => pad2(h));

  destroyChart("hourRest");
  charts.hourRest = safeNewChart(document.getElementById("chartHourRestaurant"), {
    type: "bar",
    data: { labels, datasets: [{ data: hours, backgroundColor: cssVar("--series-8"), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", barThickness: 14 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { title: (items) => `${items[0].label}:00 น.`, label: (item) => `${fmtInt(item.raw)} รายการ` } }),
      },
      scales: commonScales({ y: { beginAtZero: true, grid: { color: baseGridColor() }, ticks: { color: baseMutedColor(), callback: (v) => fmtInt(v) } } }),
    },
  });
  renderTableView("tblHourRest", ["ชั่วโมง", "จำนวนรายการ"], hours.map((v, h) => [`${pad2(h)}:00`, fmtInt(v)]));
}

/* ========================================================================
   Render: Weekday pattern (restaurant only, respects filter)
   ======================================================================== */
function renderWeekday(range) {
  const sums = {};
  WEEKDAY_ORDER.forEach((d) => (sums[d] = 0));
  DATA.items.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (!isRestaurant(r.category)) return;
    const dow = new Date(r.date + "T00:00:00").getDay();
    sums[dow] += r.net;
  });
  const labels = WEEKDAY_ORDER.map((d) => WEEKDAY_TH_SHORT[d]);
  const values = WEEKDAY_ORDER.map((d) => sums[d]);

  destroyChart("weekday");
  charts.weekday = safeNewChart(document.getElementById("chartWeekday"), {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: cssVar("--seq-450"), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", barThickness: 26 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { title: (items) => WEEKDAY_TH[WEEKDAY_ORDER[items[0].dataIndex]], label: (item) => `${fmtBaht(item.raw)} บาท` } }),
      },
      scales: commonScales(),
    },
  });
  renderTableView("tblWeekday", ["วัน", "ยอดขาย (บาท)"], WEEKDAY_ORDER.map((d, i) => [WEEKDAY_TH[d], fmtBaht(values[i])]));
}

/* ========================================================================
   Render: Payment / order-type breakdown (small horizontal bars)
   ======================================================================== */
function renderBreakdownChart(canvasId, chartKey, byLabel, colorSlots) {
  const entries = Object.entries(byLabel).sort((a, b) => b[1] - a[1]);
  const labels = entries.map((e) => e[0]);
  const values = entries.map((e) => e[1]);
  const colors = labels.map((_, i) => colorSlots[i % colorSlots.length]);

  destroyChart(chartKey);
  charts[chartKey] = safeNewChart(document.getElementById(canvasId), {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: false, barThickness: 22 }] },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { label: (item) => `${fmtBaht(item.raw)} บาท` } }),
        datalabels: { display: true, anchor: "end", align: "right", clamp: true, color: baseTextColor(), font: { size: 11 }, formatter: (v) => fmtCompact(v) },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: baseGridColor() }, ticks: { color: baseMutedColor(), callback: (v) => fmtCompact(v) }, border: { display: false } },
        y: { grid: { display: false }, ticks: { color: baseTextColor() }, border: { color: cssVar("--baseline") } },
      },
    },
  });
}

function renderPaymentAndOrderType(cur) {
  const byPayment = {};
  const byOrder = {};
  cur.bills.forEach((r) => {
    byPayment[r.paymentType] = (byPayment[r.paymentType] || 0) + r.net;
    byOrder[r.orderType] = (byOrder[r.orderType] || 0) + r.net;
  });
  renderBreakdownChart("chartPayment", "payment", byPayment, [cssVar("--series-1"), cssVar("--series-2"), cssVar("--series-3")]);
  renderBreakdownChart("chartOrderType", "orderType", byOrder, [cssVar("--series-4"), cssVar("--series-6"), cssVar("--series-5")]);
}

/* ========================================================================
   Render: Big items table (sortable)
   ======================================================================== */
let itemsTableSort = { key: "revenue", dir: -1 };
let lastItemsTableCur = null;
function renderItemsTable(cur) {
  lastItemsTableCur = cur;
  const totalRevenue = cur.restaurantRevenue || 1;
  const rows = Object.keys(cur.topByRevenue).map((name) => ({
    name,
    category: cur.itemCategory[name] || "",
    qty: cur.topByQty[name] || 0,
    revenue: cur.topByRevenue[name] || 0,
  }));
  rows.forEach((r) => {
    r.avgprice = r.qty ? r.revenue / r.qty : 0;
    r.share = (r.revenue / totalRevenue) * 100;
  });
  rows.sort((a, b) => (a[itemsTableSort.key] - b[itemsTableSort.key]) * itemsTableSort.dir);

  const tbody = document.querySelector("#itemsTable tbody");
  tbody.innerHTML = rows.slice(0, 30).map((r, i) => `
    <tr>
      <td class="rank-badge">${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.category)}</td>
      <td>${fmtInt(r.qty)}</td>
      <td>${fmtBaht(r.revenue)}</td>
      <td>${fmtBaht(r.avgprice)}</td>
      <td>${r.share.toFixed(1)}%</td>
    </tr>
  `).join("") || `<tr><td colspan="7" class="empty-state">ไม่มีข้อมูลในช่วงที่เลือก</td></tr>`;

  document.querySelectorAll('#itemsTable th[data-sort]').forEach((th) => {
    const base = th.textContent.replace(/\s*[▾▴]$/, "");
    th.textContent = base + (th.dataset.sort === itemsTableSort.key ? (itemsTableSort.dir === -1 ? " ▾" : " ▴") : "");
  });
}

/* ========================================================================
   Table-view helper (accessibility twin of a chart)
   ======================================================================== */
function renderTableView(containerId, headers, rows) {
  const el = document.getElementById(containerId);
  el.innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

/* ========================================================================
   Diagnostics banner
   ======================================================================== */
function renderDiagnostics() {
  const el = document.getElementById("diagBanner");
  if (!diagnostics.length) { el.classList.remove("show"); el.innerHTML = ""; return; }
  el.classList.add("show");
  el.innerHTML = `<strong>⚠ พบปัญหาระหว่างดึงข้อมูล:</strong><ul style="margin:6px 0 0 18px;">${diagnostics.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
    <div style="margin-top:6px;">ตรวจสอบว่า Google Sheet แชร์เป็น “ทุกคนที่มีลิงก์ - ดูได้” และชื่อแท็บ/gid ใน CONFIG (ต้นไฟล์ app.js) ตรงกับชีตจริง</div>`;
}

function setSyncState(state, text) {
  const dot = document.getElementById("syncDot");
  dot.className = "sync-dot" + (state === "err" ? " err" : state === "loading" ? " loading" : "");
  document.getElementById("syncText").textContent = text;
  document.getElementById("lastSyncFoot").textContent = state === "ok" ? text : "";
}

/* ========================================================================
   Master render — recomputes everything for the current filter
   ======================================================================== */
function renderAll() {
  const cur = computeCore(currentRange);
  const prev = computeCore(previousRange());
  renderKPIs(cur, prev);
  renderDaily(currentRange);
  renderTopItems(cur);
  renderCategory(cur);
  renderHourAll(currentRange);
  renderMeal(currentRange);
  renderHourRestaurant();
  renderWeekday(currentRange);
  renderPaymentAndOrderType(cur);
  renderItemsTable(cur);
}

/* ========================================================================
   UI wiring
   ======================================================================== */
function applyPreset(preset) {
  document.querySelectorAll(".chip[data-preset]").forEach((b) => b.classList.toggle("active", b.dataset.preset === preset));
  const max = DATA.maxDate, min = DATA.minDate;
  let start, end;
  if (preset === "all") { start = min; end = max; }
  else if (preset === "7") { start = toISODate(addDays(new Date(max), -6)); end = max; }
  else if (preset === "30") { start = toISODate(addDays(new Date(max), -29)); end = max; }
  else if (preset === "thismonth") {
    const d = new Date(max);
    start = toISODate(new Date(d.getFullYear(), d.getMonth(), 1)); end = max;
  } else if (preset === "lastmonth") {
    const d = new Date(max);
    const firstThisMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    const lastMonthEnd = addDays(firstThisMonth, -1);
    start = toISODate(new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1));
    end = toISODate(lastMonthEnd);
  }
  if (start < min) start = min;
  setRange(start, end);
  renderAll();
}

function wireUI() {
  document.querySelectorAll(".chip[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });
  document.getElementById("applyCustom").addEventListener("click", () => {
    document.querySelectorAll(".chip[data-preset]").forEach((b) => b.classList.remove("active"));
    const s = document.getElementById("startDate").value;
    const e = document.getElementById("endDate").value;
    if (s && e && s <= e) { setRange(s, e); renderAll(); }
  });
  document.querySelectorAll(".mini-btn[data-topmode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      topMode = btn.dataset.topmode;
      document.querySelectorAll(".mini-btn[data-topmode]").forEach((b) => b.classList.toggle("active", b === btn));
      renderTopItems(computeCore(currentRange));
    });
  });
  document.querySelectorAll(".table-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      target.classList.toggle("show");
      btn.textContent = btn.textContent.includes("▾") ? btn.textContent.replace("▾", "▴") : btn.textContent.replace("▴", "▾");
    });
  });
  document.querySelectorAll('#itemsTable th[data-sort]').forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (itemsTableSort.key === key) itemsTableSort.dir *= -1;
      else itemsTableSort = { key, dir: -1 };
      if (lastItemsTableCur) renderItemsTable(lastItemsTableCur);
    });
  });

  document.getElementById("refreshBtn").addEventListener("click", () => boot(true));

  // Re-render charts on dark/light mode switch so canvas colors follow the OS theme
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());
}

/* ========================================================================
   Boot
   ======================================================================== */
async function boot(isManualRefresh) {
  const ok = await loadAllData();
  if (!ok) return;
  if (!isManualRefresh || !currentRange.start) {
    setRange(DATA.minDate, DATA.maxDate);
    document.querySelectorAll(".chip[data-preset]").forEach((b) => b.classList.toggle("active", b.dataset.preset === "all"));
  }
  renderAll();
}

document.addEventListener("DOMContentLoaded", () => {
  wireUI();
  boot(false);
  if (CONFIG.AUTO_REFRESH_MINUTES > 0) {
    setInterval(() => boot(true), CONFIG.AUTO_REFRESH_MINUTES * 60 * 1000);
  }
});
