// ============================================================
//  SignDee — LINE Webhook  (/api/line-webhook)
//  รวม lib ไว้ในไฟล์เดียว (Vercel Hobby: ทุก .js ใน api/ นับเป็น function → ห้ามมี api/lib/)
//
//  ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, LINE_CHANNEL_TOKEN, ANTHROPIC_API_KEY
// ============================================================

const crypto = require('crypto');

/* ══════════ helpers (เดิมอยู่ใน lib/reminder-lib.js) ══════════ */
const SB = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SR = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;

const sbHeaders = {
  apikey: SR,
  Authorization: 'Bearer ' + SR,
  'Content-Type': 'application/json',
};

/* ── Supabase REST ───────────────────────────────────────── */

// sbSelect('contracts?select=*&id=eq.xxx&limit=1') → array
async function sbSelect(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders });
  if (!r.ok) {
    console.error('[sbSelect]', r.status, path, await r.text().catch(() => ''));
    return [];
  }
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

// sbInsert('slip_hashes', {...})  ·  sbInsert(table, row, { upsert:true })
async function sbInsert(table, row, opts) {
  const prefer = (opts && opts.upsert)
    ? 'return=representation,resolution=merge-duplicates'
    : 'return=representation';
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: prefer },
    body: JSON.stringify(row),
  });
  if (r.status === 409) return { duplicate: true };
  if (!r.ok) {
    console.error('[sbInsert]', r.status, table, await r.text().catch(() => ''));
    return null;
  }
  return r.json().catch(() => null);
}

