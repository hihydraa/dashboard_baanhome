/* =========================================================================
   Dashboard ยอดขายร้านอาหาร — บ้านโฮม
   ดึงข้อมูลสดจาก Google Sheet (POS export) ผ่าน Google Visualization API
   โดยโหลดเป็น <script> tag (JSONP) แทนการใช้ fetch() ตรงๆ เพื่อเลี่ยงปัญหา
   CORS ที่ endpoint นี้อาจเจอได้ (ไม่ต้องมี backend / API key — ชีตต้องแชร์
   เป็น "ทุกคนที่มีลิงก์-ดูได้")
   ========================================================================= */

const CONFIG = {
  // ---- Google Sheet ที่เป็นฐานข้อมูลยอดขาย (POS export) ----
  SHEET_ID: "1h-_POlaVm6SIykAp5yz1vZjsJp3WPtRn-PDvkzo4Nzg",

  // ---- Google Sheet ที่เก็บต้นทุน/สูตรอาหาร (ไฟล์ menu_cost_baanhome) ----
  // ถ้าย้ายไปรวมไฟล์เดียวกับ SHEET_ID ให้ใส่ค่าเดียวกันได้
  MENU_SHEET_ID: "1cQdSlEcNjcM46s0VtDP9L5UfHn3vH_OgTn2fI5bcwyo",

  // ---- ชื่อแท็บชีต 3 แท็บ ต้องตรงกับที่ Export จาก POS เป๊ะๆ ----
  // ถ้าการดึงข้อมูลด้วยชื่อชีตใช้ไม่ได้ (เช่น เจอ banner แจ้งเตือนด้านบน)
  // ให้เปิดชีตแต่ละแท็บใน Google Sheets แล้วคัดลอกเลข gid จาก URL
  // (ส่วนที่อยู่หลัง #gid=) มาใส่ในช่อง gid ด้านล่างแทน
  TABS: {
    // แหล่งข้อมูลหลัก — รายละเอียดรายบิล (1 แถว = 1 รายการสินค้าในบิล)
    detail: { name: "detail_perbill", gid: null },
    // ใช้เฉพาะ "จำนวนลูกค้า" ซึ่งไม่มีในชีต detail_perbill — ถ้าไม่มีก็ยังใช้งานได้
    bills: { name: "ยอดขายแยกตามบิล", gid: null },
  },

  MENU_TAB: { name: "menu_cost", gid: null },

  // ---- ตัวคูณเกณฑ์แกนตั้งเริ่มต้น (0.7 = Kasavana-Smith, 1 = ค่าเฉลี่ยตรงๆ) ----
  MM_FACTOR_DEFAULT: 0.7,

  // ---- ตัวชี้วัดเริ่มต้นของแผนภาพ Menu Engineering ----
  ME_Y_DEFAULT: "cmshare",   // "cmshare" = %CM สัดส่วนกำไรรวม | "mm" = %MM สัดส่วนจำนวนจาน
  ME_X_DEFAULT: "cm",        // "cm" = CM ต่อจาน (บาท) | "margin" = %กำไรต่อจาน

  // ---- หมวดสินค้าที่ถือว่าเป็น "ที่พัก" ----
  // ใช้ทั้งกับการแยกยอดขาย และการจัดประเภทบิล
  // ถ้าต้องการนับ "ค่าห้อง VIP" เป็นที่พักด้วย ให้เพิ่ม "ค่าห้อง VIP" ลงในลิสต์นี้
  LODGING_CATEGORIES: ["รีสอร์ท", "ห้องพัก พูลวิลล่า"],

  // ---- ประเภทบิล (จัดตามว่าในบิลนั้นมีอะไรบ้าง) ----
  BILL_TYPES: [
    { key: "food",    label: "บิลอาหาร",               desc: "มีเฉพาะรายการอาหาร",              varName: "--series-1" },
    { key: "lodging", label: "บิลที่พัก",               desc: "มีเฉพาะที่พัก รีสอร์ท/พูลวิลล่า",  varName: "--series-3" },
    { key: "mixed",   label: "บิลอื่นๆ (อาหาร+ที่พัก)", desc: "มีทั้งอาหารและที่พักในบิลเดียว",    varName: "--series-4" },
  ],

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

/* ---- แปลงค่าจากคอลัมน์ "เวลา" ให้เป็นเลขชั่วโมง 0-23 (รองรับหลายรูปแบบ) ----
   รองรับ: Date object (gviz ส่งมาแบบนี้เมื่อเซลล์เป็น date/datetime/time),
   สตริง "Date(2026,6,15,10,23,45)", "10:23", "10:23:45", "10.23 น.",
   "15/07/2026 10:23", timeofday array [h,m,s], และเลขทศนิยมเศษของวัน */
function toHour(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.getHours();
  if (Array.isArray(v)) return typeof v[0] === "number" ? ((v[0] % 24) + 24) % 24 : null;
  if (typeof v === "number") {
    if (v >= 0 && v < 1) return Math.floor(v * 24);            // เศษของวัน
    if (Number.isInteger(v) && v >= 0 && v <= 23) return v;    // เลขชั่วโมงตรงๆ
    return Math.floor(v) % 24;
  }
  const s = String(v).trim();
  // gviz datetime ที่มาเป็นสตริง
  let m = s.match(/^Date\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d{1,2})\s*,/);
  if (m) return parseInt(m[1], 10) % 24;
  // หา "HH:MM" (หรือ "HH.MM") ที่ไหนก็ได้ในสตริง — เผื่อมีวันที่นำหน้า หรือมี " น." ต่อท้าย
  m = s.match(/(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*\d{2})?\s*([AaPp])?/);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[3] ? m[3].toUpperCase() : null;
    if (ap === "P" && h < 12) h += 12;
    if (ap === "A" && h === 12) h = 0;
    return h % 24;
  }
  const f = parseFloat(s.replace(",", "."));
  if (!isNaN(f) && f >= 0 && f < 1) return Math.floor(f * 24);
  if (!isNaN(f) && Number.isInteger(f) && f >= 0 && f <= 23) return f;
  return null;
}

