// ============================================================
//  SignDee Commerce Core — shared library
//  ไฟล์ขึ้นต้นด้วย "_" → Vercel ไม่นับเป็น serverless function
//  (convention เดียวกับ _emp_templates.js เดิมในโปรเจกต์)
//
//  ไม่มี dependency ภายนอก (vercel.json ตั้ง installCommand: "echo skip")
//  เงินทั้งหมดเป็น integer minor unit (สตางค์) ห้ามใช้ float
// ============================================================

const crypto = require('crypto');

/* ══════════ ENV ══════════ */
const SB = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SR = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

/* ══════════ Beam config ══════════
   Commerce Core แยก environment ออกจากระบบสัญญาเดิมได้
   ตั้ง COMMERCE_BEAM_* เมื่อไหร่ ตัวนั้นชนะทันที · ไม่ตั้ง = ใช้ค่าเดิมของโปรเจกต์
   → ทดสอบ eBook บน playground ได้โดยไม่กระทบ contract flow ที่รับเงินจริงอยู่
   ⚠️ playground กับ production ใช้ merchant/API key คนละชุด
      ถ้าตั้ง COMMERCE_BEAM_ENV=playground ต้องตั้ง key ของ playground ด้วย */
const COMMERCE_BEAM_ENV = process.env.COMMERCE_BEAM_ENV || null;
const BEAM_ENV = COMMERCE_BEAM_ENV || process.env.BEAM_ENV || null;

const beamBaseFor = env => (env === 'production'
  ? 'https://api.beamcheckout.com'
  : 'https://playground.api.beamcheckout.com');

const BEAM_MERCHANT_ID = process.env.COMMERCE_BEAM_MERCHANT_ID || process.env.BEAM_MERCHANT_ID;
const BEAM_API_KEY = process.env.COMMERCE_BEAM_API_KEY || process.env.BEAM_API_KEY;
const BEAM_WEBHOOK_SECRET = process.env.BEAM_WEBHOOK_SECRET;

// COMMERCE_BEAM_ENV ถูกตั้ง = ตัดขาดจาก BEAM_API_BASE ของระบบเดิมไปเลย
const BEAM_BASE = process.env.COMMERCE_BEAM_API_BASE
  || (COMMERCE_BEAM_ENV
    ? beamBaseFor(COMMERCE_BEAM_ENV)
    : (process.env.BEAM_API_BASE || beamBaseFor(BEAM_ENV)));

// Beam คิดยอดเป็นสตางค์เหมือน charges API เดิมใน create-payment-intent.js
// ถ้าพบว่า Payment Links รับเป็นบาท ให้ตั้ง BEAM_AMOUNT_UNIT=major แล้ว redeploy
const BEAM_AMOUNT_UNIT = process.env.BEAM_AMOUNT_UNIT || 'minor';

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://signdee.com').replace(/\/$/, '');
const DOWNLOAD_PATH = process.env.COMMERCE_DOWNLOAD_PATH || '/api/download';

const sbHeaders = () => ({
  apikey: SR,
  Authorization: 'Bearer ' + SR,
  'Content-Type': 'application/json',
});

/* ══════════ utils ══════════ */
const nowISO = () => new Date().toISOString();
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

/* ══════════ structured logging ══════════
   ห้าม log: BEAM_API_KEY, service key, Authorization header, token ดิบ
*/
const LOG_EVENTS = new Set([
  'ORDER_CREATED', 'PAYMENT_CREATED', 'BEAM_WEBHOOK_RECEIVED', 'PAYMENT_CONFIRMED',
  'PAYMENT_MISMATCH', 'DELIVERY_CREATED', 'DOWNLOAD_COMPLETED', 'WEBHOOK_REJECTED',
  'PAYMENT_FAILED', 'DOWNLOAD_DENIED', 'BEAM_LINK_SETTINGS_OK',
]);

const SECRET_KEYS = /^(authorization|apikey|api_key|secret|password|token|key)$/i;
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

