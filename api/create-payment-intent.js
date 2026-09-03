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