// sbUpdate('rent_cycles', { id: 'xxx' }, { status:'paid' })
async function sbUpdate(table, match, patch) {
  const qs = Object.entries(match)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const r = await fetch(`${SB}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) console.error('[sbUpdate]', r.status, table, await r.text().catch(() => ''));
  return r.ok;
}

// sbDelete('slip_await', { line_user_id: 'Uxxx' })
async function sbDelete(table, match) {
  const qs = Object.entries(match)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const r = await fetch(`${SB}/rest/v1/${table}?${qs}`, {
    method: 'DELETE',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
  });
  if (!r.ok) console.error('[sbDelete]', r.status, table, await r.text().catch(() => ''));
  return r.ok;
}

/* ── LINE Messaging API ──────────────────────────────────── */

// linePush(userId, message | [messages])
async function linePush(to, messages) {
  if (!to || !LINE_TOKEN) return false;
  const arr = Array.isArray(messages) ? messages : [messages];
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ to, messages: arr }),
  });
  if (!r.ok) console.error('[linePush]', r.status, await r.text().catch(() => ''));
  return r.ok;
}

// lineReply(replyToken, message | [messages])
async function lineReply(replyToken, messages) {
  if (!replyToken || !LINE_TOKEN) return false;
  const arr = Array.isArray(messages) ? messages : [messages];
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ replyToken, messages: arr }),
  });
  if (!r.ok) console.error('[lineReply]', r.status, await r.text().catch(() => ''));
  return r.ok;
}

// โหลดรูปที่ผู้ใช้ส่งมาใน LINE → data URL (base64)
async function lineGetImageDataUrl(messageId) {
  if (!messageId || !LINE_TOKEN) return null;
  try {
    const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: 'Bearer ' + LINE_TOKEN },
    });
    if (!r.ok) {
      console.error('[lineGetImage]', r.status);
      return null;
    }
    const type = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    // กันรูปใหญ่เกิน (Supabase/LINE payload) — เกิน ~4MB ตัดทิ้ง
    if (buf.length > 4 * 1024 * 1024) {
      console.error('[lineGetImage] image too large:', buf.length);
      return null;
    }
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.error('[lineGetImage]', e.message);
    return null;
  }
}

/* ── utils ───────────────────────────────────────────────── */
function baht(n) {
  return '฿' + (Number(n) || 0).toLocaleString('th-TH');
}

const L = { sbSelect, sbInsert, sbUpdate, sbDelete, linePush, lineReply, lineGetImageDataUrl, baht };

/* ══════════════════════ webhook ══════════════════════ */
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

/* ── OCR อ่านสลิปด้วย Claude (ไม่เพิ่ม serverless function) ── */
async function ocrSlip(dataUrl) {
  if (!ANTHROPIC_KEY || !dataUrl) return null;
  try {
    const m = String(dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!m) return null;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role:'user', content: [
          { type:'image', source:{ type:'base64', media_type:m[1], data:m[2] } },
          { type:'text', text:
            'อ่านสลิปโอนเงินไทยใบนี้ ตอบเป็น JSON เท่านั้น ไม่ต้องมีคำอธิบายหรือ markdown:\n' +
            '{"bank":"ธนาคารต้นทาง หรือ null","datetime":"YYYY-MM-DD HH:MM หรือ null","sender":"ชื่อผู้โอน หรือ null",' +
            '"receiver":"ชื่อผู้รับเงิน หรือ null","amount":ตัวเลขจำนวนเงินบาท หรือ null,"ref":"เลขอ้างอิง หรือ null",' +
            '"readable":true/false}\n' +
            'ถ้าอ่านไม่ออกหรือไม่ใช่สลิปโอนเงิน ให้ readable=false และฟิลด์อื่นเป็น null' }
        ]}]
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = ((j.content || []).find(x => x.type === 'text') || {}).text || '';
    const clean = txt.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) { console.error('[slip-ocr]', e.message); return null; }
}

/* ── ตรวจความสมเหตุสมผลกับสัญญา (deterministic) ── */
function crossCheck(ocr, c, cyc) {
  const flags = [];
  if (!ocr || ocr.readable === false) { flags.push({ level:'warn', msg:'อ่านข้อมูลจากสลิปไม่ได้ — โปรดตรวจด้วยตา' }); return flags; }

  const rent = Number(c.rent) || 0;
  const penalty = Number(cyc && cyc.penalty_snapshot) || 0;
  const expectMin = rent, expectMax = rent + penalty;
  const amt = Number(ocr.amount);

  if (!amt) flags.push({ level:'warn', msg:'อ่านจำนวนเงินไม่ได้' });
  else if (amt < expectMin) flags.push({ level:'alert', msg:`ยอดโอนน้อยกว่าค่าเช่า (โอน ${L.baht(amt)} · ค่าเช่า ${L.baht(rent)})` });
  else if (penalty > 0 && amt < expectMax) flags.push({ level:'warn', msg:`ยังไม่รวมค่าปรับ (ต้องชำระรวม ${L.baht(expectMax)})` });

  // วันที่โอน — ต้องไม่ล่วงหน้า และไม่เก่าเกิน 45 วัน
  if (ocr.datetime) {
    const t = new Date(String(ocr.datetime).replace(' ', 'T') + ':00+07:00');
    if (!isNaN(t)) {
      const days = (Date.now() - t.getTime()) / 86400000;
      if (days < -1) flags.push({ level:'alert', msg:'วันที่บนสลิปเป็นอนาคต' });
      else if (days > 45) flags.push({ level:'alert', msg:'สลิปเก่ากว่า 45 วัน — อาจเป็นสลิปของรอบก่อน' });
    }
  } else flags.push({ level:'warn', msg:'อ่านวันที่บนสลิปไม่ได้' });

  // ชื่อผู้รับ — เทียบกับผู้ให้เช่า (ตัดคำนำหน้า/เว้นวรรค)
  const norm = v => String(v||'').replace(/นาย|นาง|นางสาว|น\.ส\.|คุณ|\s|\./g,'');
  if (ocr.receiver && c.ll_name) {
    const a = norm(ocr.receiver), b = norm(c.ll_name);
    if (a && b && !a.includes(b.slice(0,4)) && !b.includes(a.slice(0,4)))
      flags.push({ level:'warn', msg:`ชื่อผู้รับบนสลิป (${ocr.receiver}) ไม่ตรงกับผู้ให้เช่า (${c.ll_name})` });
  }
  return flags;
}

function sha256(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || dataUrl;
  return crypto.createHash('sha256').update(b64).digest('hex');
}


module.exports = async (req, res) => {
  // ── debug: GET /api/line-webhook?nda_test=<lineUserId>&key=<ADMIN_PASSWORD> ──
  if (req.method === 'GET' && req.query && req.query.nda_test) {
    if (!process.env.ADMIN_PASSWORD || req.query.key !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const out = await ndaFollowDiag(String(req.query.nda_test), req.query.push === '1');
    return res.status(200).json(out);
  }
  if (req.method !== 'POST') return res.status(200).end();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const events = (body && body.events) || [];

  // ตอบ 200 ให้ LINE ทันที (กัน timeout) แล้วประมวลผลต่อ
  res.status(200).json({ ok: true });

  for (const ev of events) {
    try {
      if (ev.type === 'postback') await handlePostback(ev);
      else if (ev.type === 'follow') await handleNdaFollow(ev);
      else if (ev.type === 'message' && ev.message && ev.message.type === 'image') await handleImage(ev);
      else if (ev.type === 'message' && ev.message && ev.message.type === 'text')  await handleEmpLinkText(ev);
    } catch (e) {
      console.error('[webhook] event error:', e.message);
    }
  }
};


/* ══════════════════════════════════════════════════════════════
   SignDee สัญญาจ้าง — ผูกบัญชีนายจ้างกับ LINE
   นายจ้างกดปุ่มในแอป → เปิดแชต OA พร้อมข้อความ "ผูกบัญชี ABC123"
   → ที่นี่จับคู่ code กับ line_user_id → แอป poll แล้วได้ session
   ══════════════════════════════════════════════════════════════ */
const EMP_LINK_RE = /(?:ผูกบัญชี|ผูกบัญชี|link)\s*[:：]?\s*([A-Za-z0-9]{6})\b/;

async function lineGetProfile(userId) {
  if (!userId || !LINE_TOKEN) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    });
    if (!r.ok) return null;
    return r.json();
  } catch (_) { return null; }
}

async function handleEmpLinkText(ev) {
  const userId = ev.source && ev.source.userId;
  const text = (ev.message && ev.message.text) || '';
  if (!userId) return;

  const m = EMP_LINK_RE.exec(text) || /^\s*([A-Za-z0-9]{6})\s*$/.exec(text);
  if (!m) return;                       // ไม่ใช่ข้อความผูกบัญชี — ปล่อยผ่าน
  const code = m[1].toUpperCase();

  const rows = await sbSelect(`emp_line_link?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
  const row = rows && rows[0];
  if (!row) {
    await lineReply(ev.replyToken, { type: 'text', text: 'ไม่พบรหัสนี้ หรือรหัสหมดอายุแล้ว\nกรุณากดขอรหัสใหม่ในหน้าแดชบอร์ด' });
    return;
  }
  if (row.line_user_id && row.line_user_id !== userId) {
    await lineReply(ev.replyToken, { type: 'text', text: 'รหัสนี้ถูกใช้ไปแล้ว กรุณาขอรหัสใหม่' });
    return;
  }

  const pr = await lineGetProfile(userId);
  await sbUpdate('emp_line_link', { code }, {
    line_user_id: userId,
    line_name: (pr && pr.displayName) || null,
    linked_at: new Date().toISOString(),
  });
  await lineReply(ev.replyToken, { type: 'text', text:
    'ผูกบัญชีเรียบร้อยแล้ว ✅\n' + ((pr && pr.displayName) ? (pr.displayName + '\n') : '') +
    'กลับไปที่หน้าแดชบอร์ดในเบราว์เซอร์ได้เลย ระบบจะเข้าสู่ระบบให้อัตโนมัติ' });
}

/* ══════════════════════════════════════════════════════════════
   NDA — เพิ่มเพื่อน OA แล้วส่งลิงก์ดาวน์โหลดสัญญาให้ทันที
   ผูกกันด้วย line_user_id ที่บันทึกไว้ตอนผู้ลงนามยืนยันตัวตนผ่าน LIFF
   หมายเหตุ: LINE push ไฟล์ PDF ตรง ๆ ไม่ได้ → ส่งเป็น Flex + ปุ่มดาวน์โหลด
   ══════════════════════════════════════════════════════════════ */
const NDA_APP_URL = process.env.NDA_APP_URL || 'https://nda.signdee.com/';

async function handleNdaFollow(ev) {
  const userId = ev.source && ev.source.userId;
  console.log('[nda-follow] follow event userId=', userId);
  if (!userId) return;
  const r = await ndaFollowDiag(userId, true);
  console.log('[nda-follow] result:', JSON.stringify(r));
}

/* ค้นสัญญาของ lineUserId แล้ว (ถ้า push=true) ส่ง Flex ให้
   คืนผลละเอียดเพื่อใช้ debug ผ่าน GET ?nda_test= */
async function ndaFollowDiag(userId, push) {
  const out = { userId, matchedA: 0, matchedB: 0, complete: 0, pushed: 0, rows: [], errors: [] };
  if (!SB || !SR) { out.errors.push('SUPABASE_URL/SERVICE_KEY ไม่ได้ตั้งใน env'); return out; }
  if (!LINE_TOKEN) out.errors.push('LINE_CHANNEL_TOKEN ไม่ได้ตั้งใน env (push ไม่ได้)');

  const uid = encodeURIComponent(userId);
  // ใช้ select=* กันกรณีชื่อคอลัมน์ไม่ตรง แล้ว PostgREST ตอบ 400 เงียบ ๆ
  const qa = `nda_contracts?select=*&a_line_user_id=eq.${uid}&limit=5`;
  const qb = `nda_contracts?select=*&b_line_user_id=eq.${uid}&limit=5`;
  const ra = await sbSelect(qa);
  const rb = await sbSelect(qb);
  out.matchedA = ra.length; out.matchedB = rb.length;

  const cand = []
    .concat(ra.map(r => ({ row: r, party: 'a' })))
    .concat(rb.map(r => ({ row: r, party: 'b' })));

  if (!cand.length) {
    out.errors.push('ไม่พบแถวที่ a_line_user_id หรือ b_line_user_id ตรงกับ userId นี้ — แปลว่าตอนเซ็นไม่ได้บันทึก LINE userId ลง DB');
    return out;
  }

  for (const c of cand) {
    const r = c.row;
    const done = !!(r.a_signed_at && r.b_signed_at);
    out.rows.push({ id: r.id, party: c.party, a_signed: !!r.a_signed_at, b_signed: !!r.b_signed_at, complete: done });
    if (!done) continue;
    out.complete++;
    if (push && LINE_TOKEN) {
      const ok = await linePush(userId, [buildNdaPdfFlex(r, c.party)]);
      if (ok) out.pushed++; else out.errors.push('linePush ล้มเหลวสำหรับ ' + r.id);
    }
  }
  if (!out.complete) out.errors.push('เจอสัญญาแต่ยังลงนามไม่ครบ 2 ฝ่าย');
  return out;
}

function buildNdaPdfFlex(row, party) {
  const label = party === 'a' ? 'ผู้ให้ข้อมูล' : 'ผู้รับข้อมูล';
  const url   = `${NDA_APP_URL}?reload=${encodeURIComponent(row.id)}&autodownload=1`;
  const dt    = row.b_signed_at || row.a_signed_at;
  const dateTh = dt
    ? new Date(dt).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';

  const kv = (k, v, bold) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs',
    contents: [
      { type: 'text', text: k, size: 'xs', color: '#8E95A3', flex: 2 },
      { type: 'text', text: String(v || '—'), size: 'xs', color: '#14171F', flex: 5, wrap: true, weight: bold ? 'bold' : 'regular' },
    ],
  });

  return {
    type: 'flex',
    altText: '📄 สัญญารักษาความลับ (NDA) พร้อมดาวน์โหลดแล้ว',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0B1220', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📄 สัญญารักษาความลับ (NDA)', color: '#6EC3EA', size: 'md', weight: 'bold', wrap: true },
          { type: 'text', text: 'SignDee · ลงนามครบทุกฝ่ายแล้ว', color: '#B9D4E8', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          kv('เลขที่สัญญา', row.contract_no),
          kv('วันที่ลงนามครบ', dateTh),
          kv('สำเนาของ', label, true),
          kv('เลขใบรับรอง', row.cert_no),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '✅ มีผลผูกพันตามกฎหมาย พร้อมใบรับรองและ Audit Trail', size: 'xs', color: '#1a7f5a', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: '#2E86C6', height: 'sm',
            action: { type: 'uri', label: '⬇️ ดาวน์โหลด PDF สัญญา', uri: url } },
          { type: 'text', text: 'ระบบเก็บสัญญาไว้ 60 วัน กรุณาดาวน์โหลดเก็บไว้เป็นหลักฐาน',
            size: 'xxs', color: '#8E95A3', align: 'center', wrap: true, margin: 'sm' },
        ],
      },
    },
  };
}

