// POST /api/webhooks/beam — รับแจ้งการชำระเงินจาก Beam
//
// ความปลอดภัยสามชั้น:
//   1. ตรวจลายเซ็น x-beam-signature (HMAC-SHA256 · base64 ของ raw body)
//   2. กันซ้ำด้วย fingerprint ของ payload (unique index)
//   3. ยืนยันกับ Beam API ว่า charge / payment link นั้นจ่ายจริง ก่อนส่งของเสมอ
//      ← ชั้นนี้สำคัญที่สุด ไม่เคยเชื่อ payload อย่างเดียว
//
// ยอด/สกุลเงินไม่ตรงกับ order → ไม่ส่งของ · บันทึกเป็น PAYMENT_MISMATCH

const C = require('../_commerce.js');

const REF_PATHS = ['order.referenceId', 'referenceId', 'data.order.referenceId', 'data.referenceId',
  'paymentLink.order.referenceId', 'charge.referenceId', 'data.charge.referenceId'];
const LINK_PATHS = ['paymentLinkId', 'chargeId', 'data.chargeId', 'charge.chargeId',
  'data.paymentLinkId', 'paymentLink.paymentLinkId', 'id', 'data.id'];
const STATUS_PATHS = ['status', 'data.status', 'paymentLink.status'];
const EVENTID_PATHS = ['eventId', 'id', 'data.eventId'];
const AMOUNT_PATHS = ['order.netAmount', 'netAmount', 'amount', 'data.order.netAmount',
  'data.netAmount', 'data.amount', 'amount.amount'];
