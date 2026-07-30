// verify-payment-intent.js
// SignDee — Level B: ตรวจสถานะ PaymentIntent ฝั่ง server กับ Stripe โดยตรง (source of truth)
// ถ้า succeeded + ยอดตรง + contract ตรง เท่านั้น → เขียน payment_completed ลง Supabase ผ่าน service_role
// (anon เขียน column นี้ไม่ได้ เพราะมี trigger protect_payment_columns กันไว้)
// วางไว้ที่ D:\justsign-api\api\verify-payment-intent.js
//
// ENV ที่ต้องตั้งใน Vercel (ใช้ตัวเดียวกับ verify-charge เดิมได้เลยถ้ามีอยู่แล้ว):
//   STRIPE_SECRET_KEY
//   SUPABASE_URL                  เช่น https://xxxx.supabase.co  (มีอยู่แล้ว)
//   SUPABASE_SERVICE_KEY          service_role key (ไม่ใช่ anon!)  (มีอยู่แล้ว)

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const EXPECTED_AMOUNT = 79000; // ฿790 — กันการยิง PI ที่ยอดไม่ตรง
// ⚠️ ปรับให้ตรง schema จริง: ชื่อคอลัมน์ primary key ของตาราง contracts
const ID_COLUMN = 'id';


/* ══════════ Beam Gateway verify ══════════ */
const BEAM_MERCHANT_ID = process.env.BEAM_MERCHANT_ID;
const BEAM_API_KEY     = process.env.BEAM_API_KEY;
const BEAM_BASE = (process.env.BEAM_ENV === 'production')
  ? 'https://api.beamcheckout.com'
  : 'https://playground.api.beamcheckout.com';

// ดึงสถานะ charge จาก Beam โดยตรง (ไม่เชื่อ client)
async function verifyBeamCharge(chargeId, contractId) {
  if (!BEAM_MERCHANT_ID || !BEAM_API_KEY) return { ok:false, reason:'missing_beam_env' };
  const auth = Buffer.from(`${BEAM_MERCHANT_ID}:${BEAM_API_KEY}`).toString('base64');
  const r = await fetch(`${BEAM_BASE}/api/v1/charges/${encodeURIComponent(chargeId)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok:false, reason:'beam_error', status:r.status, detail:j };

  const status = String(j.status || '').toUpperCase();
  if (status !== 'SUCCEEDED') return { ok:false, reason:'not_succeeded', status };

  // ตรวจยอด + สัญญา (ถ้า Beam ส่งกลับมา)
  if (j.amount != null && Number(j.amount) !== EXPECTED_AMOUNT) return { ok:false, reason:'amount_mismatch', status };
  if (j.currency && String(j.currency).toUpperCase() !== 'THB') return { ok:false, reason:'currency_mismatch', status };
  if (j.referenceId && String(j.referenceId) !== String(contractId)) return { ok:false, reason:'contract_mismatch', status };

  return { ok:true, status, ref: j.chargeId || chargeId };
}


/* ══════════ Beam Webhook (charge.succeeded) ══════════
   ไม่เพิ่ม serverless function — ใช้ endpoint นี้รับ webhook ด้วย
   Beam ส่ง header: x-beam-event, x-beam-signature (HMAC-SHA256 base64)
   ⚠️ ไม่เชื่อ payload → เอา chargeId ไปถามสถานะกับ Beam โดยตรง (กันปลอม webhook)
   ENV เสริม: BEAM_WEBHOOK_HMAC_KEY (base64 จาก Lighthouse) — ถ้าตั้งไว้จะตรวจลายเซ็นด้วย
*/
const crypto = require('crypto');
const BEAM_WEBHOOK_HMAC_KEY = process.env.BEAM_WEBHOOK_HMAC_KEY;

function beamSignatureOk(rawBody, headerSig) {
  if (!BEAM_WEBHOOK_HMAC_KEY || !headerSig || !rawBody) return null;   // null = ตรวจไม่ได้ (ไม่ถือว่าผิด)
  try {
    const key = Buffer.from(BEAM_WEBHOOK_HMAC_KEY, 'base64');
    const mac = crypto.createHmac('sha256', key).update(rawBody).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(headerSig)));
  } catch (e) { return null; }
}

// map product → ตาราง + คอลัมน์ ref
function _productTarget(product) {
  if (product === 'sale') return { table: 'sale_contracts', refCol: 'payment_intent_id' };
  if (product === 'nda')  return { table: 'nda_contracts',  refCol: 'payment_ref' };
  if (product === 'emp')  return { table: 'emp_contracts',  refCol: 'payment_ref' };
  return { table: 'contracts', refCol: 'payment_ref' };
}

// เขียน payment_completed ให้สัญญา (หาว่าอยู่ตาราง contracts / sale_contracts / nda_contracts)
async function markPaidByContractId(contractId, chargeId) {
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const targets = [
    { table: 'contracts',      refCol: 'payment_ref' },
    { table: 'sale_contracts', refCol: 'payment_intent_id' },
    { table: 'nda_contracts',  refCol: 'payment_ref' },
    { table: 'emp_contracts',  refCol: 'payment_ref' },
  ];
  for (const t of targets) {
    const patch = { payment_completed: true };
    patch[t.refCol] = chargeId;
    if (t.table === 'emp_contracts') { patch.paid_at = new Date().toISOString(); patch.status = 'paid'; }
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/${t.table}?${ID_COLUMN}=eq.${encodeURIComponent(contractId)}`,
      { method: 'PATCH', headers: sbHeaders, body: JSON.stringify(patch) }
    );
    if (!r.ok) continue;
    const rows = await r.json().catch(() => []);
    if (Array.isArray(rows) && rows.length) return { ok: true, table: t.table };
  }
  return { ok: false, error: 'contract_not_found' };
}

