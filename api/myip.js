// ============================================================
//  SignDee — /api/myip  (multi-purpose utility endpoint)
//  วางไฟล์นี้ใน  D:\justsign-api\api\myip.js  แล้ว deploy
//
//  โหมด 1 — GET  : คืน IP ของผู้เรียก (เดิม — ใช้จับ IP ตอนเซ็น)
//  โหมด 2 — POST { image } : OCR บัตรประชาชน/พาสปอร์ต → JSON ที่ validate แล้ว
//                            (รวมไว้ที่นี่เพื่อไม่ให้เกิน 12 functions บน Hobby)
//
//  ENV ที่ต้องตั้งใน Vercel (สำหรับโหมด OCR):
//    GEMINI_API_KEY = <key จาก aistudio.google.com>
//    OCR_PROVIDER   = 'gemini' (default) หรือ 'anthropic'
//    OCR_MODEL      = 'gemini-2.0-flash' (default)
//    ANTHROPIC_API_KEY = <key>  (เฉพาะถ้า OCR_PROVIDER=anthropic)
//  ไม่ตั้ง env → โหมด GET (ip) ยังทำงานปกติ, โหมด OCR จะคืน error อย่างสุภาพ
// ============================================================

const OCR_PROVIDER  = (process.env.OCR_PROVIDER || 'gemini').toLowerCase();
const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OCR_MODEL     = process.env.OCR_MODEL || 'gemini-2.0-flash';
const MAX_B64_BYTES = 8 * 1024 * 1024;

// ── Turnstile (กันบอท) — verify token เฉพาะเมื่อตั้ง env TURNSTILE_SECRET ──
//   TEST secret (ผ่านทุกครั้ง): 1x0000000000000000000000000000000AA
//   ยังไม่ตั้ง env = ไม่บังคับ (deploy โค้ดได้โดยไม่พังของเดิม)
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false };
  try {
    const form = new URLSearchParams();
    form.append('secret', TURNSTILE_SECRET);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await r.json();
    return { ok: !!j.success, detail: j['error-codes'] };
  } catch (e) {
    return { ok: false, detail: String(e.message || e) };
  }
}

// ── NDA config ──────────────────────────────────────────────────
//  ENV เพิ่มสำหรับ NDA (ถ้าไม่ตั้ง generate/content จะคืน error สุภาพ):
//    ANTHROPIC_API_KEY  = <key>          (ใช้ทั้ง OCR provider=anthropic และ generate)
//    SUPABASE_URL       = https://xxx.supabase.co
//    SUPABASE_SERVICE_KEY = <service_role key>
//    NDA_GEN_MODEL      = 'claude-sonnet-4-6' (default)
//    LINE_CHANNEL_TOKEN = <push token>   (โหมด notify)
const crypto        = require('crypto');
const SUPABASE_URL  = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || '';
const NDA_GEN_MODEL = process.env.NDA_GEN_MODEL || 'claude-haiku-4-5-20251001';
// ── Employment (สัญญาจ้าง) ──
const EMPT       = require('./_emp_templates.js');
const EMP_SEED   = require('./_emp_positions.json');
const EMP_TABLE  = 'emp_contracts';
const EMP_JD_MODEL = process.env.EMP_JD_MODEL || NDA_GEN_MODEL;
const LINE_TOKEN    = process.env.LINE_CHANNEL_TOKEN || '';

const EXTRACT_PROMPT = [
  'You are an OCR extractor for Thai identity documents (Thai national ID card or passport).',
  'Read the document in the image and return ONLY a JSON object, no markdown, no backticks, no commentary.',
  'Use this exact schema (use "" for any field you cannot read confidently):',
  '{',
  '  "document_type": "thai_id" | "passport" | "other" | "unclear",',
  '  "prefix": "",            // คำนำหน้า เช่น นาย/นาง/นางสาว (Thai). "" if none',
  '  "first_name_th": "",     // ชื่อภาษาไทย ไม่รวมคำนำหน้า',
  '  "last_name_th": "",      // นามสกุลภาษาไทย',
  '  "first_name_en": "",     // ชื่อภาษาอังกฤษถ้ามี',
  '  "last_name_en": "",',
  '  "id_number": "",         // เลข 13 หลัก ตัวเลขล้วน ไม่มีเว้นวรรค (thai_id เท่านั้น)',
  '  "passport_number": "",   // เลขพาสปอร์ต (passport เท่านั้น)',
  '  "address_th": "",        // ที่อยู่ตามบัตร ภาษาไทย บรรทัดเดียว',
  '  "date_of_birth": "",     // YYYY-MM-DD (ค.ศ.) ถ้าอ่านได้',
  '  "date_issue": "",        // YYYY-MM-DD',
  '  "date_expiry": ""        // YYYY-MM-DD',
  '}',
  'Rules:',
  '- Keep Thai text in Thai. For id_number output digits only (13 digits).',
  '- CRITICAL — Thai diacritics. Thai surnames differ only by a tone mark, and dropping one produces a legally wrong name.',
  '    Zoom into each syllable and copy EVERY mark above and below the consonant exactly as printed:',
  '    vowels ั ิ ี ึ ื ุ ู ํ, tone marks ่ (เอก) ้ (โท) ๊ (ตรี) ๋ (จัตวา), ็ (ไม้ไต่คู้), ์ (การันต์).',
  '    On a Thai ID card a tone mark sits ABOVE a vowel that is itself above the consonant (stacked two levels) — e.g. ลิ้ม = ล + ิ + ้.',
  '    Do NOT normalise, simplify, or drop a stacked mark. Do NOT swap ่ for ้ . If a mark is present, output it.',
  '- CRITICAL — cross-check the Thai name against the printed English name before answering.',
  '    The card prints "Name" and "Last name" in English right below the Thai line. Romanisation must match the Thai you output:',
  '    "Limcharoen" -> ลิ้มเจริญ (has ้), NOT ลิมเจริญ and NOT ลิ่มเจริญ. "Sri-" -> ศรี/สี, "-porn" -> พร, "-sak" -> ศักดิ์.',
  '    If your Thai reading and the English do not correspond, re-read the Thai characters before answering.',
  '- CRITICAL — prefix (คำนำหน้า). Copy the word literally printed before the first name on the "ชื่อตัวและชื่อสกุล" line.',
  '    นาง and นางสาว are different words — นางสาว has สาว after นาง. Read the actual characters; the English "Mrs." = นาง, "Miss" = นางสาว, "Mr." = นาย.',
  '    Never infer the prefix from the photo, the age, or the marital status. If the printed prefix is unclear, output "".',
  '- address_th: อ่านที่อยู่ให้ครบทั้งบรรทัด ตั้งแต่ "ที่อยู่" — รวมบ้านเลขที่ หมู่ ตำบล/แขวง อำเภอ/เขต จังหวัด ให้อยู่ในบรรทัดเดียว อย่าตัดเลขบ้าน/หมู่/ตำบลออก',
  '- บัตรประชาชนไทยมี 2 วันที่ด้านล่าง แยกให้ถูกตาม label อย่าสลับกัน:',
  '    date_issue = "วันออกบัตร / Date of Issue" (อยู่ด้านซ้ายล่าง)',
  '    date_expiry = "วันบัตรหมดอายุ / Date of Expiry" (อยู่ด้านขวาล่าง)',
  '    โดยปกติ date_expiry จะอยู่หลัง date_issue ประมาณ 8 ปี ถ้าอ่านได้ค่าเดียวให้ใส่ในช่องที่ตรง label เท่านั้น อย่าเดาสลับ',
  '- Convert Thai Buddhist years (พ.ศ.) to Gregorian (ค.ศ.) by subtracting 543. Output all dates as YYYY-MM-DD (ค.ศ.).',
  '- If the image is not an ID document, set document_type to "other".',
  '- Before returning, re-read the name line one more time character by character and fix any missing tone mark.',
].join('\n');

// แยก mime + base64 payload ออกจาก data URL
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const b64 = m[3];
  if (Math.floor(b64.length * 3 / 4) > MAX_B64_BYTES) return { tooBig: true };
  return { mime: m[1].toLowerCase(), b64 };
}

// Thai national ID checksum (mod 11)
function validateThaiId(id) {
  const d = String(id || '').replace(/\D/g, '');
  if (d.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(d[i], 10) * (13 - i);
  return ((11 - (sum % 11)) % 10) === parseInt(d[12], 10);
}

// ดึง JSON ก้อนแรกจาก text (กัน model ห่อ ```json หรือมี preamble)
function extractJson(text) {
  if (!text) return null;
  const t = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

async function callGemini(mime, b64) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: EXTRACT_PROMPT },
        { inline_data: { mime_type: mime, data: b64 } },
      ]}],
      generationConfig: { temperature: 0, maxOutputTokens: 800, responseMimeType: 'application/json' },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const data = await r.json();
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function callAnthropic(mime, b64) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: EXTRACT_PROMPT + '\nReturn JSON only.' },
      ]}],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const data = await r.json();
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}

async function handleOcr(req, res, image) {
  const parsed = parseDataUrl(image);
  if (!parsed)       return res.status(400).json({ ok: false, error: 'invalid_image' });
  if (parsed.tooBig) return res.status(413).json({ ok: false, error: 'image_too_large' });

  let raw;
  if (OCR_PROVIDER === 'anthropic') raw = await callAnthropic(parsed.mime, parsed.b64);
  else                              raw = await callGemini(parsed.mime, parsed.b64);

  const j = extractJson(raw);
  if (!j) return res.status(502).json({ ok: false, error: 'ocr_parse_failed' });

  const docType = ['thai_id', 'passport', 'other', 'unclear'].includes(j.document_type) ? j.document_type : 'unclear';
  const idNumber = String(j.id_number || '').replace(/\D/g, '').slice(0, 13);
  const fullNameTh = [j.prefix, j.first_name_th, j.last_name_th].map(s => (s || '').trim()).filter(Boolean).join(' ');

  return res.status(200).json({
    ok: true,
    provider: OCR_PROVIDER,
    fields: {
      document_type: docType,
      prefix:        (j.prefix || '').trim(),
      first_name_th: (j.first_name_th || '').trim(),
      last_name_th:  (j.last_name_th || '').trim(),
      full_name_th:  fullNameTh,
      first_name_en: (j.first_name_en || '').trim(),
      last_name_en:  (j.last_name_en || '').trim(),
      id_number:     idNumber,
      passport_number: (j.passport_number || '').trim(),
      address_th:    (j.address_th || '').trim(),
      date_of_birth: (j.date_of_birth || '').trim(),
      date_issue:    (j.date_issue || '').trim(),
      date_expiry:   (j.date_expiry || '').trim(),
    },
    id_valid: docType === 'thai_id' ? validateThaiId(idNumber) : false,
  });
}

// ════════════════════════════════════════════════════════════════
//  NDA — generate / content / notify  (ยุบรวมไว้ใน myip เพื่อคง 12 functions)
//  ⚠️ ข้อความสัญญาด้านล่างเป็น "โครงร่างเพื่อพัฒนา" — ต้องให้ทนายรีวิว
//     ก่อน launch จริง (ตาม roadmap §15 ในเอกสารออกแบบ)
// ════════════════════════════════════════════════════════════════

// ── Supabase REST ผ่าน service_role ──
// อ่าน/เขียนตารางใดก็ได้ (ใช้กับ sale_contracts ด้วย)
async function sbGetT(table, id) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('supabase_env_missing');
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=*`;
  const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) throw new Error(`sb_get ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
async function sbPatchT(table, id, fields) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('supabase_env_missing');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) console.error('[sbPatchT] fail', table, r.status, (await r.text().catch(() => '')).slice(0, 300));
  return r.ok;
}