async function logEvent(event, { orderId = null, orderNumber = null, level = 'info', data = {} } = {}) {
  const safe = redact(data);
  // stdout: บรรทัดเดียวเป็น JSON อ่านง่ายใน Vercel Logs
  const line = JSON.stringify({ ts: nowISO(), event, orderNumber, level, ...safe });
  if (level === 'error') console.error(line); else console.log(line);
  if (!LOG_EVENTS.has(event)) return;
  try {
    await sbInsert('commerce_events',
      { event, order_id: orderId, order_number: orderNumber, level, data: safe }, { minimal: true });
  } catch (_) { /* logging ต้องไม่ทำให้ flow หลักพัง */ }
}

/* ══════════ Supabase REST ══════════ */
async function sbSelect(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) {
    console.error(JSON.stringify({ ts: nowISO(), event: 'SB_SELECT_FAILED', status: r.status, path }));
    return [];
  }
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

async function sbInsert(table, row, opts = {}) {
  const prefer = opts.minimal
    ? 'return=minimal'
    : (opts.ignoreDuplicates ? 'return=representation,resolution=ignore-duplicates' : 'return=representation');
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(), Prefer: prefer }, body: JSON.stringify(row),
  });
  if (r.status === 409) return { conflict: true };
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(JSON.stringify({ ts: nowISO(), event: 'SB_INSERT_FAILED', status: r.status, table, detail: text.slice(0, 300) }));
    return { error: true, status: r.status, detail: text };
  }
  if (opts.minimal) return { ok: true };
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j[0] : j;
}

