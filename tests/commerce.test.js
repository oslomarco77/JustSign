// ============================================================
//  SignDee Commerce Core — Phase 1 tests
//  รัน: node --test tests/
//  ไม่ยิง Beam จริง ไม่แตะ Supabase จริง
// ============================================================
'use strict';

const H = require('./harness.js');

// ── env ต้องตั้งก่อน require โมดูล เพราะอ่าน env ตอน load ──
process.env.SUPABASE_URL = H.SB;
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.BEAM_MERCHANT_ID = 'test-merchant';
process.env.BEAM_API_KEY = 'test-key';
process.env.BEAM_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.BEAM_ENV = 'playground';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.APP_BASE_URL = 'https://signdee.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../api/_commerce.js');
const createOrderHandler = require('../api/commerce/orders/index.js');
const paymentHandler = require('../api/commerce/orders/[id]/payment.js');
const statusHandler = require('../api/commerce/orders/[id]/status.js');
const webhookHandler = require('../api/webhooks/beam.js');
const downloadHandler = require('../api/download/[token].js');
const adminHandler = require('../api/commerce/admin/orders.js');

let db, beam;
function reset() {
  db = H.newDb();
  beam = H.newBeam();
  H.install({ db, beam });
}

/* ── helper: ทำงานได้ทั้งโหมด charge (QR) และ link ── */
function markPaid(id) {
  const c = beam.charges[id];
  if (c) { c.status = 'SUCCEEDED'; return; }
  markPaid(id);
}
function setAmount(id, v) {
  const c = beam.charges[id];
  if (c) { c.amount = v; return; }
  beam.links[id].order.netAmount = v;
}
function setCurrency(id, v) {
  const c = beam.charges[id];
  if (c) { c.currency = v; return; }
  beam.links[id].order.currency = v;
}

/* ── helper: สร้าง order + payment ให้พร้อมจ่าย ── */
async function seedPaidReadyOrder(overrides = {}) {
  const res1 = H.mkRes();
  await createOrderHandler(H.mkReq({
    method: 'POST',
    body: { product_code: 'LANDLORD_AI_GUIDE', source: 'website', ...overrides },
  }), res1);
  const order = res1.body;

  const res2 = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: order.order_id } }), res2);
  return { order, payment: res2.body };
}

/** ยิง webhook แบบเซ็นถูกต้อง */
async function fireWebhook(payload, { event = 'payment_link.paid', secret = 'test-webhook-secret' } = {}) {
  const raw = JSON.stringify(payload);
  const res = H.mkRes();
  await webhookHandler(H.mkReq({
    method: 'POST',
    headers: { 'x-beam-event': event, 'x-beam-signature': H.sign(secret, raw) },
    body: raw,
  }), res);
  return res;
}

/* ══════════════════ ORDER ══════════════════ */