const CURRENCY_PATHS = ['order.currency', 'currency', 'data.order.currency', 'data.currency'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return C.json(res, 405, { error: 'method_not_allowed' });

  const raw = C.rawBodyOf(req);
  const eventType = String(req.headers['x-beam-event'] || req.headers['x-beam-event-type'] || '');
  const signature = req.headers['x-beam-signature'];

  // ══ 1. ลายเซ็น ══
  const sigResult = C.beamVerifySignature(raw, signature);
  const strict = (process.env.BEAM_WEBHOOK_VERIFY || 'strict') === 'strict';

  if (sigResult === false && strict) {
    await C.logEvent('WEBHOOK_REJECTED', {
      level: 'warn', data: { reason: 'bad_signature', event: eventType },
    });
    return C.json(res, 401, { error: 'invalid_signature' });
  }
  if (sigResult === 'no_secret' && strict) {
    // ยังไม่ตั้ง secret → ไม่ยอมรับ webhook เข้าระบบเลย ปลอดภัยกว่าเดา
    await C.logEvent('WEBHOOK_REJECTED', {
      level: 'error', data: { reason: 'webhook_secret_not_configured', event: eventType },
    });
    return C.json(res, 503, { error: 'webhook_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const refId = C.pick(body, REF_PATHS);
  const linkId = C.pick(body, LINK_PATHS);
  const statusIn = String(C.pick(body, STATUS_PATHS) || '').toUpperCase();
  const fingerprint = C.sha256(raw);

  await C.logEvent('BEAM_WEBHOOK_RECEIVED', {
    orderNumber: refId, data: { event: eventType, payment_link_id: linkId, status: statusIn },
  });

  // ══ 2. กันซ้ำ — insert fingerprint ก่อน ถ้าชนแปลว่าเคยรับแล้ว ══
  const logged = await C.sbInsert('payment_webhook_events', {
    provider: 'beam',
    event_type: eventType || null,
    event_fingerprint: fingerprint,
    provider_event_id: C.pick(body, EVENTID_PATHS),
    provider_reference: refId,
    payment_link_id: linkId,
    payload: body,
  });

  if (logged && logged.conflict) {
    // Beam retry — ตอบ 200 เพื่อให้หยุด retry แต่ไม่ทำงานซ้ำ
    return C.json(res, 200, { ok: true, duplicate: true });
  }

  const finish = async (result, extra = {}) => {
    if (logged && logged.id) {
      await C.sbUpdate('payment_webhook_events', { id: logged.id }, { processed: true, result });
    }
    return C.json(res, 200, { ok: true, result, ...extra });
  };

  // ══ เอาเฉพาะ event ที่หมายถึง "จ่ายแล้ว" ══
  const looksPaid = /payment_link\.paid/i.test(eventType)
    || /charge\.succeeded/i.test(eventType)
    || statusIn === 'PAID' || statusIn === 'SUCCEEDED';
  if (!looksPaid) return finish('IGNORED');

  // ══ หา order ══
  let order = refId ? await C.findOrder(refId) : null;
  if (!order && linkId) {
    const pay = (await C.sbSelect(
      `payments?select=order_id&provider_payment_link_id=eq.${encodeURIComponent(linkId)}&limit=1`))[0];
    if (pay) order = await C.findOrder(pay.order_id);
  }
  if (!order) {
    await C.logEvent('WEBHOOK_REJECTED', {
      level: 'error', orderNumber: refId,
      data: { reason: 'unknown_order', payment_link_id: linkId },
    });
    return finish('UNKNOWN_ORDER');
  }

  // ══ 3. ยืนยันกับ Beam API — source of truth ══
  const payment = await C.latestPayment(order.id);
  const confirmId = (payment && payment.provider_payment_link_id) || linkId;
  const remote = await C.beamGetPayment(confirmId);

  if (!remote) {
    await C.logEvent('PAYMENT_MISMATCH', {
      orderId: order.id, orderNumber: order.order_number, level: 'error',
      data: { reason: 'cannot_confirm_with_provider', payment_link_id: confirmId },
    });
    return finish('UNCONFIRMED');       // ไม่ส่งของ · ให้คนตรวจ
  }

  const remoteStatus = String(remote.status || '').toUpperCase();
  if (remoteStatus !== 'PAID') {
    await C.logEvent('PAYMENT_MISMATCH', {
      orderId: order.id, orderNumber: order.order_number, level: 'warn',
      data: { reason: 'provider_status_not_paid', provider_status: remoteStatus },
    });
    return finish('NOT_PAID');
  }

  // ══ ยอดและสกุลเงินต้องตรง ══
  const remoteAmountMinor = C.fromBeamAmount(C.pick(remote, AMOUNT_PATHS));
  const remoteCurrency = String(C.pick(remote, CURRENCY_PATHS) || order.currency).toUpperCase();

  if (remoteAmountMinor !== null && remoteAmountMinor !== Number(order.amount)) {
    await C.logEvent('PAYMENT_MISMATCH', {
      orderId: order.id, orderNumber: order.order_number, level: 'error',
      data: { reason: 'amount_mismatch', expected: Number(order.amount), received: remoteAmountMinor },
    });
    if (payment) {
      await C.sbUpdate('payments', { id: payment.id },
        { failure_reason: `amount_mismatch expected=${order.amount} got=${remoteAmountMinor}`, updated_at: C.nowISO() });
    }
    return finish('MISMATCH');          // ← ไม่ fulfill เด็ดขาด
  }
  if (remoteCurrency !== String(order.currency).toUpperCase()) {
    await C.logEvent('PAYMENT_MISMATCH', {
      orderId: order.id, orderNumber: order.order_number, level: 'error',
      data: { reason: 'currency_mismatch', expected: order.currency, received: remoteCurrency },
    });
    return finish('MISMATCH');
  }

  // ══ ถึงตรงนี้ = จ่ายจริง ยอดตรง ══
  const paidAt = C.nowISO();

  if (payment && payment.status !== 'PAID') {
    await C.sbUpdate('payments', { id: payment.id }, {
      status: 'PAID', paid_at: paidAt, updated_at: paidAt,
      provider_payment_id: C.pick(remote, ['chargeId', 'paymentId', 'id']) || null,
      provider_payload: remote,
    });
  }

  if (order.status === 'PENDING_PAYMENT') {
    await C.sbUpdate('orders', { id: order.id }, { status: 'PAID', paid_at: paidAt, updated_at: paidAt });
    order.status = 'PAID';
    order.paid_at = paidAt;
  }

  await C.logEvent('PAYMENT_CONFIRMED', {
    orderId: order.id, orderNumber: order.order_number,
    data: { amount: Number(order.amount), currency: order.currency, provider: 'beam' },
  });

  // ══ สร้าง delivery (idempotent ด้วย unique index) ══
  const product = await C.getProduct(order.product_code);
  if (!product) {
    await C.logEvent('WEBHOOK_REJECTED', {
      orderId: order.id, orderNumber: order.order_number, level: 'error',
      data: { reason: 'product_missing_at_delivery' },
    });
    return finish('PAID_NO_DELIVERY');
  }

  const del = await C.createDelivery(order, product);
  if (del.error) return finish('PAID_DELIVERY_FAILED');

  // ── สั่งซื้อผ่าน LINE OA → ส่งลิงก์ดาวน์โหลดกลับเข้าแชท ──
  if (order.source === 'line' && order.source_reference) {
    try {
      const LB = require('../_line_ebook.js');
      await LB.notifyDelivered(order);
    } catch (e) {
      // ส่งเข้าแชทไม่ได้ ไม่ถือว่า fulfillment ล้มเหลว — ลูกค้ายังเช็คสถานะเองได้
      console.error(JSON.stringify({ ts: C.nowISO(), event: 'LINE_PUSH_FAILED',
        orderNumber: order.order_number, message: e.message }));
    }
  }

  return finish('PROCESSED', { order_number: order.order_number });
};