async function sbUpdate(table, match, patch, opts = {}) {
  const qs = Object.entries(match)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`${SB}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: opts.returning ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(JSON.stringify({ ts: nowISO(), event: 'SB_UPDATE_FAILED', status: r.status, table, detail: text.slice(0, 300) }));
    return { error: true };
  }
  if (!opts.returning) return { ok: true };
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j[0] : j;
}

async function sbRpc(fn, args = {}) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify(args),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(JSON.stringify({ ts: nowISO(), event: 'SB_RPC_FAILED', status: r.status, fn, detail: text.slice(0, 300) }));
    return null;
  }
  return r.json().catch(() => null);
}

/* ══════════ PRODUCT ══════════ */
async function getProduct(productCode) {
  const rows = await sbSelect(`products?select=*&product_code=eq.${encodeURIComponent(productCode)}&limit=1`);
  return rows[0] || null;
}

/* ══════════ BEAM ══════════ */
function beamAuthHeader() {
  return 'Basic ' + Buffer.from(`${BEAM_MERCHANT_ID}:${BEAM_API_KEY}`).toString('base64');
}
const beamConfigured = () => !!(BEAM_MERCHANT_ID && BEAM_API_KEY);

/** แปลง minor unit (สตางค์) → หน่วยที่ Beam รับ */
function toBeamAmount(minorUnits) {
  return BEAM_AMOUNT_UNIT === 'major' ? Math.round(minorUnits / 100) : minorUnits;
}
/** แปลงกลับจากยอดที่ Beam ส่งมา → minor unit เพื่อเทียบกับ order */
function fromBeamAmount(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return BEAM_AMOUNT_UNIT === 'major' ? Math.round(n * 100) : Math.round(n);
}

/* ช่องทางชำระเงินที่จะบังคับเปิดในลิงก์
   ไม่ตั้ง = ไม่ส่ง linkSettings ไปเลย → Beam ใช้ช่องทางที่บัญชีร้านเปิดใช้งานอยู่จริง
   บังคับเปิดช่องทางที่บัญชียังไม่ได้รับอนุมัติ Beam จะตอบ 400 "cannot enable CREDIT_CARD"
   ตั้งได้เมื่อบัญชีพร้อม เช่น BEAM_LINK_METHODS=card,ewallets */
/* วิธีรับเงิน:
   charge (ค่าเริ่มต้น) = Charges API + QR PromptPay — วิธีเดียวกับที่ระบบสัญญาใช้อยู่จริง
   link                 = Payment Links (ต้องเปิดบัตรได้ก่อน ถึงจะใช้ได้) */
const BEAM_PAYMENT_MODE = (process.env.BEAM_PAYMENT_MODE || 'charge').toLowerCase() === 'link'
  ? 'link' : 'charge';

const BEAM_LINK_METHODS = (process.env.BEAM_LINK_METHODS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* ชื่อ key ของแต่ละช่องทางใน linkSettings
   เอกสาร Beam ระบุ card / eWallets ไว้ชัด ส่วน PromptPay ยังไม่ชัดว่าใช้ key ไหน
   → ถ้าไม่ได้ตั้ง BEAM_LINK_METHODS ไว้ โค้ดจะไล่ลองรูปแบบใน CANDIDATES ให้เอง
     แล้ว log ตัวที่สำเร็จไว้ที่ event BEAM_LINK_SETTINGS_OK เพื่อเอาไป pin ทีหลัง */
const METHOD_KEYS = {
  card: 'card',
  ewallets: 'eWallets', ewallet: 'eWallets',
  promptpay: 'promptPay',
  qrpromptpay: 'qrPromptPay',
  qr: 'qr',
};

function buildLinkSettings() {
  if (!BEAM_LINK_METHODS.length) return null;
  // ระบุแบบชัดเจน: ที่ list ไว้ = เปิด · card ที่ไม่ได้ list = ปิด (ไม่ใส่ key เฉย ๆ ไม่พอ)
  const s = { card: { isEnabled: BEAM_LINK_METHODS.includes('card') } };
  for (const m of BEAM_LINK_METHODS) {
    const key = METHOD_KEYS[m];
    if (key && key !== 'card') s[key] = { isEnabled: true };
  }
  return s;
}

/* ลำดับที่จะลองเมื่อ Beam ตอบ 400 — หยุดทันทีที่ใบไหนผ่าน */
const LINK_SETTINGS_CANDIDATES = [
  null,                                                                  // ปล่อยให้ Beam ใช้ค่าของร้าน
  { card: { isEnabled: false }, qrPromptPay: { isEnabled: true } },
  { card: { isEnabled: false }, promptPay: { isEnabled: true } },
  { card: { isEnabled: false }, eWallets: { isEnabled: true } },
  { card: { isEnabled: false } },
];

/** POST /api/v1/payment-links — docs.beamcheckout.com/payment-links/payment-links */
async function beamCreatePaymentLink({ orderNumber, amountMinor, currency, description, redirectUrl, expiresAt }) {
  if (!beamConfigured()) return { error: 'beam_not_configured' };

  const base = {
    order: {
      netAmount: toBeamAmount(amountMinor),
      currency,
      description,
      referenceId: orderNumber,          // ← ตัวผูกกลับมาหา order ตอน webhook เข้า
    },
    redirectUrl,
    cancelUrl: redirectUrl,
    expiresAt,
  };
  const settings = buildLinkSettings();

  const post = async payload => {
    const r = await fetch(`${BEAM_BASE}/api/v1/payment-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: beamAuthHeader() },
      body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ตั้ง BEAM_LINK_METHODS ไว้ = เชื่อค่านั้นก่อน แล้วค่อยถอยไปตามลำดับสำรอง
  const attempts = settings
    ? [settings, ...LINK_SETTINGS_CANDIDATES]
    : LINK_SETTINGS_CANDIDATES;

  try {
    let res = null;
    for (let i = 0; i < attempts.length; i++) {
      const ls = attempts[i];
      res = await post(ls ? { ...base, linkSettings: ls } : base);
      if (res.ok) {
        if (i > 0) {
          await logEvent('BEAM_LINK_SETTINGS_OK', {
            orderNumber, level: 'warn',
            data: { note: 'ตั้ง BEAM_LINK_METHODS ให้ตรงกับรูปแบบนี้เพื่อตัดการลองซ้ำ', linkSettings: ls },
          });
        }
        break;
      }
      if (res.status !== 400) break;    // ไม่ใช่ปัญหารูปแบบ ไม่ต้องลองต่อ
    }

    if (!res.ok) return { error: `beam_http_${res.status}`, detail: res.body };

    const j = res.body;
    const id = j.paymentLinkId || j.id || null;
    const url = j.url || j.paymentLinkUrl || j.link || j.checkoutUrl || null;
    if (!id || !url) return { error: 'beam_unexpected_response', detail: j };
    return { id, url, status: j.status || 'ACTIVE', raw: j };
  } catch (e) {
    return { error: 'beam_unreachable', detail: { message: e.message } };
  }
}