async function sbGet(id) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('supabase_env_missing');
  const url = `${SUPABASE_URL}/rest/v1/nda_contracts?id=eq.${encodeURIComponent(id)}&select=*`;
  const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) throw new Error(`sb_get ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
async function sbPatch(id, fields) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('supabase_env_missing');
  const url = `${SUPABASE_URL}/rest/v1/nda_contracts?id=eq.${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`sb_patch ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return true;
}

function sha256(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }

// append audit event ลง jsonb[] (best-effort — อ่านของเดิมมา concat)
async function ndaAudit(row, event, req, meta) {
  try {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ev = {
      event, ts: new Date().toISOString(),
      ip: fwd || req.headers['x-real-ip'] || '',
      ua: (req.headers['user-agent'] || '').slice(0, 200),
      meta: meta || null,
    };
    const log = Array.isArray(row.audit_log) ? row.audit_log.slice() : [];
    log.push(ev);
    await sbPatch(row.id, { audit_log: log });
  } catch (_) { /* audit ห้ามทำ flow หลักพัง */ }
}

// ── วันที่ ──
function addMonths(d, m) { const x = new Date(d.getTime()); x.setMonth(x.getMonth() + Number(m || 0)); return x; }
function thDate(d) {
  const mo = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return `${d.getDate()} ${mo[d.getMonth()]} พ.ศ. ${d.getFullYear() + 543}`;
}
function partyName(p) { return (p && (p.name || '')).trim() || '—'; }

// ════════════════════════════════════════════════════════════════
//  NDA TEMPLATE — ข้อความ verbatim จากไฟล์ Word ของ Ken (8 ข้อ)
//  เติมเฉพาะช่องว่าง {SLOT}; ไม่ให้ AI ร่างเนื้อกฎหมายเอง
//  ⚠️ คงข้อความตามต้นฉบับ (รวมจุดที่อาจเป็นคำสะกดผิดในต้นฉบับ)
// ════════════════════════════════════════════════════════════════
const NDA_T = {
  c1: `1. ผู้ให้ข้อมูลเป็นเจ้าของข้อมูลเกี่ยวกับ {SUBJECT} ซึ่งต่อไปนี้จะเรียกว่า "ข้อมูล" มีความประสงค์ที่จะเปิดเผยข้อมูลดังกล่าวให้แก่ผู้รับข้อมูล และผู้รับข้อมูลมีความต้องการที่จะใช้ข้อมูลของผู้ให้ข้อมูลเพื่อที่จะ {OBJECTIVE} ซึ่งผู้ให้ข้อมูลประสงค์ที่คุ้มครองเรื่องดังกล่าวไว้เป็นข้อมูลที่เป็นความลับ`,
  c2: `2. "ข้อมูล" หมายความถึง ข้อมูลใดๆ ไม่ว่าจะอยู่ในรูปแบบใดๆ ของผู้ให้ข้อมูลได้เปิดเผยแก่ผู้รับข้อมูล ซึ่งมีอยู่แล้วขณะทำสัญญารวมถึงที่จะได้มีขึ้นในภายหน้า โดยผู้รับข้อมูลรวมถึง กรรมการ พนักงาน ผู้บริการ ลูกจ้าง ตัวแทน บริษัทในเครือ หรือที่ปรึกษา ตลอดจนบริวารของผู้รับข้อมูลตกลงที่จะรักษาข้อมูลตามสัญญาฉบับนี้ไว้เป็นความลับ โดยจะไม่เปิดเผยข้อมูลดังกล่าวไม่ว่าบางส่วนหรือทั้งหมดให้แก่ผู้หนึ่งผู้ใดโดยไม่ได้รับความยินยอมเป็นลายลักษณ์อักษรจากผู้ให้ข้อมูลก่อน`,
  c3: `3. ผู้รับข้อมูลตกลงว่าจะเก็บรักษาข้อมูลที่เป็นความลับที่ฝ่ายผู้ให้ข้อมูลได้เปิดเผยให้แก่ฝ่ายผู้รับข้อมูลภายใต้สัญญาฉบับนี้ โดยฝ่ายผู้รับข้อมูลตกลงที่จะดำเนินการเก็บรักษาข้อมูลที่เป็นความลับที่ได้รับจากฝ่ายผู้ให้ข้อมูลไว้เป็นความลับอย่างเคร่งครัด และไม่เปิดเผยข้อมูลที่เป็นความลับไม่ว่าทั้งหมดหรือแต่บางส่วนให้แก่บุคคลใดทราบ เว้นแต่จะเป็นการเปิดเผยข้อมูลที่เป็นความลับภายในฝ่ายผู้รับข้อมูล หรือบุคคลภายนอกที่ต้องเกี่ยวข้องโดยตรงกับข้อมูลที่เป็นความลับนั้น โดยผู้รับข้อมูลจะต้องจัดให้ผู้เกี่ยวข้องโดยตรงกับข้อมูลดังกล่าวได้ผูกพันและปฏิบัติตามเงื่อนไขในการรักษาข้อมูลที่เป็นความลับอย่างเคร่งครัด`,
  c4: `4. ผู้รับข้อมูลตกลงใช้ข้อมูลเพื่อดำเนินการตามวัตถุประสงค์ที่ได้แจ้งไว้ตามสัญญานี้เท่านั้น และให้ใช้ข้อมูลได้เท่าที่จำเป็นเพื่อการนั้น หากการใดที่ผู้รับข้อมูลจะดำเนินการนอกเหนือวัตถุประสงค์ที่ได้แจ้งไว้ตามสัญญานี้ จะต้องได้รับความยินยอมเป็นลายลักษณ์อักษรจากผู้ให้ข้อมูลก่อนภายใน 30 วันนับแต่วันที่ทราบเหตุแก่งการนั้น
ผู้รับข้อมูลต้องไม่ทำซ้ำข้อมูลส่วนหนึ่งส่วนใดหรือทั้งหมด เว้นแต่การทำซ้ำเพื่อการใช้ข้อมูลให้บรรลุผลตามวัตถุประสงค์ที่กำหนดไว้ในสัญญานี้ รวมถึงไม่ทำวิศวกรรมย้อนกลับ หรือถอดรหัสข้อมูลที่เป็นความลับ ต้นแบบ หรือสิ่งอื่นใดที่บรรจุข้อมูลที่เป็นความลับ รวมทั้งไม่เคลื่อนย้าย พิมพ์ทับ หรือทำให้เสียรูปซึ่งสัญลักษณ์ที่แสดงเครื่องหมายสิทธิบัตร ลิขสิทธิ์ เครื่องหมายการค้า ตราสัญลักษณ์ และเครื่องหมายอื่นใดที่แสดงกรรมสิทธิ์ของต้นแบบหรือสำเนาของข้อมูลที่เป็นความลับที่ได้รับมาจากผู้ให้ข้อมูล`,
  c5: `5. กรณีข้อมูลที่มีลักษณะดังต่อไปนี้ มิให้ถือว่าเป็นการเปิดเผยข้อมูลตามสัญญานี้
5.1 ข้อมูลตามสัญญากลายเป็นข้อมูลสาธารณะโดยมิได้เกิดจากการกระทำของผู้รับข้อมูล
5.2 ข้อมูลที่ผู้รับข้อมูลทราบมาก่อนการทำสัญญา ไม่ว่าจากวิธีใดหรือบุคคลใดก่อนวันทำสัญญา เว้นแต่ได้รับข้อมูลมาจากผู้ให้ข้อมูล
5.3 ข้อมูลที่ได้รับอนุญาตเป็นลายลักษณ์อักษรจากผู้เปิดเผยข้อมูล
5.4 ข้อมูลที่มาจากการดำเนินการโดยอิสระของผู้รับข้อมูล`,
  c6: `6. ข้อมูลตามสัญญาฉบับนี้ยังคงเป็นทรัพย์สินของผู้ให้ข้อมูล เมื่อสิ้นสุดสัญญาหรือได้รับการแจ้งเป็นลายลักษณ์อักษรจากผู้ให้ข้อมูล ผู้รับข้อมูลมีหน้าที่คืนหรือทำลายข้อมูลลับรวมถึงสำเนาเอกสาร หรือ ข้อมูลที่ได้ถูกจัดเก็บในรูปแบบอิเล็กทรอนิกส์ด้วยตามคำสั่งของผู้เปิดเผยข้อมูลในทันที`,
  c7: `7. สัญญาฉบับนี้มีกำหนดระยะเวลา {YEARS} ปีนับตั้งแต่วันที่ {START} ถึงวันที่ {END}
การรักษาความลับตามสัญญานี้ ให้รักษาความลับตลอดระยะเวลาที่สัญญานี้มีผลบังคับใช้ โดยผู้รับข้อมูลจะเปิดเผยข้อมูลที่เป็นความลับได้ต่อเมื่อได้รับความยินยอมเป็นหนังสือจากผู้ให้ข้อมูลดังกล่าวก่อน หรือจนกว่าข้อมูลที่เป็นความลับนั้นกลายเป็นข้อมูลที่ไม่ใช่ความลับโดยชอบด้วยกฎหมายหรือตามลักษณะที่กำหนดในสัญญานี้`,
  c8: `8. หากผู้รับข้อมูลฝ่าฝืนการกฎิบัติตามเงื่อนไขของสัญญาข้อหนึ่งข้อใดและก่อให้เกิดความเสียหายแก่ผู้ให้ข้อมูล ให้ถือว่าสัญญาเลิกกัน และผู้รับข้อมูลจะต้องชดใช้ค่าเสียหายให้แก่ผู้ให้ข้อมูลหรือบุคคลที่ได้รับความเสียหายสำหรับความเสียหายเช่นว่านั้น`,
  intro: `ผู้ให้ข้อมูลตกลงเปิดเผยข้อมูลและผู้รับข้อมูลตกลงรับข้อมูลตามสัญญา โดยมีเงื่อนไขดังต่อไปนี้`,
  closing: `สัญญานี้ทำขึ้นสองฉบับมีข้อความถูกต้องตรงกัน คู่สัญญาได้อ่านและเข้าใจข้อความในสัญญานี้ละเอียดโดยตลอดแล้ว จึงได้ลงลายมือชื่อและประทับตราไว้ (หากมี) ไว้เป็นสำคัญ`,
};

function ageFromDob(dob) {
  if (!dob) return '';
  const d = new Date(dob); if (isNaN(d)) return '';
  const now = new Date(); let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return (a > 0 && a < 130) ? String(a) : '';
}
function partyDetailLine(p, card) {
  const name = (p && p.name || '').trim() || '________________';
  const id = (p && p.id13 || '').trim() || '________________';
  const addr = (p && p.address || '').trim() || '________________';
  const dob = card && card.ocr_raw && card.ocr_raw.date_of_birth;
  return { name, id, addr, age: ageFromDob(dob) };
}

// ════════════════════════════════════════════════════════════════
//  NDA TEMPLATE — ฉบับ MUTUAL (ทั้งสองฝ่ายเปิดเผยข้อมูลต่อกัน)
//
//  ⚠️⚠️ ยังไม่เปิดใช้งาน — รอข้อความจากทนาย ⚠️⚠️
//
//  วิธีเปิดใช้งาน (ทำ 2 อย่าง ไม่ต้องแก้ที่อื่นเลย):
//    1. วางข้อความ verbatim จากไฟล์ Word ฉบับ Mutual ลงใน c1–c8 / intro / closing
//       ด้านล่าง — ใส่ให้ครบทุกช่อง ห้ามเว้นว่าง ห้ามแต่งเอง
//       ช่องที่เติมค่าได้: {SUBJECT} {OBJECTIVE} ในข้อ 1 · {YEARS} {START} {END} ในข้อ 7
//       (ถ้าฉบับ Mutual วางเลขข้ออื่น ให้ย้าย placeholder ไปตามข้อจริง)
//    2. เปลี่ยน ready: false → true
//
//  จนกว่าจะทำ 2 ข้อนี้ ระบบจะปฏิเสธคำขอ nda_type='mutual' พร้อมข้อความ
//  บอกผู้ใช้ตรง ๆ — ไม่มีทางที่เอกสาร Mutual ปลอมจะหลุดออกไป
// ════════════════════════════════════════════════════════════════
const NDA_T_MUTUAL = {
  ready: false,
  c1: '', c2: '', c3: '', c4: '', c5: '', c6: '', c7: '', c8: '',
  intro: '', closing: '',
};
function ndaMutualReady() {
  if (!NDA_T_MUTUAL.ready) return false;
  // กันเผลอตั้ง ready=true ทั้งที่ยังกรอกไม่ครบ
  for (let i = 1; i <= 8; i++) if (!String(NDA_T_MUTUAL['c' + i] || '').trim()) return false;
  return true;
}

/* เลือกชุดข้อความตามประเภท NDA แล้วเติมเฉพาะช่องว่าง
   คืน null เมื่อขอ mutual แต่เทมเพลตยังไม่พร้อม — จุดเรียกต้องเช็ค */
function buildNdaClauses(ctx) {
  const mutual = (ctx.nda_type === 'mutual');
  if (mutual && !ndaMutualReady()) return null;
  const T = mutual ? NDA_T_MUTUAL : NDA_T;
  const c1 = String(T.c1).replace('{SUBJECT}', ctx.subject || ctx.purpose).replace('{OBJECTIVE}', ctx.objective || ctx.purpose);
  const c7 = String(T.c7).replace('{YEARS}', ctx.years).replace('{START}', ctx.start_th).replace('{END}', ctx.end_th);
  return { c1, c2: T.c2, c3: T.c3, c4: T.c4, c5: T.c5, c6: T.c6, c7, c8: T.c8 };
}
/* intro / closing ก็ต้องสลับตามประเภทด้วย */
function ndaMeta2(ndaType) {
  const T = (ndaType === 'mutual' && ndaMutualReady()) ? NDA_T_MUTUAL : NDA_T;
  return { intro: T.intro || NDA_T.intro, closing: T.closing || NDA_T.closing };
}
/* ชื่อเรียกคู่สัญญาตามประเภท — ฉบับ Mutual ทั้งสองฝ่ายเป็นทั้งผู้ให้และผู้รับ */
function ndaRoleNames(ndaType) {
  return (ndaType === 'mutual')
    ? { a: 'คู่สัญญาฝ่ายที่หนึ่ง', b: 'คู่สัญญาฝ่ายที่สอง' }
    : { a: 'ผู้ให้ข้อมูล', b: 'ผู้รับข้อมูล' };
}

// AI ช่วยแยกเฉพาะ "ช่องว่าง" ข้อ 1 จากข้อความที่ผู้ใช้พิมพ์เอง (ไม่ร่างเนื้อกฎหมาย)
// เรียกไม่ได้/พัง → fallback ใช้ purpose ตรง ๆ (ไม่บล็อก flow)
async function extractSlots(ctx) {
  const fb = { subject: ctx.purpose, objective: ctx.purpose, nda_type: 'one_way', risk_level: 'medium' };
  if (!ANTHROPIC_KEY) return fb;
  try {
    const sys = [
      'ดึงคำ/วลีจากข้อความที่ผู้ใช้พิมพ์เพื่อเติมช่องว่างในสัญญา ห้ามแต่งเติมหรือร่างประโยคใหม่',
      'ตอบเป็น JSON เท่านั้น เริ่มด้วย { ทันที ปิดด้วย } ไม่มีข้อความอื่น',
      '{ "subject": "ประเภท/หัวข้อข้อมูลที่จะเปิดเผย (วลีสั้น)", "objective": "วัตถุประสงค์การใช้ข้อมูล (วลีสั้น)", "nda_type": "one_way หรือ mutual", "risk_level": "low/medium/high" }',
    ].join('\n');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: NDA_GEN_MODEL, max_tokens: 400, temperature: 0,
        system: sys,
        messages: [{ role: 'user', content: `ข้อความจากผู้ใช้: ${ctx.purpose}` }],
      }),
    });
    if (!r.ok) return fb;
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const j = extractJson(text);
    if (!j) return fb;
    return {
      subject: String(j.subject || ctx.purpose).trim() || ctx.purpose,
      objective: String(j.objective || ctx.purpose).trim() || ctx.purpose,
      nda_type: ['one_way', 'mutual'].includes(j.nda_type) ? j.nda_type : 'one_way',
      risk_level: ['low', 'medium', 'high'].includes(j.risk_level) ? j.risk_level : 'medium',
    };
  } catch (_) { return fb; }
}

// ════════════════════════════════════════════════════════════════
//  SignDee NOTICE — ทวงถามค่าเช่า / บอกเลิกสัญญา / แจ้งตำรวจ
//  ⚠️ เนื้อหนังสือประกอบที่ server เท่านั้น — ยังไม่ชำระเงิน = ไม่ส่งเนื้อหาออก
//  ข้อความ verbatim จากไฟล์ Word ของ Ken เติมเฉพาะช่องว่าง
// ════════════════════════════════════════════════════════════════
const NOTICE_TABLE = 'notice_cases';
const TH_MO = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

function ntDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  return d.getDate() + ' ' + TH_MO[d.getMonth()] + ' พ.ศ. ' + (d.getFullYear() + 543);
}
function ntParts(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return { d: '........', m: '.....................', y: '...........' };
  return { d: String(d.getDate()), m: TH_MO[d.getMonth()], y: String(d.getFullYear() + 543) };
}
function ntMoney(v) { return (Number(v) || 0).toLocaleString('en-US'); }
function ntDash(v) { return (v && String(v).trim()) ? String(v).trim() : '........................'; }
function ntMonthLabel(m, y) { if (!m || !y) return ''; return TH_MO[parseInt(m, 10) - 1] + ' ' + (parseInt(y, 10) + 543); }
function ntBaht(numV) {
  let n = Math.round(Number(numV) || 0);
  if (n === 0) return 'ศูนย์บาทถ้วน';
  const d = ['','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
  const p = ['','สิบ','ร้อย','พัน','หมื่น','แสน'];
  function rg(g) {
    const str = String(g), len = str.length; let o = '';
    for (let i = 0; i < len; i++) {
      const dig = parseInt(str[i], 10), pos = len - 1 - i;
      if (!dig) continue;
      if (pos === 0 && dig === 1 && len > 1) o += 'เอ็ด';
      else if (pos === 1 && dig === 2) o += 'ยี่สิบ';
      else if (pos === 1 && dig === 1) o += 'สิบ';
      else o += d[dig] + p[pos];
    }
    return o;
  }
  const mil = Math.floor(n / 1000000), rest = n % 1000000;
  let o = '';
  if (mil) o += rg(mil) + 'ล้าน';
  if (rest) o += rg(rest);
  return o + 'บาทถ้วน';
}
function ntAddr2(a) {
  const s2 = String(a || '').trim(); if (!s2) return ['', ''];
  const m = /(อำเภอ|เขต)/.exec(s2);
  if (!m) return [s2, ''];
  return [s2.slice(0, m.index).trim(), s2.slice(m.index).trim()];
}
function ntPropRef(LS) {
  const parts = [LS.ptype || 'ทรัพย์ที่เช่า'];
  if (LS.pno) parts.push('โครงการ ' + LS.pno);
  parts.push(LS.house ? ('เลขที่ ' + LS.house) : 'เลขที่ ........................');
  return parts.join(' ');
}
function ntBreachList(row) {
  return (Array.isArray(row.breaches) ? row.breaches : [])
    .map(b => (b && b.type === 'อื่นๆ โปรดระบุ') ? String(b.note || '').trim() : ((b && b.type) || ''))
    .filter(Boolean);
}
function ntBreachBody(list) {
  return (list.length === 1 ? list[0] : list.map((x, i) => '(' + (i + 1) + ') ' + x).join(' ')) +
         ' ซึ่งเป็นการผิดสัญญาเช่าในสาระสำคัญ';
}
function ntTenantName(T) {
  return [T.name, T.name2].filter(Boolean).join(' และ ') || '........................................';
}
function ntLeaseRef(LS) {
  return [LS.leaseNo ? ('เลขที่ ' + LS.leaseNo) : '', LS.leaseDate ? ('ลงวันที่ ' + ntDate(LS.leaseDate)) : '']
           .filter(Boolean).join(' ') || '[เลขที่ ลงวันที่ ]';
}

// ── ① หนังสือทวงถามค่าเช่า ──
function ntBuildDemand(row) {
  const L = row.landlord || {}, T = row.tenant || {}, LS = row.lease || {}, AR = row.arrears || {};
  const DM = row.demand || {};
  const ip = ntParts(DM.issuedDate), lp = ntParts(LS.leaseDate);
  const bl = ntBreachList(row);
  const hasAr = Number(AR.total || 0) > 0;
  const days = DM.days || 15;
  const rentMonths = (AR.rentItems || []).map(x => ntMonthLabel(x.m, x.y)).filter(Boolean).join(', ');
  const utilMonths = (AR.utilItems || []).map(x => ntMonthLabel(x.m, x.y)).filter(Boolean).join(', ');
  const brBody = bl.length ? ntBreachBody(bl) : '';
  const brSolo = bl.length ? ('ข้อเท็จจริงปรากฏว่า ท่านได้ปฏิบัติผิดเงื่อนไขของสัญญาเช่าดังกล่าวข้างต้น กล่าวคือ ' + brBody) : '';
  const brAdd  = bl.length ? ('นอกจากนี้ ท่านยังได้ปฏิบัติผิดเงื่อนไขของสัญญาเช่าดังกล่าวข้างต้น กล่าวคือ ' + brBody) : '';
  const act = hasAr
    ? (bl.length ? 'ดำเนินการชำระเงินค่าเช่าและค่าน้ำประปา/ค่าไฟฟ้าดังกล่าวข้างต้นให้แก่ข้าพเจ้า และแก้ไขการปฏิบัติผิดสัญญาให้ถูกต้อง'
                 : 'ดำเนินการชำระเงินค่าเช่าและค่าน้ำประปา/ค่าไฟฟ้าดังกล่าวข้างต้นให้แก่ข้าพเจ้า')
    : 'ระงับการกระทำดังกล่าว และแก้ไขการปฏิบัติผิดสัญญาให้ถูกต้อง';
  const failTxt = hasAr
    ? (bl.length ? 'ท่านยังคงละเลยไม่ชำระเงินจำนวนดังกล่าวหรือไม่แก้ไขการปฏิบัติผิดสัญญา' : 'ท่านยังคงละเลยไม่ชำระเงินจำนวนดังกล่าว')
    : 'ท่านยังคงละเลยไม่แก้ไขการปฏิบัติผิดสัญญา';
  const subject = (hasAr && bl.length) ? 'ขอให้ชำระค่าเช่าค้างชำระ และปฏิบัติตามสัญญาเช่าให้ถูกต้อง'
                : (bl.length ? 'ขอให้ปฏิบัติตามสัญญาเช่าให้ถูกต้อง' : 'ขอให้ชำระค่าเช่าค้างชำระและค่าน้ำประปา/ค่าไฟฟ้า');
  const p2 = hasAr
    ? ('ปรากฏว่า ท่านได้ค้างชำระค่าเช่าประจำเดือน ' + ntDash(rentMonths) +
       ' เป็นเงินทั้งสิ้น ' + ntMoney(AR.rentTotal) + ' บาท (' + ntBaht(AR.rentTotal) + ')' +
       (Number(AR.utilTotal || 0) > 0 ? '  รวมถึงค่าน้ำประปาและค่าไฟฟ้าประจำเดือน ' + ntDash(utilMonths) + ' เป็นเงิน ' + ntMoney(AR.utilTotal) + ' บาท' : '') +
       ' รวมทั้งสิ้น ' + ntMoney(AR.total) + ' บาท (' + ntBaht(AR.total) + ')' + (brAdd ? ('  ' + brAdd) : ''))
    : brSolo;
  return {
    place2: ntAddr2(LS.paddr || ''),
    dateLine: 'วันที่ ' + ip.d + ' เดือน ' + ip.m + ' พ.ศ. ' + ip.y,
    subject, to: ntTenantName(T),
    ref: 'อ้างถึง สัญญาเช่า ' + ntLeaseRef(LS),
    p1: 'ตามที่ท่านได้ทำสัญญาเช่าที่อ้างถึง ' + ntPropRef(LS) +
        ' ตามสัญญาเช่าลงวันที่ ' + lp.d + ' เดือน ' + lp.m + ' พ.ศ. ' + lp.y +
        ' โดยกำหนดชำระค่าเช่าทุกวันที่ ' + ntDash(LS.dueDay) + ' ของเดือน ในอัตราเดือนละ ' + ntMoney(LS.rent) + ' บาท ความละเอียดแจ้งแล้วนั้น',
    p2,
    p3: 'ในการนี้ จึงขอให้ท่าน' + act + 'ภายในกำหนด ' + days +
        ' วัน นับแต่วันที่ท่านได้รับหนังสือฉบับนี้ หากพ้นกำหนดเวลาดังกล่าวแล้ว ' + failTxt +
        ' ข้าพเจ้ามีความจำเป็นต้องขอใช้สิทธิบอกเลิกสัญญาเช่า' +
        (DM.softTone ? '' : ' ตัดการจ่ายสาธารณูปโภค การเข้าออกทรัพย์ที่ให้เช่า') + ' และดำเนินการตามกฎหมายต่อไป',
    signer: L.name || '',
  };
}

// ── ② หนังสือบอกเลิกสัญญาเช่า ──
function ntBuildTerminate(row) {
  const L = row.landlord || {}, T = row.tenant || {}, LS = row.lease || {}, AR = row.arrears || {};
  const DM = row.demand || {}, TM = row.terminate || {};
  const ip = ntParts(TM.issuedDate), lp = ntParts(LS.leaseDate), dp = ntParts(DM.issuedDate);
  const days = TM.days || 7;
  const bl = ntBreachList(row);
  const hasAr = Number(AR.total || 0) > 0;
  const lead = hasAr
    ? ('ปรากฏว่า แต่ท่านยังคงละเลยมิได้ทำการชำระเงินค่าเช่าและค่าน้ำ/ค่าไฟฟ้าที่ค้างชำระแต่อย่างใด' +
       (bl.length ? (' อีกทั้งยังคงปฏิบัติผิดเงื่อนไขของสัญญาเช่า กล่าวคือ ' + ntBreachBody(bl) + ' โดยมิได้แก้ไขให้ถูกต้อง') : ''))
    : ('ปรากฏว่า ท่านยังคงปฏิบัติผิดเงื่อนไขของสัญญาเช่า กล่าวคือ ' + ntBreachBody(bl) + ' โดยมิได้แก้ไขให้ถูกต้องแต่อย่างใด');
  const tail = TM.softTone
    ? 'หากท่านไม่ย้ายออกภายในกำหนดเวลาดังกล่าว ข้าพเจ้าจะดำเนินการตามกฎหมาย โดยใช้สิทธิทางศาลเพื่อขับไล่และเรียกค่าเสียหายจากท่านต่อไป'
    : 'หากท่านไม่ย้ายออกภายในกำหนดเวลาดังกล่าว ข้าพเจ้าจะเข้าดำเนินการล็อกประตูสถานที่เช่า ตัดสาธารณูปโภค การเข้าออกทรัพย์ที่ให้เช่า ขนย้ายทรัพย์สิน บริวาร ย้ายออกจากสถานที่เช่า และดำเนินการตามกฎหมายต่อไป';
  return {
    place2: ntAddr2(LS.paddr || ''),
    dateLine: 'วันที่ ' + ip.d + ' เดือน ' + ip.m + ' พ.ศ. ' + ip.y,
    subject: 'บอกเลิกสัญญาเช่า และขอให้ส่งมอบพื้นที่เช่าคืน',
    to: ntTenantName(T),
    ref1: 'อ้างถึง  1. สัญญาเช่า ' + ntLeaseRef(LS),
    ref2: '           2. หนังสือ ฉบับลงวันที่ ' + dp.d + ' เดือน ' + dp.m + ' พ.ศ. ' + dp.y + ' เรื่อง ขอให้ชำระค่าเช่าค้างชำระและค่าน้ำประปา/ค่าไฟฟ้า',
    p1: 'ตามที่ท่านได้ทำสัญญาเช่าที่อ้างถึง 1. ' + ntPropRef(LS) +
        ' ตามสัญญาเช่าลงวันที่ ' + lp.d + ' เดือน ' + lp.m + ' พ.ศ. ' + lp.y +
        ' โดยกำหนดชำระค่าเช่าทุกวันที่ ' + ntDash(LS.dueDay) + ' ของเดือน ในอัตราเดือนละ ' + ntMoney(LS.rent) +
        ' บาท และหนังสือขอให้ชำระค่าเช่าค้างชำระและค่าน้ำประปา/ค่าไฟฟ้าอ้างถึง 2. ซึ่งท่านได้รับไว้โดยชอบแล้ว ความละเอียดแจ้งแล้วนั้น',
    p2: lead + ' ด้วยเหตุนี้ ข้าพเจ้าในฐานะผู้ให้เช่า จึงขอใช้สิทธิบอกเลิกสัญญาเช่าที่อ้างถึง 1. โดยให้สัญญาเช่าเป็นอันสิ้นสุดลงนับแต่วันที่ท่านได้รับหนังสือฉบับนี้ และขอให้ท่านดำเนินการขนย้ายทรัพย์สิน บริวาร และย้ายออกจากสถานที่เช่าภายในกำหนด ' +
        days + ' วัน นับแต่วันที่ได้รับหนังสือฉบับนี้ พร้อมทั้งชำระค่าเช่าที่ค้างชำระ ค่าน้ำประปา ค่าไฟฟ้า และค่าเสียหายจากการขาดประโยชน์จนถึงวันที่ย้ายออกจริง ตลอดจนส่งมอบกุญแจและคีย์การ์ดคืนแก่ข้าพเจ้า ณ วันที่ย้ายออก ' + tail,
    signer: L.name || '',
  };
}

// ── ③ หนังสือแจ้งตำรวจ (ลงบันทึกประจำวัน) ──
function ntBuildPolice(row) {
  const L = row.landlord || {}, T = row.tenant || {}, LS = row.lease || {}, AR = row.arrears || {};
  const DM = row.demand || {}, EV = row.evidence || {}, P = EV.police || {};
  const dp = ntParts(P.date), lp = ntParts(LS.leaseDate);
  const cs = ((row.demand_delivery || {}).copies) || [];
  const rentMonths = (AR.rentItems || []).map(x => ntMonthLabel(x.m, x.y)).filter(Boolean).join(', ');
  const bl = ntBreachList(row);
  const facts = [];
  let i = 1;
  facts.push(i++ + '. ข้าพเจ้า ' + ntDash(L.name) + (L.id13 ? (' เลขประจำตัวประชาชน ' + L.id13) : '') +
    ' เป็นผู้ให้เช่า ' + ntPropRef(LS) + ' ตั้งอยู่ ' + ntDash(LS.paddr));
  facts.push(i++ + '. ข้าพเจ้าได้ทำสัญญาเช่ากับ ' + ntDash(ntTenantName(T)) +
    ' ตามสัญญาเช่า' + (LS.leaseNo ? (' เลขที่ ' + LS.leaseNo) : '') +
    ' ลงวันที่ ' + lp.d + ' เดือน ' + lp.m + ' พ.ศ. ' + lp.y +
    ' อัตราค่าเช่าเดือนละ ' + ntMoney(LS.rent) + ' บาท กำหนดชำระทุกวันที่ ' + ntDash(LS.dueDay) + ' ของเดือน');
  if (Number(AR.total || 0) > 0) {
    facts.push(i++ + '. ผู้เช่าผิดนัดไม่ชำระค่าเช่าประจำเดือน ' + ntDash(rentMonths) +
      ' รวมค่าเช่าและค่าสาธารณูปโภคค้างชำระเป็นเงินทั้งสิ้น ' + ntMoney(AR.total) + ' บาท (' + ntBaht(AR.total) + ')');
  }
  if (bl.length) facts.push(i++ + '. ผู้เช่าปฏิบัติผิดเงื่อนไขของสัญญาเช่า กล่าวคือ ' + ntBreachBody(bl));
  const sent = cs.filter(c => c && c.sentDate);
  if (sent.length) {
    const c = sent[0];
    const addr = [c.house, c.road, c.sub ? ('ตำบล/แขวง' + c.sub) : '', c.dist ? ('อำเภอ/เขต' + c.dist) : '', c.prov, c.zip].filter(Boolean).join(' ');
    facts.push(i++ + '. ข้าพเจ้าได้มีหนังสือทวงถามให้ชำระหนี้ ส่งทางไปรษณีย์ลงทะเบียนตอบรับ' +
      (c.tracking ? (' เลขที่สิ่งของ ' + c.tracking) : '') +
      ' เมื่อวันที่ ' + ntDate(c.sentDate) + ' ไปยังที่อยู่ตามบัตรประชาชนของผู้เช่า คือ ' + ntDash(addr));
    const rec = cs.filter(c2 => c2 && c2.recvDate);
    if (rec.length) {
      const r = rec[rec.length - 1];
      facts.push(i++ + '. ผู้เช่าได้รับหนังสือดังกล่าวแล้วเมื่อวันที่ ' + ntDate(r.recvDate) +
        (r.recvName ? (' โดยมี ' + r.recvName + ' เป็นผู้ลงชื่อรับ') : '') +
        ' ปรากฏตามใบตอบรับ (ป.133) ที่แนบมาพร้อมนี้');
      if (DM.deadlineDate) {
        facts.push(i++ + '. หนังสือดังกล่าวกำหนดให้ผู้เช่าชำระหนี้ภายใน ' + (DM.days || 15) +
          ' วันนับแต่วันที่ได้รับ ซึ่งครบกำหนดในวันที่ ' + ntDate(DM.deadlineDate) +
          ' แต่จนถึงขณะนี้ผู้เช่ายังคงเพิกเฉย มิได้ชำระหนี้แต่อย่างใด');
      }
    }
  }
  facts.push(i++ + '. ข้าพเจ้าจึงมาแจ้งความไว้เป็นหลักฐาน เพื่อประโยชน์ในการดำเนินการตามกฎหมายต่อไป');
  return {
    dateLine: 'วันที่ ' + dp.d + ' เดือน ' + dp.m + ' พ.ศ. ' + dp.y,
    station: P.station || '........................................',
    stationAddr: P.stationAddr || '',
    subject: 'ขอความอนุเคราะห์ลงบันทึกประจำวันไว้เป็นหลักฐาน',
    facts,
    purpose: 'ทั้งนี้ ข้าพเจ้าประสงค์ขอให้พนักงานสอบสวนบันทึกข้อเท็จจริงข้างต้นไว้เป็นหลักฐานในบันทึกประจำวัน เพื่อใช้ประกอบการดำเนินคดีตามกฎหมายและการใช้สิทธิทางศาลต่อไป',
    attach: ['สำเนาสัญญาเช่า', 'สำเนาหนังสือทวงถามให้ชำระหนี้', 'ใบตอบรับไปรษณีย์ลงทะเบียน (ป.133)', 'สำเนาบัตรประจำตัวประชาชนของข้าพเจ้า'],
    signer: L.name || '', phone: L.phone || '',
  };
}

// ══════════════════════════════════════════════════════════════════════
//  POST { action:'notice_conversion', row_id, gclid?, source? }
//  Google Ads Purchase conversion — "ผู้ตัดสิน" ว่ายิงได้หรือไม่ อยู่ที่ฝั่งนี้เท่านั้น
//
//  คืน { ok, fire, reason, transaction_id, value, currency }
//    fire=true  → frontend ยิง gtag('event','purchase') ได้ (ครั้งเดียวเท่านั้น)
//    fire=false → reason = 'unpaid' | 'already_sent' | 'not_found'
//
//  กัน duplicate แบบ atomic: PATCH เฉพาะแถวที่ ads_conversion_sent_at ยัง null
//  (PostgREST filter) → ถ้าสองแท็บยิงพร้อมกัน จะมีแค่แท็บเดียวที่ได้ row กลับมา
// ══════════════════════════════════════════════════════════════════════
const NOTICE_PRICE_THB = 2990;   // ฿2,990 ต่อเคส (ตรงกับ PRICE ที่ใช้สร้าง charge)

async function handleNoticeConversion(req, res, body) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสเคส' });

  const row = await sbGetT(NOTICE_TABLE, rowId);
  if (!row) return res.status(404).json({ ok: true, fire: false, reason: 'not_found' });

  // (1) ต้องชำระเงินสำเร็จจริงตามฐานข้อมูลเท่านั้น — ไม่เชื่อ client
  if (row.payment_completed !== true)
    return res.status(200).json({ ok: true, fire: false, reason: 'unpaid' });

  // (2) ส่งไปแล้ว → ห้ามส่งซ้ำ
  if (row.ads_conversion_sent_at)
    return res.status(200).json({
      ok: true, fire: false, reason: 'already_sent',
      transaction_id: row.ads_transaction_id || null,
      sent_at: row.ads_conversion_sent_at,
    });

  const txnId = String(row.payment_ref || row.case_no || ('NT-' + rowId)).slice(0, 100);
  const value = Number(row.ads_value || row.payment_amount || NOTICE_PRICE_THB) || NOTICE_PRICE_THB;

  // (3) จองสิทธิ์ยิง conversion แบบ atomic — อัปเดตเฉพาะแถวที่ยังไม่เคยส่ง
  let claimed = false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${NOTICE_TABLE}`
      + `?id=eq.${encodeURIComponent(rowId)}&ads_conversion_sent_at=is.null`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
      body: JSON.stringify({
        ads_conversion_sent_at: new Date().toISOString(),
        ads_transaction_id: txnId,
        ads_value: value,
        ads_gclid: (body.gclid || row.ads_gclid || null),
        ads_source: (body.source && typeof body.source === 'object') ? body.source : (row.ads_source || null),
      }),
    });
    const updated = await r.json().catch(() => []);
    claimed = r.ok && Array.isArray(updated) && updated.length > 0;
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'claim_failed', detail: String(e.message || e).slice(0, 160) });
  }

  if (!claimed)   // มีคนอื่นจองไปก่อนแล้วเสี้ยววินาทีนี้
    return res.status(200).json({ ok: true, fire: false, reason: 'already_sent' });

  return res.status(200).json({
    ok: true, fire: true,
    transaction_id: txnId,
    value: value,
    currency: 'THB',
    case_no: row.case_no || null,
  });
}