test('order: created with server-side price, never from client', async () => {
  reset();
  const res = H.mkRes();
  await createOrderHandler(H.mkReq({
    method: 'POST',
    body: { product_code: 'LANDLORD_AI_GUIDE', source: 'facebook', amount: 1, price: 1 },
  }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.amount, 29900, 'ราคาต้องมาจาก DB ไม่ใช่จาก client');
  assert.equal(res.body.currency, 'THB');
  assert.equal(res.body.status, 'PENDING_PAYMENT');
  assert.match(res.body.order_number, /^SD-EBOOK-\d{8}-\d{6}$/);
  assert.ok(res.body.lookup_token && res.body.lookup_token.length >= 20);

  const row = db.orders[0];
  assert.equal(row.amount, 29900);
  assert.equal(row.source, 'facebook');
  assert.ok(!row.lookup_token, 'ห้ามเก็บ token ดิบใน DB');
  assert.ok(row.lookup_token_hash);
});

test('order: unknown product รับไม่ได้', async () => {
  reset();
  const res = H.mkRes();
  await createOrderHandler(H.mkReq({ method: 'POST', body: { product_code: 'NOPE' } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'product_not_found');
});

test('order: inactive product ซื้อไม่ได้', async () => {
  reset();
  db.products[0].status = 'INACTIVE';
  const res = H.mkRes();
  await createOrderHandler(H.mkReq({ method: 'POST', body: { product_code: 'LANDLORD_AI_GUIDE' } }), res);
  assert.equal(res.statusCode, 409);
});

test('order: source tracking + pain_category เก็บครบ', async () => {
  reset();
  const res = H.mkRes();
  await createOrderHandler(H.mkReq({
    method: 'POST',
    body: {
      product_code: 'LANDLORD_AI_GUIDE', source: 'line', source_reference: 'U123',
      utm_source: 'fb', utm_campaign: 'ebook-aug', pain_category: 'RENT_ARREARS',
    },
  }), res);
  const row = db.orders[0];
  assert.equal(row.source, 'line');
  assert.equal(row.source_reference, 'U123');
  assert.equal(row.utm_campaign, 'ebook-aug');
  assert.equal(row.pain_category, 'RENT_ARREARS');
});

test('order: pain_category ที่ไม่รู้จักถูกทิ้ง ไม่ทำให้ล้ม', async () => {
  reset();
  const res = H.mkRes();
  await createOrderHandler(H.mkReq({
    method: 'POST', body: { product_code: 'LANDLORD_AI_GUIDE', pain_category: 'DROP TABLE' },
  }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(db.orders[0].pain_category, null);
});

/* ══════════════════ PAYMENT ══════════════════ */

test('payment: สร้างได้ และคืน payment_url', async () => {
  reset();
  const { payment } = await seedPaidReadyOrder();
  assert.equal(payment.status, 'PENDING');
  assert.ok(payment.payment_url.includes('/pay.html'), 'โหมด charge พาไปหน้า QR ของเราเอง');
  assert.equal(db.payments.length, 1);
  assert.equal(db.payments[0].amount, 29900);
});

test('payment: IDEMPOTENT — เรียกซ้ำได้ payment ใบเดิม ไม่สร้าง link ใหม่', async () => {
  reset();
  const { order, payment } = await seedPaidReadyOrder();

  const res = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: order.order_id } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payment_id, payment.payment_id, 'ต้องเป็น payment ใบเดิม');
  assert.equal(res.body.reused, true);
  assert.equal(db.payments.length, 1, 'ต้องมี payment ใบเดียว');
  assert.equal(beam.createCalls, 1, 'ต้องเรียก Beam ครั้งเดียว');
});

test('payment: Beam ล่ม → 502 และ order ไม่ถูกทำลาย ลองใหม่ได้', async () => {
  reset();
  const res1 = H.mkRes();
  await createOrderHandler(H.mkReq({
    method: 'POST', body: { product_code: 'LANDLORD_AI_GUIDE' },
  }), res1);

  beam.createFails = true; beam.chargeFails = true;
  const res2 = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: res1.body.order_id } }), res2);
  assert.equal(res2.statusCode, 502);
  assert.equal(db.payments.length, 0);
  assert.equal(db.orders[0].status, 'PENDING_PAYMENT', 'order ต้องยังอยู่');

  // ลองใหม่เมื่อ Beam กลับมา
  beam.createFails = false; beam.chargeFails = false;
  const res3 = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: res1.body.order_id } }), res3);
  assert.equal(res3.statusCode, 200);
  assert.ok(res3.body.payment_url);
});

test('payment: order ที่จ่ายแล้วสร้าง payment ใหม่ไม่ได้', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  db.orders[0].status = 'PAID';

  const res = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: order.order_id } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'order_already_paid');
});

test('payment: order ไม่มีจริง → 404', async () => {
  reset();
  const res = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: 'SD-EBOOK-20990101-000001' } }), res);
  assert.equal(res.statusCode, 404);
});

/* ══════════════════ WEBHOOK ══════════════════ */

