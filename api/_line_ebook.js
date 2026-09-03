// ============================================================
//  SignDee — LINE OA: ขาย eBook ในแชท
//  ไฟล์ขึ้นต้นด้วย "_" → Vercel ไม่นับเป็น serverless function
//  เสียบเข้า api/line-webhook.js เดิม (ดู LINE_EBOOK_SETUP.md)
//
//  flow: พิมพ์คุย → Flex แนะนำคู่มือ → กดซื้อ → เปิดหน้า QR
//        → จ่าย → beam webhook → push ลิงก์ดาวน์โหลดกลับเข้าแชท
//
//  ไม่เก็บอะไรเพิ่มในฐานข้อมูล — ใช้ orders.source='line'
//  และ orders.source_reference = LINE userId
// ============================================================
'use strict';

const C = require('./_commerce.js');

const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PRODUCT_CODE = process.env.LINE_EBOOK_PRODUCT || 'LANDLORD_AI_GUIDE';
const APP_BASE = C.APP_BASE_URL;

const baht = n => (Number(n) / 100).toLocaleString('th-TH');

/* ══════════ LINE API ══════════ */
async function lineSend(path, payload) {
  if (!LINE_TOKEN) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'LINE_TOKEN_MISSING',
      note: 'ไม่พบ LINE_CHANNEL_TOKEN ใน environment นี้ — ตอบกลับไม่ได้' }));
    return false;
  }
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error('[line-ebook]', path, r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (e) { console.error('[line-ebook]', path, e.message); return false; }
}
const push = (to, messages) =>
  lineSend('push', { to, messages: Array.isArray(messages) ? messages : [messages] });
const reply = (replyToken, messages) =>
  lineSend('reply', { replyToken, messages: Array.isArray(messages) ? messages : [messages] });

const text = t => ({ type: 'text', text: t });

/* ══════════ Flex ══════════ */
const BRAND = { deep: '#0B1220', accent: '#2E86C6', sky: '#6EC3EA', ink: '#14171F', mute: '#8E95A3' };

function productFlex(product) {
  return {
    type: 'flex',
    altText: 'คู่มือเอาตัวรอดของเจ้าของห้องเช่าในยุค AI · ' + baht(product.price) + ' บาท',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: BRAND.deep, paddingAll: '18px',
        contents: [
          { type: 'text', text: 'LANDLORD AI SURVIVAL PLAYBOOK', color: BRAND.sky, size: 'xxs', weight: 'bold' },
          { type: 'text', text: 'คู่มือเอาตัวรอด\nของเจ้าของห้องเช่าในยุค AI',
            color: '#FFFFFF', size: 'lg', weight: 'bold', wrap: true, margin: 'sm' },
          { type: 'text', text: 'ปล่อยห้องให้ไว เลือกผู้เช่าให้ดี\nและรู้ว่าต้องทำอะไรเมื่อเริ่มมีปัญหา',
            color: '#C3CAD6', size: 'xs', wrap: true, margin: 'md' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          ...[
            'Tenant Problem Decision Tree — เปิดก่อนส่งข้อความแรง ๆ',
            'Emergency Page — หน้าเดียวจบ เซฟไว้ในมือถือ',
            'AI Prompt Pack 9 ชุด — copy ไปใช้ได้ทันที',
            'Move-In / Move-Out Checklist พร้อมปริ้น',
            'ต้องให้เวลากี่วัน 15 หรือ 30 — ตอบไว้ในเล่ม',
          ].map(t => ({
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '•', size: 'sm', color: BRAND.accent, flex: 0 },
              { type: 'text', text: t, size: 'sm', color: BRAND.ink, wrap: true, flex: 1 },
            ],
          })),
          { type: 'separator', margin: 'lg' },
          { type: 'box', layout: 'baseline', margin: 'lg', contents: [
            { type: 'text', text: baht(product.price), size: 'xxl', weight: 'bold', color: BRAND.ink, flex: 0 },
            { type: 'text', text: ' บาท · PDF 30 หน้า', size: 'sm', color: BRAND.mute, margin: 'sm' },
          ] },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
        contents: [
          { type: 'button', style: 'primary', color: BRAND.deep, height: 'sm',
            action: { type: 'postback', label: 'ซื้อคู่มือ ' + baht(product.price) + ' บาท',
              data: 'action=ebook_buy', displayText: 'ขอซื้อคู่มือครับ/ค่ะ' } },
          { type: 'text', text: 'จ่ายด้วยพร้อมเพย์ · ได้ไฟล์ทันทีหลังชำระเงิน',
            size: 'xxs', color: BRAND.mute, align: 'center', wrap: true },
        ],
      },
    },
  };
}