// ── POST { action:'notice_conv_status', row_id } — อ่านอย่างเดียว (ใช้ debug/ตรวจสอบ) ──
async function handleNoticeConvStatus(req, res, body) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id' });
  const row = await sbGetT(NOTICE_TABLE, rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found' });
  return res.status(200).json({
    ok: true,
    paid: row.payment_completed === true,
    paid_at: row.paid_at || null,
    payment_ref: row.payment_ref || null,
    conversion_sent_at: row.ads_conversion_sent_at || null,
    transaction_id: row.ads_transaction_id || null,
    value: row.ads_value || null,
    gclid: row.ads_gclid || null,
  });
}

// ── POST { action:'notice_doc', row_id, doc:'demand'|'terminate'|'police' } ──
//  ส่งรูปแบบกลาง: { ok, locked, case_no, doc:{ place,dateLine,subject,to,refs[],paras[],attach[],signRole,signer,phone,noIndent } }
//  🔒 locked = true → doc มีเฉพาะส่วนหัว (paras ว่าง) เนื้อหาไม่ออกจาก server
async function handleNoticeDoc(req, res, body) {
  const rowId = body.row_id;
  const kind  = body.doc || 'demand';
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสเคส' });
  if (!['demand', 'terminate', 'police'].includes(kind))
    return res.status(400).json({ ok: false, code: 'bad_doc', message_th: 'ไม่รู้จักเอกสาร' });

  const row = await sbGetT(NOTICE_TABLE, rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบเคส' });

  const paid = (row.payment_completed === true);
  const LS = row.lease || {}, T = row.tenant || {}, L = row.landlord || {};

  let doc;
  if (kind === 'police') {
    const EV = row.evidence || {}, P = EV.police || {};
    const dp = ntParts(P.date);
    const full = paid ? ntBuildPolice(row) : null;
    doc = {
      place: '',
      dateLine: 'วันที่ ' + dp.d + ' เดือน ' + dp.m + ' พ.ศ. ' + dp.y,
      subject: 'ขอความอนุเคราะห์ลงบันทึกประจำวันไว้เป็นหลักฐาน',
      to: 'พนักงานสอบสวน ' + (P.station || '........................................'),
      refs: P.stationAddr ? [P.stationAddr] : [],
      paras: full ? full.facts.concat([full.purpose]) : [],
      attach: full ? full.attach : [],
      signRole: 'ผู้แจ้ง',
      signer: L.name || '',
      phone: L.phone || '',
      noIndent: true,
    };
  } else if (kind === 'terminate') {
    const TM = row.terminate || {}, DM = row.demand || {};
    const ip = ntParts(TM.issuedDate), dp = ntParts(DM.issuedDate);
    const full = paid ? ntBuildTerminate(row) : null;
    doc = {
      place: LS.paddr || '',
      dateLine: 'วันที่ ' + ip.d + ' เดือน ' + ip.m + ' พ.ศ. ' + ip.y,
      subject: 'บอกเลิกสัญญาเช่า และขอให้ส่งมอบพื้นที่เช่าคืน',
      to: ntTenantName(T),
      refs: [
        'อ้างถึง  1. สัญญาเช่า ' + ntLeaseRef(LS),
        '           2. หนังสือ ฉบับลงวันที่ ' + dp.d + ' เดือน ' + dp.m + ' พ.ศ. ' + dp.y + ' เรื่อง ขอให้ชำระค่าเช่าค้างชำระและค่าน้ำประปา/ค่าไฟฟ้า',
      ],
      paras: full ? [full.p1, full.p2] : [],
      attach: [],
      signRole: '(ผู้ให้เช่า)',
      signer: L.name || '',
      phone: '',
    };
  } else {
    const DM = row.demand || {};
    const ip = ntParts(DM.issuedDate);
    const full = paid ? ntBuildDemand(row) : null;
    // หัวเรื่องคำนวณจากเหตุที่เลือก — เปิดให้เห็นได้ก่อนจ่าย (ไม่ใช่เนื้อหา)
    const bl = ntBreachList(row);
    const hasAr = Number((row.arrears || {}).total || 0) > 0;
    const subject = (hasAr && bl.length) ? 'ขอให้ชำระค่าเช่าค้างชำระ และปฏิบัติตามสัญญาเช่าให้ถูกต้อง'
                  : (bl.length ? 'ขอให้ปฏิบัติตามสัญญาเช่าให้ถูกต้อง'
                               : 'ขอให้ชำระค่าเช่าค้างชำระและค่าน้ำประปา/ค่าไฟฟ้า');
    doc = {
      place: LS.paddr || '',
      dateLine: 'วันที่ ' + ip.d + ' เดือน ' + ip.m + ' พ.ศ. ' + ip.y,
      subject,
      to: ntTenantName(T),
      refs: ['อ้างถึง สัญญาเช่า ' + ntLeaseRef(LS)],
      paras: full ? [full.p1, full.p2, full.p3] : [],
      attach: [],
      signRole: '(ผู้ให้เช่า)',
      signer: L.name || '',
      phone: '',
    };
  }

  return res.status(200).json({ ok: true, locked: !paid, case_no: row.case_no || '', doc });
}

// ── POST { action:'generate', row_id } ──
async function handleNdaGenerate(req, res, body) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสสัญญา' });
  const row = await sbGet(rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });

  // ล็อกเนื้อหาหลังเริ่มเซ็น
  if (row.a_signed_at || row.b_signed_at)
    return res.status(409).json({ ok: false, code: 'locked', message_th: 'สัญญาเริ่มลงนามแล้ว แก้ไขไม่ได้' });

  const aName = partyName(row.party_a), bName = partyName(row.party_b);
  const purpose = (row.purpose || '').trim();
  if (aName === '—' || bName === '—' || purpose.length < 5)
    return res.status(400).json({ ok: false, code: 'incomplete', message_th: 'ข้อมูลคู่สัญญาหรือวัตถุประสงค์ไม่ครบ' });

  const months = row.duration_months || 12;
  const now = new Date();
  const start = now, end = addMonths(now, months);
  const slots = await extractSlots({ purpose });   // AI เติมเฉพาะช่องว่างข้อ 1 (มี fallback)

  /* ประเภท NDA: ผู้ใช้เลือกเองมีน้ำหนักสูงสุด → ค่าที่เคยบันทึกไว้ในแถว → AI เดา
     (AI เดาไว้เป็น fallback เฉย ๆ ห้ามให้ทับสิ่งที่ผู้ใช้เลือก) */
  const _wanted = ['one_way', 'mutual'].includes(body.nda_type) ? body.nda_type
                : (['one_way', 'mutual'].includes(row.nda_type) ? row.nda_type : slots.nda_type);
  if (_wanted === 'mutual' && !ndaMutualReady())
    return res.status(400).json({
      ok: false, code: 'mutual_not_ready',
      message_th: 'ฉบับ Mutual NDA ยังไม่เปิดใช้งาน — อยู่ระหว่างรอทนายรีวิวข้อความ กรุณาเลือก One-way NDA ไปก่อน',
    });
  const ndaType = _wanted, risk = slots.risk_level;

  const ctx = {
    purpose, years: (months / 12 % 1 === 0) ? String(months / 12) : (months + ' เดือน'),
    subject: slots.subject, objective: slots.objective,
    start_th: thDate(start), end_th: thDate(end),
    nda_type: ndaType,
  };
  const clauses = buildNdaClauses(ctx);   // 8 ข้อ verbatim + slot
  if (!clauses)
    return res.status(400).json({ ok: false, code: 'mutual_not_ready',
      message_th: 'ฉบับ Mutual NDA ยังไม่เปิดใช้งาน — อยู่ระหว่างรอทนายรีวิวข้อความ' });

  const _t2 = ndaMeta2(ndaType), _roles = ndaRoleNames(ndaType);
  // meta หัวสัญญา (รายละเอียดคู่สัญญาตามฟอร์ม Word)
  const meta = {
    contract_no: row.contract_no || '',
    date_th: thDate(now),
    a: partyDetailLine(row.party_a, row.a_card),
    b: partyDetailLine(row.party_b, row.b_card),
    years: ctx.years, start_th: ctx.start_th, end_th: ctx.end_th,
    intro: _t2.intro, closing: _t2.closing,
    nda_type: ndaType, roles: _roles,
  };

  // hash ของสัญญาฉบับเต็ม (เรียงข้อ 1-8)
  const fullText = Array.from({ length: 8 }, (_, i) => clauses['c' + (i + 1)]).join('\n\n');
  const hash = sha256(fullText);

  const hist = Array.isArray(row.hash_history) ? row.hash_history.slice() : [];
  hist.push({ stage: 'generated', hash, ts: new Date().toISOString() });

  await sbPatch(rowId, {
    clauses_json: clauses, doc_hash: hash, hash_history: hist,
    nda_type: ndaType, risk_level: risk, status: 'generated',
  });
  await ndaAudit(row, 'nda_generate', req, { model: NDA_GEN_MODEL, nda_type: ndaType, risk_level: risk });

  // preview: ข้อ 2-8 = placeholder (ห้ามส่งของจริงมา client ก่อนจ่าย)
  const BLUR = 'ปลดล็อกสัญญาฉบับเต็มเพื่ออ่านข้อนี้ — เนื้อหาถูกป้องกันไว้ที่เซิร์ฟเวอร์จนกว่าจะชำระเงิน';
  const preview = {};
  for (let i = 1; i <= 8; i++) {
    const k = 'c' + i;
    preview[k] = (i >= 2 && i <= 8) ? `${i}. 🔒 ${BLUR}` : clauses[k];
  }
  return res.status(200).json({
    ok: true, status: 'generated', nda_type: ndaType, risk_level: risk,
    doc_hash: hash, parties: { a: aName, b: bName }, meta,
    clauses_preview: preview,
  });
}