function parseData(data) {
  const o = {};
  String(data || '').split('&').forEach(kv => {
    const [k, v] = kv.split('=');
    if (k) o[k] = decodeURIComponent(v || '');
  });
  return o;
}

async function handlePostback(ev) {
  const d = parseData(ev.postback && ev.postback.data);
  const replyToken = ev.replyToken;
  const userId = ev.source && ev.source.userId;

  if (d.action === 'ack' && d.cyc) {
    await L.sbUpdate('rent_cycles', { id: d.cyc }, { status: 'acknowledged', acknowledged_at: new Date().toISOString() });
    return L.lineReply(replyToken, { type: 'text', text: '👍 รับทราบแล้ว ขอบคุณค่ะ ระบบจะเตือนอีกครั้งเมื่อใกล้/ถึงกำหนดชำระ' });
  }

  if (d.action === 'paid' && d.cyc) {
    // ตั้งสถานะรอสลิป + ผูก userId กับ cycle (upsert)
    await L.sbUpdate('rent_cycles', { id: d.cyc }, { status: 'paid_pending_slip' });
    if (userId) {
      await L.sbInsert('slip_await', { line_user_id: userId, contract_id: d.cid, cycle_id: d.cyc }, { upsert: true });
    }
    return L.lineReply(replyToken, { type: 'text', text: '📸 กรุณาส่งรูปสลิปการโอนเงินในแชทนี้ เพื่อยืนยันการชำระค่ะ' });
  }

  // ── ผู้ให้เช่ายืนยัน/ปฏิเสธ การรับเงิน ──
  if (d.action === 'slip_ok' && d.cyc) {
    await L.sbUpdate('rent_cycles', { id: d.cyc }, { status:'paid', paid_at:new Date().toISOString(), reviewed_at:new Date().toISOString() });
    const c = (await L.sbSelect(`contracts?select=tn_line_user_id,tn2_line_user_id,prop_name,room_no&id=eq.${d.cid}&limit=1`))[0];
    for (const t of [c && c.tn_line_user_id, c && c.tn2_line_user_id].filter(Boolean)) {
      await L.linePush(t, { type:'text', text:'✅ ผู้ให้เช่ายืนยันรับเงินค่าเช่าแล้ว ขอบคุณค่ะ 🙏' });
    }
    return L.lineReply(replyToken, { type:'text', text:'✅ บันทึกการรับเงินเรียบร้อย ระบบหยุดแจ้งเตือนรอบนี้แล้วค่ะ' });
  }
  if (d.action === 'slip_no' && d.cyc) {
    await L.sbUpdate('rent_cycles', { id: d.cyc }, { status:'pending', reviewed_at:new Date().toISOString(), review_note:'ผู้ให้เช่าแจ้งว่ายังไม่ได้รับเงิน' });
    const c = (await L.sbSelect(`contracts?select=tn_line_user_id,tn2_line_user_id&id=eq.${d.cid}&limit=1`))[0];
    for (const t of [c && c.tn_line_user_id, c && c.tn2_line_user_id].filter(Boolean)) {
      await L.linePush(t, { type:'text', text:'⚠️ ผู้ให้เช่าแจ้งว่ายังไม่ได้รับเงินตามสลิปที่ส่งมา กรุณาตรวจสอบการโอนอีกครั้ง หรือติดต่อผู้ให้เช่าโดยตรงค่ะ' });
    }
    return L.lineReply(replyToken, { type:'text', text:'บันทึกแล้ว — ระบบแจ้งผู้เช่าให้ตรวจสอบการโอนอีกครั้ง และจะเตือนค่าเช่าต่อตามปกติค่ะ' });
  }

  if (d.action === 'renew' && d.cid) {
    await L.sbUpdate('contracts', { id: d.cid }, { renewal_status: 'renew', renewal_responded_at: new Date().toISOString() });
    await notifyLandlordRenewal(d.cid, true);
    return L.lineReply(replyToken, { type: 'text', text: '🔄 รับเรื่องขอต่อสัญญาแล้ว ระบบได้แจ้งผู้ให้เช่าเพื่อจัดทำสัญญาใหม่ค่ะ' });
  }

  if (d.action === 'norenew' && d.cid) {
    await L.sbUpdate('contracts', { id: d.cid }, { renewal_status: 'no_renew', renewal_responded_at: new Date().toISOString() });
    await notifyLandlordRenewal(d.cid, false);
    return L.lineReply(replyToken, { type: 'text', text: '🚪 รับทราบว่าไม่ต่อสัญญา ระบบจะแจ้งผู้ให้เช่าเตรียมคืนเงินประกันเมื่อใกล้ครบกำหนดค่ะ' });
  }
}