test('webhook: ลายเซ็นผิด → 401 และไม่มีอะไรเปลี่ยน', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);

  const raw = JSON.stringify({ paymentLinkId: linkId, order: { referenceId: order.order_number } });
  const res = H.mkRes();
  await webhookHandler(H.mkReq({
    method: 'POST',
    headers: { 'x-beam-event': 'payment_link.paid', 'x-beam-signature': 'wrong-signature' },
    body: raw,
  }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(db.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(db.deliveries.length, 0);
});

test('webhook: ไม่มีลายเซ็นเลย → 401', async () => {
  reset();
  const res = H.mkRes();
  await webhookHandler(H.mkReq({
    method: 'POST', headers: { 'x-beam-event': 'payment_link.paid' }, body: '{}',
  }), res);
  assert.equal(res.statusCode, 401);
});

test('webhook: happy path → order PAID + delivery READY', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);

  const res = await fireWebhook({ paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, 'PROCESSED');
  assert.equal(db.payments[0].status, 'PAID');
  assert.ok(db.payments[0].paid_at);
  assert.equal(db.orders[0].status, 'DELIVERED');   // PAID → สร้าง delivery → DELIVERED
  assert.ok(db.orders[0].paid_at);
  assert.equal(db.deliveries.length, 1);
  assert.equal(db.deliveries[0].delivery_status, 'READY');
  assert.ok(db.deliveries[0].download_token_hash);
});

test('webhook: DUPLICATE — ยิงซ้ำ payload เดิม ไม่ fulfill ซ้ำ', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);
  const payload = { paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } };

  const first = await fireWebhook(payload);
  const second = await fireWebhook(payload);

  assert.equal(first.body.result, 'PROCESSED');
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(db.deliveries.length, 1, 'ต้องมี delivery ใบเดียว');
  assert.equal(db.payments.length, 1);
});

test('webhook: ยอดไม่ตรง → MISMATCH · ไม่ส่งของ · order ไม่ PAID', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);
  setAmount(linkId, 100);          // ← จ่ายแค่ 1 บาท

  const res = await fireWebhook({ paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } });

  assert.equal(res.body.result, 'MISMATCH');
  assert.equal(db.orders[0].status, 'PENDING_PAYMENT');
  assert.equal(db.deliveries.length, 0);
  const ev = db.commerce_events.find(e => e.event === 'PAYMENT_MISMATCH');
  assert.ok(ev, 'ต้องบันทึก PAYMENT_MISMATCH');
  assert.equal(ev.data.reason, 'amount_mismatch');
});

test('webhook: สกุลเงินไม่ตรง → MISMATCH', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);
  setCurrency(linkId, 'USD');

  const res = await fireWebhook({ paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } });
  assert.equal(res.body.result, 'MISMATCH');
  assert.equal(db.deliveries.length, 0);
});

test('webhook: order ไม่รู้จัก → UNKNOWN_ORDER ไม่ล้ม', async () => {
  reset();
  const res = await fireWebhook({ paymentLinkId: 'PLunknown', status: 'PAID', order: { referenceId: 'SD-EBOOK-20990101-000009' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, 'UNKNOWN_ORDER');
  assert.equal(db.deliveries.length, 0);
});

test('webhook: Beam ยืนยันไม่ได้ → UNCONFIRMED ไม่ส่งของ', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);
  beam.getReturnsNull = true;                        // ← Beam API ล่ม

  const res = await fireWebhook({ paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } });
  assert.equal(res.body.result, 'UNCONFIRMED');
  assert.equal(db.deliveries.length, 0);
  assert.equal(db.orders[0].status, 'PENDING_PAYMENT');
});

test('webhook: payload บอก PAID แต่ Beam บอก ACTIVE → ไม่ส่งของ (กัน replay/ปลอม)', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  // beam.links[linkId].status ยังเป็น ACTIVE

  const res = await fireWebhook({ paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } });
  assert.equal(res.body.result, 'NOT_PAID');
  assert.equal(db.deliveries.length, 0);
});

test('webhook: event ที่ไม่เกี่ยวกับการจ่าย → IGNORED', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  const res = await fireWebhook(
    { paymentLinkId: linkId, status: 'ACTIVE', order: { referenceId: order.order_number } },
    { event: 'payment_link.created' });
  assert.equal(res.body.result, 'IGNORED');
  assert.equal(db.deliveries.length, 0);
});

/* ══════════════════ DELIVERY (idempotency ระดับ lib) ══════════════════ */

