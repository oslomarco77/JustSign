// create-payment-intent.js
// SignDee — สร้าง + confirm Stripe PaymentIntent (PromptPay) แล้วคืน QR ให้ frontend render เอง
// ใช้ raw fetch (ไม่ใช้ stripe npm SDK) เพื่อให้เข้ากับ Vercel project ที่ไม่มี package.json
// วางไว้ที่ D:\justsign-api\api\create-payment-intent.js
//
// ENV ที่ต้องตั้งใน Vercel:
//   STRIPE_SECRET_KEY  =  sk_test_... (ตอนทดสอบ)  /  sk_live_... (ตอนขึ้นจริง)
//   *** อย่าฮาร์ดโค้ด key ลงไฟล์ — ใส่ใน Vercel Environment Variables เท่านั้น ***

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_SATANG = 79000; // ฿790 = 79,000 สตางค์ (Stripe คิด THB เป็นหน่วยสตางค์ = ×100)

/* ราคาต่อผลิตภัณฑ์ (สตางค์) — ต้องตรงกับ PRODUCT_MAP ใน verify-payment-intent.js
   ⚠️ เพิ่มผลิตภัณฑ์ใหม่ต้องเพิ่มทั้ง 2 ไฟล์เสมอ */
const PRICE_BY_PRODUCT = {
  rental: 79000,    // ฿790
  sale:   79000,    // ฿790
  notice: 299000,   // ฿2,990 — ทวงถาม/บอกเลิกสัญญาเช่า (ครอบทั้ง 3 ฉบับ)
  nda:    79000,    // ฿790 — สัญญารักษาความลับ
  emp:    79000,    // ฿790 — สัญญาจ้างงาน
};
function priceOf(product){ return PRICE_BY_PRODUCT[product] || PRICE_SATANG; }
/* ══════════ DEV skip (ทดสอบบน production โดยไม่ต้องจ่ายจริง) ══════════
   เรียกด้วย { action:'dev_skip', product|kind, contract_id, secret }
   ปลดล็อกได้ก็ต่อเมื่อ secret ตรงกับ ENV: DEV_SKIP_SECRET
   ⚠️ ถ้าไม่ตั้ง DEV_SKIP_SECRET ไว้ = ปิดสนิท (ปลอดภัยโดย default)
*/
const DEV_SKIP_SECRET = process.env.DEV_SKIP_SECRET;
const SUPABASE_URL_ENV = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY_ENV = process.env.SUPABASE_SERVICE_KEY;
const DEV_TABLE = {
  rental: { table:'contracts',      refCol:'payment_ref' },
  sale:   { table:'sale_contracts', refCol:'payment_intent_id' },
  notice: { table:'notice_cases',   refCol:'payment_ref' },
  nda:    { table:'nda_contracts',  refCol:'payment_ref' },
  emp:    { table:'emp_contracts',  refCol:'payment_ref' },
};
function timingSafeEq(a, b){
  const A = String(a||''), B = String(b||'');
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i=0;i<A.length;i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}
async function handleDevSkip(body, res){
  if (!DEV_SKIP_SECRET) return res.status(403).json({ ok:false, error:'dev_skip_disabled' });
  if (!timingSafeEq(body.secret, DEV_SKIP_SECRET))
    return res.status(403).json({ ok:false, error:'bad_secret' });

  const contractId = body.contract_id;
  if (!contractId) return res.status(400).json({ ok:false, error:'contract_id required' });
  if (!SUPABASE_URL_ENV || !SUPABASE_SERVICE_KEY_ENV)
    return res.status(500).json({ ok:false, error:'missing_supabase_env' });

  const key = body.product || body.kind || 'rental';
  const cfg = DEV_TABLE[key] || DEV_TABLE.rental;
  const patch = { payment_completed: true };
  patch[cfg.refCol] = 'DEV_SKIP_' + Date.now();
  if (cfg.table === 'notice_cases') {
    patch.payment_provider = 'dev_skip';
    patch.paid_at = new Date().toISOString();
    patch.status  = 'demand_ready';
  }
  if (cfg.table === 'nda_contracts' || cfg.table === 'emp_contracts') {
    patch.paid_at = new Date().toISOString();
    patch.status  = 'paid';
  }
  const r = await fetch(
    `${SUPABASE_URL_ENV}/rest/v1/${cfg.table}?id=eq.${encodeURIComponent(contractId)}`,
    { method:'PATCH',
      headers:{ apikey:SUPABASE_SERVICE_KEY_ENV, Authorization:`Bearer ${SUPABASE_SERVICE_KEY_ENV}`,
                'Content-Type':'application/json', Prefer:'return=representation' },
      body: JSON.stringify(patch) });
  if (!r.ok) return res.status(500).json({ ok:false, error:'supabase_write_failed', detail: await r.text() });
  const rows = await r.json().catch(()=>[]);
  if (!Array.isArray(rows) || !rows.length)
    return res.status(404).json({ ok:false, error:'contract_not_found', table: cfg.table });
  return res.status(200).json({ ok:true, dev:true, table: cfg.table });
}