/* ══════════ Beam Charges API — QR PromptPay ══════════
   โหมดเริ่มต้นของ Commerce Core เพราะเป็นวิธีเดียวกับที่ระบบสัญญาใช้รับเงินอยู่จริง
   (บัญชี SignDee เปิดบัตรไม่ได้ → Payment Links ใช้ไม่ได้)
   docs: docs.beamcheckout.com/charges/charges-api */
const BEAM_QR_EXPIRY_MIN = Math.min(Math.max(parseInt(process.env.BEAM_QR_EXPIRY_MIN, 10) || 30, 5), 60);

/** POST /api/v1/charges — ได้ QR PromptPay กลับมาเป็น PNG base64 */
async function beamCreateCharge({ orderNumber, amountMinor, currency, returnUrl }) {
  if (!beamConfigured()) return { error: 'beam_not_configured' };

  const expiry = new Date(Date.now() + BEAM_QR_EXPIRY_MIN * 60000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');

  try {
    const r = await fetch(`${BEAM_BASE}/api/v1/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: beamAuthHeader() },
      body: JSON.stringify({
        amount: toBeamAmount(amountMinor),
        currency,
        paymentMethod: {
          qrPromptPay: { expiryTime: expiry },
          paymentMethodType: 'QR_PROMPT_PAY',
        },
        referenceId: orderNumber,        // ← ตัวผูกกลับมาหา order ตอน webhook เข้า
        returnUrl,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: `beam_http_${r.status}`, detail: j };

    const img = j.encodedImage && j.encodedImage.imageBase64Encoded;
    if (!j.chargeId || !img) return { error: 'beam_no_qr', detail: j };

    return {
      id: j.chargeId,
      qr: {
        image: 'data:image/png;base64,' + img,
        raw: (j.encodedImage && j.encodedImage.rawData) || null,
        expiry: (j.encodedImage && j.encodedImage.expiry) || expiry,
      },
      status: j.status || 'PENDING',
      raw: { chargeId: j.chargeId, status: j.status || null, amount: j.amount, currency: j.currency },
    };
  } catch (e) {
    return { error: 'beam_unreachable', detail: { message: e.message } };
  }
}

/** GET /api/v1/charges/{id} — source of truth ก่อนส่งของ */
async function beamGetCharge(chargeId) {
  if (!beamConfigured() || !chargeId) return null;
  try {
    const r = await fetch(`${BEAM_BASE}/api/v1/charges/${encodeURIComponent(chargeId)}`,
      { headers: { Authorization: beamAuthHeader() } });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

/** แปลงสถานะของ provider ให้เป็นคำเดียวกันทั้งสองโหมด */
function normalizeProviderStatus(s) {
  const v = String(s || '').toUpperCase();
  if (v === 'PAID' || v === 'SUCCEEDED' || v === 'SUCCESS') return 'PAID';
  if (v === 'ACTIVE' || v === 'PENDING' || v === 'CREATED' || v === 'AUTHORIZED') return 'ACTIVE';
  if (v === 'EXPIRED') return 'EXPIRED';
  if (!v) return '';
  return 'FAILED';
}

/** ถาม provider ตามโหมดที่ใช้อยู่ — คืน raw ของ provider พร้อม status ที่ normalize แล้ว */
async function beamGetPayment(id) {
  const raw = BEAM_PAYMENT_MODE === 'charge'
    ? await beamGetCharge(id)
    : await beamGetPaymentLink(id);
  if (!raw) return null;
  return { ...raw, status: normalizeProviderStatus(raw.status) };
}

/** GET /api/v1/payment-links/{id} — ใช้เป็น source of truth ยืนยันก่อนส่งของเสมอ */
async function beamGetPaymentLink(linkId) {
  if (!beamConfigured() || !linkId) return null;
  try {
    const r = await fetch(`${BEAM_BASE}/api/v1/payment-links/${encodeURIComponent(linkId)}`,
      { headers: { Authorization: beamAuthHeader() } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) { return null; }
}

/** ตรวจลายเซ็น webhook — HMAC-SHA256 ของ raw body เข้ารหัส base64 */
/* HMAC Key จาก Beam Lighthouse เป็น base64
   เอกสารไม่ได้ระบุว่าใช้ "ตัวอักษร base64 ตรง ๆ" หรือ "ไบต์ที่ถอด base64 แล้ว" เป็นกุญแจ
   → ลองทั้งสองแบบ ผ่านแบบใดแบบหนึ่งถือว่าใช้ได้
   (ทั้งคู่คือความลับเดียวกัน ไม่ได้ลดความปลอดภัย และยังมีการยืนยันซ้ำกับ Beam API อีกชั้น) */
function beamVerifySignature(rawBody, signatureHeader) {
  if (!BEAM_WEBHOOK_SECRET) return 'no_secret';
  if (!signatureHeader) return false;

  const keys = [BEAM_WEBHOOK_SECRET];
  try {
    const decoded = Buffer.from(BEAM_WEBHOOK_SECRET, 'base64');
    if (decoded.length) keys.push(decoded);
  } catch (_) { /* ไม่ใช่ base64 — ใช้แบบ string อย่างเดียว */ }

  let ok = false;
  for (const k of keys) {
    const expect = crypto.createHmac('sha256', k).update(rawBody).digest('base64');
    if (timingSafeEqualStr(signatureHeader, expect)) ok = true;   // ไม่ break — ให้เวลาคงที่
  }
  return ok;
}

/* ══════════ ORDER ══════════ */
const VALID_SOURCES = new Set(['website', 'facebook', 'line', 'qr', 'tiktok', 'google', 'manual', 'other']);
const VALID_PAIN = new Set(['VACANT_ROOM', 'TENANT_SCREENING', 'NORMAL_TENANCY', 'LATE_PAYMENT',
  'RENT_ARREARS', 'BREACH', 'TERMINATION', 'WONT_LEAVE', 'OTHER']);

const clean = (v, max = 200) =>
  (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max) : null;

async function createOrder(input = {}) {
  const productCode = clean(input.product_code, 64);
  if (!productCode) return { error: 'product_code_required' };

  const product = await getProduct(productCode);
  if (!product) return { error: 'product_not_found' };
  if (product.status !== 'ACTIVE') return { error: 'product_inactive' };

  const source = VALID_SOURCES.has(input.source) ? input.source : 'website';
  const pain = VALID_PAIN.has(input.pain_category) ? input.pain_category : null;

  const orderNumber = await sbRpc('next_order_number', { p_prefix: 'SD-EBOOK' });
  if (!orderNumber || typeof orderNumber !== 'string') return { error: 'order_number_failed' };

  const lookupToken = randomToken(24);

  const order = await sbInsert('orders', {
    order_number: orderNumber,
    product_code: product.product_code,
    product_version: product.current_version,
    amount: product.price,          // ← ราคามาจาก DB เท่านั้น ไม่เคยรับจาก client
    currency: product.currency,
    source,
    source_reference: clean(input.source_reference, 200),
    utm_source: clean(input.utm_source, 100),
    utm_medium: clean(input.utm_medium, 100),
    utm_campaign: clean(input.utm_campaign, 150),
    utm_content: clean(input.utm_content, 150),
    customer_name: clean(input.customer_name, 150),
    customer_email: clean(input.customer_email, 200),
    customer_phone: clean(input.customer_phone, 40),
    pain_category: pain,
    status: 'PENDING_PAYMENT',
    lookup_token_hash: sha256(lookupToken),
  });

  if (!order || order.error) return { error: 'order_insert_failed' };

  await logEvent('ORDER_CREATED', {
    orderId: order.id, orderNumber,
    data: { product_code: product.product_code, amount: product.price, source, pain_category: pain },
  });

  return { order, lookupToken, product };
}

async function findOrder(idOrNumber) {
  if (!idOrNumber) return null;
  const col = isUuid(idOrNumber) ? 'id' : 'order_number';
  const rows = await sbSelect(`orders?select=*&${col}=eq.${encodeURIComponent(idOrNumber)}&limit=1`);
  return rows[0] || null;
}

async function latestPayment(orderId) {
  const rows = await sbSelect(`payments?select=*&order_id=eq.${orderId}&order=created_at.desc&limit=1`);
  return rows[0] || null;
}

async function getDelivery(orderId) {
  const rows = await sbSelect(`deliveries?select=*&order_id=eq.${orderId}&limit=1`);
  return rows[0] || null;
}

/* ══════════ PAYMENT ══════════ */
async function createPayment(order, product) {
  // ── IDEMPOTENT: ถ้ามี payment ที่ยังเปิดอยู่ ให้คืนใบเดิม ──
  const existing = (await sbSelect(
    `payments?select=*&order_id=eq.${order.id}&status=in.(CREATED,PENDING)&order=created_at.desc&limit=1`))[0];

  if (existing) {
    // เช็กกับ Beam ว่ายังใช้ได้จริงไหม
    const remote = existing.provider_payment_link_id
      ? await beamGetPayment(existing.provider_payment_link_id) : null;
    let st = remote && remote.status;

    // QR หมดอายุแล้วต้องออกใบใหม่ ถึงแม้ Beam จะยังบอกว่า charge รออยู่
    const qrExp = existing.provider_payload && existing.provider_payload.qr
      && existing.provider_payload.qr.expiry;
    if (st !== 'PAID' && qrExp && Date.parse(qrExp) < Date.now()) st = 'EXPIRED';

    if (st === 'PAID') return { payment: existing, alreadyPaid: true };
    if (!st || st === 'ACTIVE') return { payment: existing, reused: true };

    // หมดอายุ / ถูกยกเลิก → ปิดใบเดิมแล้วออกใหม่
    await sbUpdate('payments', { id: existing.id },
      { status: st === 'EXPIRED' ? 'EXPIRED' : 'FAILED', updated_at: nowISO() });
  }

  const payPageUrl = `${APP_BASE_URL}/pay.html?o=${encodeURIComponent(order.order_number)}`;

  const link = BEAM_PAYMENT_MODE === 'charge'
    ? await beamCreateCharge({
      orderNumber: order.order_number,
      amountMinor: order.amount,
      currency: order.currency,
      returnUrl: payPageUrl,
    })
    : await beamCreatePaymentLink({
      orderNumber: order.order_number,
      amountMinor: order.amount,
      currency: order.currency,
      description: product.name,
      redirectUrl: `${APP_BASE_URL}/purchase-success.html?o=${encodeURIComponent(order.order_number)}`,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });

  if (link.error) {
    await logEvent('PAYMENT_FAILED', {
      orderId: order.id, orderNumber: order.order_number, level: 'error',
      data: { reason: link.error, mode: BEAM_PAYMENT_MODE, detail: link.detail },
    });
    return { error: link.error };     // ← ไม่ทำลาย order · เรียกซ้ำได้
  }

  // โหมด charge: ลูกค้าอยู่บนหน้าเว็บเราเอง (สแกน QR) ไม่ได้ออกไปหน้า Beam
  const payment = await sbInsert('payments', {
    order_id: order.id,
    provider: 'beam',
    provider_payment_id: BEAM_PAYMENT_MODE === 'charge' ? link.id : null,
    provider_payment_link_id: link.id,
    provider_reference: order.order_number,
    status: 'PENDING',
    amount: order.amount,
    currency: order.currency,
    payment_url: BEAM_PAYMENT_MODE === 'charge' ? payPageUrl : link.url,
    provider_payload: BEAM_PAYMENT_MODE === 'charge'
      ? { mode: 'charge', chargeId: link.id, qr: link.qr }
      : (link.raw || null),
  });

  if (!payment || payment.error) {
    // แข่งกันสร้างพร้อมกัน → unique index กันไว้แล้ว ให้ดึงใบที่ชนะมาใช้
    const winner = (await sbSelect(
      `payments?select=*&order_id=eq.${order.id}&status=in.(CREATED,PENDING)&limit=1`))[0];
    if (winner) return { payment: winner, reused: true };
    return { error: 'payment_insert_failed' };
  }

  await logEvent('PAYMENT_CREATED', {
    orderId: order.id, orderNumber: order.order_number,
    data: { mode: BEAM_PAYMENT_MODE, provider_id: link.id,
      amount: order.amount, currency: order.currency },
  });

  return { payment };
}

/* ══════════ DELIVERY ══════════ */
async function createDelivery(order, product) {
  const existing = await getDelivery(order.id);
  if (existing) return { delivery: existing, reused: true };

  const token = randomToken(32);
  const ttlHours = product.download_ttl_hours || 720;

  const delivery = await sbInsert('deliveries', {
    order_id: order.id,
    product_code: product.product_code,
    product_version: order.product_version || product.current_version,
    delivery_status: 'READY',
    download_token_hash: sha256(token),
    download_expires_at: new Date(Date.now() + ttlHours * 3600 * 1000).toISOString(),
    max_downloads: product.max_downloads || 5,
    delivered_at: nowISO(),
  });

  if (!delivery || delivery.error) {
    const winner = await getDelivery(order.id);
    if (winner) return { delivery: winner, reused: true };   // อีก request ชนะไปแล้ว
    return { error: 'delivery_insert_failed' };
  }

  await sbUpdate('orders', { id: order.id }, { status: 'DELIVERED', updated_at: nowISO() });

  await logEvent('DELIVERY_CREATED', {
    orderId: order.id, orderNumber: order.order_number,
    data: { product_code: product.product_code, version: delivery.product_version },
  });

  return { delivery, token };
}

const downloadUrl = token => `${APP_BASE_URL}${DOWNLOAD_PATH}/${token}`;

/* ══════════ HTTP helpers ══════════ */
function json(res, code, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json(body);
}
const badRequest = (res, error, message) => json(res, 400, { error, message: message || null });

/** อ่าน raw body สำหรับตรวจลายเซ็น — Vercel parse body ให้แล้ว จึงต้องรองรับหลายรูปแบบ */
function rawBodyOf(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  return JSON.stringify(req.body ?? {});
}

/** ดึงค่าจาก payload หลายรูปแบบ (Beam ปรับ schema ได้) */
function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

module.exports = {
  // config
  SB, BEAM_BASE, BEAM_ENV, BEAM_AMOUNT_UNIT, APP_BASE_URL, DOWNLOAD_PATH,
  beamConfigured,
  // utils
  nowISO, sha256, randomToken, isUuid, timingSafeEqualStr, redact, pick, clean,
  toBeamAmount, fromBeamAmount,
  // db
  sbSelect, sbInsert, sbUpdate, sbRpc,
  // domain
  getProduct, createOrder, findOrder, latestPayment, getDelivery,
  createPayment, createDelivery, downloadUrl,
  // beam
  beamCreatePaymentLink, beamGetPaymentLink, beamVerifySignature, beamAuthHeader,
  beamCreateCharge, beamGetCharge, beamGetPayment, BEAM_PAYMENT_MODE,
  // http
  json, badRequest, rawBodyOf, logEvent,
};