test('delivery: สร้างซ้ำไม่ได้ ได้ใบเดิมเสมอ', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const orderRow = db.orders[0];
  const product = db.products[0];

  const a = await C.createDelivery(orderRow, product);
  const b = await C.createDelivery(orderRow, product);

  assert.ok(a.delivery && b.delivery);
  assert.equal(db.deliveries.length, 1);
  assert.equal(b.reused, true);
  assert.equal(a.delivery.id, b.delivery.id);
});

/* ══════════════════ DOWNLOAD ══════════════════ */

async function paidOrderWithToken() {
  const { order } = await seedPaidReadyOrder();
  const linkId = db.payments[0].provider_payment_link_id;
  markPaid(linkId);
  await fireWebhook({ paymentLinkId: linkId, status: 'PAID', order: { referenceId: order.order_number } });

  // token ดิบไม่ถูกเก็บ — ขอผ่าน status endpoint เหมือน client จริง
  const res = H.mkRes();
  await statusHandler(H.mkReq({
    query: { id: order.order_number, t: order.lookup_token },
  }), res);
  const token = String(res.body.download_url).split('/').pop();
  return { order, token, statusBody: res.body };
}

test('download: token ถูกต้อง + จ่ายแล้ว → 302 และนับจำนวนครั้ง', async () => {
  reset();
  const { token } = await paidOrderWithToken();

  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token } }), res);

  assert.equal(res.statusCode, 302);
  assert.ok(String(res.headers.Location).includes('/storage/v1/object/sign/'));
  const d = db.deliveries[0];
  assert.equal(d.download_count, 1);
  assert.ok(d.downloaded_at, 'ต้องบันทึกเวลาดาวน์โหลดครั้งแรก');
  assert.equal(d.delivery_status, 'DOWNLOADED');
  assert.ok(db.commerce_events.some(e => e.event === 'DOWNLOAD_COMPLETED'));
});

test('download: token มั่ว → 404 ไม่บอกใบ้อะไร', async () => {
  reset();
  await paidOrderWithToken();
  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token: 'x'.repeat(43) } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(db.deliveries[0].download_count, 0);
});

test('download: token สั้น/ว่าง → 400', async () => {
  reset();
  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token: 'abc' } }), res);
  assert.equal(res.statusCode, 400);
});

test('download: order ยังไม่จ่าย → 403 แม้ token ถูก', async () => {
  reset();
  const { token } = await paidOrderWithToken();
  db.orders[0].status = 'PENDING_PAYMENT';           // ย้อนสถานะ

  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(db.deliveries[0].download_count, 0);
});

test('download: ครบจำนวนครั้ง → 429', async () => {
  reset();
  const { token } = await paidOrderWithToken();
  db.deliveries[0].download_count = 5;
  db.deliveries[0].max_downloads = 5;

  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token } }), res);
  assert.equal(res.statusCode, 429);
});

test('download: หมดอายุ → 410', async () => {
  reset();
  const { token } = await paidOrderWithToken();
  db.deliveries[0].download_expires_at = new Date(Date.now() - 1000).toISOString();

  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token } }), res);
  assert.equal(res.statusCode, 410);
  assert.equal(db.deliveries[0].delivery_status, 'EXPIRED');
});

test('download: storage ล่ม → 500 และไม่นับ download', async () => {
  reset();
  const { token } = await paidOrderWithToken();
  db._storageFails = true;

  const res = H.mkRes();
  await downloadHandler(H.mkReq({ query: { token } }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(db.deliveries[0].download_count, 0);
});

/* ══════════════════ STATUS ══════════════════ */

test('status: ไม่มี lookup token → 401', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const res = H.mkRes();
  await statusHandler(H.mkReq({ query: { id: order.order_number } }), res);
  assert.equal(res.statusCode, 401);
});

test('status: token ผิด → 404 (ตอบเหมือนไม่มี order เพื่อกันเดา)', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const res = H.mkRes();
  await statusHandler(H.mkReq({ query: { id: order.order_number, t: 'wrong-token-value-1234567890' } }), res);
  assert.equal(res.statusCode, 404);
});