// ── POST { action:'content', row_id, token? } → เนื้อจริง หลังเช็คจ่าย/token ──
async function handleNdaContent(req, res, body) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสสัญญา' });
  const row = await sbGet(rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });

  const token = (body.token || '').trim();
  const tokenOk = token && (token === row.a_read_token || token === row.b_read_token);
  let paid = row.payment_completed === true;

  // ── ปลดล็อกโดยไม่จ่าย: อนุญาต 2 กรณีเท่านั้น ──
  //   1) NDA_ALLOW_SKIP=1  → preview/staging deployment
  //   2) dev_key ตรงกับ ADMIN_PASSWORD → โหมด dev บน production (เจ้าของระบบเท่านั้น)
  //   รหัสไม่เคยอยู่ในซอร์สฝั่ง client — ผู้ใช้ทั่วไปข้ามไม่ได้
  const _devSecrets = [process.env.NDA_DEV_KEY, process.env.ADMIN_PASSWORD].filter(Boolean);
  const devKeyOk = !!body.dev_key && _devSecrets.includes(body.dev_key);
  const _envSkip  = (process.env.NDA_ALLOW_SKIP === '1');
  // dev_key ผิด → 401 เฉพาะตอนที่ deployment นี้ "ไม่ได้" เปิด NDA_ALLOW_SKIP ไว้
  //   เดิมเช็คก่อน NDA_ALLOW_SKIP ทำให้รหัส dev ค้างเก่าใน localStorage
  //   บล็อกการข้ามบน staging ทั้งที่ env อนุญาตอยู่แล้ว
  if (body.skip === true && body.dev_key && !devKeyOk && !_envSkip)
    return res.status(401).json({ ok: false, code: 'bad_dev_key', message_th: 'รหัสผ่าน dev ไม่ถูกต้อง' });

  if (!paid && body.skip === true && (_envSkip || devKeyOk)) {
    await sbPatch(rowId, { payment_completed: true, payment_ref: 'SKIP-TEST', status: 'paid' });
    await ndaAudit(row, 'payment_skipped_staging', req, { via: devKeyOk ? 'dev_key' : 'env' });
    row.payment_completed = true;
    paid = true;
  }

  // 🔒 ปิดช่องโหว่: read token ปลดล็อกเนื้อหาได้เฉพาะสัญญาที่ชำระเงินแล้วเท่านั้น
  //    (anon เขียน a_read_token/b_read_token ได้ ถ้ายอมให้ token ผ่านโดยไม่เช็คเงิน
  //     ผู้ใช้จะสร้าง token เองแล้วดึงสัญญาฉบับเต็มโดยไม่จ่ายได้)
  if (!paid)
    return res.status(403).json({ ok: false, code: 'locked', message_th: 'ยังไม่ปลดล็อก (ต้องชำระเงินก่อน)' });
  if (!tokenOk && body.token)
    return res.status(403).json({ ok: false, code: 'bad_token', message_th: 'ลิงก์ลงนามไม่ถูกต้อง' });

  const _t2c = ndaMeta2(row.nda_type);
  const meta = {
    contract_no: row.contract_no || '',
    date_th: thDate(new Date(row.created_at || Date.now())),
    a: partyDetailLine(row.party_a, row.a_card),
    b: partyDetailLine(row.party_b, row.b_card),
    intro: _t2c.intro, closing: _t2c.closing,
    nda_type: row.nda_type || 'one_way', roles: ndaRoleNames(row.nda_type),
  };
  return res.status(200).json({
    ok: true, doc_hash: row.doc_hash, clauses: row.clauses_json || null, meta,
    parties: { a: partyName(row.party_a), b: partyName(row.party_b) },
    nda_type: row.nda_type, status: row.status,
  });
}