async function handleImage(ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId) return;
  const await_ = (await L.sbSelect(`slip_await?select=*&line_user_id=eq.${userId}&limit=1`))[0];
  if (!await_) return;                                    // ไม่ได้รอสลิป — เพิกเฉย

  const dataUrl = await L.lineGetImageDataUrl(ev.message.id);
  if (!dataUrl) return L.lineReply(ev.replyToken, { type:'text', text:'❌ รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้งค่ะ' });

  // ── 1) กันสลิปซ้ำ (แม่นยำ 100%) ──
  const hash = sha256(dataUrl);
  const dup = (await L.sbSelect(`slip_hashes?select=*&slip_hash=eq.${hash}&limit=1`))[0];
  if (dup) {
    await L.lineReply(ev.replyToken, { type:'text',
      text:'⚠️ สลิปนี้เคยถูกส่งมาแล้ว (เมื่อ ' + new Date(dup.created_at).toLocaleDateString('th-TH') + ')\nกรุณาส่งสลิปการโอนของรอบนี้ค่ะ' });
    const cDup = (await L.sbSelect(`contracts?select=ll_line_user_id,prop_name,room_no,tn_name&id=eq.${await_.contract_id}&limit=1`))[0];
    if (cDup && cDup.ll_line_user_id) {
      await L.linePush(cDup.ll_line_user_id, { type:'text',
        text:'🔴 แจ้งเตือน: ผู้เช่า ' + (cDup.tn_name||'') + ' (' + (cDup.prop_name||'') + ' ห้อง ' + (cDup.room_no||'') + ') ส่งสลิปที่เคยใช้มาแล้ว — โปรดตรวจสอบ' });
    }
    return;
  }

  // ── 2) OCR + cross-check กับสัญญา ──
  const c   = (await L.sbSelect(`contracts?select=id,rent,late_penalty,pay_day,ll_name,ll_line_user_id,tn_name,prop_name,room_no&id=eq.${await_.contract_id}&limit=1`))[0];
  const cyc = (await L.sbSelect(`rent_cycles?select=*&id=eq.${await_.cycle_id}&limit=1`))[0];
  const ocr = await ocrSlip(dataUrl);
  const flags = c ? crossCheck(ocr, c, cyc) : [];
  const hasAlert = flags.some(f => f.level === 'alert');

  // ── 3) บันทึก: รอผู้ให้เช่ายืนยัน (ไม่ mark paid เอง) ──
  await L.sbUpdate('rent_cycles', { id: await_.cycle_id }, {
    status: 'paid_pending_review',
    slip_image: dataUrl, slip_hash: hash, slip_ocr: ocr || null,
    slip_flags: flags.length ? flags : null, slip_at: new Date().toISOString()
  });
  await L.sbInsert('slip_hashes', { slip_hash: hash, contract_id: await_.contract_id, cycle_id: await_.cycle_id });
  await L.sbDelete('slip_await', { line_user_id: userId });

  await L.lineReply(ev.replyToken, { type:'text',
    text:'✅ ได้รับสลิปแล้ว ระบบส่งให้ผู้ให้เช่าตรวจสอบและยืนยันการรับเงิน\nจะแจ้งผลให้ทราบอีกครั้งค่ะ 🙏' });

  // ── 4) ส่งให้ผู้ให้เช่าตัดสินใจ ──
  if (c && c.ll_line_user_id) await notifyLandlordSlip(c, cyc, ocr, flags, hasAlert, dataUrl);
}