// เก็บชื่อเดิมไว้เผื่อมีโค้ดส่วนอื่นเรียกใช้
function parseHourFromTimeField(raw) { return toHour(raw); }

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
function fetchGvizTable(tabConfig, sheetId) {
  return new Promise((resolve, reject) => {
    const cbName = `__gvizCb_${++__jsonpSeq}_${Date.now()}`;
    const base = `https://docs.google.com/spreadsheets/d/${sheetId || CONFIG.SHEET_ID}/gviz/tq`;
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
  if (v instanceof Date) return toISODate(v);
  if (typeof v === "string") {
    const m = v.match(/^Date\((\d+),(\d+),(\d+)/);
    if (m) return `${m[1]}-${pad2(+m[2] + 1)}-${pad2(+m[3])}`; // gviz month is 0-based
    const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${pad2(+iso[2])}-${pad2(+iso[3])}`;
    const dmy = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); // 15/07/2026 (หรือ พ.ศ. 2569)
    if (dmy) {
      let y = +dmy[3];
      if (y > 2400) y -= 543;
      return `${y}-${pad2(+dmy[2])}-${pad2(+dmy[1])}`;
    }
    return v.slice(0, 10);
  }
  return "";
}
function gHour(row, idx) {
  return toHour(gcell(row, idx));
}

/* ---- หาตำแหน่งคอลัมน์จาก "หัวคอลัมน์" (ถ้าหาไม่เจอค่อยใช้ตำแหน่งเดิม) ---- */
function normLabel(s) { return String(s || "").replace(/\s+/g, "").toLowerCase(); }
function findCol(table, tester, fallback) {
  const cols = (table && table.cols) || [];
  for (let i = 0; i < cols.length; i++) {
    const lb = cols[i] && (cols[i].label || "");
    if (lb && tester(normLabel(lb))) return i;
  }
  return fallback;
}

/* ---- ถ้าอ่านคอลัมน์เวลาตามตำแหน่งไม่ได้ ให้ไล่หาคอลัมน์ที่หน้าตาเป็น "เวลา" จริงๆ ---- */
function detectHourColumn(table) {
  const rows = (table && table.rows) || [];
  const nCols = ((table && table.cols) || []).length;
  let best = -1, bestDistinct = 0;
  for (let c = 0; c < nCols; c++) {
    const seen = new Set();
    let ok = 0, tried = 0;
    for (let i = 0; i < rows.length && tried < 300; i++) {
      const v = gcell(rows[i], c);
      if (v === null || v === undefined || v === "") continue;
      tried++;
      const looksLikeTime =
        v instanceof Date ||
        Array.isArray(v) ||
        (typeof v === "string" && /\d{1,2}\s*[:.]\s*\d{2}/.test(v));
      if (!looksLikeTime) continue;
      const h = toHour(v);
      if (h !== null) { ok++; seen.add(h); }
    }
    if (tried >= 5 && ok / tried > 0.8 && seen.size > bestDistinct) {
      bestDistinct = seen.size;
      best = c;
    }
  }
  return bestDistinct >= 3 ? best : -1;
}

const diagnostics = [];
function pushDiag(msg) { diagnostics.push(msg); }

/* ------------------------------------------------------------------------
   โหลดและทำความสะอาดข้อมูลทั้ง 3 ชีต
   ------------------------------------------------------------------------ */
let DATA = { items: [], bills: [], billsMeta: [], menucost: [], minDate: null, maxDate: null };

async function loadAllData() {
  diagnostics.length = 0;
  if (CHART_SETUP_ERROR) pushDiag(CHART_SETUP_ERROR);
  setSyncState("loading", "กำลังโหลดข้อมูล…");

  const [detailTable, billsTable] = await Promise.all([
    fetchGvizTable(CONFIG.TABS.detail).catch((e) => {
      pushDiag(`โหลดชีตรายละเอียดรายบิล (${CONFIG.TABS.detail.name}) ไม่สำเร็จ: ${e.message}`); return null;
    }),
    fetchGvizTable(CONFIG.TABS.bills).catch(() => null),   // ไม่บังคับ ใช้เฉพาะจำนวนลูกค้า
  ]);

  // แท็บต้นทุน อยู่คนละไฟล์ — โหลดแยก และไม่ทำให้ทั้งหน้าพังถ้าดึงไม่ได้
  const menuTable = await fetchGvizTable(CONFIG.MENU_TAB, CONFIG.MENU_SHEET_ID).catch((e) => {
    pushDiag(`โหลดแท็บต้นทุน (${CONFIG.MENU_TAB.name}) ไม่สำเร็จ: ${e.message} — หน้า Menu Engineering จะยังไม่แสดงผล ` +
      `(ตรวจสอบว่าไฟล์ต้นทุนแชร์เป็น "ทุกคนที่มีลิงก์ - ดูได้")`);
    return null;
  });

  DATA.items = detailTable ? cleanDetail(detailTable) : [];
  DATA.bills = buildBills(DATA.items);
  DATA.billsMeta = billsTable ? cleanBills(billsTable) : [];
  DATA.menucost = menuTable ? cleanMenuCost(menuTable) : [];
  if (menuTable && DATA.menucost.length === 0) {
    pushDiag(`แท็บต้นทุน (${CONFIG.MENU_TAB.name}) โหลดได้แต่ไม่พบเมนูที่มีทั้งราคาขายและต้นทุน — ` +
      `ตรวจสอบว่าคอลัมน์ K "ต้นทุนที่ใช้" มีค่าแล้ว`);
  }

  if (detailTable && (detailTable.cols || []).length < 20) {
    pushDiag(`ชีต ${CONFIG.TABS.detail.name} มีจำนวนคอลัมน์น้อยกว่าที่คาดไว้ (${(detailTable.cols || []).length}) — ตรวจสอบชื่อแท็บใน CONFIG`);
  }
  if (!billsTable) {
    pushDiag(`ไม่พบชีต ${CONFIG.TABS.bills.name} — ตัวเลข "ลูกค้าเฉลี่ยต่อบิล" จะไม่แสดง ส่วนที่เหลือใช้งานได้ปกติ`);
  }

  const allDates = DATA.items.map((r) => r.date).filter(Boolean).sort();
  DATA.minDate = allDates.length ? allDates[0] : toISODate(new Date());
  DATA.maxDate = allDates.length ? allDates[allDates.length - 1] : toISODate(new Date());

  renderDiagnostics();
  if (!DATA.items.length) {
    setSyncState("err", "โหลดข้อมูลไม่สำเร็จ — ดูรายละเอียดด้านบน");
    return false;
  }
  setSyncState("ok", `อัปเดตล่าสุด ${new Date().toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}`);
  return true;
}

/* ชีต detail_perbill — 1 แถว = 1 รายการสินค้าในบิล
   หาตำแหน่งคอลัมน์จากหัวคอลัมน์ก่อน ถ้าไม่เจอจึงใช้ตำแหน่งตามไฟล์ export เดิม */
function cleanDetail(table) {
  const rows = (table && table.rows) || [];
  const i = {
    date:  findCol(table, (l) => l.includes("วันที่"), 0),
    time:  findCol(table, (l) => l.includes("เวลา"), 1),
    bill:  findCol(table, (l) => l.includes("หมายเลขใบเสร็จ") || l.includes("ใบเสร็จ"), 2),
    name:  findCol(table, (l) => l.includes("ชื่อเมนู") || l.includes("ชื่อสินค้า"), 6),
    order: findCol(table, (l) => l.includes("ประเภทการสั่ง"), 7),
    qty:   findCol(table, (l) => l === "จำนวน", 8),
    gross: findCol(table, (l) => l.includes("ยอดก่อนลด"), 10),
    disc:  findCol(table, (l) => l === "ส่วนลดสินค้า", 11),
    net:   findCol(table, (l) => l.includes("ราคาสุทธิ"), 13),
    pay:   findCol(table, (l) => l.includes("ประเภทการชำระ"), 19),
    cat:   findCol(table, (l) => l.includes("หมวดสินค้า"), 25),
  };

  let voided = 0;
  const out = [];
  rows.forEach((r) => {
    const pay = gStr(r, i.pay);
    const date = gDateISO(r, i.date);
    const name = gStr(r, i.name);
    if (!date || !name) return;
    if (pay === "Void All") { voided++; return; }
    const category = gStr(r, i.cat) || "ไม่ระบุหมวด";
    out.push({
      date,
      hour: gHour(r, i.time),
      bill: gStr(r, i.bill) || `${date}#${out.length}`,
      name,
      category,
      isLodging: CONFIG.LODGING_CATEGORIES.includes(category),
      qty: gNum(r, i.qty),
      grossBeforeDiscount: gNum(r, i.gross),
      discount: gNum(r, i.disc),
      net: gNum(r, i.net),
      paymentType: pay || "ไม่ระบุ",
      orderType: gStr(r, i.order) || "ไม่ระบุ",
    });
  });

  if (out.length && out.filter((r) => r.hour !== null).length / out.length < 0.5) {
    pushDiag(`อ่านค่าเวลาในชีต ${CONFIG.TABS.detail.name} ไม่สำเร็จ — กราฟที่แยกตามชั่วโมงและตามมื้อจะว่าง`);
  }
  if (voided > 0) {
    pushDiag(`ตัดรายการที่ถูกยกเลิก (Void All) ออก ${fmtInt(voided)} รายการ`);
  }
  return out;
}