function payFlex(order, payUrl, expiresAt) {
  const mins = expiresAt
    ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60000)) : null;
  return {
    type: 'flex',
    altText: 'สแกนจ่าย ' + baht(order.amount) + ' บาท · ' + order.order_number,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '18px',
        contents: [
          { type: 'text', text: 'พร้อมจ่ายแล้วค่ะ', size: 'lg', weight: 'bold', color: BRAND.ink },
          { type: 'box', layout: 'baseline', contents: [
            { type: 'text', text: baht(order.amount), size: 'xxl', weight: 'bold', color: BRAND.ink, flex: 0 },
            { type: 'text', text: ' บาท', size: 'sm', color: BRAND.mute, margin: 'sm' },
          ] },
          { type: 'text', text: 'กดปุ่มด้านล่างเพื่อเปิด QR พร้อมเพย์\nสแกนจ่ายแล้วระบบจะส่งไฟล์กลับมาในแชทนี้',
            size: 'sm', color: BRAND.mute, wrap: true },
          { type: 'separator' },
          { type: 'text', text: 'เลขที่คำสั่งซื้อ ' + order.order_number, size: 'xxs', color: BRAND.mute },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
        contents: [
          { type: 'button', style: 'primary', color: BRAND.accent, height: 'sm',
            action: { type: 'uri', label: 'เปิด QR พร้อมเพย์', uri: payUrl } },
          { type: 'button', style: 'link', height: 'sm',
            action: { type: 'postback', label: 'เช็คสถานะการชำระเงิน',
              data: 'action=ebook_status', displayText: 'เช็คสถานะ' } },
          mins ? { type: 'text', text: 'QR หมดอายุใน ' + mins + ' นาที · หมดแล้วกดขอใหม่ได้',
            size: 'xxs', color: BRAND.mute, align: 'center', wrap: true } : { type: 'filler' },
        ],
      },
    },
  };
}

function downloadFlex(order, url) {
  return {
    type: 'flex',
    altText: '📘 คู่มือของคุณพร้อมดาวน์โหลดแล้ว',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: BRAND.deep, paddingAll: '16px',
        contents: [
          { type: 'text', text: '📘 ขอบคุณที่อุดหนุนค่ะ', color: '#FFFFFF', size: 'md', weight: 'bold' },
          { type: 'text', text: 'ชำระเงินเรียบร้อยแล้ว', color: BRAND.sky, size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: 'คู่มือเอาตัวรอดของเจ้าของห้องเช่าในยุค AI',
            size: 'sm', weight: 'bold', color: BRAND.ink, wrap: true },
          { type: 'text', text: 'เลขที่คำสั่งซื้อ ' + order.order_number, size: 'xxs', color: BRAND.mute },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
        contents: [
          { type: 'button', style: 'primary', color: BRAND.accent, height: 'sm',
            action: { type: 'uri', label: '⬇️ ดาวน์โหลด PDF', uri: url } },
          { type: 'text', text: 'แนะนำให้เซฟไฟล์เก็บไว้ในเครื่อง\nลิงก์ใช้ได้ชั่วคราวและจำกัดจำนวนครั้ง',
            size: 'xxs', color: BRAND.mute, align: 'center', wrap: true },
        ],
      },
    },
  };
}

/* ══════════ order helpers ══════════ */
async function latestOrderOf(userId) {
  const rows = await C.sbSelect('orders?select=*&source=eq.line'
    + '&source_reference=eq.' + encodeURIComponent(userId)
    + '&order=created_at.desc&limit=1');
  return rows[0] || null;
}