/* ── แจ้งผู้ให้เช่า: ข้อมูลสลิป + จุดที่ไม่ตรง + ปุ่มยืนยัน/ปฏิเสธ ── */
async function notifyLandlordSlip(c, cyc, ocr, flags, hasAlert, dataUrl) {
  const rows = [];
  const kv = (l, v) => rows.push({ type:'box', layout:'baseline', spacing:'sm', contents:[
    { type:'text', text:l, color:'#999', size:'sm', flex:4 },
    { type:'text', text:String(v == null || v === '' ? '—' : v), wrap:true, color:'#333', size:'sm', flex:6 }
  ]});
  kv('ทรัพย์สิน', (c.prop_name||'—') + (c.room_no ? ' ห้อง ' + c.room_no : ''));
  kv('ผู้เช่า', c.tn_name || '—');
  kv('ค่าเช่า', L.baht(c.rent));
  if (cyc && Number(cyc.penalty_snapshot) > 0) kv('ค่าปรับ', L.baht(cyc.penalty_snapshot));
  rows.push({ type:'separator', margin:'md' });
  kv('ยอดบนสลิป', ocr && ocr.amount ? L.baht(ocr.amount) : 'อ่านไม่ออก');
  kv('วันเวลาโอน', (ocr && ocr.datetime) || 'อ่านไม่ออก');
  kv('ผู้โอน', (ocr && ocr.sender) || '—');
  kv('ผู้รับ', (ocr && ocr.receiver) || '—');
  kv('ธนาคาร', (ocr && ocr.bank) || '—');

  const color = hasAlert ? '#D64545' : (flags.length ? '#C4913A' : '#1A7F5A');
  const header = hasAlert ? '🔴 สลิปมีจุดที่ต้องตรวจสอบ'
               : flags.length ? '🟡 สลิปเข้ามาแล้ว — มีข้อสังเกต'
                              : '🟢 สลิปเข้ามาแล้ว — ข้อมูลตรงกับสัญญา';
  const note = flags.length
    ? flags.map(f => (f.level === 'alert' ? '🔴 ' : '🟡 ') + f.msg).join('\n') + '\n\n⚠️ ระบบตรวจได้เฉพาะข้อมูลบนสลิป ไม่สามารถยืนยันว่าเงินเข้าบัญชีจริง — โปรดตรวจยอดในบัญชีก่อนกดยืนยัน'
    : '⚠️ ข้อมูลบนสลิปตรงกับสัญญา แต่ระบบไม่สามารถยืนยันว่าเงินเข้าบัญชีจริง — โปรดตรวจยอดในบัญชีก่อนกดยืนยัน';

  const bubble = {
    type:'bubble',
    header:{ type:'box', layout:'vertical', backgroundColor:color, paddingAll:'14px',
      contents:[{ type:'text', text:header, color:'#FFF', weight:'bold', size:'md', wrap:true }] },
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[
      { type:'box', layout:'vertical', spacing:'sm', contents: rows },
      { type:'separator', margin:'md' },
      { type:'text', text: note, wrap:true, size:'xs', color:'#666', margin:'md' }
    ]},
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'button', style:'primary', height:'sm', color:'#1A7F5A',
        action:{ type:'postback', label:'✅ ยืนยันรับเงินแล้ว', data:`action=slip_ok&cid=${c.id}&cyc=${cyc && cyc.id}` } },
      { type:'button', style:'secondary', height:'sm',
        action:{ type:'postback', label:'❌ ยังไม่ได้รับเงิน', data:`action=slip_no&cid=${c.id}&cyc=${cyc && cyc.id}` } }
    ]}
  };
  await L.linePush(c.ll_line_user_id, [{ type:'flex', altText: header, contents: bubble }]);
  try { await L.linePush(c.ll_line_user_id, [{ type:'image', originalContentUrl: dataUrl, previewImageUrl: dataUrl }]); } catch(e) {}
}