test('status: ยังไม่จ่าย → คืน payment_url ไม่คืน download_url', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const res = H.mkRes();
  await statusHandler(H.mkReq({ query: { id: order.order_number, t: order.lookup_token } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PENDING_PAYMENT');
  assert.equal(res.body.payment_status, 'PENDING');
  assert.ok(res.body.payment_url);
  assert.equal(res.body.download_url, undefined);
});

test('status: จ่ายแล้ว → delivery READY + download_url และไม่มีข้อมูลส่วนตัว', async () => {
  reset();
  const { statusBody } = await paidOrderWithToken();

  assert.equal(statusBody.status, 'DELIVERED');
  assert.equal(statusBody.payment_status, 'PAID');
  assert.equal(statusBody.delivery_status, 'READY');
  assert.ok(statusBody.download_url);
  assert.equal(statusBody.customer_name, undefined);
  assert.equal(statusBody.customer_email, undefined);
  assert.equal(statusBody.order_id, undefined, 'ห้ามคืน internal id');
});

/* ══════════════════ ADMIN ══════════════════ */

test('admin: ไม่มี key → 401', async () => {
  reset();
  const res = H.mkRes();
  await adminHandler(H.mkReq({ query: {} }), res);
  assert.equal(res.statusCode, 401);
});

test('admin: key ผิด → 401', async () => {
  reset();
  const res = H.mkRes();
  await adminHandler(H.mkReq({ query: { key: 'nope' } }), res);
  assert.equal(res.statusCode, 401);
});

/* ══════════════════ MONEY / UNIT ══════════════════ */

test('money: ไม่มี float ใน order/payment', async () => {
  reset();
  await seedPaidReadyOrder();
  assert.equal(Number.isInteger(db.orders[0].amount), true);
  assert.equal(Number.isInteger(db.payments[0].amount), true);
});

test('money: toBeamAmount ตาม BEAM_AMOUNT_UNIT (default = สตางค์)', () => {
  assert.equal(C.toBeamAmount(29900), 29900);
  assert.equal(C.fromBeamAmount(29900), 29900);
});

/* ══════════════════ LOGGING ══════════════════ */

test('logging: มี event สำคัญครบ และไม่มีความลับหลุด', async () => {
  reset();
  await paidOrderWithToken();
  const names = db.commerce_events.map(e => e.event);
  for (const want of ['ORDER_CREATED', 'PAYMENT_CREATED', 'BEAM_WEBHOOK_RECEIVED',
    'PAYMENT_CONFIRMED', 'DELIVERY_CREATED']) {
    assert.ok(names.includes(want), 'ขาด event: ' + want);
  }
  const dump = JSON.stringify(db.commerce_events);
  assert.ok(!dump.includes('test-key'), 'BEAM_API_KEY หลุดใน log');
  assert.ok(!dump.includes('test-service-key'), 'service key หลุดใน log');
  assert.ok(!dump.includes('test-webhook-secret'), 'webhook secret หลุดใน log');
});

/* ══════════════════ BEAM: โหมด link (สำรอง) ══════════════════ */

/** โหลด _commerce.js ใหม่ในโหมด link พร้อม env ที่กำหนด */
function loadLinkMode(env = {}) {
  const saved = {};
  const set = { BEAM_PAYMENT_MODE: 'link', ...env };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  delete require.cache[require.resolve('../api/_commerce.js')];
  const mod = require('../api/_commerce.js');
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return mod;
}
/** คืน _commerce.js กลับเป็นโหมดปกติ (charge) ให้เทสอื่น */
function restoreChargeMode() {
  delete require.cache[require.resolve('../api/_commerce.js')];
  require('../api/_commerce.js');
}

const linkArgs = {
  orderNumber: 'SD-EBOOK-TEST-000001', amountMinor: 29900, currency: 'THB',
  description: 'test', redirectUrl: 'https://signdee.test/ok',
  expiresAt: new Date(Date.now() + 3600e3).toISOString(),
};

test('link mode: ไม่ตั้ง BEAM_LINK_METHODS = ไม่ส่ง linkSettings ในใบแรก', async () => {
  reset();
  const C2 = loadLinkMode();
  const link = await C2.beamCreatePaymentLink(linkArgs);
  assert.ok(!link.error, JSON.stringify(link.detail || {}));
  assert.equal(beam.lastPayload.linkSettings, undefined);
  assert.equal(beam.createCalls, 1);
  restoreChargeMode();
});

test('link mode: บัญชีเปิดบัตรไม่ได้ → ไล่ลองจนเจอรูปแบบที่ผ่าน แล้ว log ไว้ให้', async () => {
  reset();
  beam.promptPayOnly = true;                    // ผ่านเฉพาะ card:false + qrPromptPay:true
  const C2 = loadLinkMode();

  const link = await C2.beamCreatePaymentLink(linkArgs);
  assert.ok(!link.error, 'ควรหาเจอรูปแบบที่ผ่าน: ' + JSON.stringify(link.detail || {}));
  assert.equal(beam.lastPayload.linkSettings.card.isEnabled, false, 'ต้องปิดบัตร');
  assert.equal(beam.lastPayload.linkSettings.qrPromptPay.isEnabled, true, 'ต้องเปิด PromptPay');
  assert.ok(beam.createCalls > 1, 'ต้องมีการไล่ลอง');

  const hint = db.commerce_events.find(e => e.event === 'BEAM_LINK_SETTINGS_OK');
  assert.ok(hint, 'ต้อง log รูปแบบที่ใช้ได้ไว้');
  restoreChargeMode();
});

test('link mode: ตั้ง BEAM_LINK_METHODS แล้วบัญชีเปิดบัตรไม่ได้ → ถอยแล้วยังสร้างได้', async () => {
  reset();
  beam.rejectCard = true;
  const C2 = loadLinkMode({ BEAM_LINK_METHODS: 'card,ewallets' });

  const link = await C2.beamCreatePaymentLink(linkArgs);
  assert.ok(!link.error, JSON.stringify(link.detail || {}));
  assert.ok(beam.createCalls >= 2, 'ใบแรกต้องโดนปฏิเสธก่อน');
  restoreChargeMode();
});

/* ══════════════════ BEAM: โหมด charge (ค่าเริ่มต้น) ══════════════════ */

test('charge mode: ยิง Charges API ด้วย QR_PROMPT_PAY และเก็บ QR ไว้ให้หน้าเว็บ', async () => {
  reset();
  const { payment } = await seedPaidReadyOrder();

  assert.equal(beam.lastPayload.paymentMethod.paymentMethodType, 'QR_PROMPT_PAY');
  assert.equal(beam.lastPayload.amount, 29900, 'ยอดเป็นสตางค์');
  assert.equal(beam.lastPayload.currency, 'THB');
  assert.ok(beam.lastPayload.paymentMethod.qrPromptPay.expiryTime, 'ต้องกำหนดเวลาหมดอายุ QR');
  assert.ok(payment.payment_url.includes('/pay.html'));

  const row = db.payments[0];
  assert.equal(row.provider_payload.mode, 'charge');
  assert.ok(row.provider_payload.qr.image.startsWith('data:image/png;base64,'));
  assert.equal(row.provider_payment_id, row.provider_payment_link_id, 'chargeId เก็บทั้งสองช่อง');
});

test('charge mode: status คืน QR ตอนยังไม่จ่าย และเลิกคืนเมื่อจ่ายแล้ว', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const token = order.lookup_token;

  const res1 = H.mkRes();
  await statusHandler(H.mkReq({ query: { id: order.order_number, t: token } }), res1);
  assert.ok(res1.body.qr && res1.body.qr.image, 'ต้องคืน QR ตอนรอจ่าย');
  assert.ok(res1.body.qr.expires_at);
  assert.equal(res1.body.download_url, undefined, 'ยังไม่จ่าย ห้ามมีลิงก์ดาวน์โหลด');

  const chargeId = db.payments[0].provider_payment_link_id;
  markPaid(chargeId);
  await fireWebhook({ chargeId, status: 'SUCCEEDED', referenceId: order.order_number });

  const res2 = H.mkRes();
  await statusHandler(H.mkReq({ query: { id: order.order_number, t: token } }), res2);
  assert.ok(['PAID', 'DELIVERED'].includes(res2.body.status));
  assert.equal(res2.body.qr, undefined, 'จ่ายแล้วต้องไม่คืน QR อีก');
  assert.ok(res2.body.download_url);
});

test('charge mode: QR หมดอายุ → เรียก payment ซ้ำได้ใบใหม่ ไม่ใช้ใบเดิม', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const first = db.payments[0];

  // ทำให้ QR ของใบแรกหมดอายุ
  first.provider_payload.qr.expiry = new Date(Date.now() - 60000).toISOString();

  const res = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: order.order_number } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reused, false, 'ต้องออกใบใหม่');
  assert.equal(first.status, 'EXPIRED', 'ใบเดิมต้องถูกปิด');
  assert.equal(db.payments.length, 2);
});

