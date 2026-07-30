// ============================================================
//  SignDee — Admin Stats Endpoint  (/api/admin-stats)
//  วางไฟล์นี้ใน  D:\justsign-api\api\admin-stats.js  แล้ว deploy
//
//  ความปลอดภัย:
//   - ใช้ service_role (ฝั่ง server เท่านั้น) → bypass RLS อ่านข้อมูลรวมได้
//   - ป้องกันด้วยรหัสผ่าน ADMIN_PASSWORD (ไม่ผ่าน = 401)
//   - anon key ไม่เกี่ยวข้องเลย → ข้อมูลลูกค้าไม่รั่วทาง client
//
//  ENV ที่ต้องมีใน Vercel (Production):
//   - SUPABASE_URL                 (เช่น https://xxxx.supabase.co)
//   - SUPABASE_SERVICE_ROLE_KEY    (service_role key — ลับสุด)
//   - ADMIN_PASSWORD               (รหัสผ่านเข้า dashboard ที่ตั้งเอง)
//  (ถ้า function จ่ายเงินเดิมใช้ชื่อ env อื่นสำหรับ Supabase ให้ใช้ชื่อเดิมได้ — มี fallback ด้านล่าง)
// ============================================================

module.exports = async (req, res) => {
  // ---------- CORS ----------
  res.setHeader('Access-Control-Allow-Origin', '*'); // password คือปราการจริง
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // ---------- Auth ----------
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const key = (req.headers['x-admin-key'] || (body && body.key) || '').toString();
  const ADMIN = process.env.ADMIN_PASSWORD;
  if (!ADMIN) return res.status(500).json({ error: 'admin_password_not_set' });
  if (key !== ADMIN) return res.status(401).json({ error: 'unauthorized' });

  // ---------- Supabase config ----------
  const SB = process.env.SUPABASE_URL || process.env.SB_URL;
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!SB || !SR) return res.status(500).json({ error: 'supabase_config_missing' });
  const headers = { apikey: SR, Authorization: 'Bearer ' + SR };

  const q = async (path) => {
    const r = await fetch(SB.replace(/\/$/, '') + '/rest/v1/' + path, { headers });
    if (!r.ok) throw new Error('supabase ' + r.status + ' on ' + path);
    return r.json();
  };

  try {
    const sinceISO = new Date(Date.now() - 14 * 86400000).toISOString();
    const [summary, revenue, contracts, recent] = await Promise.all([
      q('v_dashboard_summary?select=*'),
      q('v_revenue_by_month?select=*'),
      q('v_contracts_list?select=*&limit=50'),
      q('contracts?select=created_at&created_at=gte.' + encodeURIComponent(sinceISO)),
    ]);

    // bucket รายวัน 14 วันล่าสุด
    const map = {};
    for (let i = 13; i >= 0; i--) map[new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)] = 0;
    for (const r of (recent || [])) {
      const k = (r.created_at || '').slice(0, 10);
      if (k in map) map[k]++;
    }
    const daily = Object.keys(map).map(k => ({ date: k, count: map[k] }));

    return res.status(200).json({
      summary: (summary && summary[0]) || {},
      revenue: revenue || [],     // [{month, paid_contracts, revenue_thb}]  (เรียง DESC)
      contracts: contracts || [], // [{id, created_at, status_th, landlord_name, tenant_name, property, room_no, rent, payment_completed,...}]
      daily,                      // [{date, count}]
    });
  } catch (e) {
    return res.status(500).json({ error: 'query_failed', detail: String(e && e.message || e) });
  }
};