/** ลิงก์หน้า QR — พก lookup token ไปด้วยเพราะเบราว์เซอร์ใน LINE ไม่มี localStorage ของเรา */
const payUrlOf = (orderNumber, token) =>
  `${APP_BASE}/pay.html?o=${encodeURIComponent(orderNumber)}&t=${encodeURIComponent(token)}`;

/** ออก download token ใบใหม่ (ของเดิมใช้ไม่ได้ทันที — เก็บแค่ hash) */
async function freshDownloadUrl(order) {
  const delivery = await C.getDelivery(order.id);
  if (!delivery) return null;
  if (!['READY', 'DELIVERED', 'DOWNLOADED'].includes(delivery.delivery_status)) return null;
  if (delivery.download_expires_at && new Date(delivery.download_expires_at) < new Date()) return null;
  if (Number(delivery.download_count) >= Number(delivery.max_downloads)) return null;

  const token = C.randomToken(32);
  await C.sbUpdate('deliveries', { id: delivery.id },
    { download_token_hash: C.sha256(token), updated_at: C.nowISO() });
  return C.downloadUrl(token);
}

/* ══════════ actions ══════════ */
async function showProduct(replyToken) {
  const product = await C.getProduct(PRODUCT_CODE);
  if (!product || product.status !== 'ACTIVE') {
    trace('product_unavailable', { found: !!product });
    return reply(replyToken, text('ตอนนี้ยังไม่เปิดขายคู่มือค่ะ ลองใหม่อีกครั้งภายหลังนะคะ'));
  }
  return reply(replyToken, productFlex(product));
}

async function buy(userId, replyToken) {
  const product = await C.getProduct(PRODUCT_CODE);
  if (!product || product.status !== 'ACTIVE') {
    return reply(replyToken, text('ตอนนี้ยังไม่เปิดขายคู่มือค่ะ'));
  }

  // มีคำสั่งซื้อค้างอยู่แล้ว → ใช้ใบเดิม ไม่สร้างซ้ำ
  const prev = await latestOrderOf(userId);
  if (prev && (prev.status === 'PAID' || prev.status === 'DELIVERED')) {
    const url = await freshDownloadUrl(prev);
    if (url) {
      return reply(replyToken, [
        text('คุณซื้อคู่มือเล่มนี้ไปแล้วค่ะ ส่งลิงก์ดาวน์โหลดให้อีกครั้งนะคะ'),
        downloadFlex(prev, url),
      ]);
    }
  }

  let order = (prev && prev.status === 'PENDING_PAYMENT') ? prev : null;
  let lookupToken = null;

  if (!order) {
    const created = await C.createOrder({
      product_code: PRODUCT_CODE, source: 'line', source_reference: userId,
    });
    if (created.error) {
      console.error('[line-ebook] createOrder', created.error);
      return reply(replyToken, text('ระบบสร้างคำสั่งซื้อไม่สำเร็จค่ะ รบกวนลองใหม่อีกครั้งนะคะ'));
    }
    order = created.order;
    lookupToken = created.lookupToken;
  } else {
    // ใบเดิม: ไม่ได้เก็บ token ดิบไว้ → ออกใบใหม่แทน token เดิม
    lookupToken = C.randomToken(24);
    await C.sbUpdate('orders', { id: order.id },
      { lookup_token_hash: C.sha256(lookupToken), updated_at: C.nowISO() });
  }

  const pay = await C.createPayment(order, product);
  if (pay.error) {
    console.error('[line-ebook] createPayment', pay.error);
    return reply(replyToken, text(
      'ยังสร้างรายการชำระเงินไม่สำเร็จค่ะ รบกวนพิมพ์ "ซื้อ" อีกครั้งนะคะ'));
  }
  if (pay.alreadyPaid) {
    const url = await freshDownloadUrl(order);
    return reply(replyToken, url
      ? downloadFlex(order, url)
      : text('คำสั่งซื้อนี้ชำระเงินแล้วค่ะ กำลังเตรียมไฟล์ให้ สักครู่นะคะ'));
  }

  const qr = pay.payment && pay.payment.provider_payload && pay.payment.provider_payload.qr;
  return reply(replyToken, payFlex(order, payUrlOf(order.order_number, lookupToken),
    qr && qr.expiry));
}