// ── POST { action:'notify', row_id, party:'a'|'b', to } → push ลิงก์เซ็นผ่าน LINE ──
async function handleNdaNotify(req, res, body) {
  const { row_id: rowId, party, to } = body;
  if (!rowId || !['a', 'b'].includes(party) || !to)
    return res.status(400).json({ ok: false, code: 'bad_params', message_th: 'พารามิเตอร์ไม่ครบ' });
  if (!LINE_TOKEN) return res.status(200).json({ ok: false, code: 'line_not_configured', message_th: 'ยังไม่ตั้งค่า LINE' });

  const row = await sbGet(rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });
  const token = party === 'a' ? row.a_read_token : row.b_read_token;
  if (!token) return res.status(409).json({ ok: false, code: 'no_token', message_th: 'ยังไม่มี token สำหรับฝ่ายนี้' });

  const base = (body.sign_base_url || 'https://app.signdee.com/index-nda.html').replace(/\/$/, '');
  const link = `${base}?sign=${encodeURIComponent(token)}`;
  const name = partyName(party === 'a' ? row.party_a : row.party_b);
  const text = `📄 SignDee — คำขอลงนามสัญญารักษาความลับ (NDA)\nเรียน ${name}\nกรุณาเปิดลิงก์เพื่ออ่านและลงนาม:\n${link}`;

  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (!r.ok) return res.status(502).json({ ok: false, code: 'line_push_failed', message_th: 'ส่งลิงก์ผ่าน LINE ไม่สำเร็จ', detail: (await r.text().catch(() => '')).slice(0, 200) });
  await ndaAudit(row, 'notify_sent', req, { party, channel: 'line' });
  return res.status(200).json({ ok: true, sent: true, link });
}

