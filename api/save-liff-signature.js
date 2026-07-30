const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {})
    }
  })
  const text = await res.text()
  try { return { data: JSON.parse(text), status: res.status } }
  catch { return { data: text, status: res.status } }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { contract_id, token, party, sig_base64, signed_at, line_user_id, device } = req.body || {}

  if (!contract_id) return res.status(400).json({ error: 'contract_id จำเป็น' })
  if (!token) return res.status(400).json({ error: 'token จำเป็น' })
  if (!['tn','tn2','ll'].includes(party)) return res.status(400).json({ error: 'party ต้องเป็น tn | tn2 | ll' })
  if (!sig_base64 || !sig_base64.startsWith('data:image/')) return res.status(400).json({ error: 'sig_base64 ไม่ถูกต้อง' })

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || null

  const TOKEN_COL = { tn: 'tenant_read_token', tn2: 'tenant2_read_token', ll: 'landlord_read_token' }
  const tokenCol = TOKEN_COL[party]

  const verify = await sbFetch(`/contracts?id=eq.${contract_id}&${tokenCol}=eq.${encodeURIComponent(token)}&select=id`)
  if (!verify.data || verify.data.length === 0) return res.status(403).json({ error: 'token ไม่ถูกต้อง' })

  const UPDATES = {
    tn:  { tenant_signature: sig_base64, tenant_signed_at: signed_at || new Date().toISOString(), tn_sign_ip: ip, tn_sign_device: (device||'').slice(0,200), tn_line_user_id: line_user_id, tenant_read_confirmed: true },
    tn2: { tenant2_signature: sig_base64, tenant2_signed_at: signed_at || new Date().toISOString(), tn2_sign_ip: ip, tn2_sign_device: (device||'').slice(0,200), tn2_line_user_id: line_user_id, tenant2_read_confirmed: true },
    ll:  { landlord_signature: sig_base64, landlord_signed_at: signed_at || new Date().toISOString(), ll_sign_ip: ip, ll_sign_device: (device||'').slice(0,200), ll_line_user_id: line_user_id }
  }

  const update = await sbFetch(`/contracts?id=eq.${contract_id}`, {
    method: 'PATCH',
    body: JSON.stringify(UPDATES[party])
  })

  if (update.status >= 400) {
    console.error('[save-liff-sig] update failed:', update.data)
    return res.status(500).json({ error: 'บันทึกไม่สำเร็จ' })
  }

  console.log('[save-liff-sig] success:', contract_id, party, ip)
  return res.status(200).json({ ok: true, party, contract_id })
}