function returnUrlOf(product){
  if (product === 'sale')   return 'https://sale.signdee.com/';
  if (product === 'notice') return 'https://app.signdee.com/index-notice.html';
  if (product === 'nda')    return 'https://nda.signdee.com/';
  if (product === 'emp')    return 'https://app.signdee.com/index-emp.html';
  return 'https://app.signdee.com/';
}

// แปลง object → x-www-form-urlencoded รองรับ key แบบ Stripe (a[b]=c, a[]=c)
function toForm(obj, prefix, form) {
  form = form || new URLSearchParams();
  for (const key in obj) {
    const val = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      val.forEach((v) => form.append(`${k}[]`, v));
    } else if (typeof val === 'object') {
      toForm(val, k, form);
    } else {
      form.append(k, String(val));
    }
  }
  return form;
}


/* ══════════ Beam Gateway (QR PromptPay) ══════════
   docs: https://docs.beamcheckout.com/charges/charges-api
   ENV: BEAM_MERCHANT_ID, BEAM_API_KEY, BEAM_ENV (playground|production)
*/
const BEAM_MERCHANT_ID = process.env.BEAM_MERCHANT_ID;
const BEAM_API_KEY     = process.env.BEAM_API_KEY;
const BEAM_BASE = (process.env.BEAM_ENV === 'production')
  ? 'https://api.beamcheckout.com'
  : 'https://playground.api.beamcheckout.com';