// ════════════════════════════════════════════════════════════════
//  NDA — อ่านข้อมูลที่ anon อ่านไม่ได้แล้ว (หลังรัน nda_rls_fix.sql)
//  nda_rls_fix.sql ตัด SELECT ของ anon เหลือ 10 คอลัมน์ที่ไม่เป็นความลับ
//  (clauses_json / party_a / party_b / a_card / b_card / ลายเซ็น / audit_log
//   อ่านผ่าน service_role เท่านั้น) — 2 action ด้านล่างคือทางเข้าที่ถูกต้อง
//
//  ⚠️ ตั้งใจไม่ใส่ 2 action นี้ใน _needsHuman (Turnstile) เพราะไม่มีค่าใช้จ่าย
//     ไม่เรียก AI และ nda_row ถูกกั้นด้วย payment_completed อยู่แล้ว
// ════════════════════════════════════════════════════════════════

// ── POST { action:'nda_row', row_id, token? } ──────────────────────────────
//  คืน "แถวเต็ม" ผ่าน service_role — ใช้แทน sb.from('nda_contracts').select('*')
//  ที่ฝั่ง client ทำไม่ได้แล้ว (สร้าง Evidence PDF · กู้คืนสัญญาจากลิงก์ ?reload=)
//  🔒 กั้นด้วย payment_completed เหมือน action:'content' — ยังไม่จ่าย = ไม่มีเนื้อหาออกจาก server
async function handleNdaRow(req, res, body) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสสัญญา' });

  const row = await sbGet(rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });

  if (row.payment_completed !== true)
    return res.status(403).json({ ok: false, code: 'locked', message_th: 'ยังไม่ปลดล็อก (ต้องชำระเงินก่อน)' });

  // ส่ง token มาต้องเป็น token ที่ถูกต้อง (ผู้ลงนามทางไกล) — ไม่ส่งก็ได้ (ผู้ร่างที่ถือ row_id)
  const token = String(body.token || '').trim();
  if (token && token !== row.a_read_token && token !== row.b_read_token)
    return res.status(403).json({ ok: false, code: 'bad_token', message_th: 'ลิงก์ลงนามไม่ถูกต้อง' });

  return res.status(200).json({ ok: true, row });
}

// ── POST { action:'nda_verify_last4', row_id, party:'a'|'b', last4 } ───────
//  ตรวจเลขบัตร 4 ตัวท้ายฝั่ง server — เดิม client ดึง party_a/party_b (เลขบัตร 13 หลัก
//  + ที่อยู่เต็ม) มาเทียบเอง = เปิดข้อมูล PDPA ให้ใครก็ได้ที่มี row_id
//  คืนแค่ผลเทียบ ไม่คืนเลขบัตรกลับไปเลย
async function handleNdaVerifyLast4(req, res, body) {
  const rowId = body.row_id, party = body.party;
  if (!rowId || !['a', 'b'].includes(party))
    return res.status(400).json({ ok: false, code: 'bad_params', message_th: 'พารามิเตอร์ไม่ครบ' });

  const row = await sbGet(rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });

  const p     = (party === 'a') ? row.party_a : row.party_b;
  const id13  = String((p && p.id13) || '').replace(/\D/g, '');
  const last4 = String(body.last4 || '').replace(/\D/g, '');

  return res.status(200).json({
    ok: true,
    match: !!(id13.length === 13 && last4.length === 4 && id13.slice(-4) === last4),
    already_signed: !!(party === 'a' ? row.a_signed_at : row.b_signed_at),
  });
}

/* ══════════════════════════════════════════════════════════════
   NDA — ส่งสัญญาทาง LINE เมื่อลงนามครบ 2 ฝ่าย
   ไม่พึ่ง follow event อย่างเดียว เพราะคนที่เป็นเพื่อน OA อยู่แล้ว
   LINE จะไม่ยิง follow ให้ → จะไม่ได้รับสัญญาเลย
   ══════════════════════════════════════════════════════════════ */
const NDA_APP_URL  = process.env.NDA_APP_URL  || 'https://nda.signdee.com/';
const SALE_APP_URL = process.env.SALE_APP_URL || 'https://sale.signdee.com/';

/* ตั้งค่าต่อผลิตภัณฑ์ — ใช้โดย action:'signed_notify' */
const NOTIFY_CFG = {
  nda: {
    table: 'nda_contracts', appUrl: () => NDA_APP_URL,
    signedCols: ['a_signed_at', 'b_signed_at'],
    targets: [['a_line_user_id', 'ผู้ให้ข้อมูล'], ['b_line_user_id', 'ผู้รับข้อมูล'], ['creator_line_user_id', 'ผู้จัดทำสัญญา']],
    title: 'สัญญารักษาความลับ (NDA)',
    subject: (row) => row.contract_no || '—',
  },
  sale: {
    table: 'sale_contracts', appUrl: () => SALE_APP_URL,
    signedCols: ['s_signed_at', 'b_signed_at'],
    targets: [['s_line_user_id', 'ผู้จะขาย'], ['b_line_user_id', 'ผู้จะซื้อ'], ['creator_line_user_id', 'ผู้จัดทำสัญญา']],
    title: 'สัญญาจะซื้อจะขายอาคารชุด',
    subject: (row) => [row.condo_name || row.property_name || '', row.unit_no ? ('ห้อง ' + row.unit_no) : ''].filter(Boolean).join(' ') || '—',
  },
};

function ndaPdfFlex(row, label, cfg) {
  cfg = cfg || NOTIFY_CFG.nda;
  const url   = `${cfg.appUrl()}?reload=${encodeURIComponent(row.id)}&autodownload=1`;
  const dt    = row[cfg.signedCols[1]] || row[cfg.signedCols[0]];
  const dateTh = dt ? new Date(dt).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  const kv = (k, v, bold) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'xs',
    contents: [
      { type: 'text', text: k, size: 'xs', color: '#8E95A3', flex: 2 },
      { type: 'text', text: String(v || '—'), size: 'xs', color: '#14171F', flex: 5, wrap: true, weight: bold ? 'bold' : 'regular' },
    ],
  });
  return {
    type: 'flex',
    altText: '📄 ' + cfg.title + ' พร้อมดาวน์โหลดแล้ว',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0B1220', paddingAll: '16px',
        contents: [
          { type: 'text', text: '📄 ' + cfg.title, color: '#6EC3EA', size: 'md', weight: 'bold', wrap: true },
          { type: 'text', text: 'SignDee · ลงนามครบทุกฝ่ายแล้ว', color: '#B9D4E8', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          kv('รายละเอียด', cfg.subject(row)),
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

async function ndaPushFlex(uid, row, label, cfg) {
  if (!uid || !LINE_TOKEN) return false;
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: uid, messages: [ndaPdfFlex(row, label, cfg)] }),
  });
  if (!r.ok) console.error('[nda-signed-notify] push', r.status, (await r.text().catch(() => '')).slice(0, 200));
  return r.ok;
}

// action: 'signed_notify' — เรียกจากหน้าเว็บเมื่อพบว่าลงนามครบ (idempotent ด้วย line_notified_at)
async function handleNdaSignedNotify(req, res, body) {
  const cfg = NOTIFY_CFG[body.product === 'sale' ? 'sale' : 'nda'];
  const row = await sbGetT(cfg.table, body.row_id);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });
  if (!cfg.signedCols.every(c => row[c]))
    return res.status(200).json({ ok: true, sent: 0, reason: 'not_complete' });
  if (row.line_notified_at && !body.only_uid)
    return res.status(200).json({ ok: true, sent: 0, reason: 'already_sent' });

  // เก็บทุกปลายทาง แล้วตัดตัวซ้ำ (ผู้ร่างอาจเป็นคู่สัญญาฝ่ายใดฝ่ายหนึ่งด้วย)
  const seen = new Set();
  let targets = [];
  const add = (uid, label) => { if (uid && !seen.has(uid)) { seen.add(uid); targets.push({ uid, label }); } };
  cfg.targets.forEach(([col, label]) => add(row[col], label));

  // only_uid = ส่งเฉพาะคนนี้ (ใช้ตอนผู้ร่างเพิ่งผูก LINE ทีหลัง — ข้าม guard กันส่งซ้ำ)
  if (body.only_uid) targets = targets.filter(t => t.uid === body.only_uid);

  if (!targets.length)
    return res.status(200).json({ ok: true, sent: 0, reason: 'no_line_user' });

  let sent = 0;
  for (const t of targets) { if (await ndaPushFlex(t.uid, row, t.label, cfg)) sent++; }
  if (sent && !body.only_uid) {
    try { await sbPatchT(cfg.table, row.id, { line_notified_at: new Date().toISOString() }); } catch (_) {}
  }
  if (sent && cfg.table === 'nda_contracts') { try { await ndaAudit(row, 'pdf_sent_line', req, { count: sent }); } catch (_) {} }
  return res.status(200).json({ ok: true, sent, targets: targets.length });
}


// ════════════════════════════════════════════════════════════════
//  EMPLOYMENT — สัญญาจ้าง  (index-emp.html)
//    action:'emp_jd'       → AI ร่าง Job Description (ไม่ต้องมี row)
//    action:'emp_generate' → ประกอบสัญญา 18/19 ข้อ + hash → คืน preview ที่ blur
//    action:'emp_content'  → เนื้อจริง หลังเช็คจ่ายเงิน/token
//  เนื้อกฎหมายมาจาก _emp_templates.js ทั้งหมด — AI แตะเฉพาะ Job Description
// ════════════════════════════════════════════════════════════════

const EMP_BANNED = /(เพศ|ชาย|หญิง|อายุ\s*\d|โสด|สมรส|ศาสนา|เชื้อชาติ|สัญชาติ|หน้าตา|บุคลิกดี|รูปร่าง)/;

function empSeedFor(code, th) {
  const list = (EMP_SEED && EMP_SEED.positions) || [];
  const byCode = code && list.find(p => p.code === code);
  if (byCode) return byCode.jd;
  const q = String(th || '').trim();
  if (q) {
    const hit = list.find(p => p.th === q || p.en === q);
    if (hit) return hit.jd;
  }
  return { responsibilities: [], qualifications: [], kpis: [] };
}

function empCleanList(a, max) {
  return (Array.isArray(a) ? a : [])
    .map(x => String(x == null ? '' : x).replace(/^[\s\-•*\d.)]+/, '').trim())
    .filter(x => x.length >= 4 && x.length <= 90 && !EMP_BANNED.test(x))
    .slice(0, max);
}

