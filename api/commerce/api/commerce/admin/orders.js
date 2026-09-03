// GET /api/commerce/admin/orders?key=<ADMIN_PASSWORD>[&limit=50][&status=PAID][&order_number=...]
//
// อ่านจาก view commerce_orders_admin — ไม่มีข้อมูลส่วนตัวลูกค้าและไม่มี token ใด ๆ
// convention เดียวกับ api/admin-stats.js เดิม

const C = require('../../_commerce.js');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return C.json(res, 405, { error: 'method_not_allowed' });

  const q = req.query || {};
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass || !C.timingSafeEqualStr(q.key || '', pass)) {
    return C.json(res, 401, { error: 'unauthorized' });
  }

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const filters = [`select=*`, `order=created_at.desc`, `limit=${limit}`];
  if (q.status) filters.push(`order_status=eq.${encodeURIComponent(q.status)}`);
  if (q.order_number) filters.push(`order_number=eq.${encodeURIComponent(q.order_number)}`);
  if (q.source) filters.push(`source=eq.${encodeURIComponent(q.source)}`);

  const rows = await C.sbSelect(`commerce_orders_admin?${filters.join('&')}`);
  const daily = await C.sbSelect('commerce_sales_daily?select=*&limit=14');

  return C.json(res, 200, {
    ok: true,
    // ให้เห็นว่าตอนนี้ commerce ยิงไป Beam ตัวไหน — ไม่มีค่าลับ มีแค่ base URL สาธารณะ
    beam: {
      env: C.BEAM_ENV || 'playground (default)',
      base: C.BEAM_BASE,
      amount_unit: C.BEAM_AMOUNT_UNIT,
      configured: C.beamConfigured(),
      webhook_secret_set: Boolean(process.env.BEAM_WEBHOOK_SECRET),
    },
    count: rows.length,
    orders: rows,
    sales_daily: daily,
  });
};
