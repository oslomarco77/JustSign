const https = require('https');

// ── GET request ไปยัง Opn (Omise) ──
function omiseGet(path, secretKey) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(secretKey + ':').toString('base64');
    const options = {
      hostname: 'api.omise.co',
      path, method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad Opn response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── PATCH ไปยัง Supabase (อัปเดต row) ด้วย service_role key ──
function supabaseUpdate(rowId, fields, supabaseUrl, serviceKey, table) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(fields);
    const tbl = (table === 'nda_contracts') ? 'nda_contracts' : 'contracts';  // whitelist
    const url = new URL(`${supabaseUrl}/rest/v1/${tbl}?id=eq.${encodeURIComponent(rowId)}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error('Supabase update failed: ' + res.statusCode + ' ' + d));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { chargeId, contractRowId, sessionId, table, testSkip } = req.body || {};

    const supaUrl    = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const tbl        = (table === 'nda_contracts') ? 'nda_contracts' : 'contracts';

    // ── Staging test-skip (เปิดด้วย env ALLOW_TEST_SKIP=1 เท่านั้น — ห้ามตั้งใน production) ──
    if (testSkip === true) {
      if (process.env.ALLOW_TEST_SKIP !== '1')
        return res.status(403).json({ error: 'test_skip_disabled' });
      if (!contractRowId) return res.status(400).json({ error: 'Missing contractRowId' });
      await supabaseUpdate(contractRowId, {
        payment_completed: true,
        payment_ref: 'TEST_SKIP_' + Date.now()
      }, supaUrl, serviceKey, tbl);
      return res.status(200).json({ paid: true, ref: 'test_skip', status: 'test_skip' });
    }

    if (!chargeId) return res.status(400).json({ error: 'Missing chargeId' });

    const secretKey = process.env.OMISE_SECRET_KEY;

    // 1. ถาม Opn ว่า charge นี้สถานะอะไร (แหล่งความจริงเดียว — client ปลอมไม่ได้)
    const charge = await omiseGet(`/charges/${chargeId}`, secretKey);

    if (charge.object === 'error') {
      return res.status(400).json({ error: 'Invalid charge', detail: charge.message });
    }

    const isPaid = (charge.status === 'successful') && (charge.paid === true);

    if (!isPaid) {
      // ยังไม่จ่าย / ล้มเหลว / หมดอายุ / pending
      return res.status(200).json({ paid: false, status: charge.status });
    }

    // 2. กันเอา charge ที่จ่ายแล้วของ session อื่นมาใช้ข้ามสัญญา
    if (sessionId && charge.metadata && charge.metadata.session_id
        && charge.metadata.session_id !== sessionId) {
      return res.status(403).json({ error: 'Charge does not belong to this session' });
    }

    // 3. จ่ายจริง → backend เขียน payment_completed ด้วย service_role
    //    (ฝั่ง client/anon เขียน column นี้ไม่ได้ เพราะมี trigger ป้องกันใน Supabase)
    if (contractRowId && supaUrl && serviceKey) {
      await supabaseUpdate(contractRowId, {
        payment_completed: true,
        payment_ref: chargeId
      }, supaUrl, serviceKey, tbl);
    }

    return res.status(200).json({ paid: true, ref: chargeId, status: charge.status });

  } catch (err) {
    console.error('verify-charge error:', err);
    return res.status(500).json({ error: err.message });
  }
};
