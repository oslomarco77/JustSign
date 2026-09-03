// ============================================================
//  SignDee — Admin Stats Endpoint v2  (/api/admin-stats)
//  วางไฟล์นี้ทับ  D:\justsign-api\api\admin-stats.js  แล้ว deploy
//
//  v2 = รวมข้อมูล "ทุกผลิตภัณฑ์" ไว้ที่ endpoint เดียว
//    contracts (เช่า) · sale_contracts (ซื้อขาย) · nda_contracts (NDA)
//    emp_contracts (จ้าง) · notice_cases (ทวงถาม/บอกเลิก)
//
//  ความปลอดภัย:
//   - ใช้ service_role (ฝั่ง server เท่านั้น) → bypass RLS อ่านข้อมูลรวมได้
//   - ป้องกันด้วยรหัสผ่าน ADMIN_PASSWORD (ไม่ผ่าน = 401)
//   - ไม่ดึงคอลัมน์ลายเซ็น / รูปบัตร ปชช. เลย (payload เบา + PDPA)
//   - เลขบัตร 13 หลักถูกตัดออกก่อนส่งกลับ client (คงไว้แค่ชื่อ)
//
//  ทนต่อ schema ที่ต่างกัน:
//   - ถ้า select คอลัมน์ที่ไม่มีจริง PostgREST จะตอบ 400 พร้อมชื่อคอลัมน์
//     → ฟังก์ชัน selectRows() จะตัดคอลัมน์นั้นทิ้งแล้วลองใหม่อัตโนมัติ
//     → คอลัมน์ที่ถูกตัดรายงานกลับใน products[].dropped (ดูได้จาก dashboard)
//   - ถ้าตารางไม่มีจริง → products[].available = false (ไม่ทำให้ทั้ง endpoint พัง)
//
//  ENV ที่ต้องมีใน Vercel (Production):
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ADMIN_PASSWORD
// ============================================================

// ── ราคาต่อผลิตภัณฑ์ (บาท) — แก้ที่เดียว dashboard ใช้ค่านี้ ──
const PRICE_THB = {
  rent:   790,
  sale:   790,
  nda:    790,
  emp:    790,
  notice: 2990,
};

const PRODUCT_META = {
  rent:   { key: 'rent',   label: 'สัญญาเช่า',   table: 'contracts',      color: '#2E86C6', app: 'https://app.signdee.com/'                        },
  sale:   { key: 'sale',   label: 'ซื้อขายคอนโด', table: 'sale_contracts', color: '#1a7f5a', app: 'https://sale.signdee.com/'                       },
  nda:    { key: 'nda',    label: 'NDA',          table: 'nda_contracts',  color: '#8E6BC4', app: 'https://app.signdee.com/index-nda.html'          },
  emp:    { key: 'emp',    label: 'สัญญาจ้าง',    table: 'emp_contracts',  color: '#C4913A', app: 'https://app.signdee.com/index-emp.html'          },
  notice: { key: 'notice', label: 'ทวงถาม/บอกเลิก', table: 'notice_cases', color: '#c0392b', app: 'https://app.signdee.com/index-notice.html'       },
};

const ROW_LIMIT = 300;   // ต่อผลิตภัณฑ์

// ── ขั้นตอนของแต่ละผลิตภัณฑ์ (dashboard ใช้แสดง progress) ──
const STEPS = {
  rent:   ['สร้างสัญญา', 'ชำระค่าบริการ', 'ผู้ให้เช่าลงนาม', 'ผู้เช่าลงนาม', 'สัญญาสมบูรณ์'],
  sale:   ['สร้างสัญญา', 'ชำระค่าบริการ', 'ผู้ขายลงนาม', 'ผู้ซื้อลงนาม', 'สัญญาสมบูรณ์'],
  nda:    ['สร้างเอกสาร', 'ชำระค่าบริการ', 'ผู้ให้ข้อมูลลงนาม', 'ผู้รับข้อมูลลงนาม', 'เอกสารสมบูรณ์'],
  emp:    ['สร้างสัญญา', 'ชำระค่าบริการ', 'นายจ้างลงนาม', 'ลูกจ้างลงนาม', 'สัญญาสมบูรณ์'],
  notice: ['สร้างเคส', 'ชำระค่าบริการ', 'ส่งหนังสือทวงถาม', 'ครบกำหนด/บอกเลิก', 'ส่งหนังสือบอกเลิก', 'ปิดเคส'],
};