async function handleBeamWebhook(req, res) {
  const event = String(req.headers['x-beam-event'] || '');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // ตรวจลายเซ็น (best-effort — ไม่ใช่ตัวตัดสิน เพราะเรายืนยันกับ Beam อีกชั้น)
  try {
    const sigOk = beamSignatureOk(JSON.stringify(body), req.headers['x-beam-signature']);
    if (sigOk === false) console.warn('[beam-webhook] signature mismatch (จะยืนยันกับ Beam โดยตรงแทน)');
  } catch (e) {}

  // สนใจเฉพาะ charge สำเร็จ
  if (event && event !== 'charge.succeeded') return res.status(200).json({ ok: true, ignored: event });

  const chargeId   = body.chargeId;
  const contractId = body.referenceId;
  if (!chargeId || !contractId) return res.status(200).json({ ok: true, skipped: 'missing_ids' });

  // 🔒 ยืนยันกับ Beam โดยตรง — ไม่เชื่อ payload
  const v = await verifyBeamCharge(chargeId, contractId);
  if (!v.ok) {
    console.warn('[beam-webhook] verify failed:', v.reason, chargeId);
    return res.status(200).json({ ok: true, paid: false, reason: v.reason });   // 200 กัน Beam retry ซ้ำ
  }

  const w = await markPaidByContractId(contractId, v.ref);
  console.log('[beam-webhook] paid:', contractId, w);
  return res.status(200).json({ ok: true, paid: true, ...w });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Beam webhook (charge.succeeded) — ไม่ต้องเพิ่ม function ──
  if (req.method === 'POST' && req.headers['x-beam-event']) {
    try { return await handleBeamWebhook(req, res); }
    catch (e) { console.error('[beam-webhook]', e.message); return res.status(200).json({ ok: false }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const piId = body.payment_intent_id;
    const contractId = body.contract_id;
    const gateway = body.gateway || process.env.PAYMENT_GATEWAY || 'stripe';

    if (!piId || !contractId)
      return res.status(400).json({ error: 'payment_intent_id and contract_id are required' });

    // ── Beam: ตรวจสถานะกับ Beam แล้วเขียน payment_completed ผ่าน service_role ──
    if (gateway === 'beam') {
      const v = await verifyBeamCharge(piId, contractId);
      if (!v.ok) return res.status(200).json({ paid:false, status:v.status || null, reason:v.reason });

      const { table, refCol } = _productTarget(body.product);
      const patch  = { payment_completed: true };
      patch[refCol] = v.ref;
      if (table === 'emp_contracts') { patch.paid_at = new Date().toISOString(); patch.status = 'paid'; }
      const w = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${ID_COLUMN}=eq.${encodeURIComponent(contractId)}`,
        { method:'PATCH',
          headers:{ apikey:SUPABASE_SERVICE_KEY, Authorization:`Bearer ${SUPABASE_SERVICE_KEY}`,
                    'Content-Type':'application/json', Prefer:'return=representation' },
          body: JSON.stringify(patch) }
      );
      if (!w.ok) return res.status(500).json({ error:'Supabase write failed', detail: await w.text() });
      return res.status(200).json({ paid:true, status:'succeeded', payment_ref:v.ref, gateway:'beam' });
    }

    // 1) ดึง PaymentIntent จาก Stripe โดยตรง — ไม่เชื่อสถานะที่ client ส่งมา
    const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}`, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    });
    const pi = await piRes.json();
    if (!piRes.ok)
      return res.status(piRes.status).json({ error: pi.error?.message || 'Stripe error' });

    // 2) ตรวจเงื่อนไขครบ: succeeded + ยอดตรง + สกุลตรง + contract ตรง (จาก metadata)
    let reason = null;
    if (pi.status !== 'succeeded') reason = 'not_succeeded';
    else if (pi.amount !== EXPECTED_AMOUNT) reason = 'amount_mismatch';
    else if (pi.currency !== 'thb') reason = 'currency_mismatch';
    else if (pi.metadata?.contract_id !== contractId) reason = 'contract_mismatch';

    if (reason) {
      return res.status(200).json({ paid: false, status: pi.status, reason });
    }

    // 3) ผ่านหมด → เขียน payment_completed ผ่าน service_role (ข้าม trigger ได้เฉพาะ service_role)
    // เลือกตารางตาม product: sale → sale_contracts (คอลัมน์ payment_intent_id), อื่นๆ → contracts (payment_ref)
    const { table, refCol } = _productTarget(body.product);
    const patchBody = { payment_completed: true };
    patchBody[refCol] = pi.id;
    if (table === 'emp_contracts') { patchBody.paid_at = new Date().toISOString(); patchBody.status = 'paid'; }
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${ID_COLUMN}=eq.${encodeURIComponent(contractId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patchBody),
      }
    );

    if (!patchRes.ok) {
      const detail = await patchRes.text();
      return res.status(500).json({ error: 'Supabase write failed', detail });
    }

    return res.status(200).json({ paid: true, status: 'succeeded', payment_ref: pi.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