/* รวมรายการสินค้าเป็นบิล แล้วจัดประเภทบิลตามสิ่งที่อยู่ในบิลนั้น
   มีทั้งอาหารและที่พัก = mixed | มีเฉพาะอาหาร = food | มีเฉพาะที่พัก = lodging */
function buildBills(lines) {
  const map = new Map();
  lines.forEach((r) => {
    let b = map.get(r.bill);
    if (!b) {
      b = {
        bill: r.bill, date: r.date, hour: r.hour,
        net: 0, qty: 0, foodNet: 0, lodgingNet: 0, discount: 0,
        hasFood: false, hasLodging: false, itemCount: 0,
        paymentType: r.paymentType, orderType: r.orderType,
      };
      map.set(r.bill, b);
    }
    b.net += r.net;
    b.qty += r.qty;
    b.discount += r.discount;
    b.itemCount++;
    if (r.isLodging) { b.hasLodging = true; b.lodgingNet += r.net; }
    else { b.hasFood = true; b.foodNet += r.net; }
    if (b.hour === null && r.hour !== null) b.hour = r.hour;
  });
  const out = [...map.values()];
  out.forEach((b) => {
    b.type = b.hasFood && b.hasLodging ? "mixed" : b.hasLodging ? "lodging" : "food";
  });
  return out;
}

// แท็บ menu_cost (จากไฟล์ menu_cost_baanhome) — อ้างอิงด้วยตำแหน่งคอลัมน์:
// 0 ชื่อสินค้า, 2 กลุ่มเปรียบเทียบ, 3 ราคาขายตั้ง, 10 ต้นทุนที่ใช้, 11 ที่มาต้นทุน
function cleanMenuCost(table) {
  const rows = (table && table.rows) || [];
  const list = rows
    .map((r) => ({
      name: gStr(r, 0),
      group: gStr(r, 2) || "ไม่ระบุ",
      price: gNum(r, 3),
      cost: gNum(r, 10),
      source: gStr(r, 11),
    }))
    .filter((r) => r.name && r.price > 0 && r.cost > 0);

  // ชื่อเมนูเดียวกันอาจมีหลายแถว (เมนูเดียวถูกตั้งไว้หลายหมวดใน POS)
  // ต้องเหลือแถวเดียวต่อชื่อ ไม่งั้นจะนับยอดขายซ้ำในแผนภาพ
  const byName = new Map();
  let dup = 0;
  list.forEach((r) => {
    if (byName.has(r.name)) { dup++; return; }
    byName.set(r.name, r);
  });
  if (dup > 0) {
    pushDiag(`แท็บต้นทุน (${CONFIG.MENU_TAB.name}) มีชื่อเมนูซ้ำ ${fmtInt(dup)} แถว — ` +
      `ระบบใช้แถวแรกของแต่ละชื่อ แนะนำให้ลบแถวซ้ำในชีตเพื่อไม่ให้สับสน`);
  }
  return [...byName.values()];
}

