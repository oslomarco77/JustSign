// POST /api/commerce/orders — สร้างคำสั่งซื้อ (ช่องทางไหนก็เรียกได้)
//
// body: { product_code, source?, source_reference?, utm_*?, customer_*?, pain_category? }
// ราคามาจากตาราง products เท่านั้น — ไม่เคยเชื่อ amount จาก client

const C = require('../../_commerce.js');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return C.json(res, 405, { error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return C.badRequest(res, 'invalid_body');

  const result = await C.createOrder(body);

  if (result.error) {
    const code = ({
      product_code_required: 400,
      product_not_found: 404,
      product_inactive: 409,
    })[result.error] || 500;
    return C.json(res, code, { error: result.error });
  }

  const { order, lookupToken } = result;

  return C.json(res, 201, {
    order_id: order.id,
    order_number: order.order_number,
    product_code: order.product_code,
    amount: Number(order.amount),          // minor unit (สตางค์)
    currency: order.currency,
    status: order.status,
    // token นี้แสดงครั้งเดียว — ใช้เปิดดูสถานะคำสั่งซื้อภายหลัง
    lookup_token: lookupToken,
  });
};