test('charge mode: จ่ายแล้วแต่กดขอ QR ซ้ำ → 409 ไม่สร้างใหม่', async () => {
  reset();
  const { order } = await seedPaidReadyOrder();
  const chargeId = db.payments[0].provider_payment_link_id;
  markPaid(chargeId);
  await fireWebhook({ chargeId, status: 'SUCCEEDED', referenceId: order.order_number });

  const before = db.payments.length;
  const res = H.mkRes();
  await paymentHandler(H.mkReq({ method: 'POST', query: { id: order.order_number } }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(db.payments.length, before, 'ห้ามสร้าง payment ใบใหม่');
});

/* ══════════════════ LINE OA — ขาย eBook ในแชท ══════════════════ */

const LINE_UID = 'Utest0000000000000000000000000001';

function loadLineBot() {
  process.env.LINE_CHANNEL_TOKEN = 'test-line-token';
  delete require.cache[require.resolve('../api/_line_ebook.js')];
  return require('../api/_line_ebook.js');
}
const lineCalls = () => beam.lineCalls || [];
const lastLine = () => lineCalls()[lineCalls().length - 1];

test('line: พิมพ์ถามเรื่องคู่มือ → ตอบ Flex แนะนำสินค้า ไม่สร้าง order', async () => {
  reset();
  const LB = loadLineBot();

  const handled = await LB.handleEvent({
    type: 'message', replyToken: 'rt1',
    source: { userId: LINE_UID }, message: { type: 'text', text: 'คู่มือราคาเท่าไหร่' },
  });

  assert.equal(handled, true);
  assert.equal(db.orders.length, 0, 'แค่ถามยังไม่ต้องสร้าง order');
  const msg = lastLine().body.messages[0];
  assert.equal(msg.type, 'flex');
  assert.ok(msg.altText.includes('299'));
});

test('line: ข้อความที่ไม่เกี่ยวกับคู่มือ → ไม่จัดการ ปล่อยให้ flow เดิมทำงาน', async () => {
  reset();
  const LB = loadLineBot();
  const handled = await LB.handleEvent({
    type: 'message', replyToken: 'rt', source: { userId: LINE_UID },
    message: { type: 'text', text: 'ผูกบัญชี AB12CD' },
  });
  assert.equal(handled, false);
  assert.equal(lineCalls().length, 0);
});

test('line: กดซื้อ → สร้าง order source=line + QR และส่งลิงก์ที่มี token', async () => {
  reset();
  const LB = loadLineBot();

  await LB.handleEvent({
    type: 'postback', replyToken: 'rt2',
    source: { userId: LINE_UID }, postback: { data: 'action=ebook_buy' },
  });

  assert.equal(db.orders.length, 1);
  const order = db.orders[0];
  assert.equal(order.source, 'line');
  assert.equal(order.source_reference, LINE_UID, 'ผูก LINE userId ไว้กับ order');
  assert.equal(order.amount, 29900, 'ราคามาจาก DB');
  assert.equal(db.payments.length, 1);

  const uri = lastLine().body.messages[0].contents.footer.contents[0].action.uri;
  assert.ok(uri.includes('/pay.html'));
  assert.ok(uri.includes('o=' + order.order_number));
  assert.ok(uri.includes('t='), 'ต้องพก lookup token ไปด้วย');
});

test('line: กดซื้อซ้ำ → ใช้ order เดิม ไม่สร้างใบใหม่', async () => {
  reset();
  const LB = loadLineBot();
  const ev = { type: 'postback', replyToken: 'rt', source: { userId: LINE_UID },
    postback: { data: 'action=ebook_buy' } };

  await LB.handleEvent(ev);
  await LB.handleEvent(ev);

  assert.equal(db.orders.length, 1, 'ห้ามสร้าง order ซ้ำ');
  assert.equal(db.payments.length, 1, 'ห้ามสร้าง charge ซ้ำ');
});

test('line: จ่ายเงินแล้ว → webhook push ลิงก์ดาวน์โหลดกลับเข้าแชทเอง', async () => {
  reset();
  const LB = loadLineBot();
  await LB.handleEvent({ type: 'postback', replyToken: 'rt', source: { userId: LINE_UID },
    postback: { data: 'action=ebook_buy' } });

  const order = db.orders[0];
  const chargeId = db.payments[0].provider_payment_link_id;
  const before = lineCalls().length;

  markPaid(chargeId);
  const res = await fireWebhook({ chargeId, status: 'SUCCEEDED', referenceId: order.order_number });
  assert.equal(res.body.result, 'PROCESSED');

  const pushes = lineCalls().slice(before).filter(c => c.path.endsWith('/push'));
  assert.equal(pushes.length, 1, 'ต้อง push ลิงก์ดาวน์โหลดหนึ่งครั้ง');
  assert.equal(pushes[0].body.to, LINE_UID);

  const uri = pushes[0].body.messages[0].contents.footer.contents[0].action.uri;
  assert.ok(uri.includes('/api/download/'), 'ต้องเป็นลิงก์ดาวน์โหลดจริง');
});

test('line: ถามสถานะหลังจ่ายแล้ว → ได้ลิงก์ดาวน์โหลดใบใหม่ (token เดิมใช้ไม่ได้)', async () => {
  reset();
  const LB = loadLineBot();
  await LB.handleEvent({ type: 'postback', replyToken: 'rt', source: { userId: LINE_UID },
    postback: { data: 'action=ebook_buy' } });

  const order = db.orders[0];
  markPaid(db.payments[0].provider_payment_link_id);
  await fireWebhook({ chargeId: db.payments[0].provider_payment_link_id,
    status: 'SUCCEEDED', referenceId: order.order_number });

  const hashBefore = db.deliveries[0].download_token_hash;

  await LB.handleEvent({ type: 'message', replyToken: 'rt3', source: { userId: LINE_UID },
    message: { type: 'text', text: 'ขอลิงก์ดาวน์โหลดอีกรอบ' } });

  assert.notEqual(db.deliveries[0].download_token_hash, hashBefore, 'ต้องหมุน token ใหม่');
  const msg = lastLine().body.messages[0];
  assert.ok(msg.contents.footer.contents[0].action.uri.includes('/api/download/'));
});

test('line: ถามสถานะทั้งที่ยังไม่เคยซื้อ → ไม่สร้าง order และไม่ล้ม', async () => {
  reset();
  const LB = loadLineBot();
  await LB.handleEvent({ type: 'message', replyToken: 'rt', source: { userId: LINE_UID },
    message: { type: 'text', text: 'เช็คสถานะให้หน่อย' } });

  assert.equal(db.orders.length, 0);
  assert.equal(lastLine().body.messages[0].type, 'text');
});

test('line: ผู้ใช้คนอื่นถามสถานะ → ไม่เห็น order ของคนแรก', async () => {
  reset();
  const LB = loadLineBot();
  await LB.handleEvent({ type: 'postback', replyToken: 'rt', source: { userId: LINE_UID },
    postback: { data: 'action=ebook_buy' } });

  const other = 'Utest0000000000000000000000000099';
  await LB.handleEvent({ type: 'message', replyToken: 'rt', source: { userId: other },
    message: { type: 'text', text: 'สถานะ' } });

  const msg = lastLine().body.messages[0];
  assert.equal(msg.type, 'text');
  assert.ok(!JSON.stringify(msg).includes(db.orders[0].order_number),
    'ห้ามหลุดเลขที่คำสั่งซื้อของคนอื่น');
});