async function notifyLandlordRenewal(contractId, willRenew) {
  const c = (await L.sbSelect(`contracts?select=ll_line_user_id,prop_name,room_no,tn_name&id=eq.${contractId}&limit=1`))[0];
  if (!c || !c.ll_line_user_id) return;
  const txt = willRenew
    ? `🔄 ผู้เช่า ${c.tn_name || ''} (${c.prop_name || ''} ห้อง ${c.room_no || ''}) แจ้งความประสงค์ "ต่อสัญญา" — กรุณาจัดทำสัญญาฉบับใหม่`
    : `🚪 ผู้เช่า ${c.tn_name || ''} (${c.prop_name || ''} ห้อง ${c.room_no || ''}) แจ้ง "ไม่ต่อสัญญา" — โปรดเตรียมคืนเงินประกันเมื่อผู้เช่าย้ายออก`;
  await L.linePush(c.ll_line_user_id, { type: 'text', text: txt });
}

async function notifyLandlordPaid(contractId) {
  const c = (await L.sbSelect(`contracts?select=ll_line_user_id,prop_name,room_no,tn_name,rent&id=eq.${contractId}&limit=1`))[0];
  if (!c || !c.ll_line_user_id) return;
  await L.linePush(c.ll_line_user_id, {
    type: 'text',
    text: `✅ ผู้เช่า ${c.tn_name || ''} (${c.prop_name || ''} ห้อง ${c.room_no || ''}) ชำระค่าเช่า ${L.baht(c.rent)} แล้ว พร้อมแนบสลิป`,
  });
}