function empSanitizeJD(j, seed) {
  const r = empCleanList(j && j.responsibilities, 8);
  const q = empCleanList(j && j.qualifications, 6);
  const k = empCleanList(j && j.kpis, 4);
  if (r.length < 3) return Object.assign({}, seed, { _source: 'seed' });
  return { responsibilities: r, qualifications: q, kpis: k, _source: 'ai' };
}

const EMP_JD_SYS = [
  'คุณคือ HR ที่เขียน Job Description ภาษาไทยสำหรับบริษัทไทย',
  'ตอบเป็น JSON เท่านั้น เริ่มด้วย { ทันที ปิดด้วย } ไม่มีข้อความอื่น ไม่มี markdown',
  '{ "responsibilities": ["..."], "qualifications": ["..."], "kpis": ["..."] }',
  'responsibilities 4-8 ข้อ · qualifications 3-6 ข้อ · kpis 2-4 ข้อ',
  'กฎ:',
  '- แต่ละข้อเป็นวลีสั้น ไม่เกิน 90 ตัวอักษร ไม่ใส่เลขข้อ ไม่ใส่เครื่องหมายนำหน้า',
  '- ใช้ภาษาไทยเป็นหลัก คำเทคนิคภาษาอังกฤษเก็บไว้ได้',
  '- ห้ามระบุ เพศ อายุ ศาสนา สถานภาพสมรส เชื้อชาติ หรือรูปร่างหน้าตา ในทุกข้อ',
  '- ห้ามระบุเงินเดือน สวัสดิการ วันลา เวลาทำงาน หรือเงื่อนไขทางกฎหมายใด ๆ',
  '- ห้ามแต่งข้อความที่เป็นข้อสัญญาหรือข้อผูกพันทางกฎหมาย',
].join('\n');

// ── POST { action:'emp_jd', position_th, position_en?, position_code?, employment_type? } ──
async function handleEmpJd(req, res, body) {
  const th = String(body.position_th || '').trim().slice(0, 80);
  if (th.length < 2)
    return res.status(400).json({ ok: false, code: 'missing_position', message_th: 'ยังไม่ได้ระบุตำแหน่งงาน' });

  const seed = empSeedFor(body.position_code, th);
  if (!ANTHROPIC_KEY)
    return res.status(200).json({ ok: true, jd: Object.assign({}, seed, { _source: 'seed' }), source: 'seed' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: EMP_JD_MODEL, max_tokens: 900, temperature: 0,
        system: EMP_JD_SYS,
        messages: [{ role: 'user', content:
          `ตำแหน่งงาน: ${th}` +
          (body.position_en ? `\nชื่อภาษาอังกฤษ: ${String(body.position_en).slice(0, 80)}` : '') +
          (body.employment_type ? `\nประเภทการจ้าง: ${EMPT.EMPLOYMENT_TYPE_TH[body.employment_type] || ''}` : '') }],
      }),
    });
    clearTimeout(timer);
    if (!r.ok) return res.status(200).json({ ok: true, jd: Object.assign({}, seed, { _source: 'seed' }), source: 'seed' });
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const jd = empSanitizeJD(extractJson(text), seed);
    return res.status(200).json({ ok: true, jd, source: jd._source });
  } catch (_) {
    clearTimeout(timer);
    return res.status(200).json({ ok: true, jd: Object.assign({}, seed, { _source: 'seed' }), source: 'seed' });
  }
}

// ── ประกอบ ctx จากแถว DB ──
function empCtxFrom(row) {
  const start = row.start_date ? new Date(row.start_date) : new Date();
  const wd = Array.isArray(row.work_days) ? row.work_days : [];
  const dobB = row.b_card && row.b_card.ocr_raw && row.b_card.ocr_raw.date_of_birth;
  const ageB = parseInt(ageFromDob(dobB), 10) || 0;
  return {
    position: row.position_th || '',
    employment_type: row.employment_type || 'full_time',
    start_th: EMPT.thDateFull(start),
    end_th: row.end_date ? EMPT.thDateFull(new Date(row.end_date)) : '',
    salary: row.salary, allowance: row.allowance, bonus: row.bonus_text,
    payday_text: row.payday_text || 'ภายในวันที่ 5 ของทุกเดือน',
    probation_days: row.probation_days,
    work_days: wd, work_start: row.work_start, work_end: row.work_end, work_hours: row.work_hours,
    location: row.work_location, client_site: row.client_site,
    restrict_level: row.restrict_level, restrict_months: row.restrict_months, restrict_area: row.restrict_area,
    is_minor: ageB > 0 && ageB < 18,
  };
}

/* ── SD-407 (จาก origin/main): วันที่เอกสารและอายุต้อง deterministic ──
   empDocumentDate ยึด created_at เป็น UTC · empAgeOnDate คำนวณอายุ ณ วันออกเอกสาร
   ทำให้ doc_hash เท่าเดิมทุกครั้งที่ render ซ้ำ */
function empDocumentDate(row) {
  const value = new Date(row.created_at);
  if (!Number.isFinite(value.getTime())) throw new Error('employment_document_date_invalid');
  return value.toISOString().slice(0, 10);
}

function empAgeOnDate(card, referenceDate) {
  const dob = card && card.ocr_raw && card.ocr_raw.date_of_birth;
  if (!dob) return '';
  const birth = new Date(dob), reference = new Date(referenceDate + 'T00:00:00.000Z');
  if (!Number.isFinite(birth.getTime()) || !Number.isFinite(reference.getTime())) return '';
  let age = reference.getUTCFullYear() - birth.getUTCFullYear();
  const month = reference.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && reference.getUTCDate() < birth.getUTCDate())) age--;
  return age >= 0 && age < 130 ? String(age) : '';
}

function empThaiDocumentDate(referenceDate) {
  const [year, month, day] = referenceDate.split('-').map(Number);
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return `${day} ${months[month - 1]} พ.ศ. ${year + 543}`;
}

function empMeta(row, ctx, clauses) {
  const referenceDate = empDocumentDate(row);
  const employer = Object.assign({}, partyDetailLine(row.party_a, row.a_card),
    { jur: (row.party_a && row.party_a.jur) || null });
  const employee = partyDetailLine(row.party_b, row.b_card);
  employer.age = empAgeOnDate(row.a_card, referenceDate);
  employee.age = empAgeOnDate(row.b_card, referenceDate);
  return {
    contract_no: row.contract_no || '',
    document_date: referenceDate,
    date_th: empThaiDocumentDate(referenceDate),
    a: employer,
    b: employee,
    position: ctx.position,
    start_th: ctx.start_th, end_th: ctx.end_th,
    clause_count: EMPT.empClauseCount(clauses),
    intro: EMPT.EMP_INTRO, closing: EMPT.EMP_CLOSING,
    rates: EMPT.wageRates(row.salary, (Array.isArray(row.work_days) ? row.work_days.length : 5), row.work_hours),
  };
}

function empAppendix(row) {
  const jd = row.jd || {};
  return {
    title: 'เอกสารแนบท้าย ก. — รายละเอียดตำแหน่งงาน',
    position: row.position_th || '',
    responsibilities: Array.isArray(jd.responsibilities) ? jd.responsibilities : [],
    qualifications: Array.isArray(jd.qualifications) ? jd.qualifications : [],
    kpis: Array.isArray(jd.kpis) ? jd.kpis : [],
  };
}

// คอลัมน์ที่ client ส่งมาเขียนได้ — นอกเหนือจากนี้ทิ้งทั้งหมด
// (service_role bypass RLS/trigger จึงต้อง whitelist เองที่นี่ ห้ามพลาด)
const EMP_WRITABLE = [
  'position_th', 'position_en', 'position_code', 'jd', 'jd_edited',
  'employment_type', 'salary', 'allowance', 'bonus_text', 'payday_text',
  'probation_days', 'work_days', 'work_start', 'work_end', 'work_hours',
  'work_location', 'client_site', 'start_date', 'end_date',
  'restrict_level', 'restrict_months', 'restrict_area',
  'party_a', 'party_b', 'a_card', 'b_card', 'creator_party',
];

function empPickWritable(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const k of EMP_WRITABLE) if (payload[k] !== undefined) out[k] = payload[k];
  return out;
}

function empPartyName(p) {
  if (!p || typeof p !== 'object') return '';
  return String(p.name == null ? '' : p.name).trim();
}

// ── POST { action:'emp_generate', row_id, payload? } ──
async function handleEmpGenerate(req, res, body) {
  let _stage = 'start';
  try {
    return await _empGenerate(req, res, body, (x) => { _stage = x; });
  } catch (e) {
    console.error('[EMP] generate failed at stage:', _stage, e);
    return res.status(500).json({ ok: false, code: 'emp_generate_error', stage: _stage,
      message_th: 'สร้างสัญญาไม่สำเร็จ (' + _stage + ')',
      detail: String((e && e.message) || e).slice(0, 300) });
  }
}

async function _empGenerate(req, res, body, st) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสสัญญา' });
  // client ส่งข้อมูลทั้งหมดมาให้ backend เขียนด้วย service_role
  // (เดิมให้ client เขียนเองด้วย anon แล้วบางครั้งไม่ลง → party_a เป็น null)
  st('save_row');
  const _incoming = empPickWritable(body.payload);
  if (Object.keys(_incoming).length) {
    _incoming.status = 'ocr_done';
    const okSave = await sbPatchT(EMP_TABLE, rowId, _incoming);
    if (!okSave) throw new Error('บันทึกข้อมูลสัญญาไม่สำเร็จ (sb_patch)');
  }

  st('get_row');
  const row = await sbGetT(EMP_TABLE, rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });

  if (row.a_signed_at || row.b_signed_at)
    return res.status(409).json({ ok: false, code: 'locked', message_th: 'สัญญาเริ่มลงนามแล้ว แก้ไขไม่ได้' });

  st('check_parties');
  const aName = empPartyName(row.party_a), bName = empPartyName(row.party_b);
  if (!aName || !bName) {
    const missing = [!aName ? 'นายจ้าง' : null, !bName ? 'ลูกจ้าง' : null].filter(Boolean).join(' และ ');
    return res.status(400).json({ ok: false, code: 'incomplete',
      message_th: 'ข้อมูล' + missing + 'ยังไม่ถูกบันทึก กรุณาอัปโหลดบัตรประชาชนใหม่',
      debug: { has_party_a: !!row.party_a, has_party_b: !!row.party_b, status: row.status } });
  }
  if (!String(row.position_th || '').trim())
    return res.status(400).json({ ok: false, code: 'no_position', message_th: 'ยังไม่ได้ระบุตำแหน่งงาน' });
  if (!(Number(row.salary) > 0))
    return res.status(400).json({ ok: false, code: 'no_salary', message_th: 'ยังไม่ได้ระบุค่าจ้าง' });

  const idA = String((row.party_a && row.party_a.id13) || '').replace(/\D/g, '');
  const idB = String((row.party_b && row.party_b.id13) || '').replace(/\D/g, '');
  if (idA && idB && idA === idB)
    return res.status(400).json({ ok: false, code: 'same_person', message_th: 'นายจ้างและลูกจ้างต้องเป็นคนละบุคคล' });

  st('build_ctx');
  const ctx = empCtxFrom(row);

  // ห้ามจ้างเด็กอายุต่ำกว่า 15 ปี
  const dobB = row.b_card && row.b_card.ocr_raw && row.b_card.ocr_raw.date_of_birth;
  const ageB = parseInt(ageFromDob(dobB), 10) || 0;
  if (ageB > 0 && ageB < 15)
    return res.status(400).json({ ok: false, code: 'underage', message_th: 'กฎหมายห้ามจ้างเด็กอายุต่ำกว่า 15 ปี' });

  st('build_clauses');
  const clauses = EMPT.buildEmpClauses(ctx);
  const n = EMPT.empClauseCount(clauses);
  st('build_meta');
  const meta = empMeta(row, ctx, clauses);
  const appendix = empAppendix(row);

  const fullText = Array.from({ length: n }, (_, i) => clauses['c' + (i + 1)] || '').join('\n\n')
    + '\n\n' + JSON.stringify(appendix);
  st('hash');
  const hash = sha256(fullText);

  st('save');
  const _saved = await sbPatchT(EMP_TABLE, rowId, {
    clauses: clauses, meta: meta, doc_hash: hash, status: 'generated',
  });
  if (!_saved) throw new Error('sb_patch_failed — เขียน clauses/meta ลง emp_contracts ไม่สำเร็จ');
  st('respond');

  // preview: เห็นเฉพาะข้อ 1-2 · ที่เหลือ blur ที่เซิร์ฟเวอร์ (ห้ามส่งของจริงมา client ก่อนจ่าย)
  const BLUR_E = 'ปลดล็อกสัญญาฉบับเต็มเพื่ออ่านข้อนี้ — เนื้อหาถูกป้องกันไว้ที่เซิร์ฟเวอร์จนกว่าจะชำระเงิน';
  const preview = {};
  for (let i = 1; i <= n; i++) {
    preview['c' + i] = (i <= 2) ? clauses['c' + i] : `${i}. 🔒 ${BLUR_E}`;
  }
  const apPrev = {
    title: appendix.title, position: appendix.position, locked: true,
    responsibilities: appendix.responsibilities.slice(0, 2),
    qualifications: [], kpis: [],
  };

  return res.status(200).json({
    ok: true, status: 'generated', clause_count: n,
    doc_hash: hash, parties: { a: aName, b: bName }, meta,
    clauses_preview: preview, appendix_preview: apPrev,
  });
}