async function createBeamCharge(contractId, product) {
  if (!BEAM_MERCHANT_ID || !BEAM_API_KEY) {
    return { error: 'Missing BEAM_MERCHANT_ID / BEAM_API_KEY' };
  }
  const auth = Buffer.from(`${BEAM_MERCHANT_ID}:${BEAM_API_KEY}`).toString('base64');
  const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); // QR อายุ 15 นาที

  const r = await fetch(`${BEAM_BASE}/api/v1/charges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount: priceOf(product),             // สตางค์ (฿790 = 79000 · ฿2,990 = 299000)
      currency: 'THB',
      paymentMethod: {
        qrPromptPay: { expiryTime: expiry },
        paymentMethodType: 'QR_PROMPT_PAY',
      },
      referenceId: String(contractId),      // ผูกกับสัญญา — ใช้ตรวจตอน verify
      returnUrl: returnUrlOf(product),
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: (j && (j.message || j.error)) || `Beam error ${r.status}`, detail: j };

  if (j.actionRequired !== 'ENCODED_IMAGE' || !j.encodedImage || !j.encodedImage.imageBase64Encoded) {
    return { error: 'Beam ไม่ได้ส่ง QR กลับมา', detail: j };
  }
  return {
    gateway: 'beam',
    charge_id: j.chargeId,
    qr_image_png: 'data:image/png;base64,' + j.encodedImage.imageBase64Encoded,
    qr_raw: j.encodedImage.rawData || null,
    expiry: j.encodedImage.expiry || expiry,
    amount: priceOf(product),
    currency: 'thb',
  };
}

/* ══════════════════════════════════════════════════════════════════════
   STRIPE CONNECT — มัดจำผ่านบัตรเครดิต (DIRECT charge, Platform model)
   Marketplace ไม่รองรับในไทย → ใช้ Platform (direct charge) เงินเข้าผู้ขายตรง
   SignDee ไม่ถือเงิน · charge เกิดบนบัญชีผู้ขาย (Stripe-Account header)
   เสียบผ่าน action ใน endpoint เดิม (Vercel เต็ม 12 function)
   ทางที่ 3: ผู้ซื้อจ่าย A, ผู้ขายได้ D เต็ม, SignDee net 1.5%
   controller: losses.payments='stripe' (TH บังคับ — ผู้ขายรับผิด losses) · fees.payer='application' (platform จ่าย Stripe fee แล้วหักคืนจาก application_fee)
   ══════════════════════════════════════════════════════════════════════ */
const SB_URL  = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CARD_RATE = 0.0365, CARD_FIXED = 1000, SIGNDEE_RATE = 0.015;   // บัตรในประเทศ 3.65%+฿10 · SignDee 1.5%

function _sbHeaders() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
}
async function sbSelect(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: _sbHeaders() });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sbUpsert(table, row, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ..._sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j[0] : j;
}
async function sbPatch(table, match, patch) {
  const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH', headers: { ..._sbHeaders(), Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j[0] : j;
}

// เรียก Stripe API แบบ form-encoded (รองรับ Stripe-Account header สำหรับ Connect)
async function stripeReq(method, path, params, opts) {
  const headers = { Authorization: `Bearer ${STRIPE_SECRET_KEY}` };
  if (opts && opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
  let url = 'https://api.stripe.com' + path, body;
  if (method === 'GET') {
    if (params) url += '?' + toForm(params).toString();
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = params ? toForm(params).toString() : '';
    if (opts && opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey);
  }
  const r = await fetch(url, { method, headers, body });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: j };
}

// คำนวณยอดที่ผู้ซื้อจ่าย (ทางที่ 3) — ทุกอย่างเป็นสตางค์
function depositMath(depositSatang) {
  const D = Math.round(depositSatang);
  const A = Math.round((D * (1 + SIGNDEE_RATE) + CARD_FIXED) / (1 - CARD_RATE));
  return { buyerPays: A, sellerGets: D, applicationFee: A - D };
}

// ── action: connect_onboard — สร้าง Express account (ถ้ายังไม่มี) + Account Link ──
async function handleConnectOnboard(body, res) {
  const uid = body.member_uid;
  if (!uid) return res.status(400).json({ error: 'member_uid required' });
  let rows = await sbSelect(`sd_connect_accounts?member_uid=eq.${encodeURIComponent(uid)}&select=*&limit=1`);
  let acct = rows[0];
  let acctId = acct && acct.stripe_account_id;

  if (!acctId) {
    const cr = await stripeReq('POST', '/v1/accounts', {
      country: 'TH',
      email: body.email || undefined,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },   // Stripe บังคับ card_payments ต้องมี transfers คู่กัน
      business_type: 'individual',
      // TH: platform ห้ามรับผิด losses → ตั้ง controller ให้ผู้ขายรับผิดเอง (losses.payments='stripe')
      // fees.payer='application' = platform จ่าย Stripe fee แล้วหักคืนผ่าน application_fee (ทางที่ 3)
      // TH: express บังคับ platform คุม losses (ขัดกับกฎไทย) → ใช้ dashboard 'none'
      //  losses.payments='stripe' = ผู้ขายรับผิด · requirement_collection='stripe' = Stripe โฮสต์ onboarding/KYC
      controller: {
        fees: { payer: 'application' },
        losses: { payments: 'stripe' },
        requirement_collection: 'stripe',
        stripe_dashboard: { type: 'none' },
      },
    });
    if (!cr.ok) return res.status(502).json({ error: cr.data.error?.message || 'stripe account create failed' });
    acctId = cr.data.id;
    await sbUpsert('sd_connect_accounts', {
      member_uid: uid, email: body.email || null, line_user_id: body.line_user_id || null,
      stripe_account_id: acctId, updated_at: new Date().toISOString(),
    }, 'member_uid');
  }

  const link = await stripeReq('POST', '/v1/account_links', {
    account: acctId,
    refresh_url: body.refresh_url || 'https://sale.signdee.com/?connect=refresh',
    return_url:  body.return_url  || 'https://sale.signdee.com/?connect=done',
    type: 'account_onboarding',
  });
  if (!link.ok) return res.status(502).json({ error: link.data.error?.message || 'account_link failed' });
  return res.status(200).json({ url: link.data.url, stripe_account_id: acctId });
}

// ── action: connect_status — เช็คสถานะบัญชี + ซิงก์ลง DB ──
async function handleConnectStatus(body, res) {
  const uid = body.member_uid;
  if (!uid) return res.status(400).json({ error: 'member_uid required' });
  const rows = await sbSelect(`sd_connect_accounts?member_uid=eq.${encodeURIComponent(uid)}&select=*&limit=1`);
  const acct = rows[0];
  if (!acct || !acct.stripe_account_id) return res.status(200).json({ connected: false });

  const a = await stripeReq('GET', '/v1/accounts/' + acct.stripe_account_id);
  if (!a.ok) return res.status(200).json({ connected: true, stripe_account_id: acct.stripe_account_id, charges_enabled: false });
  const d = a.data;
  await sbPatch('sd_connect_accounts', { member_uid: uid }, {
    charges_enabled: !!d.charges_enabled, payouts_enabled: !!d.payouts_enabled,
    details_submitted: !!d.details_submitted,
    requirements_due: (d.requirements && d.requirements.currently_due) || [],
    updated_at: new Date().toISOString(),
  });
  return res.status(200).json({
    connected: true, stripe_account_id: acct.stripe_account_id,
    charges_enabled: !!d.charges_enabled, payouts_enabled: !!d.payouts_enabled,
    details_submitted: !!d.details_submitted,
    requirements_due: (d.requirements && d.requirements.currently_due) || [],
  });
}

// ── action: create_deposit — Checkout Session (บัตร) destination charge เข้าบัญชีผู้ขาย ──
async function handleCreateDeposit(body, res) {
  const contractId = body.contract_id;
  if (!contractId) return res.status(400).json({ error: 'contract_id required' });
  const rows = await sbSelect(`sale_contracts?id=eq.${encodeURIComponent(contractId)}&select=id,deposit_amt,deposit_stripe_account,condo_name,unit_no&limit=1`);
  const c = rows[0];
  if (!c) return res.status(404).json({ error: 'contract not found' });
  const sellerAcct = body.stripe_account || c.deposit_stripe_account;
  if (!sellerAcct) return res.status(400).json({ error: 'ผู้ขายยังไม่ได้เปิดรับชำระด้วยบัตร' });
  const depositSatang = Math.round(Number(c.deposit_amt || 0) * 100);
  if (depositSatang < 2000) return res.status(400).json({ error: 'ยอดมัดจำต่ำเกินไป' });

  const m = depositMath(depositSatang);
  const base = body.return_base || 'https://sale.signdee.com/';
  const sep = base.includes('?') ? '&' : '?';
  const sess = await stripeReq('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    'line_items[0][price_data][currency]': 'thb',
    'line_items[0][price_data][product_data][name]': 'เงินมัดจำ ' + (c.condo_name || 'ห้องชุด') + (c.unit_no ? ' ห้อง ' + c.unit_no : ''),
    'line_items[0][price_data][unit_amount]': String(m.buyerPays),
    'line_items[0][quantity]': '1',
    'payment_intent_data[application_fee_amount]': String(m.applicationFee),
    'payment_intent_data[metadata][contract_id]': contractId,
    'payment_intent_data[metadata][kind]': 'sale_deposit',
    success_url: base + sep + 'deposit_session={CHECKOUT_SESSION_ID}',
    cancel_url:  base + sep + 'deposit_cancel=1',
  }, { stripeAccount: sellerAcct });   // direct charge: charge เกิดบนบัญชีผู้ขาย (Platform model — ไทยรองรับแบบนี้)
  if (!sess.ok) return res.status(502).json({ error: sess.data.error?.message || 'checkout session failed' });
  return res.status(200).json({
    checkout_url: sess.data.url, session_id: sess.data.id,
    buyer_pays: m.buyerPays, seller_gets: m.sellerGets, fee: m.buyerPays - m.sellerGets,
  });
}

// ── action: verify_deposit — ยืนยัน Checkout Session แล้วเขียน deposit_paid ──
async function handleVerifyDeposit(body, res) {
  const contractId = body.contract_id, sessionId = body.session_id;
  if (!contractId || !sessionId) return res.status(400).json({ error: 'contract_id + session_id required' });
  const crow = (await sbSelect(`sale_contracts?id=eq.${encodeURIComponent(contractId)}&select=deposit_stripe_account&limit=1`))[0];
  const sellerAcct = (crow && crow.deposit_stripe_account) || body.stripe_account;
  const s = await stripeReq('GET', '/v1/checkout/sessions/' + encodeURIComponent(sessionId), null, sellerAcct ? { stripeAccount: sellerAcct } : undefined);
  if (!s.ok) return res.status(502).json({ error: 'session lookup failed' });
  const paid = s.data.payment_status === 'paid';
  if (!paid) return res.status(200).json({ paid: false, status: s.data.payment_status });
  const patch = {
    deposit_pay_via: 'card',
    deposit_paid_at: new Date().toISOString(),
    deposit_amount_paid: s.data.amount_total,
    deposit_charge_id: s.data.payment_intent || sessionId,
    deposit_payout_status: 'pending',
  };
  await sbPatch('sale_contracts', { id: contractId }, patch);
  return res.status(200).json({ paid: true, amount_total: s.data.amount_total });
}

module.exports = async (req, res) => {
  // --- CORS (ปรับ '*' เป็นโดเมน signdee จริงได้ทีหลังเพื่อความปลอดภัย) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // (เช็ค STRIPE_SECRET_KEY เฉพาะตอนใช้ Stripe — gateway beam ไม่ต้องใช้)

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    /* ⚠️ ห้ามย้ายการตรวจ STRIPE_SECRET_KEY ขึ้นไปไว้ต้น handler
       เดิมตรวจตั้งแต่ต้นทำให้คำขอที่ใช้ Beam (QR PromptPay) ถูกบล็อกไปด้วย
       ทั้งที่ไม่ได้แตะ Stripe เลย → สร้าง QR ไม่ได้ทั้งระบบ
       ตรวจเฉพาะ action ของ Stripe Connect (มัดจำผ่านบัตร) ที่ใช้ key จริง */
    const _stripeOnlyActions = ['connect_onboard', 'connect_status', 'create_deposit', 'verify_deposit'];
    if (_stripeOnlyActions.indexOf(body.action) !== -1 && !STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });
    }

    // ── Stripe Connect (มัดจำผ่านบัตร) — จาก origin/main ──
    if (body.action === 'connect_onboard') return await handleConnectOnboard(body, res);
    if (body.action === 'connect_status')  return await handleConnectStatus(body, res);
    if (body.action === 'create_deposit')  return await handleCreateDeposit(body, res);
    if (body.action === 'verify_deposit')  return await handleVerifyDeposit(body, res);

    // ── DEV skip (ต้องมี secret ตรงกับ ENV) ──
    if (body.action === 'dev_skip') return await handleDevSkip(body, res);

    const contractId = body.contract_id;
    // PromptPay บังคับต้องมี email (Stripe ใช้ส่งคำขอเลขบัญชีตอน refund)
    // frontend ควรส่ง email ผู้จ่าย (เจ้าของบ้าน) มา — ถ้าไม่มี fallback ไปที่ support
    const email = body.email || 'support@signdee.com';

    if (!contractId) return res.status(400).json({ error: 'contract_id is required' });

    // ── เลือก gateway: 'beam' → QR PromptPay ผ่าน Beam · ไม่ระบุ → Stripe (เดิม) ──
    const gateway = body.gateway || process.env.PAYMENT_GATEWAY || 'stripe';
    if (gateway === 'beam') {
      const out = await createBeamCharge(contractId, body.product);
      if (out.error) return res.status(502).json(out);
      return res.status(200).json(out);
    }

    if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });

    const params = toForm({
      amount: priceOf(body.product),
      currency: 'thb',
      payment_method_types: ['promptpay'],
      payment_method_data: { type: 'promptpay', billing_details: { email } },
      confirm: 'true',
      receipt_email: email,
      metadata: { contract_id: contractId, product:
        (body.product === 'sale'   ? 'SignDee sale-purchase contract' :
         body.product === 'notice' ? 'SignDee notice (rent demand/termination)' :
         body.product === 'nda'    ? 'SignDee NDA (non-disclosure agreement)' :
         body.product === 'emp'    ? 'SignDee employment contract' :
                                     'SignDee rental contract') },
    });

    const headers = {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // ถ้า frontend ส่ง idempotency_key มา จะกันการสร้าง PI ซ้ำจากการกดรัว ๆ
    // (อย่าใช้ค่าเดิมตลอดถ้าต้องการ QR ใหม่ตอนของเดิมหมดอายุ — ส่งค่าใหม่มาแทน)
    if (body.idempotency_key) headers['Idempotency-Key'] = String(body.idempotency_key);

    const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers,
      body: params.toString(),
    });

    const pi = await stripeRes.json();
    if (!stripeRes.ok) {
      return res.status(stripeRes.status).json({
        error: pi.error?.message || 'Stripe error',
        code: pi.error?.code || null,
      });
    }

    const qr = pi.next_action?.promptpay_display_qr_code || {};
    return res.status(200).json({
      payment_intent_id: pi.id,
      client_secret: pi.client_secret,
      status: pi.status, // ปกติ = 'requires_action' (รอลูกค้าสแกนจ่าย)
      qr_image_png: qr.image_url_png || null, // ใช้อันนี้ใส่ <img src> ได้เลย
      qr_image_svg: qr.image_url_svg || null,
      qr_data: qr.data || null, // string ดิบของ QR (เผื่ออยาก gen QR เองด้วย lib)
      amount: pi.amount,
      currency: pi.currency,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