async function status(userId, replyToken) {
  const order = await latestOrderOf(userId);
  if (!order) {
    return reply(replyToken, text('ยังไม่พบคำสั่งซื้อของคุณค่ะ พิมพ์ "คู่มือ" เพื่อดูรายละเอียดได้เลยนะคะ'));
  }

  if (order.status === 'PAID' || order.status === 'DELIVERED') {
    const url = await freshDownloadUrl(order);
    return reply(replyToken, url
      ? downloadFlex(order, url)
      : text('ชำระเงินเรียบร้อยแล้วค่ะ แต่ลิงก์ดาวน์โหลดหมดอายุหรือครบจำนวนครั้งแล้ว\n'
        + 'รบกวนแจ้งเลขที่คำสั่งซื้อ ' + order.order_number + ' ไว้ เดี๋ยวแอดมินช่วยดูให้นะคะ'));
  }

  // ยังไม่จ่าย → ส่งลิงก์หน้า QR ใหม่ (หมุน lookup token)
  const token = C.randomToken(24);
  await C.sbUpdate('orders', { id: order.id },
    { lookup_token_hash: C.sha256(token), updated_at: C.nowISO() });

  const payment = await C.latestPayment(order.id);
  const qr = payment && payment.provider_payload && payment.provider_payload.qr;

  return reply(replyToken, [
    text('ยังไม่พบการชำระเงินของคำสั่งซื้อ ' + order.order_number + ' ค่ะ'),
    payFlex(order, payUrlOf(order.order_number, token), qr && qr.expiry),
  ]);
}

/* ══════════ entry points ══════════ */

/** ข้อความที่ถือว่า "สนใจคู่มือ" */
const WANT_RE = /(คู่มือ|ebook|e-book|อีบุ๊?ก|หนังสือ|ซื้อ|สั่งซื้อ|ราคา|เท่าไห?ร่|สนใจ|playbook)/i;
const STATUS_RE = /(สถานะ|จ่ายแล้ว|โอนแล้ว|ดาวน์โหลด|download|ลิงก์|ไฟล์|ยังไม่ได้รับ)/i;

/** คืน true ถ้าจัดการ event นี้แล้ว (ผู้เรียกจะได้ไม่ทำต่อ) */
/* log สั้น ๆ ให้ตามรอยได้ใน Vercel Logs — ไม่มีข้อความลูกค้าและไม่มีค่าลับ */
function trace(step, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'LINE_EBOOK', step, ...extra }));
}

async function handleEvent(ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId) { trace('no_user_id', { type: ev.type }); return false; }

  if (ev.type === 'postback') {
    const data = String((ev.postback && ev.postback.data) || '');
    if (data.includes('action=ebook_buy')) {
      trace('postback_buy'); await buy(userId, ev.replyToken); return true;
    }
    if (data.includes('action=ebook_status')) {
      trace('postback_status'); await status(userId, ev.replyToken); return true;
    }
    return false;
  }

  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    const t = String(ev.message.text || '');
    if (STATUS_RE.test(t)) { trace('match_status'); await status(userId, ev.replyToken); return true; }
    if (WANT_RE.test(t)) {
      trace('match_want');
      const ok = await showProduct(ev.replyToken);
      trace('reply_sent', { ok: !!ok });
      return true;
    }
    trace('text_no_match', { len: t.length });   // ไม่เก็บข้อความลูกค้า เก็บแค่ความยาว
  }
  return false;
}

/** เรียกจาก webhook ของ Beam หลังสร้าง delivery สำเร็จ */
async function notifyDelivered(order) {
  if (!order || order.source !== 'line' || !order.source_reference) return false;
  const url = await freshDownloadUrl(order);
  if (!url) return false;
  return push(order.source_reference, downloadFlex(order, url));
}

module.exports = { handleEvent, notifyDelivered, showProduct, buy, status, push, reply };