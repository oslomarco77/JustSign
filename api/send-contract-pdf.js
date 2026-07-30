// ═══════════════════════════════════════════════════════════════
// /api/send-contract-pdf.js — Generate PDF URL + ส่งผ่าน LINE
// ───────────────────────────────────────────────────────────────
// เรียกจาก sign-reminder.js เมื่อเซ็นครบทุกฝ่าย
// Strategy: ส่ง download link ผ่าน LINE (PDF ที่มีอยู่แล้วใน app)
// เพราะ LINE ไม่รองรับ push PDF file โดยตรง → ส่งเป็น link แทน
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const LINE_CHANNEL_TOKEN   = process.env.LINE_CHANNEL_TOKEN
const APP_URL              = 'https://app.signdee.com'

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  try { return { data: JSON.parse(text), status: res.status } }
  catch { return { data: text, status: res.status } }
}

async function pushLine(userId, messages) {
  if (!userId || !LINE_CHANNEL_TOKEN) return false
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error('[send-pdf] LINE push error:', err)
  }
  return res.ok
}

// ── PDF download link Flex Message ──
function buildPdfFlex(contract, party) {
  const partyLabel = party === 'tn2' ? 'ผู้เช่าคนที่ 2' : party === 'll' ? 'ผู้ให้เช่า' : 'ผู้เช่า'
  const prop       = contract.property_name || 'ทรัพย์สิน'
  const room       = contract.room_no ? ` ห้อง ${contract.room_no}` : ''

  // URL สำหรับดาวน์โหลด PDF — เปิด app แล้ว auto-download
  // reload URL จะโหลดสัญญากลับมาพร้อมปุ่ม download PDF
  const downloadUrl = `${APP_URL}/?reload=${contract.id}&autodownload=1`

  // วันที่บนสัญญา
  const signedDate = contract.landlord_signed_at
    ? new Date(contract.landlord_signed_at).toLocaleDateString('th-TH', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })

  return {
    type: 'flex',
    altText: `📄 สัญญาเช่า ${prop} พร้อมดาวน์โหลดแล้ว`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: '#1a1916', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📄 สัญญาเช่าฉบับสมบูรณ์', color: '#c9a84c', size: 'md', weight: 'bold' },
          { type: 'text', text: 'SignDee · พร้อมใช้งาน', color: 'rgba(255,255,255,0.6)', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: 'ทรัพย์สิน', size: 'xs', color: '#888888', flex: 2 },
              { type: 'text', text: `${prop}${room}`, size: 'xs', color: '#111111', flex: 5, wrap: true },
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs',
            contents: [
              { type: 'text', text: 'วันที่เซ็น', size: 'xs', color: '#888888', flex: 2 },
              { type: 'text', text: signedDate, size: 'xs', color: '#111111', flex: 5 },
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs',
            contents: [
              { type: 'text', text: 'สำเนาของ', size: 'xs', color: '#888888', flex: 2 },
              { type: 'text', text: partyLabel, size: 'xs', color: '#111111', flex: 5, weight: 'bold' },
            ],
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '✅ ลงนามครบทุกฝ่ายแล้ว — สัญญามีผลผูกพันตามกฎหมาย',
            size: 'xs', color: '#1a7a5a', wrap: true, margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          {
            type: 'button', style: 'primary', color: '#1a1916', height: 'sm',
            action: { type: 'uri', label: '⬇️ ดาวน์โหลด PDF สัญญา', uri: downloadUrl },
          },
          {
            type: 'text',
            text: 'เก็บสัญญาไว้เป็นหลักฐาน — ไฟล์จะถูกเก็บไว้ 60 วัน',
            size: 'xxs', color: '#999999', align: 'center', wrap: true, margin: 'sm',
          },
        ],
      },
    },
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { contract_id } = req.body || {}
  if (!contract_id) return res.status(400).json({ error: 'contract_id จำเป็น' })

  // ดึงข้อมูล contract
  const { data: rows, status } = await sbFetch(
    `/contracts?id=eq.${contract_id}&select=*&limit=1`
  )
  if (status >= 400 || !rows || !rows[0]) {
    return res.status(404).json({ error: 'ไม่พบ contract' })
  }
  const contract = rows[0]

  // ป้องกันส่งซ้ำ
  if (contract.pdf_sent_at) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'already_sent' })
  }

  const sent = []

  // ส่งให้ผู้ให้เช่า
  if (contract.ll_line_user_id) {
    await pushLine(contract.ll_line_user_id, [buildPdfFlex(contract, 'll')])
    sent.push('ll')
  }
  // ส่งให้ผู้เช่า
  if (contract.tn_line_user_id) {
    await pushLine(contract.tn_line_user_id, [buildPdfFlex(contract, 'tn')])
    sent.push('tn')
  }
  // ส่งให้ผู้เช่าคนที่ 2 (ถ้ามี)
  if (contract.has_tenant2 && contract.tn2_line_user_id) {
    await pushLine(contract.tn2_line_user_id, [buildPdfFlex(contract, 'tn2')])
    sent.push('tn2')
  }

  // Mark pdf_sent_at
  await sbFetch(`/contracts?id=eq.${contract_id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ pdf_sent_at: new Date().toISOString() }),
  })

  console.log('[send-pdf] sent to:', sent, 'contract:', contract_id)
  return res.status(200).json({ ok: true, contract_id, sent })
}
