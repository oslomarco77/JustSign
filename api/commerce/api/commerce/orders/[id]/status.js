// GET /api/commerce/orders/:id/status?t=<lookup_token>
//
// ต้องมี lookup_token เสมอ — เลขที่คำสั่งซื้อเดาได้ (SD-EBOOK-YYYYMMDD-000001)
// จึงไม่ปลอดภัยพอที่จะใช้เป็นกุญแจอย่างเดียว
// ไม่คืนข้อมูลส่วนตัวของลูกค้าและไม่คืน internal id

const C = require('../../../_commerce.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return C.json(res, 405, { error: 'method_not_allowed' });

  const q = req.query || {};
  const id = q.id || q.orderId;
  const token = q.t || q.token;

  if (!id) return C.badRequest(res, 'order_required');
  if (!token) return C.json(res, 401, { error: 'lookup_token_required' });

  const order = await C.findOrder(id);
  // ตอบเหมือนกันทั้งกรณีไม่มี order และ token ผิด — กันเดาเลขที่คำสั่งซื้อ
  if (!order || !C.timingSafeEqualStr(order.lookup_token_hash, C.sha256(token))) {
    return C.json(res, 404, { error: 'not_found' });
  }

  const payment = await C.latestPayment(order.id);
  const delivery = await C.getDelivery(order.id);

  const body = {
    order_number: order.order_number,
    status: order.status,
    payment_status: payment ? payment.status : null,
    delivery_status: delivery ? delivery.delivery_status : null,
    amount: Number(order.amount),
    currency: order.currency,
  };

  // ลิงก์ชำระเงิน / QR: คืนเฉพาะตอนที่ยังจ่ายไม่เสร็จ
  if (order.status === 'PENDING_PAYMENT' && payment
      && ['CREATED', 'PENDING'].includes(payment.status)) {
    if (payment.payment_url) body.payment_url = payment.payment_url;

    const qr = payment.provider_payload && payment.provider_payload.qr;
    if (qr && qr.image) {
      const expired = qr.expiry && Date.parse(qr.expiry) < Date.now();
      body.qr = expired
        ? { expired: true }
        : { image: qr.image, expires_at: qr.expiry || null };
    }
  }

  // ลิงก์ดาวน์โหลด: ออกใหม่ให้เฉพาะเมื่อจ่ายแล้วจริง
  // token ดิบไม่ได้เก็บไว้ จึงหมุน token ใหม่ทุกครั้งที่ขอ (hash เดิมถูกแทนที่)
  if (delivery && ['READY', 'DELIVERED', 'DOWNLOADED'].includes(delivery.delivery_status)) {
    const expired = delivery.download_expires_at && new Date(delivery.download_expires_at) < new Date();
    if (expired) {
      body.delivery_status = 'EXPIRED';
      body.message = 'ลิงก์ดาวน์โหลดหมดอายุแล้ว กรุณาติดต่อผู้ดูแล';
    } else if (Number(delivery.download_count) >= Number(delivery.max_downloads)) {
      body.message = 'ดาวน์โหลดครบจำนวนที่กำหนดแล้ว กรุณาติดต่อผู้ดูแล';
    } else {
      const fresh = C.randomToken(32);
      await C.sbUpdate('deliveries', { id: delivery.id },
        { download_token_hash: C.sha256(fresh), updated_at: C.nowISO() });
      body.download_url = C.downloadUrl(fresh);
      body.downloads_remaining = Number(delivery.max_downloads) - Number(delivery.download_count);
    }
  }

  return C.json(res, 200, body);
};
