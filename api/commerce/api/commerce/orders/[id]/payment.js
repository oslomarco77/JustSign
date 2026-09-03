// POST /api/commerce/orders/:id/payment — สร้างลิงก์ชำระเงิน Beam
//
// :id = order id (uuid) หรือ order_number ก็ได้
// IDEMPOTENT: เรียกซ้ำจะได้ payment ใบเดิม ไม่สร้าง session ซ้ำ

const C = require('../../../_commerce.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return C.json(res, 405, { error: 'method_not_allowed' });

  const id = (req.query && (req.query.id || req.query.orderId)) || null;
  if (!id) return C.badRequest(res, 'order_id_required');

  const order = await C.findOrder(id);
  if (!order) return C.json(res, 404, { error: 'order_not_found' });

  // ── จ่ายไปแล้ว: ไม่สร้างใหม่ ──
  if (order.status === 'PAID' || order.status === 'DELIVERED') {
    return C.json(res, 409, {
      error: 'order_already_paid',
      order_number: order.order_number,
      status: order.status,
    });
  }
  if (order.status !== 'PENDING_PAYMENT') {
    return C.json(res, 409, { error: 'order_not_payable', status: order.status });
  }

  const product = await C.getProduct(order.product_code);
  if (!product) return C.json(res, 500, { error: 'product_missing' });
  if (product.status !== 'ACTIVE') return C.json(res, 409, { error: 'product_inactive' });

  const out = await C.createPayment(order, product);

  if (out.error) {
    // Beam ล่ม / timeout → order ยังอยู่ ลองใหม่ได้
    return C.json(res, 502, {
      error: 'payment_provider_unavailable',
      message: 'ยังสร้างรายการชำระเงินไม่สำเร็จ กรุณาลองอีกครั้ง',
      order_number: order.order_number,
    });
  }

  if (out.alreadyPaid) {
    return C.json(res, 409, { error: 'order_already_paid', order_number: order.order_number });
  }

  return C.json(res, 200, {
    order_id: order.id,
    order_number: order.order_number,
    payment_id: out.payment.id,
    payment_url: out.payment.payment_url,
    status: out.payment.status,
    reused: !!out.reused,
  });
};