// ชีตบิล (ยอดขายแยกตามบิล) — คอลัมน์ตามตำแหน่ง (0-based):
// 0 วันที่ชำระเงิน, 1 เวลาที่ชำระเงิน, 19 รวมสุทธิ, 22 ประเภทการสั่ง, 24 ประเภทการชำระเงิน, 29 จำนวนลูกค้า
/* ชีต "ยอดขายแยกตามบิล" — ใช้เฉพาะ "จำนวนลูกค้า" ซึ่งไม่มีในชีต detail_perbill */
function cleanBills(table) {
  const rows = (table && table.rows) || [];
  const iDate = findCol(table, (l) => l.includes("วันที่"), 0);
  const iCust = findCol(table, (l) => l.includes("จำนวนลูกค้า"), 29);
  const iPay  = findCol(table, (l) => l.includes("ประเภทการชำระ"), 24);
  return rows
    .map((r) => ({ date: gDateISO(r, iDate), customers: gNum(r, iCust), pay: gStr(r, iPay) }))
    .filter((r) => r.date && r.pay !== "Void All" && r.customers > 0);
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
// "ร้านอาหาร" = ทุกหมวดที่ไม่ใช่ที่พัก
function isRestaurant(category) { return !CONFIG.LODGING_CATEGORIES.includes(category); }

function computeCore(range) {
  const items = DATA.items.filter((r) => r.date >= range.start && r.date <= range.end);
  const bills = DATA.bills.filter((r) => r.date >= range.start && r.date <= range.end);
  const billsMeta = DATA.billsMeta.filter((r) => r.date >= range.start && r.date <= range.end);

  const restaurantItems = items.filter((r) => !r.isLodging);
  const resortItems = items.filter((r) => r.isLodging);

  const restaurantRevenue = restaurantItems.reduce((s, r) => s + r.net, 0);
  const restaurantDiscount = restaurantItems.reduce((s, r) => s + r.discount, 0);
  const resortRevenue = resortItems.reduce((s, r) => s + r.net, 0);
  const daysInRange = Math.round((new Date(range.end) - new Date(range.start)) / 86400000) + 1;
  const avgDailyRevenue = daysInRange ? restaurantRevenue / daysInRange : 0;

  const billCount = bills.length;
  const billNetTotal = bills.reduce((s, r) => s + r.net, 0);
  const avgPerBill = billCount ? billNetTotal / billCount : 0;
  const avgCustomers = billsMeta.length
    ? billsMeta.reduce((s, r) => s + r.customers, 0) / billsMeta.length
    : null;

  // ---- สรุปตามประเภทบิล ----
  const byBillType = {};
  CONFIG.BILL_TYPES.forEach((t) => {
    byBillType[t.key] = { key: t.key, label: t.label, desc: t.desc, varName: t.varName,
                          count: 0, net: 0, foodNet: 0, lodgingNet: 0, items: 0 };
  });
  bills.forEach((b) => {
    const t = byBillType[b.type];
    if (!t) return;
    t.count++;
    t.net += b.net;
    t.foodNet += b.foodNet;
    t.lodgingNet += b.lodgingNet;
    t.items += b.itemCount;
  });
  Object.values(byBillType).forEach((t) => {
    t.avgPerBill = t.count ? t.net / t.count : 0;
    t.pctBills = billCount ? (t.count / billCount) * 100 : 0;
    t.pctNet = billNetTotal ? (t.net / billNetTotal) * 100 : 0;
  });

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
    items, restaurantItems, resortItems, bills, billsMeta,
    restaurantRevenue, restaurantDiscount, resortRevenue, avgDailyRevenue, daysInRange,
    billCount, billNetTotal, avgPerBill, avgCustomers, byBillType,
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
function safeNewChart(canvasEl, config, extraPlugins) {
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
  if (extraPlugins && extraPlugins.length) {
    config = Object.assign({}, config, { plugins: (config.plugins || []).concat(extraPlugins) });
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
      <div class="foot">รวมทุกรายการที่ไม่ใช่ที่พัก แยกรายบิลจากชีต detail_perbill</div>
    </div>
    <div class="kpi">
      <div class="label">ยอดขายเฉลี่ยต่อวัน</div>
      <div class="value">${fmtBaht(cur.avgDailyRevenue)} <small>บาท</small></div>
      ${deltaHtml(pctDelta(cur.avgDailyRevenue, prev.avgDailyRevenue))}
      <div class="foot">เฉพาะร้านอาหาร เฉลี่ยจาก ${cur.daysInRange} วันที่เลือก</div>
    </div>
    <div class="kpi">
      <div class="label">จำนวนบิลทั้งหมด</div>
      <div class="value">${fmtInt(cur.billCount)} <small>บิล</small></div>
      ${deltaHtml(pctDelta(cur.billCount, prev.billCount))}
      <div class="foot">ทุกประเภทบิล ไม่นับบิลที่ถูกยกเลิก · ดูแยกประเภทได้ด้านล่าง</div>
    </div>
    <div class="kpi">
      <div class="label">ยอดขายเฉลี่ยต่อบิล</div>
      <div class="value">${fmtBaht(cur.avgPerBill)} <small>บาท</small></div>
      ${deltaHtml(pctDelta(cur.avgPerBill, prev.avgPerBill))}
      <div class="foot">เฉลี่ยจากทุกประเภทบิล · ดูแยกประเภทได้ด้านล่าง</div>
    </div>
    <div class="kpi">
      <div class="label">เมนูขายดีที่สุด</div>
      <div class="value" style="font-size:18px; line-height:1.3;">${escapeHtml(cur.topItemName)}</div>
      <div class="foot">ขายได้ ${fmtInt(cur.topItemQty)} รายการ ในช่วงที่เลือก</div>
    </div>
    <div class="kpi">
      <div class="label">ลูกค้าเฉลี่ยต่อบิล</div>
      <div class="value">${cur.avgCustomers === null ? "—" : cur.avgCustomers.toFixed(1)} <small>คน</small></div>
      <div class="foot">${cur.avgCustomers === null ? "ไม่มีข้อมูลจำนวนลูกค้าในช่วงนี้" : `จากรายงาน ${escapeHtml(CONFIG.TABS.bills.name)} (${fmtInt(cur.billsMeta.length)} บิลที่บันทึกจำนวนลูกค้าไว้)`}</div>
    </div>
    <div class="kpi muted">
      <div class="label">ยอดขายรีสอร์ท</div>
      <div class="value">${fmtBaht(cur.resortRevenue)} <small>บาท</small></div>
      <div class="foot">เฉพาะรายการหมวดที่พัก แม้จะอยู่ในบิลเดียวกับอาหารก็แยกออกได้แล้ว</div>
    </div>
  `;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ========================================================================
   Render: สรุปตามประเภทบิล
   ======================================================================== */
function renderBillTypes(cur) {
  const grid = document.getElementById("billTypeKpi");
  if (grid) {
    grid.innerHTML = CONFIG.BILL_TYPES.map((t) => {
      const d = cur.byBillType[t.key];
      return `<div class="kpi me-kpi" style="border-left:4px solid ${cssVar(t.varName)}">
        <div class="label">${escapeHtml(t.label)}</div>
        <div class="value">${fmtInt(d.count)} <small>บิล</small></div>
        <div class="foot">${fmtBaht(d.avgPerBill)} บาท/บิล · ยอดรวม ${fmtBaht(d.net)} บาท (${d.pctNet.toFixed(1)}% ของยอดทั้งหมด)</div>
      </div>`;
    }).join("");
  }

  const tbody = document.querySelector("#billTypeTable tbody");
  if (tbody) {
    const rows = CONFIG.BILL_TYPES.map((t) => cur.byBillType[t.key]);
    tbody.innerHTML = rows.map((d) => `<tr>
      <td style="text-align:left;"><span class="me-badge" style="background:${cssVar(d.varName)}">${escapeHtml(d.label)}</span></td>
      <td style="text-align:left;font-size:12px;color:var(--text-secondary);">${escapeHtml(d.desc)}</td>
      <td>${fmtInt(d.count)}</td>
      <td>${d.pctBills.toFixed(1)}%</td>
      <td>${fmtBaht(d.net)}</td>
      <td>${d.pctNet.toFixed(1)}%</td>
      <td><strong>${fmtBaht(d.avgPerBill)}</strong></td>
      <td>${fmtBaht(d.foodNet)}</td>
      <td>${fmtBaht(d.lodgingNet)}</td>
    </tr>`).join("") + `<tr class="total-row">
      <td style="text-align:left;"><strong>รวมทั้งหมด</strong></td>
      <td></td>
      <td><strong>${fmtInt(cur.billCount)}</strong></td>
      <td>100.0%</td>
      <td><strong>${fmtBaht(cur.billNetTotal)}</strong></td>
      <td>100.0%</td>
      <td><strong>${fmtBaht(cur.avgPerBill)}</strong></td>
      <td><strong>${fmtBaht(cur.restaurantRevenue)}</strong></td>
      <td><strong>${fmtBaht(cur.resortRevenue)}</strong></td>
    </tr>`;
  }

  // โดนัท: สัดส่วนยอดขายตามประเภทบิล
  const labels = CONFIG.BILL_TYPES.map((t) => t.label);
  const values = CONFIG.BILL_TYPES.map((t) => cur.byBillType[t.key].net);
  const colors = CONFIG.BILL_TYPES.map((t) => cssVar(t.varName));
  destroyChart("billType");
  charts.billType = safeNewChart(document.getElementById("chartBillType"), {
    type: "doughnut",
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: cssVar("--surface-1"), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "58%",
      plugins: {
        legend: { position: "bottom", labels: { color: baseTextColor(), boxWidth: 10, usePointStyle: true, pointStyle: "circle", font: { size: 11 } } },
        datalabels: { display: false },
        tooltip: Object.assign(tooltipBase(), {
          callbacks: {
            label: (item) => {
              const tot = values.reduce((a, b) => a + b, 0);
              const pct = tot ? (item.raw / tot) * 100 : 0;
              return `${fmtBaht(item.raw)} บาท (${pct.toFixed(1)}%)`;
            },
          },
        }),
      },
    },
  });
}

/* ========================================================================
   Render: จำนวนบิลตามชั่วโมง แยกประเภทบิล
   ======================================================================== */
function renderBillTypeByHour(cur) {
  const buckets = {};
  CONFIG.BILL_TYPES.forEach((t) => { buckets[t.key] = new Array(24).fill(0); });
  cur.bills.forEach((b) => {
    if (b.hour === null || !buckets[b.type]) return;
    buckets[b.type][b.hour]++;
  });
  const labels = new Array(24).fill(0).map((_, h) => pad2(h));

  destroyChart("hourRest");
  charts.hourRest = safeNewChart(document.getElementById("chartBillTypeHour"), {
    type: "bar",
    data: {
      labels,
      datasets: CONFIG.BILL_TYPES.map((t) => ({
        label: t.label,
        data: buckets[t.key],
        backgroundColor: cssVar(t.varName),
        stack: "b",
        barThickness: 14,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: baseTextColor(), boxWidth: 10, usePointStyle: true, pointStyle: "circle", font: { size: 11 } } },
        datalabels: { display: false },
        tooltip: Object.assign(tooltipBase(), {
          callbacks: { title: (items) => `${items[0].label}:00 น.`, label: (item) => `${item.dataset.label}: ${fmtInt(item.raw)} บิล` },
        }),
      },
      scales: commonScales({
        x: { stacked: true, grid: { display: false }, ticks: { color: baseMutedColor() }, border: { display: false } },
        y: { stacked: true, beginAtZero: true, grid: { color: baseGridColor() }, ticks: { color: baseMutedColor(), callback: (v) => fmtInt(v) }, border: { display: false } },
      }),
    },
  });
  renderTableView("tblHourRest",
    ["ชั่วโมง", ...CONFIG.BILL_TYPES.map((t) => `${t.label} (บิล)`), "รวม (บิล)"],
    labels.map((l, h) => {
      const vals = CONFIG.BILL_TYPES.map((t) => buckets[t.key][h]);
      return [`${l}:00`, ...vals.map(fmtInt), fmtInt(vals.reduce((a, b) => a + b, 0))];
    }));
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
          label: "รีสอร์ท (ไว้เทียบ)",
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
  const food = new Array(24).fill(0);
  const lodging = new Array(24).fill(0);
  DATA.items.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (r.hour === null) return;
    if (r.isLodging) lodging[r.hour] += r.net;
    else food[r.hour] += r.net;
  });
  const labels = food.map((_, h) => `${pad2(h)}`);

  destroyChart("hourAll");
  charts.hourAll = safeNewChart(document.getElementById("chartHourAll"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "ร้านอาหาร", data: food, backgroundColor: cssVar("--series-1"), stack: "h", barThickness: 14 },
        { label: "ที่พัก", data: lodging, backgroundColor: cssVar("--series-3"), stack: "h", barThickness: 14 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: baseTextColor(), boxWidth: 10, usePointStyle: true, pointStyle: "circle", font: { size: 11 } } },
        datalabels: { display: false },
        tooltip: Object.assign(tooltipBase(), {
          callbacks: { title: (items) => `${items[0].label}:00 น.`, label: (item) => `${item.dataset.label}: ${fmtBaht(item.raw)} บาท` },
        }),
      },
      scales: commonScales({
        x: { stacked: true, grid: { display: false }, ticks: { color: baseMutedColor() }, border: { display: false } },
        y: { stacked: true, beginAtZero: true, grid: { color: baseGridColor() }, ticks: { color: baseMutedColor(), callback: (v) => fmtCompact(v) }, border: { display: false } },
      }),
    },
  });
  renderTableView("tblHourAll", ["ชั่วโมง", "ร้านอาหาร (บาท)", "ที่พัก (บาท)", "รวม (บาท)"],
    labels.map((l, h) => [`${l}:00`, fmtBaht(food[h]), fmtBaht(lodging[h]), fmtBaht(food[h] + lodging[h])]));
}

/* ========================================================================
   Render: Meal periods (all POS, respects filter)
   ======================================================================== */
function renderMeal(range) {
  const hours = new Array(24).fill(0);
  DATA.items.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (r.hour === null || r.isLodging) return;
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
      // เว้นที่ด้านบนไว้ให้ตัวเลขกำกับของแท่งที่สูงที่สุด (ไม่งั้นจะถูกตัดหายไปนอกกรอบ)
      layout: { padding: { top: 22 } },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(tooltipBase(), { callbacks: { label: (item) => `${fmtBaht(item.raw)} บาท` } }),
        datalabels: {
          display: true,
          anchor: "end", align: "top",
          clamp: true, clip: false,
          color: baseTextColor(), font: { size: 11 },
          formatter: (v) => fmtCompact(v),
        },
      },
      scales: commonScales({
        y: {
          beginAtZero: true,
          grace: "5%", // ดันเพดานแกน Y ขึ้นอีกนิด เผื่อที่ให้ label
          grid: { color: baseGridColor(), drawTicks: false },
          border: { display: false },
          ticks: { color: baseMutedColor(), callback: (v) => fmtCompact(v), maxTicksLimit: 6 },
        },
      }),
    },
  });
  renderTableView("tblMeal", ["มื้อ", "ยอดขาย (บาท)"], labels.map((l, i) => [l, fmtBaht(values[i])]));
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
   Menu Engineering
   แกนตั้ง  = %CM (สัดส่วนกำไรรวม) หรือ %MM (สัดส่วนจำนวนจาน) — เลือกได้
   แกนนอน  = CM ต่อจาน (บาท) หรือ %กำไรต่อจาน — เลือกได้
   จัดกลุ่มตามหลัก Kasavana-Smith: Star / Horse / Puzzle / Dog
   ======================================================================== */
const ME_CLASSES = {
  Star:   { th: "ดาวเด่น",  varName: "--series-4", advice: "Retain — คุมมาตรฐานรสชาติและปริมาณให้คงที่" },
  Horse:  { th: "ม้าแก่",   varName: "--series-1", advice: "Re-price — ทบทวนราคาขาย หรือลดต้นทุนวัตถุดิบ" },
  Puzzle: { th: "ปริศนา",   varName: "--series-3", advice: "Reposition — ดันยอดขาย ย้ายตำแหน่งในเล่มเมนู ให้พนักงานเชียร์" },
  Dog:    { th: "สุนัข",    varName: "--series-6", advice: "Replace — พิจารณาตัดออกจากเมนู" },
};
const ME_ORDER = ["Star", "Puzzle", "Horse", "Dog"];

// แกนตั้ง — ทั้งสองแบบเป็น "สัดส่วน" ที่รวมกันได้ 100% จึงใช้เกณฑ์เดียวกันได้
const ME_Y = {
  cmshare: {
    short: "%CM",
    axis: "%CM — เมนูนี้สร้างกำไรกี่ % ของกำไรรวมทั้งกลุ่ม",
    get: (r) => r.cmShare,
  },
  mm: {
    short: "%MM",
    axis: "%MM — เมนูนี้ขายได้กี่ % ของจำนวนจานรวมทั้งกลุ่ม",
    get: (r) => r.mm,
  },
};
// แกนนอน
const ME_X = {
  cm: {
    short: "CM ต่อจาน",
    axis: "CM ต่อจาน (บาท) — กำไรเบื้องต้นก่อนหักค่าใช้จ่าย",
    get: (r) => r.cm,
    isPct: false,
    fmt: (v) => `${fmtBaht(v)} บาท`,
  },
  margin: {
    short: "%กำไรต่อจาน",
    axis: "%กำไรต่อจาน — CM ÷ ราคาขาย",
    get: (r) => r.margin,
    isPct: true,
    fmt: (v) => `${(v * 100).toFixed(1)}%`,
  },
};

let meGroup = null;                        // กลุ่มเปรียบเทียบที่กำลังดูอยู่
let meFactor = CONFIG.MM_FACTOR_DEFAULT;   // ตัวคูณเกณฑ์แกนตั้ง
let meYMetric = CONFIG.ME_Y_DEFAULT;       // ตัวชี้วัดแกนตั้ง
let meXMetric = CONFIG.ME_X_DEFAULT;       // ตัวชี้วัดแกนนอน
let meCategory = "ALL";                    // กรองตามหมวดสินค้าใน POS
let meScope = "group";                     // "group" = ใช้เกณฑ์ของทั้งกลุ่ม | "category" = คำนวณเกณฑ์ใหม่เฉพาะหมวด
let meFilter = "ALL";                      // ตัวกรองตารางด้านล่าง (Star/Horse/Puzzle/Dog)
let meRows = [];
let meStats = null;
let meCategoryList = [];

function meAvailableGroups() {
  const seen = new Set();
  DATA.menucost.forEach((m) => seen.add(m.group));
  const list = [...seen];
  list.sort((a, b) => (a === "อาหาร" ? -1 : b === "อาหาร" ? 1 : a.localeCompare(b, "th")));
  return list;
}

function computeMenuEngineering(range, group, factor, yMetric, xMetric, category, scope) {
  // ยอดขายจริงในช่วงที่เลือก (เฉพาะฝั่งร้านอาหาร) + หาหมวดสินค้าหลักของแต่ละเมนู
  const sales = {};
  DATA.items.forEach((r) => {
    if (r.date < range.start || r.date > range.end) return;
    if (!isRestaurant(r.category)) return;
    const s = sales[r.name] || (sales[r.name] = { qty: 0, net: 0, cats: {} });
    s.qty += r.qty;
    s.net += r.net;
    if (r.category) s.cats[r.category] = (s.cats[r.category] || 0) + r.qty;
  });
  // เมนูหนึ่งอาจถูกตั้งไว้หลายหมวดใน POS — เลือกหมวดที่ขายได้มากที่สุด
  Object.keys(sales).forEach((n) => {
    const cats = sales[n].cats;
    let best = "", bestQty = -1;
    Object.keys(cats).forEach((c) => { if (cats[c] > bestQty) { bestQty = cats[c]; best = c; } });
    sales[n].category = best || "ไม่ระบุหมวด";
  });

  const all = [];
  DATA.menucost.forEach((m) => {
    if (m.group !== group) return;
    const s = sales[m.name];
    if (!s || s.qty <= 0) return;
    const cm = m.price - m.cost;
    all.push({
      name: m.name, group: m.group, source: m.source, category: s.category,
      price: m.price, cost: m.cost, cm,
      margin: m.price > 0 ? cm / m.price : 0,
      qty: s.qty, net: s.net,
      revenue: m.price * s.qty,
      cmTotal: cm * s.qty,
    });
  });

  // รายชื่อหมวดที่เลือกได้ (จากเมนูที่วิเคราะห์ได้จริงในกลุ่มนี้)
  const catSet = new Set(all.map((r) => r.category));
  const categories = [...catSet].sort((a, b) => a.localeCompare(b, "th"));

  const inCat = (r) => category === "ALL" || r.category === category;
  // ฐานที่ใช้คำนวณเกณฑ์: ทั้งกลุ่ม หรือเฉพาะหมวดที่เลือก
  const base = (category !== "ALL" && scope === "category") ? all.filter(inCat) : all;

  const totQty = base.reduce((a, r) => a + r.qty, 0);
  const totCM  = base.reduce((a, r) => a + r.cmTotal, 0);
  const totRev = base.reduce((a, r) => a + r.revenue, 0);

  const yThr = base.length > 0 ? factor / base.length : 0;
  const xThr = xMetric === "margin"
    ? (totRev > 0 ? totCM / totRev : 0)
    : (totQty > 0 ? totCM / totQty : 0);

  const yGet = ME_Y[yMetric].get, xGet = ME_X[xMetric].get;
  all.forEach((r) => {
    r.mm = totQty > 0 ? r.qty / totQty : 0;
    r.cmShare = totCM > 0 ? r.cmTotal / totCM : 0;
    r.yVal = yGet(r);
    r.xVal = xGet(r);
    const hiY = r.yVal >= yThr;
    const hiX = r.xVal >= xThr;
    r.cls = hiY && hiX ? "Star" : hiY && !hiX ? "Horse" : !hiY && hiX ? "Puzzle" : "Dog";
  });

  const rows = all.filter(inCat).sort((a, b) => b.cmTotal - a.cmTotal);

  // ความครอบคลุม — เทียบกับเมนูที่ขายจริงในขอบเขตเดียวกัน
  let allMenus = 0, allNet = 0;
  Object.keys(sales).forEach((n) => {
    if (category !== "ALL" && sales[n].category !== category) return;
    allMenus++; allNet += sales[n].net;
  });
  const covered = rows.reduce((a, r) => a + r.net, 0);

  return {
    rows, categories, yThr, xThr, totQty, totCM, totRev,
    baseCount: base.length,
    baseIsCategory: category !== "ALL" && scope === "category",
    coverage: { menus: rows.length, allMenus, net: covered, allNet },
  };
}

// เส้นแบ่ง 4 ควอดรันต์ + ป้ายกำกับมุม
const quadrantPlugin = {
  id: "meQuadrants",
  beforeDatasetsDraw(chart, args, opts) {
    const { ctx, chartArea: a, scales } = chart;
    if (!a || !opts || opts.xLine == null) return;
    const x = scales.x.getPixelForValue(opts.xLine);
    const y = scales.y.getPixelForValue(opts.yLine);
    ctx.save();
    ctx.strokeStyle = opts.lineColor || "#999";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    if (x >= a.left && x <= a.right) { ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke(); }
    if (y >= a.top && y <= a.bottom) { ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.font = "600 11px system-ui, -apple-system, 'Noto Sans Thai', sans-serif";
    ctx.fillStyle = opts.labelColor || "#999";
    const pad = 6;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";   ctx.fillText("ม้าแก่ (Horse)",  a.left + pad,  a.top + pad);
    ctx.textAlign = "right";  ctx.fillText("ดาวเด่น (Star)",  a.right - pad, a.top + pad);
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";   ctx.fillText("สุนัข (Dog)",     a.left + pad,  a.bottom - pad);
    ctx.textAlign = "right";  ctx.fillText("ปริศนา (Puzzle)", a.right - pad, a.bottom - pad);
    ctx.restore();
  },
};

function renderMenuEngineering(range) {
  const wrapEmpty = document.getElementById("meEmpty");
  const body = document.getElementById("meBody");
  if (!DATA.menucost.length) {
    if (wrapEmpty) wrapEmpty.style.display = "block";
    if (body) body.style.display = "none";
    return;
  }
  if (wrapEmpty) wrapEmpty.style.display = "none";
  if (body) body.style.display = "";

  const sel = document.getElementById("meGroupSel");
  const groups = meAvailableGroups();
  if (sel && sel.options.length !== groups.length) {
    sel.innerHTML = groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  }
  if (!meGroup || !groups.includes(meGroup)) meGroup = groups[0] || null;
  if (sel) sel.value = meGroup;
  const fsel = document.getElementById("meFactorSel"); if (fsel) fsel.value = String(meFactor);
  const ysel = document.getElementById("meYSel");      if (ysel) ysel.value = meYMetric;
  const xsel = document.getElementById("meXSel");      if (xsel) xsel.value = meXMetric;

  const yCfg = ME_Y[meYMetric], xCfg = ME_X[meXMetric];
  let res = computeMenuEngineering(range, meGroup, meFactor, meYMetric, meXMetric, meCategory, meScope);

  // เติมรายชื่อหมวดลง dropdown แล้วคำนวณซ้ำถ้าหมวดที่เลือกไว้ไม่มีอยู่แล้ว
  const csel = document.getElementById("meCatSel");
  const sameList = meCategoryList.length === res.categories.length &&
                   meCategoryList.every((c, i) => c === res.categories[i]);
  if (csel && !sameList) {
    meCategoryList = res.categories;
    csel.innerHTML = `<option value="ALL">ทุกหมวด</option>` +
      res.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  }
  if (meCategory !== "ALL" && !res.categories.includes(meCategory)) {
    meCategory = "ALL";
    res = computeMenuEngineering(range, meGroup, meFactor, meYMetric, meXMetric, meCategory, meScope);
  }
  if (csel) csel.value = meCategory;
  const ssel = document.getElementById("meScopeSel");
  if (ssel) { ssel.value = meScope; ssel.disabled = meCategory === "ALL"; }

  meRows = res.rows;
  meStats = res;

  // ---- การ์ดสรุป 4 กลุ่ม ----
  const grid = document.getElementById("meKpi");
  if (grid) {
    grid.innerHTML = ME_ORDER.map((k) => {
      const list = res.rows.filter((r) => r.cls === k);
      const cm = list.reduce((a, r) => a + r.cmTotal, 0);
      const share = res.totCM > 0 ? (cm / res.totCM) * 100 : 0;
      const c = ME_CLASSES[k];
      const scopeTxt = res.baseIsCategory ? "ของกำไรหมวดนี้" : "ของกำไรกลุ่มนี้";
      return `<div class="kpi me-kpi" style="border-left:4px solid ${cssVar(c.varName)}">
        <div class="label">${k} · ${c.th}</div>
        <div class="value">${fmtInt(list.length)} <small>เมนู</small></div>
        <div class="foot">CM รวม ${fmtBaht(cm)} บาท · ${share.toFixed(1)}% ${scopeTxt}</div>
      </div>`;
    }).join("");
  }

  // ---- ข้อความครอบคลุม + เกณฑ์ ----
  const note = document.getElementById("meCoverage");
  if (note) {
    const cov = res.coverage;
    const pct = cov.allNet > 0 ? (cov.net / cov.allNet) * 100 : 0;
    const scopeTxt = meCategory === "ALL"
      ? `คำนวณเกณฑ์จากทั้งกลุ่ม “${meGroup}” (${fmtInt(res.baseCount)} เมนู)`
      : res.baseIsCategory
        ? `คำนวณเกณฑ์ใหม่เฉพาะหมวด “${meCategory}” (${fmtInt(res.baseCount)} เมนู)`
        : `แสดงเฉพาะหมวด “${meCategory}” แต่ยังใช้เกณฑ์ของทั้งกลุ่ม “${meGroup}” (${fmtInt(res.baseCount)} เมนู)`;
    note.textContent =
      `วิเคราะห์ได้ ${fmtInt(cov.menus)} เมนูที่มีต้นทุนแล้ว จากเมนูที่ขายจริงในขอบเขตนี้ทั้งหมด ${fmtInt(cov.allMenus)} เมนู ` +
      `(คิดเป็น ${pct.toFixed(1)}% ของยอดขาย) · ${scopeTxt} · ` +
      `เกณฑ์ ${yCfg.short} = ${(res.yThr * 100).toFixed(2)}% · ` +
      `เกณฑ์ ${xCfg.short} = ${xCfg.fmt(res.xThr)} (ค่าเฉลี่ยถ่วงน้ำหนัก)`;
  }

  // ---- Scatter ----
  const toX = (v) => (xCfg.isPct ? v * 100 : v);
  const datasets = ME_ORDER.map((k) => {
    const c = ME_CLASSES[k];
    return {
      label: `${k} · ${c.th}`,
      data: res.rows.filter((r) => r.cls === k).map((r) => ({ x: toX(r.xVal), y: r.yVal * 100, r0: r })),
      backgroundColor: cssVar(c.varName),
      borderColor: cssVar(c.varName),
      pointRadius: 5, pointHoverRadius: 8,
    };
  });

  destroyChart("me");
  charts.me = safeNewChart(document.getElementById("chartME"), {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 10, right: 10 } },
      plugins: {
        legend: { position: "bottom", labels: { color: baseTextColor(), boxWidth: 10, usePointStyle: true, pointStyle: "circle", font: { size: 11 } } },
        datalabels: { display: false },
        meQuadrants: { xLine: toX(res.xThr), yLine: res.yThr * 100, lineColor: baseGridColor(), labelColor: baseMutedColor() },
        tooltip: Object.assign(tooltipBase(), {
          callbacks: {
            title: (items) => items[0].raw.r0.name,
            label: (item) => {
              const r = item.raw.r0;
              return [
                `ขายได้ ${fmtInt(r.qty)} จาน · %MM ${(r.mm * 100).toFixed(2)}%`,
                `CM รวม ${fmtBaht(r.cmTotal)} บาท · %CM ${(r.cmShare * 100).toFixed(2)}%`,
                `ราคาขาย ${fmtBaht(r.price)} · ต้นทุน ${fmtBaht(r.cost)} บาท`,
                `CM ต่อจาน ${fmtBaht(r.cm)} บาท · %กำไร ${(r.margin * 100).toFixed(1)}%`,
                `หมวด ${r.category} · กลุ่ม ${r.cls} · ${ME_CLASSES[r.cls].th}`,
              ];
            },
          },
        }),
      },
      scales: {
        x: {
          title: { display: true, text: xCfg.axis, color: baseMutedColor(), font: { size: 11 } },
          grid: { color: baseGridColor() },
          ticks: { color: baseMutedColor(), callback: (v) => (xCfg.isPct ? `${v}%` : fmtCompact(v)) },
          border: { display: false },
        },
        y: {
          title: { display: true, text: yCfg.axis, color: baseMutedColor(), font: { size: 11 } },
          beginAtZero: true,
          grid: { color: baseGridColor() },
          ticks: { color: baseMutedColor(), callback: (v) => `${v}%` },
          border: { display: false },
        },
      },
    },
  }, [quadrantPlugin]);

  renderMETable();
}

function renderMETable() {
  const tbody = document.querySelector("#meTable tbody");
  if (!tbody) return;
  const rows = meFilter === "ALL" ? meRows : meRows.filter((r) => r.cls === meFilter);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:18px;">ไม่มีเมนูที่ตรงกับตัวกรองนี้</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const c = ME_CLASSES[r.cls];
    return `<tr>
      <td class="rank-badge">${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td style="text-align:left;font-size:12px;color:var(--text-secondary);">${escapeHtml(r.category)}</td>
      <td style="text-align:left;"><span class="me-badge" style="background:${cssVar(c.varName)}">${r.cls}</span></td>
      <td>${fmtInt(r.qty)}</td>
      <td>${(r.cmShare * 100).toFixed(2)}%</td>
      <td>${(r.mm * 100).toFixed(2)}%</td>
      <td>${fmtBaht(r.price)}</td>
      <td>${fmtBaht(r.cost)}</td>
      <td>${fmtBaht(r.cm)}</td>
      <td>${(r.margin * 100).toFixed(1)}%</td>
      <td><strong>${fmtBaht(r.cmTotal)}</strong></td>
      <td style="text-align:left;font-size:12px;color:var(--text-secondary);">${escapeHtml(c.advice)}</td>
    </tr>`;
  }).join("");
}


/* ========================================================================
   Export ตารางเป็นไฟล์ CSV
   ใส่ BOM ไว้ข้างหน้าเพื่อให้ Excel อ่านภาษาไทยได้ถูกต้อง
   ======================================================================== */
function csvEscape(v) {
  const s = String(v == null ? "" : v).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableToCSV(tableEl) {
  const lines = [];
  tableEl.querySelectorAll("tr").forEach((tr) => {
    const cells = [...tr.querySelectorAll("th,td")];
    if (!cells.length) return;
    // ข้ามแถวที่เป็นข้อความแจ้งเตือน (colspan เต็มแถว)
    if (cells.length === 1 && cells[0].hasAttribute("colspan")) return;
    lines.push(cells.map((c) => csvEscape(c.textContent)).join(","));
  });
  return lines.join("\r\n");
}

function downloadCSV(csvText, filename) {
  const blob = new Blob(["\ufeff" + csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportTableById(elementId, label) {
  const host = document.getElementById(elementId);
  if (!host) return false;
  const tbl = host.tagName === "TABLE" ? host : host.querySelector("table");
  if (!tbl || !tbl.querySelector("tbody tr")) return false;
  const csv = tableToCSV(tbl);
  if (!csv) return false;
  const rangeTxt = currentRange ? `_${currentRange.start}_ถึง_${currentRange.end}` : "";
  downloadCSV(csv, `${label}${rangeTxt}.csv`.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "_"));
  return true;
}

function flashBtn(btn, text, cls) {
  const original = btn.dataset.origText || btn.textContent;
  btn.dataset.origText = original;
  btn.textContent = text;
  btn.classList.add(cls);
  clearTimeout(btn.__flashTimer);
  btn.__flashTimer = setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("done", "fail");
  }, 1800);
}

function wireCsvButtons() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".csv-btn");
    if (!btn) return;
    const ok = exportTableById(btn.dataset.csv, btn.dataset.name || btn.dataset.csv);
    flashBtn(btn, ok ? "✓ ดาวน์โหลดแล้ว" : "ไม่มีข้อมูลให้ดาวน์โหลด", ok ? "done" : "fail");
  });
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
  renderBillTypes(cur);
  renderDaily(currentRange);
  renderTopItems(cur);
  renderCategory(cur);
  renderHourAll(currentRange);
  renderMeal(currentRange);
  renderBillTypeByHour(cur);
  renderWeekday(currentRange);
  renderPaymentAndOrderType(cur);
  renderMenuEngineering(currentRange);
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

function syncMEFilterChips() {
  document.querySelectorAll(".chip[data-mefilter]").forEach((b) => b.classList.toggle("active", b.dataset.mefilter === meFilter));
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

  const gsel = document.getElementById("meGroupSel");
  if (gsel) gsel.addEventListener("change", () => { meGroup = gsel.value; meCategory = "ALL"; meCategoryList = []; meFilter = "ALL"; syncMEFilterChips(); renderMenuEngineering(currentRange); });
  const fsel = document.getElementById("meFactorSel");
  if (fsel) fsel.addEventListener("change", () => { meFactor = parseFloat(fsel.value) || 0.7; renderMenuEngineering(currentRange); });
  const ysel = document.getElementById("meYSel");
  if (ysel) ysel.addEventListener("change", () => { meYMetric = ME_Y[ysel.value] ? ysel.value : "cmshare"; renderMenuEngineering(currentRange); });
  const xsel = document.getElementById("meXSel");
  if (xsel) xsel.addEventListener("change", () => { meXMetric = ME_X[xsel.value] ? xsel.value : "cm"; renderMenuEngineering(currentRange); });
  const csel = document.getElementById("meCatSel");
  if (csel) csel.addEventListener("change", () => { meCategory = csel.value; meFilter = "ALL"; syncMEFilterChips(); renderMenuEngineering(currentRange); });
  const ssel = document.getElementById("meScopeSel");
  if (ssel) ssel.addEventListener("change", () => { meScope = ssel.value; renderMenuEngineering(currentRange); });
  document.querySelectorAll(".chip[data-mefilter]").forEach((btn) => {
    btn.addEventListener("click", () => { meFilter = btn.dataset.mefilter; syncMEFilterChips(); renderMETable(); });
  });

  wireCsvButtons();

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