// ============================================================
//  helpers
// ============================================================
function jname(o) {
  if (!o) return null;
  if (typeof o === 'string') return o.trim() || null;
  if (typeof o !== 'object') return null;
  const j = o.jur;
  if (j && j.on && (j.name || j.jur_name)) return String(j.name || j.jur_name);
  return o.name || o.full_name || o.fullname || o.title || null;
}
function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function isSigned(v) { return !!(v && String(v).length > 0); }
function dayKey(iso) { return String(iso || '').slice(0, 10); }
function monthKey(iso) { return String(iso || '').slice(0, 7); }

// PostgREST บอกชื่อคอลัมน์ที่ไม่มีมาใน error → ดึงออกมาเพื่อตัดทิ้งแล้วลองใหม่
function parseMissingColumn(txt, table) {
  let m = '';
  try {
    const j = JSON.parse(txt);
    m = [j.message, j.details, j.hint].filter(Boolean).join(' ');
  } catch (e) { m = String(txt || ''); }
  let mm = m.match(new RegExp('column\\s+' + table + '\\.([a-zA-Z0-9_]+)\\s+does not exist'));
  if (mm) return mm[1];
  mm = m.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/);
  if (mm) return mm[1];
  mm = m.match(/Could not find the '([a-zA-Z0-9_]+)' column/);
  if (mm) return mm[1];
  mm = m.match(/["']([a-zA-Z0-9_]+)["']\s+column\s+of/);
  if (mm) return mm[1];
  return null;
}

// ============================================================
//  main
// ============================================================
module.exports = async (req, res) => {
  // ---------- CORS ----------
  res.setHeader('Access-Control-Allow-Origin', '*'); // password คือปราการจริง
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // ---------- Auth ----------
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const key = (req.headers['x-admin-key'] || (body && body.key) || '').toString();
  const ADMIN = process.env.ADMIN_PASSWORD;
  if (!ADMIN) return res.status(500).json({ error: 'admin_password_not_set' });
  if (key !== ADMIN) return res.status(401).json({ error: 'unauthorized' });

  // ---------- Supabase config ----------
  const SB = (process.env.SUPABASE_URL || process.env.SB_URL || '').replace(/\/$/, '');
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!SB || !SR) return res.status(500).json({ error: 'supabase_config_missing' });
  const headers = { apikey: SR, Authorization: 'Bearer ' + SR };

  const q = async (path) => {
    const r = await fetch(SB + '/rest/v1/' + path, { headers });
    if (!r.ok) throw new Error('supabase ' + r.status + ' on ' + path);
    return r.json();
  };

  // select ที่ตัดคอลัมน์ซึ่งไม่มีจริงออกอัตโนมัติแล้วลองใหม่
  async function selectRows(table, wish, limit) {
    let cols = wish.slice();
    let order = 'created_at.desc';
    const dropped = [];
    for (let attempt = 0; attempt < 16; attempt++) {
      const path = table + '?select=' + cols.join(',')
                 + (order ? '&order=' + order : '')
                 + '&limit=' + (limit || ROW_LIMIT);
      let r;
      try { r = await fetch(SB + '/rest/v1/' + path, { headers }); }
      catch (e) { return { ok: false, rows: [], dropped, error: String(e && e.message || e) }; }

      if (r.ok) { return { ok: true, rows: await r.json().catch(() => []), dropped, error: null }; }

      const txt = await r.text().catch(() => '');
      if (r.status === 404) return { ok: false, rows: [], dropped, error: 'table_not_found' };

      const bad = parseMissingColumn(txt, table);
      if (bad === 'created_at' && order) { order = ''; continue; }               // ไม่มี created_at → เลิก order
      if (bad && cols.indexOf(bad) >= 0 && cols.length > 1) {
        cols = cols.filter((c) => c !== bad);
        dropped.push(bad);
        continue;
      }
      if (bad && order && order.indexOf(bad) === 0) { order = ''; continue; }
      // ตัดไม่ได้แล้ว → ลองชุดขั้นต่ำสุดครั้งเดียว
      if (cols.length > 2) { cols = ['id', 'created_at']; order = 'created_at.desc'; continue; }
      return { ok: false, rows: [], dropped, error: (txt || '').slice(0, 200) || ('http ' + r.status) };
    }
    return { ok: false, rows: [], dropped, error: 'too_many_retries' };
  }

  // ============================================================
  //  ตัว normalize ต่อผลิตภัณฑ์ → item รูปแบบเดียวกันหมด
  // ============================================================
  function mkItem(product, o) {
    const total = STEPS[product].length;
    const step = Math.max(1, Math.min(total, o.step || 1));
    return {
      product: product,
      id: String(o.id),
      no: o.no || null,                       // เลขที่สัญญา/เคส (ถ้ามี)
      created_at: o.created_at || null,
      updated_at: o.updated_at || null,
      title: o.title || '—',
      subtitle: o.subtitle || '',
      party_a: o.party_a || null,
      party_b: o.party_b || null,
      party_a_label: o.party_a_label || 'ฝ่ายที่ 1',
      party_b_label: o.party_b_label || 'ฝ่ายที่ 2',
      status_raw: o.status_raw || null,
      status_th: o.status_th || '—',
      paid: !!o.paid,
      paid_at: o.paid_at || null,
      amount: o.paid ? (PRICE_THB[product] || 0) : 0,
      price: PRICE_THB[product] || 0,
      step: step,
      steps_total: total,
      steps: STEPS[product],
      next_step: step >= total ? 'เสร็จสมบูรณ์' : STEPS[product][step],
      done: step >= total,
      signed_a_at: o.signed_a_at || null,
      signed_b_at: o.signed_b_at || null,
      cert_no: o.cert_no || null,
      link: o.link || null,
      extra: o.extra || {},
    };
  }

  // ── 1) สัญญาเช่า ──
  function normRent(r) {
    const paid = r.payment_completed === true;
    const aSig = pick(r.landlord_signed_at, r.ll_signed_at);
    const bSig = pick(r.tenant_signed_at, r.tn_signed_at);
    const st = String(r.status_th || '');
    let step = 1;
    if (paid) step = 2;
    if (paid && aSig) step = 3;
    if (paid && aSig && bSig) step = 5;
    else if (paid && bSig) step = 3;
    if (!aSig && !bSig && /สมบูรณ์|ครบ|เสร็จ/.test(st)) step = 5;
    const prop = pick(r.property, r.prop_name, r.property_name);
    const room = pick(r.room_no, r.unit_no);
    const a = pick(r.landlord_name, r.ll_name, jname(r.ll_jur_name));
    const b = pick(r.tenant_name, r.tn_name);
    return mkItem('rent', {
      id: r.id, created_at: r.created_at, updated_at: r.updated_at,
      title: (prop || 'สัญญาเช่า') + (room ? ' · ห้อง ' + room : ''),
      subtitle: (a || '—') + ' → ' + (b || '—'),
      party_a: a, party_b: b, party_a_label: 'ผู้ให้เช่า', party_b_label: 'ผู้เช่า',
      status_raw: r.status_th || null,
      status_th: st || (step >= 5 ? 'สมบูรณ์' : paid ? 'รอลงนาม' : 'ยังไม่ชำระ'),
      paid: paid, paid_at: r.paid_at || null,
      step: step, signed_a_at: aSig, signed_b_at: bSig,
      link: PRODUCT_META.rent.app + '?reload=' + r.id,
      extra: { rent: num(r.rent), deposit: num(r.deposit), creator_role: r.creator_role || null },
    });
  }

  // ── 2) ซื้อขายคอนโด ──
  function normSale(r) {
    const paid = r.payment_completed === true;
    const aSig = r.s_signed_at, bSig = r.b_signed_at;
    let step = paid ? 2 : 1;
    if (paid && aSig) step = 3;
    if (paid && aSig && bSig) step = 5;
    else if (paid && bSig) step = 3;
    const a = pick(r.s_name, jname(r.seller)), b = pick(r.b_name, jname(r.buyer));
    return mkItem('sale', {
      id: r.id, created_at: r.created_at, updated_at: r.updated_at,
      title: (pick(r.condo_name, 'ซื้อขายคอนโด')) + (r.unit_no ? ' · ห้อง ' + r.unit_no : ''),
      subtitle: (a || '—') + ' → ' + (b || '—'),
      party_a: a, party_b: b, party_a_label: 'ผู้ขาย', party_b_label: 'ผู้ซื้อ',
      status_th: step >= 5 ? 'สมบูรณ์' : paid ? 'รอลงนาม' : 'ยังไม่ชำระ',
      paid: paid, paid_at: r.paid_at || null,
      step: step, signed_a_at: aSig, signed_b_at: bSig,
      link: PRODUCT_META.sale.app,
      extra: {
        total_price: num(r.total_price), deposit_amt: num(r.deposit_amt),
        deposit_paid_at: r.deposit_paid_at || null, deposit_pay_via: r.deposit_pay_via || null,
        deposit_payout_status: r.deposit_payout_status || null,
      },
    });
  }

  // ── 3) NDA ──
  function normNda(r) {
    const paid = r.payment_completed === true;
    const aSig = r.a_signed_at, bSig = r.b_signed_at;
    let step = paid ? 2 : 1;
    if (paid && aSig) step = 3;
    if (paid && aSig && bSig) step = 5;
    else if (paid && bSig) step = 3;
    const a = pick(jname(r.party_a), r.a_name, r.a_line_name);
    const b = pick(jname(r.party_b), r.b_name, r.b_line_name);
    return mkItem('nda', {
      id: r.id, no: r.cert_no || null, created_at: r.created_at, updated_at: r.updated_at,
      title: 'NDA · ' + (a || '—'),
      subtitle: (a || '—') + ' → ' + (b || '—'),
      party_a: a, party_b: b, party_a_label: 'ผู้ให้ข้อมูล', party_b_label: 'ผู้รับข้อมูล',
      status_raw: r.status || null,
      status_th: step >= 5 ? 'สมบูรณ์' : paid ? 'รอลงนาม' : 'ยังไม่ชำระ',
      paid: paid, paid_at: r.paid_at || null,
      step: step, signed_a_at: aSig, signed_b_at: bSig, cert_no: r.cert_no || null,
      link: PRODUCT_META.nda.app,
      extra: { doc_hash: r.doc_hash ? String(r.doc_hash).slice(0, 12) : null },
    });
  }

  // ── 4) สัญญาจ้าง ──
  function normEmp(r) {
    const paid = r.payment_completed === true;
    const aSig = r.a_signed_at, bSig = r.b_signed_at;
    let step = paid ? 2 : 1;
    if (paid && aSig) step = 3;
    if (paid && aSig && bSig) step = 5;
    else if (paid && bSig) step = 3;
    const a = pick(jname(r.party_a), r.owner_line_name);
    const b = jname(r.party_b);
    const ST_TH = {
      draft: 'ร่าง', ocr_done: 'อ่านบัตรแล้ว', generated: 'สร้างเอกสารแล้ว',
      paid: 'ชำระแล้ว', reviewed: 'ตรวจแล้ว', sent: 'ส่งให้ลงนาม', completed: 'สมบูรณ์',
    };
    return mkItem('emp', {
      id: r.id, no: r.contract_no || null, created_at: r.created_at, updated_at: r.updated_at,
      title: (pick(r.position_th, 'สัญญาจ้าง')) + (r.contract_no ? ' · ' + r.contract_no : ''),
      subtitle: (a || '—') + ' → ' + (b || '—'),
      party_a: a, party_b: b, party_a_label: 'นายจ้าง', party_b_label: 'ลูกจ้าง',
      status_raw: r.status || null,
      status_th: ST_TH[r.status] || (step >= 5 ? 'สมบูรณ์' : paid ? 'รอลงนาม' : 'ยังไม่ชำระ'),
      paid: paid, paid_at: r.paid_at || null,
      step: step, signed_a_at: aSig, signed_b_at: bSig, cert_no: r.cert_no || null,
      link: PRODUCT_META.emp.app,
      extra: {
        salary: num(r.salary),
        employment_type: ({ full_time: 'เต็มเวลา', part_time: 'พาร์ทไทม์', temporary: 'ชั่วคราว', probation: 'ทดลองงาน' })[r.employment_type] || r.employment_type || null,
        start_date: r.start_date || null, position: r.position_th || null,
      },
    });
  }

  // ── 5) Notice (เคสทวงถาม/บอกเลิก) ──
  function normNotice(r) {
    const paid = r.payment_completed === true;
    const st = String(r.status || 'draft');
    const ORDER = {
      draft: 1, demand_ready: 2, demand_sent: 3,
      terminate_ready: 4, terminate_sent: 5, evidence: 5, closed: 6,
    };
    let step = ORDER[st] || (paid ? 2 : 1);
    if (paid && step < 2) step = 2;
    const ST_TH = {
      draft: 'ร่างเคส', demand_ready: 'พร้อมส่งทวงถาม', demand_sent: 'ส่งทวงถามแล้ว',
      terminate_ready: 'พร้อมบอกเลิก', terminate_sent: 'ส่งบอกเลิกแล้ว',
      evidence: 'รวบรวมหลักฐาน', closed: 'ปิดเคส',
    };
    // ก้อน jsonb ของ notice ต่างเวอร์ชันกันได้ → หาแบบยืดหยุ่น
    const box = r.case_data || r.data || r || {};
    const LL = r.landlord || box.landlord || {};
    const TN = r.tenant || box.tenant || {};
    const PROP = r.property || box.property || {};
    const a = pick(jname(LL), r.ll_name, r.landlord_name);
    const b = pick(jname(TN), r.tn_name, r.tenant_name);
    const propName = pick(jname(PROP), PROP.name, PROP.address, r.prop_name, r.property_name);
    const arrears = r.arrears || box.arrears || null;
    let arrearTotal = 0;
    if (arrears && typeof arrears === 'object') {
      arrearTotal = num(arrears.total);
      if (!arrearTotal && Array.isArray(arrears.items))
        arrearTotal = arrears.items.reduce((s, x) => s + num(x && (x.amount || x.amt)), 0);
    }
    const demand = r.demand || box.demand || {};
    return mkItem('notice', {
      id: r.id, no: r.case_no || null, created_at: r.created_at, updated_at: r.updated_at,
      title: (propName || 'เคสทวงถาม') + (r.case_no ? ' · ' + r.case_no : ''),
      subtitle: (a || '—') + ' → ' + (b || '—'),
      party_a: a, party_b: b, party_a_label: 'ผู้ให้เช่า', party_b_label: 'ผู้เช่า',
      status_raw: st, status_th: ST_TH[st] || st,
      paid: paid, paid_at: r.paid_at || null,
      step: step,
      link: PRODUCT_META.notice.app,
      extra: {
        arrears_total: arrearTotal,
        deadline: pick(demand.deadlineDate, demand.deadline_date, r.deadline_date),
        sent_at: pick(demand.sentAt, demand.sent_at, r.demand_sent_at),
        recv_at: pick(demand.recvDate, demand.recv_date, r.demand_recv_at),
        payment_provider: r.payment_provider || null,
      },
    });
  }

  // ── column wishlist ต่อผลิตภัณฑ์ (ไม่มีลายเซ็น/รูปบัตร) ──
  const WISH = {
    rent: ['id', 'created_at', 'updated_at', 'status_th', 'landlord_name', 'tenant_name',
           'property', 'room_no', 'rent', 'deposit', 'payment_completed', 'paid_at',
           'landlord_signed_at', 'tenant_signed_at', 'creator_role',
           'll_name', 'tn_name', 'prop_name'],
    sale: ['id', 'created_at', 'condo_name', 'unit_no', 's_name', 'b_name',
           'total_price', 'deposit_amt', 'payment_completed', 'paid_at',
           's_signed_at', 'b_signed_at', 'deposit_paid_at', 'deposit_pay_via', 'deposit_payout_status'],
    nda:  ['id', 'created_at', 'status', 'party_a', 'party_b', 'payment_completed', 'paid_at',
           'a_signed_at', 'b_signed_at', 'cert_no', 'doc_hash', 'a_line_name', 'b_line_name'],
    emp:  ['id', 'created_at', 'updated_at', 'contract_no', 'status', 'position_th',
           'party_a', 'party_b', 'salary', 'employment_type', 'start_date',
           'payment_completed', 'paid_at', 'a_signed_at', 'b_signed_at', 'cert_no', 'owner_line_name'],
    notice: ['id', 'created_at', 'updated_at', 'case_no', 'status', 'payment_completed', 'paid_at',
             'payment_provider', 'landlord', 'tenant', 'property', 'arrears', 'demand',
             'case_data', 'data'],
  };
  const NORM = { rent: normRent, sale: normSale, nda: normNda, emp: normEmp, notice: normNotice };

  try {
    // ── เช่า: ใช้ view เดิมก่อน (มี status_th สวย ๆ) ถ้าไม่มี view ค่อยอ่านตารางตรง ──
    const jobs = [];
    jobs.push((async () => {
      let out = await selectRows('v_contracts_list', WISH.rent, ROW_LIMIT);
      if (!out.ok) out = await selectRows('contracts', WISH.rent, ROW_LIMIT);
      // view เก่ามักไม่มีคอลัมน์เวลาลงนาม → เติมจากตาราง contracts (best-effort)
      const needSign = (out.dropped || []).some((c) =>
        c === 'landlord_signed_at' || c === 'tenant_signed_at' || c === 'paid_at');
      if (out.ok && needSign && out.rows.length) {
        const extra = await selectRows('contracts',
          ['id', 'created_at', 'landlord_signed_at', 'tenant_signed_at', 'paid_at', 'updated_at'], ROW_LIMIT);
        if (extra.ok) {
          const byId = {};
          extra.rows.forEach((r) => { byId[String(r.id)] = r; });
          out.rows = out.rows.map((r) => {
            const e = byId[String(r.id)];
            return e ? Object.assign({}, r, {
              landlord_signed_at: e.landlord_signed_at, tenant_signed_at: e.tenant_signed_at,
              paid_at: e.paid_at, updated_at: e.updated_at,
            }) : r;
          });
          out.dropped = (out.dropped || []).filter((c) =>
            ['landlord_signed_at', 'tenant_signed_at', 'paid_at', 'updated_at'].indexOf(c) < 0);
        }
      }
      return { key: 'rent', out: out };
    })());
    ['sale', 'nda', 'emp', 'notice'].forEach((k) => {
      jobs.push((async () => ({ key: k, out: await selectRows(PRODUCT_META[k].table, WISH[k], ROW_LIMIT) }))());
    });

    const results = await Promise.all(jobs);

    // ── รายได้ต่อเดือนจาก view เดิม (ถ้ามี) เอาไว้ cross-check ──
    let revenueView = [];
    try { revenueView = await q('v_revenue_by_month?select=*'); } catch (e) { revenueView = []; }
    let summaryView = {};
    try { const s = await q('v_dashboard_summary?select=*'); summaryView = (s && s[0]) || {}; } catch (e) { summaryView = {}; }

    // ── normalize ──
    const items = [];
    const products = [];
    for (const rs of results) {
      const k = rs.key, meta = PRODUCT_META[k];
      const list = (rs.out.rows || []).map((row) => {
        try { return NORM[k](row); } catch (e) { return null; }
      }).filter(Boolean);
      items.push.apply(items, list);

      const paidN = list.filter((x) => x.paid).length;
      const doneN = list.filter((x) => x.done).length;
      products.push({
        key: k, label: meta.label, table: meta.table, color: meta.color, app: meta.app,
        price: PRICE_THB[k] || 0,
        available: rs.out.ok,
        error: rs.out.error || null,
        dropped: rs.out.dropped || [],
        total: list.length,
        paid: paidN,
        unpaid: list.length - paidN,
        done: doneN,
        pending: list.length - doneN,
        revenue: paidN * (PRICE_THB[k] || 0),
      });
    }

    items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    // ── daily 14 วัน แยกผลิตภัณฑ์ ──
    const dmap = {};
    for (let i = 13; i >= 0; i--) {
      const k = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      dmap[k] = { date: k, total: 0, rent: 0, sale: 0, nda: 0, emp: 0, notice: 0 };
    }
    // ── monthly 6 เดือน ──
    const mmap = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const k = d.toISOString().slice(0, 7);
      mmap[k] = { month: k, revenue: 0, count: 0, rent: 0, sale: 0, nda: 0, emp: 0, notice: 0 };
    }
    for (const it of items) {
      const dk = dayKey(it.created_at), mk = monthKey(it.created_at);
      if (dmap[dk]) { dmap[dk].total++; dmap[dk][it.product]++; }
      if (mmap[mk] && it.paid) {
        mmap[mk].revenue += it.amount;
        mmap[mk].count++;
        mmap[mk][it.product] += it.amount;
      }
    }

    const totalPaid = items.filter((x) => x.paid).length;
    const revenueTotal = items.reduce((s, x) => s + x.amount, 0);

    return res.status(200).json({
      ok: true,
      version: 2,
      generated_at: new Date().toISOString(),
      prices: PRICE_THB,
      steps: STEPS,
      products: products,
      items: items,
      totals: {
        total: items.length,
        paid: totalPaid,
        unpaid: items.length - totalPaid,
        done: items.filter((x) => x.done).length,
        pending: items.filter((x) => !x.done).length,
        revenue: revenueTotal,
      },
      daily: Object.keys(dmap).map((k) => dmap[k]),
      monthly: Object.keys(mmap).sort().map((k) => mmap[k]),

      // ── backward compatible กับ dashboard เวอร์ชันเก่า ──
      summary: summaryView,
      revenue: revenueView,
      contracts: items.filter((x) => x.product === 'rent').map((x) => ({
        id: x.id, created_at: x.created_at, status_th: x.status_th,
        landlord_name: x.party_a, tenant_name: x.party_b,
        property: x.title, room_no: (x.extra && x.extra.room_no) || null,
        payment_completed: x.paid,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: 'query_failed', detail: String(e && e.message || e) });
  }
};
