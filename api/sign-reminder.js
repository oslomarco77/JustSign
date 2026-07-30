// ═══════════════════════════════════════════════════════════════
// /api/sign-reminder.js — SignDee Signing Reminder Cron Job
// ───────────────────────────────────────────────────────────────
// ทำงานทุก 10 นาที (กำหนดใน vercel.json)
// Logic:
//   1. หา contracts ที่ payment_completed=true แต่ยังไม่ครบทุกฝ่าย
//   2. เช็คว่าผ่านไปกี่นาทีจาก reminder_started_at
//   3. ถ้า < 30 นาที → push LINE reminder ให้ฝ่ายที่ยังไม่เซ็น
//   4. ถ้า > 30 นาที → mark reminder_stopped=true หยุด
//   5. ถ้าเซ็นครบ → trigger send-contract-pdf
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const LINE_CHANNEL_TOKEN   = process.env.LINE_CHANNEL_TOKEN
const SELF_URL             = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://justsign-api.vercel.app'

// ── Supabase REST helper ──
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

// ── LINE Push ──
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
  return res.ok
}

// ── LIFF signing URL ──
function buildSignUrl(contractId, token, party) {
  return `https://liff.line.me/2010446677-pGlyP8jM?liff_sign=1&cid=${contractId}&ttoken=${token}&party=${party}`
}

