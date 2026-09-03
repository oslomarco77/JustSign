// GET /api/download/:token — ดาวน์โหลด eBook แบบควบคุม
//
// token ดิบไม่เคยถูกเก็บใน DB — เก็บแค่ sha256
// ตรวจ: token ถูก → order จ่ายแล้ว → ยังไม่หมดอายุ → ยังไม่เกินจำนวนครั้ง
// แล้วค่อย redirect ไป signed URL ของ Supabase Storage (อายุ 60 วินาที)

const C = require('../_commerce.js');

const PAGE = (title, msg, sub) => `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anuphan:wght@800&family=Sarabun:wght@400&display=swap">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F1F0EA;color:#14171F;
font-family:'Sarabun',system-ui,sans-serif;padding:24px}
.c{background:#FEFEFC;border:1px solid #E6E4DC;border-radius:16px;padding:32px;max-width:420px;text-align:center;
box-shadow:0 1px 2px rgba(11,18,32,.04),0 12px 32px -18px rgba(11,18,32,.2)}
h1{font-family:'Anuphan',sans-serif;font-size:20px;font-weight:800;margin:0 0 8px}
p{color:#5B6270;font-size:14.5px;line-height:1.75;margin:0}</style></head>
<body><div class="c"><h1>${msg}</h1><p>${sub}</p></div></body></html>`;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return C.json(res, 405, { error: 'method_not_allowed' });

  const token = (req.query && req.query.token) || '';
  const fail = async (code, msg, sub, reason) => {
    await C.logEvent('DOWNLOAD_DENIED', { level: 'warn', data: { reason } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(code).send(PAGE('SignDee', msg, sub));
  };

  if (!token || String(token).length < 20) {
    return fail(400, 'ลิงก์ไม่ถูกต้อง', 'กรุณากดลิงก์จากหน้ายืนยันการชำระเงินอีกครั้ง', 'malformed_token');
  }

  const hash = C.sha256(token);
  const delivery = (await C.sbSelect(
    `deliveries?select=*&download_token_hash=eq.${hash}&limit=1`))[0];

  if (!delivery) {
    return fail(404, 'ลิงก์ไม่ถูกต้องหรือถูกใช้แทนที่แล้ว',
      'ถ้าคุณเพิ่งขอลิงก์ใหม่ กรุณาใช้ลิงก์ล่าสุดที่ได้รับ', 'token_not_found');
  }

  // ── order ต้องจ่ายแล้วเท่านั้น ──
  const order = await C.findOrder(delivery.order_id);
  if (!order || !['PAID', 'DELIVERED'].includes(order.status)) {
    return fail(403, 'ยังไม่สามารถดาวน์โหลดได้',
      'ระบบยังไม่พบการชำระเงินของคำสั่งซื้อนี้', 'order_not_paid');
  }

  // ── หมดอายุ ──
  if (delivery.download_expires_at && new Date(delivery.download_expires_at) < new Date()) {
    await C.sbUpdate('deliveries', { id: delivery.id },
      { delivery_status: 'EXPIRED', updated_at: C.nowISO() });
    return fail(410, 'ลิงก์ดาวน์โหลดหมดอายุแล้ว',
      'กรุณาติดต่อผู้ดูแลเพื่อขอลิงก์ใหม่', 'expired');
  }

  // ── ครบจำนวนครั้ง ──
  const count = Number(delivery.download_count || 0);
  const max = Number(delivery.max_downloads || 5);
  if (count >= max) {
    return fail(429, 'ดาวน์โหลดครบจำนวนแล้ว',
      `ลิงก์นี้ดาวน์โหลดได้ ${max} ครั้ง ถ้าไฟล์หายกรุณาติดต่อผู้ดูแล`, 'limit_reached');
  }

  // ── สร้าง signed URL ของไฟล์จริง อายุ 60 วินาที ──
  const product = await C.getProduct(delivery.product_code);
  if (!product) return fail(500, 'เปิดไฟล์ไม่สำเร็จ', 'กรุณาติดต่อผู้ดูแล', 'product_missing');

  let signed = null;
  try {
    const r = await fetch(`${C.SB}/storage/v1/object/sign/${product.storage_bucket}/${product.storage_path}`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 60 }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      signed = j && j.signedURL;
    }
  } catch (_) { /* จัดการด้านล่าง */ }

  if (!signed) {
    return fail(500, 'เปิดไฟล์ไม่สำเร็จ',
      'ระบบจัดเก็บไฟล์ขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง', 'storage_failure');
  }

  // ── บันทึกการดาวน์โหลด ──
  const first = count === 0;
  await C.sbUpdate('deliveries', { id: delivery.id }, {
    download_count: count + 1,
    downloaded_at: delivery.downloaded_at || C.nowISO(),
    last_download_at: C.nowISO(),
    last_download_ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
    delivery_status: 'DOWNLOADED',
    updated_at: C.nowISO(),
  });

  await C.logEvent('DOWNLOAD_COMPLETED', {
    orderId: order.id, orderNumber: order.order_number,
    data: { download_count: count + 1, first_download: first, product_code: delivery.product_code },
  });

  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: `${C.SB}/storage/v1${signed}` });
  return res.end();
};