// ── POST { action:'emp_content', row_id, token? } ──
async function handleEmpContent(req, res, body) {
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id', message_th: 'ไม่พบรหัสสัญญา' });
  const row = await sbGetT(EMP_TABLE, rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'ไม่พบสัญญา' });

  const token = String(body.token || '').trim();
  const tokenOk = !!token && (token === row.a_read_token || token === row.b_read_token);
  let paid = row.payment_completed === true;

  const _devSecrets = [process.env.EMP_DEV_KEY, process.env.NDA_DEV_KEY, process.env.ADMIN_PASSWORD].filter(Boolean);
  const devKeyOk = !!body.dev_key && _devSecrets.includes(body.dev_key);
  const _envSkip  = (process.env.EMP_ALLOW_SKIP === '1' || process.env.NDA_ALLOW_SKIP === '1');
  // บั๊กลำดับเดียวกับ NDA — dev_key ค้างเก่าใน localStorage เคยบล็อกการข้ามบน staging
  // ทั้งที่ EMP_ALLOW_SKIP=1 อนุญาตอยู่แล้ว · production ไม่ตั้ง env นี้ พฤติกรรมเดิมไม่เปลี่ยน
  if (body.skip === true && body.dev_key && !devKeyOk && !_envSkip)
    return res.status(401).json({ ok: false, code: 'bad_dev_key', message_th: 'รหัสผ่าน dev ไม่ถูกต้อง' });

  if (!paid && body.skip === true && (_envSkip || devKeyOk)) {
    await sbPatchT(EMP_TABLE, rowId, { payment_completed: true, payment_ref: 'SKIP-TEST', status: 'paid', paid_at: new Date().toISOString() });
    paid = true;
  }

  // read token ปลดล็อกได้เฉพาะสัญญาที่ชำระเงินแล้ว (ช่องโหว่เดียวกับที่ NDA เคยมี)
  if (!paid)
    return res.status(403).json({ ok: false, code: 'locked', message_th: 'ยังไม่ปลดล็อก (ต้องชำระเงินก่อน)' });
  if (body.token && !tokenOk)
    return res.status(403).json({ ok: false, code: 'bad_token', message_th: 'ลิงก์ลงนามไม่ถูกต้อง' });

  // ผู้ร่างเลือกว่าตนเป็นคู่สัญญาฝ่ายไหน — เขียนด้วย service_role (anon เขียนอาจไม่ผ่าน)
  if (!body.token && ['a', 'b', 'third'].includes(body.creator_party) && row.creator_party !== body.creator_party) {
    await sbPatchT(EMP_TABLE, rowId, { creator_party: body.creator_party, status: 'reviewed' });
    row.creator_party = body.creator_party;
  }

  let clauses = row.clauses;
  const ctx = empCtxFrom(row);
  if (!clauses) clauses = EMPT.buildEmpClauses(ctx); // เผื่อ generate ไม่สำเร็จ — ประกอบใหม่
  const meta = empMeta(row, ctx, clauses); // SD-407: วันที่/อายุใช้ authority semantic เดียวกันเสมอ
  return res.status(200).json({
    ok: true, doc_hash: row.doc_hash, clauses, meta,
    appendix: empAppendix(row),
    clause_count: EMPT.empClauseCount(clauses),
    parties: { a: partyName(row.party_a), b: partyName(row.party_b) },
    status: row.status, cert_no: row.cert_no,
    a_signature: row.a_signature, b_signature: row.b_signature,
    a_signed_at: row.a_signed_at, b_signed_at: row.b_signed_at,
  });
}


// ════════════════════════════════════════════════════════════════
//  ผูกบัญชีนายจ้างกับ LINE — แทน magic link ทางอีเมล
//    emp_link_start    → คืนรหัส 6 ตัว ให้ผู้ใช้ส่งในแชต OA
//    emp_link_poll     → เมื่อ webhook จับคู่แล้ว คืน session
//    emp_claim         → ผูกสัญญาเข้ากับเจ้าของ
//    emp_my_contracts  → รายการสัญญาของเจ้าของคนนั้น
//  session = HMAC-SHA256 ไม่เก็บใน DB · line_user_id เพียงอย่างเดียวใช้ไม่ได้
// ════════════════════════════════════════════════════════════════
const EMP_SESSION_SECRET = process.env.EMP_SESSION_SECRET || SERVICE_KEY || 'signdee-dev-secret';
const EMP_SESSION_DAYS   = 90;
const EMP_LINK_TABLE     = 'emp_line_link';

function _b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function _b64uDec(str){ return Buffer.from(String(str).replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); }
function _hmac(str){ return crypto.createHmac('sha256', EMP_SESSION_SECRET).update(str).digest(); }

function empMakeSession(lineUserId, name) {
  const payload = JSON.stringify({ u: lineUserId, n: (name||'').slice(0,60), e: Date.now() + EMP_SESSION_DAYS*864e5 });
  const p = _b64u(payload);
  return p + '.' + _b64u(_hmac(p));
}
function empReadSession(session) {
  try {
    const [p, sig] = String(session||'').split('.');
    if (!p || !sig) return null;
    const expect = _b64u(_hmac(p));
    // เทียบแบบ constant-time
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const o = JSON.parse(_b64uDec(p));
    if (!o.u || !o.e || Date.now() > o.e) return null;
    return o;
  } catch (_) { return null; }
}

function empNewCode() {
  const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // ตัด I O 0 1 ที่อ่านสับสน
  let out = '';
  const b = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += AL[b[i] % AL.length];
  return out;
}

async function sbInsertT(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  return r.ok;
}
async function sbQuery(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sbPatchQ(table, qs, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  return r.ok;
}

// ── POST { action:'emp_link_start' } ──
async function handleEmpLinkStart(req, res) {
  for (let i = 0; i < 5; i++) {
    const code = empNewCode();
    if (await sbInsertT(EMP_LINK_TABLE, { code })) {
      return res.status(200).json({
        ok: true, code,
        oa_url: (process.env.LINE_OA_URL || 'https://line.me/R/ti/p/@signdee'),
        msg_url: 'https://line.me/R/oaMessage/' + encodeURIComponent(process.env.LINE_OA_ID || '@signdee') + '/?' + encodeURIComponent('ผูกบัญชี ' + code),
      });
    }
  }
  return res.status(500).json({ ok: false, code: 'code_gen_failed', message_th: 'สร้างรหัสไม่สำเร็จ' });
}

// ── POST { action:'emp_link_poll', code } ──
async function handleEmpLinkPoll(req, res, body) {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (code.length !== 6) return res.status(400).json({ ok: false, code: 'bad_code' });
  const rows = await sbQuery(`${EMP_LINK_TABLE}?code=eq.${code}&select=*&limit=1`);
  const row = rows && rows[0];
  if (!row) return res.status(404).json({ ok: false, code: 'not_found', message_th: 'รหัสหมดอายุแล้ว กรุณาขอรหัสใหม่' });
  if (!row.line_user_id) return res.status(200).json({ ok: true, linked: false });
  await sbPatchQ(EMP_LINK_TABLE, `code=eq.${code}`, { consumed_at: new Date().toISOString() });
  return res.status(200).json({
    ok: true, linked: true,
    name: row.line_name || '',
    session: empMakeSession(row.line_user_id, row.line_name),
  });
}

// ── POST { action:'emp_claim', session, row_id } ──
async function handleEmpClaim(req, res, body) {
  const ses = empReadSession(body.session);
  if (!ses) return res.status(401).json({ ok: false, code: 'bad_session', message_th: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  const rowId = body.row_id;
  if (!rowId) return res.status(400).json({ ok: false, code: 'missing_row_id' });
  const row = await sbGetT(EMP_TABLE, rowId);
  if (!row) return res.status(404).json({ ok: false, code: 'not_found' });
  if (row.owner_line_id && row.owner_line_id !== ses.u)
    return res.status(409).json({ ok: false, code: 'already_owned', message_th: 'สัญญานี้ผูกกับบัญชีอื่นแล้ว' });
  await sbPatchT(EMP_TABLE, rowId, {
    owner_line_id: ses.u, owner_line_name: ses.n || null, owner_linked_at: new Date().toISOString(),
  });
  return res.status(200).json({ ok: true });
}

// ── POST { action:'emp_my_contracts', session } ──
async function handleEmpMyContracts(req, res, body) {
  const ses = empReadSession(body.session);
  if (!ses) return res.status(401).json({ ok: false, code: 'bad_session', message_th: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  const cols = ['id','contract_no','status','position_th','salary','allowance','probation_days','start_date',
    'party_a','party_b','payment_completed','creator_token','a_read_token','b_read_token',
    'a_signed_at','b_signed_at','cert_no','doc_hash','created_at'].join(',');
  const rows = await sbQuery(
    `${EMP_TABLE}?owner_line_id=eq.${encodeURIComponent(ses.u)}&select=${cols}&order=created_at.desc&limit=200`);
  return res.status(200).json({ ok: true, name: ses.n || '', contracts: Array.isArray(rows) ? rows : [] });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST: NDA action → OCR → (ตกไป ip) ──
  if (req.method === 'POST') {
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
    catch (_) { body = {}; }

    // ── กันบอท: endpoint ที่มีค่าใช้จ่าย (OCR + NDA generate/content) ต้องผ่าน Turnstile ──
    const _clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const _needsHuman = (body && body.image) || (body && ['generate','content','emp_jd','emp_generate','emp_content'].includes(body.action));
    if (_needsHuman) {
      const _v = await verifyTurnstile(body.turnstile_token, _clientIp);
      if (!_v.ok) return res.status(403).json({ ok: false, code: 'turnstile_failed', message_th: 'ยืนยันว่าไม่ใช่บอทไม่สำเร็จ กรุณาลองใหม่' });
    }

    // NDA generate / content / notify
    if (body && body.action) {
      try {
        if (body.action === 'notice_doc') return await handleNoticeDoc(req, res, body);
        if (body.action === 'notice_conversion')  return await handleNoticeConversion(req, res, body);
        if (body.action === 'notice_conv_status') return await handleNoticeConvStatus(req, res, body);
        if (body.action === 'generate') return await handleNdaGenerate(req, res, body);
        if (body.action === 'content')  return await handleNdaContent(req, res, body);
        if (body.action === 'nda_row')          return await handleNdaRow(req, res, body);
        if (body.action === 'nda_verify_last4') return await handleNdaVerifyLast4(req, res, body);
        if (body.action === 'notify')   return await handleNdaNotify(req, res, body);
        if (body.action === 'signed_notify') return await handleNdaSignedNotify(req, res, body);
        if (body.action === 'emp_jd')       return await handleEmpJd(req, res, body);
        if (body.action === 'emp_generate') return await handleEmpGenerate(req, res, body);
        if (body.action === 'emp_content')  return await handleEmpContent(req, res, body);
        if (body.action === 'emp_link_start')   return await handleEmpLinkStart(req, res);
        if (body.action === 'emp_link_poll')    return await handleEmpLinkPoll(req, res, body);
        if (body.action === 'emp_claim')        return await handleEmpClaim(req, res, body);
        if (body.action === 'emp_my_contracts') return await handleEmpMyContracts(req, res, body);
        return res.status(400).json({ ok: false, code: 'unknown_action', message_th: 'ไม่รู้จักคำสั่ง' });
      } catch (e) {
        return res.status(500).json({ ok: false, code: 'nda_error', message_th: 'ระบบขัดข้อง กรุณาลองใหม่', detail: String(e.message || e).slice(0, 200) });
      }
    }

    // OCR: POST พร้อมรูป
    try {
      if (body && body.image) return await handleOcr(req, res, body.image);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'ocr_failed', detail: String(e.message || e).slice(0, 200) });
    }
    // POST ไม่มี action/รูป → ตกไปโหมด ip ด้านล่าง
  }

  // ── โหมด IP (เดิม): GET หรือ POST ที่ไม่มีรูป ──
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd
    || req.headers['x-real-ip']
    || (req.socket && req.socket.remoteAddress)
    || '';
  return res.status(200).json({ ip });
};