// ── Reminder Flex Message ──
function buildReminderFlex(contract, party, attemptNo) {
  const partyLabel = party === 'tn2' ? 'ผู้เช่าคนที่ 2' : party === 'll' ? 'ผู้ให้เช่า' : 'ผู้เช่า'
  const token = party === 'tn2' ? contract.tenant2_read_token
              : party === 'll'  ? contract.landlord_read_token
              :                   contract.tenant_read_token
  const signingUrl  = buildSignUrl(contract.id, token, party)
  const prop        = contract.property_name || 'ทรัพย์สิน'
  const room        = contract.room_no ? ` ห้อง ${contract.room_no}` : ''
  const isLast      = attemptNo >= 3
  const headerColor = isLast ? '#C0392B' : '#1a1916'
  const headerText  = isLast ? '⚠️ แจ้งเตือนครั้งสุดท้าย' : `🔔 แจ้งเตือนครั้งที่ ${attemptNo}/3`
  const bodyText    = isLast
    ? 'นี่คือการแจ้งเตือนครั้งสุดท้าย กรุณาเซ็นสัญญาโดยเร็วที่สุด'
    : 'กรุณากดปุ่มด้านล่างเพื่ออ่านและลงลายมือชื่อในสัญญา'

  return {
    type: 'flex',
    altText: `${headerText} — กรุณาเซ็นสัญญาเช่า ${prop}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: headerColor, paddingAll: '16px',
        contents: [
          { type: 'text', text: headerText, color: '#ffffff', size: 'sm', weight: 'bold' },
          { type: 'text', text: 'SignDee · สัญญาเช่ารอลายเซ็น', color: 'rgba(255,255,255,0.6)', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: `${partyLabel} — ยังไม่ได้ลงนาม`, weight: 'bold', size: 'md', color: '#111111' },
          { type: 'text', text: `📍 ${prop}${room}`, size: 'sm', color: '#666666', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: bodyText, size: 'sm', color: '#444444', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [{
          type: 'button', style: 'primary', color: '#06c755',
          action: { type: 'uri', label: '✍️ เซ็นสัญญาเลย', uri: signingUrl },
        }],
      },
    },
  }
}

// ── Completion Flex (เซ็นครบแล้ว) ──
function buildCompletionFlex(contract, party) {
  const partyLabel = party === 'tn2' ? 'ผู้เช่าคนที่ 2' : party === 'll' ? 'ผู้ให้เช่า' : 'ผู้เช่า'
  const prop       = contract.property_name || 'ทรัพย์สิน'
  const room       = contract.room_no ? ` ห้อง ${contract.room_no}` : ''

  return {
    type: 'flex',
    altText: `✅ สัญญาเช่า ${prop} ลงนามครบแล้ว — PDF กำลังส่งให้`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: '#1a7a5a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '✅ ลงนามครบทุกฝ่ายแล้ว!', color: '#ffffff', size: 'md', weight: 'bold' },
          { type: 'text', text: 'SignDee · สัญญาเช่าสมบูรณ์', color: 'rgba(255,255,255,0.6)', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: `สำเนาสัญญาเช่าของ ${partyLabel}`, weight: 'bold', size: 'sm', color: '#111111', wrap: true },
          { type: 'text', text: `📍 ${prop}${room}`, size: 'sm', color: '#666666', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: 'ไฟล์ PDF สัญญาฉบับสมบูรณ์จะถูกส่งมาในข้อความถัดไป', size: 'sm', color: '#444444', wrap: true, margin: 'md' },
        ],
      },
    },
  }
}

// ── เช็คว่าเซ็นครบทุกฝ่ายหรือยัง ──
function isFullySigned(contract) {
  const hasTn  = !!contract.tenant_signed_at
  const hasTn2 = !contract.has_tenant2 || !!contract.tenant2_signed_at
  const hasLl  = !!contract.landlord_signed_at
  return hasTn && hasTn2 && hasLl
}

// ── เช็ค completion เฉพาะสัญญาเดียว (เรียกจากหน้า LIFF หลังเซ็น) ──
async function handleSignEvent(contractId) {
  const { data } = await sbFetch(`/contracts?id=eq.${encodeURIComponent(contractId)}&select=*&limit=1`)
  const contract = Array.isArray(data) ? data[0] : null
  if (!contract) return { ok: false, error: 'not_found' }
  if (contract.pdf_sent_at) return { ok: true, action: 'already_done' }   // กันแจ้งซ้ำ
  if (!isFullySigned(contract)) return { ok: true, action: 'not_complete_yet' }
  await triggerPdf(contract)                                              // แจ้งผู้ให้เช่า+ผู้เช่า + PDF
  return { ok: true, action: 'completed_notified' }
}

// ── Main Handler ──
export default async function handler(req, res) {
  // CORS (เผื่อ preflight จากหน้า LIFF)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // ── โหมด POST: เช็ก "เซ็นครบ" ของสัญญาเดียว → แจ้งผู้ให้เช่า + ส่ง PDF ทันที ──
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
      const cid = body.contract_id
      if (!cid) return res.status(400).json({ ok: false, error: 'contract_id required' })
      const r = await handleSignEvent(cid)
      return res.status(200).json(r)
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) })
    }
  }

  // ── โหมด GET (cron เดิม): ตรวจทุกสัญญา ส่ง reminder/completion ──
  // Vercel Cron inject Authorization header อัตโนมัติ
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  console.log('[sign-reminder] cron started:', new Date().toISOString())

  // ดึง contracts ที่ต้อง process
  const { data: contracts, status } = await sbFetch(
    `/contracts?payment_completed=eq.true&reminder_stopped=neq.true&reminder_started_at=not.is.null&pdf_sent_at=is.null&select=*&limit=50`
  )

  if (status >= 400 || !Array.isArray(contracts)) {
    console.error('[sign-reminder] fetch error:', contracts)
    return res.status(500).json({ error: 'fetch failed', detail: contracts })
  }

  console.log(`[sign-reminder] ${contracts.length} contracts to process`)
  const results = []

  for (const contract of contracts) {
    try {
      const r = await processContract(contract)
      results.push({ id: contract.id, ...r })
      console.log(`[sign-reminder] ${contract.id}:`, r)
    } catch (e) {
      console.error('[sign-reminder] error:', contract.id, e.message)
      results.push({ id: contract.id, error: e.message })
    }
  }

  return res.status(200).json({ ok: true, processed: contracts.length, results })
}

async function processContract(contract) {
  // เซ็นครบ → PDF
  if (isFullySigned(contract)) {
    await triggerPdf(contract)
    return { action: 'pdf_triggered' }
  }

  const now          = new Date()
  const startedAt    = new Date(contract.reminder_started_at)
  const elapsedMin   = (now - startedAt) / 60000
  const reminderCount = contract.reminder_count || 0

  // เกิน 30 นาที → หยุด
  if (elapsedMin > 30) {
    await sbFetch(`/contracts?id=eq.${contract.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ reminder_stopped: true }),
    })
    return { action: 'stopped', elapsed_min: Math.round(elapsedMin) }
  }

  // เช็คว่าถึงเวลา reminder ครั้งถัดไปหรือยัง (แต่ละครั้งห่างกัน 10 นาที)
  const nextAt = (reminderCount + 1) * 10
  if (elapsedMin < nextAt - 1) {
    return { action: 'wait', next_at_min: nextAt, elapsed_min: Math.round(elapsedMin) }
  }

  const attemptNo = reminderCount + 1
  const pushed    = []

  // ส่ง reminder ให้ฝ่ายที่ยังไม่เซ็น
  if (!contract.tenant_signed_at && contract.tn_line_user_id) {
    await pushLine(contract.tn_line_user_id, [buildReminderFlex(contract, 'tn', attemptNo)])
    pushed.push('tn')
  }
  if (contract.has_tenant2 && !contract.tenant2_signed_at && contract.tn2_line_user_id) {
    await pushLine(contract.tn2_line_user_id, [buildReminderFlex(contract, 'tn2', attemptNo)])
    pushed.push('tn2')
  }
  if (!contract.landlord_signed_at && contract.ll_line_user_id) {
    await pushLine(contract.ll_line_user_id, [buildReminderFlex(contract, 'll', attemptNo)])
    pushed.push('ll')
  }

  // อัปเดต counter
  await sbFetch(`/contracts?id=eq.${contract.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      reminder_count: attemptNo,
      reminder_stopped: attemptNo >= 3,
    }),
  })

  return { action: 'reminded', attempt: attemptNo, pushed }
}

async function triggerPdf(contract) {
  await fetch(`${SELF_URL}/api/send-contract-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract_id: contract.id }),
  })

  // แจ้งผู้ให้เช่าก่อน
  if (contract.ll_line_user_id) {
    await pushLine(contract.ll_line_user_id, [buildCompletionFlex(contract, 'll')])
  }
  // แจ้งผู้เช่า
  if (contract.tn_line_user_id) {
    await pushLine(contract.tn_line_user_id, [buildCompletionFlex(contract, 'tn')])
  }
  if (contract.has_tenant2 && contract.tn2_line_user_id) {
    await pushLine(contract.tn2_line_user_id, [buildCompletionFlex(contract, 'tn2')])
  }

  await sbFetch(`/contracts?id=eq.${contract.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ reminder_stopped: true, pdf_sent_at: new Date().toISOString() }),
  })
}
