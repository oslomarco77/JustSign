// ═══════════════════════════════════════════════════════════════
// /api/start-reminder.js — เริ่ม reminder timer ตอนส่งลิงก์เซ็น
// ───────────────────────────────────────────────────────────────
// เรียกจาก index-test-liff.html ตอนผู้ให้เช่ากด "ส่งลิงก์เซ็นผ่าน LINE"
// แยกออกจาก payment endpoint โดยสิ้นเชิง → index.html ปลอดภัย 100%
//
// Body: { contract_id }
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const contractId = body.contract_id
  if (!contractId) return res.status(400).json({ error: 'contract_id จำเป็น' })

  // เช็คก่อนว่า contract มีจริง และยังไม่เริ่ม reminder
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}&select=id,reminder_started_at`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  )
  const rows = await checkRes.json()
  if (!Array.isArray(rows) || !rows[0]) {
    return res.status(404).json({ error: 'ไม่พบสัญญา' })
  }

  // ถ้าเริ่มไปแล้ว → ไม่ reset (กันกดซ้ำ)
  if (rows[0].reminder_started_at) {
    return res.status(200).json({ ok: true, already_started: true })
  }

  // เริ่ม reminder timer ด้วย service_role (เขียน protected column ได้)
  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/contracts?id=eq.${encodeURIComponent(contractId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        reminder_started_at: new Date().toISOString(),
        reminder_count: 0,
        reminder_stopped: false,
      }),
    }
  )

  if (!patchRes.ok) {
    const detail = await patchRes.text()
    return res.status(500).json({ error: 'เริ่ม reminder ไม่สำเร็จ', detail })
  }

  console.log('[start-reminder] started for:', contractId)
  return res.status(200).json({ ok: true, contract_id: contractId })
}
