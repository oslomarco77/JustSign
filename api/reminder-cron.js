// ============================================================
//  SignDee — reminder-cron.js (standalone — no external lib)
//  วางที่  D:\justsign-api\api\reminder-cron.js  (แทนของเดิม)
// ============================================================

// ── ENV ──
const SB         = process.env.SUPABASE_URL || process.env.SB_URL;
const SR         = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;
const sbH = { apikey: SR, Authorization: 'Bearer ' + SR, 'Content-Type': 'application/json' };

// ── Supabase helpers ──
async function sbGet(path) {
  const r = await fetch(SB.replace(/\/$/, '') + '/rest/v1/' + path, { headers: sbH });
  if (!r.ok) throw new Error('sbGet ' + r.status + ' ' + path);
  return r.json();
}
async function sbInsert(table, row) {
  const r = await fetch(SB.replace(/\/$/, '') + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...sbH, Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (r.status === 409) return { duplicate: true };
  if (!r.ok) throw new Error('sbInsert ' + r.status + ' ' + table);
  return r.json();
}
async function sbPatch(table, match, patch) {
  const qs = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await fetch(SB.replace(/\/$/, '') + '/rest/v1/' + table + '?' + qs, {
    method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error('sbPatch ' + r.status + ' ' + table);
}

// ── LINE push ──
async function linePush(to, messages) {
  if (!to || !LINE_TOKEN) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ to, messages: Array.isArray(messages) ? messages : [messages] }),
  });
}

// ── Date helpers (ICT = UTC+7) ──
function todayICT() {
  const n = new Date(Date.now() + 7*3600000);
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function ymd(d) { return d.toISOString().slice(0,10); }
function ymStr(d) { return d.toISOString().slice(0,7); }
function daysBetween(a,b) { return Math.round((b-a)/86400000); }
function dueDateFor(d, payDay) {
  const y=d.getUTCFullYear(), m=d.getUTCMonth();
  const last = new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(parseInt(payDay)||1, last)));
}
function contractEnd(startISO, term) {
  if (!startISO) return null;
  const months = parseInt(String(term||'').replace(/[^0-9]/g,'')) || 12;
  const s = new Date(startISO+'T00:00:00Z');
  const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth()+months, s.getUTCDate()));
  e.setUTCDate(e.getUTCDate()-1); return e;
}
function baht(n) { return '฿'+(Number(n)||0).toLocaleString('th-TH'); }
function thDate(d) {
  if (!d) return '—';
  return d.toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
}

// ── Idempotency: claim slot ──
async function claim(cid, kind, refDate, meta) {
  const r = await sbInsert('reminder_log', { contract_id:cid, kind, ref_date:ymd(refDate), meta:meta||null });
  return !(r && r.duplicate);
}

// ── LINE Flex builders ──
function flexBubble(color, header, rows, buttons, note) {
  const body = { type:'box', layout:'vertical', spacing:'sm', contents: rows.map(([l,v,s])=>({
    type:'box', layout:'baseline', spacing:'sm', contents:[
      {type:'text', text:l, color:'#999', size:'sm', flex:4},
      {type:'text', text:String(v), wrap:true, color: s?color:'#333', weight:s?'bold':'regular', size:'sm', flex:6}
    ]
  }))};
  const bubble = {
    type:'bubble',
    header:{ type:'box', layout:'vertical', backgroundColor:color, paddingAll:'14px',
      contents:[{type:'text', text:header, color:'#FFF', weight:'bold', size:'md', wrap:true}]},
    body:{ type:'box', layout:'vertical', spacing:'md', contents:[body] }
  };
  if (note) bubble.body.contents.push(
    {type:'separator', margin:'md'},
    {type:'text', text:note, wrap:true, size:'xs', color:'#999', margin:'md'}
  );
  if (buttons&&buttons.length) bubble.footer = { type:'box', layout:'vertical', spacing:'sm',
    contents: buttons.map(b=>({ type:'button', style:b.style||'primary', height:'sm', color:b.color||color,
      action:{type:'postback', label:b.label, data:b.data} }))};
  return { type:'flex', altText:header, contents:bubble };
}

function msgRentDue(c, due, daysToDue, cycId, forTenant) {
  const when = daysToDue>0?`อีก ${daysToDue} วัน`:'วันนี้';
  const hdr = daysToDue>0?`🔔 ใกล้ครบกำหนดชำระค่าเช่า (${when})`:'🔔 ครบกำหนดชำระค่าเช่าวันนี้';
  const btns = forTenant ? [
    {label:'✅ ชำระเงินเรียบร้อยแล้ว', data:`action=paid&cid=${c.id}&cyc=${cycId}`, color:'#1A7F5A'},
    {label:'👍 รับทราบ', style:'secondary', data:`action=ack&cid=${c.id}&cyc=${cycId}`}
  ] : null;
  return flexBubble('#1A7F5A', hdr,
    [['ทรัพย์สิน',c.prop_name||'—'],['ห้อง',c.room_no||'—'],[`ค่าเช่า`,baht(c.rent),true],['กำหนดชำระ',thDate(due),true]],
    btns, forTenant?'กดปุ่ม "ชำระเงินเรียบร้อยแล้ว" แล้วส่งรูปสลิปในแชทนี้':null);
}
function msgOverdue(c, due, daysOv, penalty, cycId, forTenant, showTerm) {
  const hdr = `⚠️ ค้างชำระค่าเช่า ${daysOv} วัน`;
  const lt = parseInt(c.late_terminate_days)||10;
  const note = showTerm
    ? `⛔ ค้างชำระเกิน 5 วันแล้ว — หากค้างเกิน ${lt} วันตามสัญญา ผู้ให้เช่ามีสิทธิ์บอกเลิกสัญญา`
    : forTenant ? 'กรุณาชำระโดยเร็ว ค่าปรับเพิ่มทุกวัน' : 'ผู้เช่าได้รับการแจ้งเตือนค้างชำระแล้ว';
  const btns = forTenant ? [
    {label:'✅ ชำระเงินเรียบร้อยแล้ว', data:`action=paid&cid=${c.id}&cyc=${cycId}`, color:'#D64545'},
    {label:'👍 รับทราบ', style:'secondary', data:`action=ack&cid=${c.id}&cyc=${cycId}`}
  ] : null;
  return flexBubble('#D64545', hdr, [
    ['ทรัพย์สิน',c.prop_name||'—'],['ห้อง',c.room_no||'—'],['ค่าเช่า',baht(c.rent)],
    ['ครบกำหนดเมื่อ',thDate(due)],[`ค่าปรับสะสม`,baht(penalty)+` (${baht(c.late_penalty)}/วัน × ${daysOv})`,true],
    ['ยอดค้างรวม',baht((Number(c.rent)||0)+penalty),true]
  ], btns, note);
}
// ครบเกณฑ์ที่ผู้ให้เช่ามีสิทธิ์บอกเลิกสัญญา (ค้างชำระถึง late_terminate_days)
function msgTerminate(c, daysOv, lt, penalty, cycId, forTenant) {
  const hdr = `⛔ ค้างชำระครบ ${daysOv} วัน`;
  const note = forTenant
    ? `ค้างชำระครบ ${lt} วันตามที่ระบุในสัญญาแล้ว — ผู้ให้เช่ามีสิทธิ์บอกเลิกสัญญาตามข้อสัญญา กรุณาติดต่อผู้ให้เช่าและชำระโดยด่วน`
    : `ผู้เช่าค้างชำระครบ ${lt} วันตามข้อสัญญาแล้ว — ท่านมีสิทธิ์บอกเลิกสัญญาได้ตามเงื่อนไข (ระบบหยุดแจ้งเตือนค่าเช่ารอบนี้แล้ว)`;
  const btns = forTenant ? [
    {label:'✅ ชำระเงินเรียบร้อยแล้ว', data:`action=paid&cid=${c.id}&cyc=${cycId}`, color:'#7A1C1C'}
  ] : null;
  return flexBubble('#7A1C1C', hdr, [
    ['ทรัพย์สิน',c.prop_name||'—'],['ห้อง',c.room_no||'—'],
    ['ค้างชำระ',`${daysOv} วัน`,true],['ค่าปรับสะสม',baht(penalty),true],
    ['ยอดค้างรวม',baht((Number(c.rent)||0)+penalty),true]
  ], btns, note);
}
function msgExpiry(c, end, daysToEnd) {
  const hdr = `📅 สัญญาเช่าใกล้ครบกำหนด (อีก ${daysToEnd} วัน)`;
  return flexBubble('#C98A1B', hdr,
    [['ทรัพย์สิน',c.prop_name||'—'],['ห้อง',c.room_no||'—'],['วันสิ้นสุดสัญญา',thDate(end),true]],
    null, 'หากประสงค์ต่อสัญญา กรุณาแจ้งผู้ให้เช่าล่วงหน้า');
}
function msgRenewal(c, end, daysToEnd) {
  const hdr = '🔄 ต้องการต่อสัญญาเช่าหรือไม่?';
  return flexBubble('#1A7F5A', hdr,
    [['ทรัพย์สิน',c.prop_name||'—'],['ห้อง',c.room_no||'—'],['สิ้นสุดสัญญา',thDate(end),true],['เหลือ',`${daysToEnd} วัน`]],
    [{label:'🔄 ต้องการต่อสัญญา', data:`action=renew&cid=${c.id}`, color:'#1A7F5A'},
     {label:'🚪 ไม่ต่อสัญญา', style:'secondary', data:`action=norenew&cid=${c.id}`}],
    'กรุณาแจ้งภายในช่วง 40–30 วันก่อนครบกำหนด');
}
function msgDeposit(c, end, daysToEnd) {
  const hdr = `💰 เตรียมคืนเงินประกัน (สิ้นสุดสัญญาอีก ${daysToEnd} วัน)`;
  return flexBubble('#1A7F5A', hdr,
    [['ทรัพย์สิน',c.prop_name||'—'],['ห้อง',c.room_no||'—'],['ผู้เช่า',c.tn_name||'—'],
     ['เงินประกัน',baht(c.deposit),true],['วันสิ้นสุด',thDate(end),true]],
    null, 'โปรดเตรียมคืนเงินประกันภายใน 30 วันหลังผู้เช่าย้ายออก');
}

// ── รวมแจ้งเตือนผู้ให้เช่าหลายห้องเป็นข้อความเดียว ──
function addLL(LL, llId, compact, full) {
  if (!llId) return;
  (LL[llId] = LL[llId] || []).push({ compact, full });
}
function digestRow(it) {
  return { type:'box', layout:'baseline', spacing:'sm', contents:[
    { type:'text', text: it.icon, flex:0, size:'sm' },
    { type:'text', text: `${it.prop||'—'}${it.room?' ห้อง '+it.room:''}`, size:'sm', color:'#333', flex:5, wrap:true },
    { type:'text', text: it.label, size:'xs', color: it.urgent?'#D64545':'#1A7F5A', flex:6, wrap:true, align:'end' },
  ]};
}
function buildDigestFlex(items) {
  const sorted = items.slice().sort((a,b)=> (b.urgent?1:0)-(a.urgent?1:0));
  const shown = sorted.slice(0, 20);
  const rows = shown.map(digestRow);
  const overflow = sorted.length - shown.length;
  if (overflow > 0) rows.push({ type:'text', text:`…และอีก ${overflow} รายการ`, size:'xs', color:'#999', margin:'md', align:'center' });
  const nUrgent = items.filter(i=>i.urgent).length;
  return {
    type:'flex',
    altText:`🔔 สรุปแจ้งเตือน ${items.length} รายการ`,
    contents:{ type:'bubble',
      header:{ type:'box', layout:'vertical', backgroundColor: nUrgent?'#D64545':'#1A7F5A', paddingAll:'14px',
        contents:[
          { type:'text', text:'🔔 สรุปแจ้งเตือนวันนี้', color:'#FFF', weight:'bold', size:'md' },
          { type:'text', text:`${items.length} รายการ${nUrgent?` · เร่งด่วน ${nUrgent}`:''}`, color:'rgba(255,255,255,.85)', size:'xs', margin:'xs' },
        ]},
      body:{ type:'box', layout:'vertical', spacing:'sm', paddingAll:'16px', contents: rows },
      footer:{ type:'box', layout:'vertical', paddingAll:'12px',
        contents:[{ type:'text', text:'ดูรายละเอียดแต่ละห้องได้ในระบบ SignDee', size:'xs', color:'#999', align:'center', wrap:true }]},
    }
  };
}

// ── Case 1: ค่าเช่า ──
async function processRent(c, today, log, LL) {
  if (!c.rent || !c.pay_day) return;
  const due = dueDateFor(today, c.pay_day);
  const dtd = daysBetween(today, due);
  const ym  = ymStr(today);
  const tnIds = [c.tn_line_user_id, c.tn2_line_user_id].filter(Boolean);
  const llId  = c.ll_line_user_id;

  // หา/สร้าง rent_cycle
  let cyc = (await sbGet(`rent_cycles?select=*&contract_id=eq.${c.id}&cycle_ym=eq.${ym}&limit=1`))[0];
  if (!cyc) {
    const ins = await sbInsert('rent_cycles', { contract_id:c.id, cycle_ym:ym, due_date:ymd(due), status:'pending' });
    cyc = Array.isArray(ins) ? ins[0] : null;
    if (!cyc) cyc = (await sbGet(`rent_cycles?select=*&contract_id=eq.${c.id}&cycle_ym=eq.${ym}&limit=1`))[0];
  }
  if (!cyc || cyc.status === 'paid') return;

  if (dtd >= 0 && dtd <= 3) {
    if (await claim(c.id, 'rent', today, { phase:'due', dtd })) {
      for (const t of tnIds) await linePush(t, msgRentDue(c, due, dtd, cyc.id, true));
      if (llId) addLL(LL, llId, { icon:'🔔', prop:c.prop_name, room:c.room_no, label: dtd>0?`อีก ${dtd} วันครบกำหนดชำระ`:'ครบกำหนดชำระวันนี้', urgent:false }, msgRentDue(c, due, dtd, cyc.id, false));
      log.rent++;
    }
  } else if (dtd < 0) {
    const daysOv = -dtd;
    const lt = parseInt(c.late_terminate_days) || 10;
    const perDay = Number(c.late_penalty) || Math.round((Number(c.rent)||0)/30) || 0;
    const penalty = perDay * daysOv;

    if (daysOv < lt) {
      // ค้างชำระ: เตือนทุกวัน จนถึงก่อนวันครบเกณฑ์บอกเลิกสัญญา
      if (await claim(c.id, 'rent', today, { phase:'overdue', daysOv, penalty })) {
        for (const t of tnIds) await linePush(t, msgOverdue(c, due, daysOv, penalty, cyc.id, true, daysOv>=5));
        if (llId) addLL(LL, llId, { icon:'⚠️', prop:c.prop_name, room:c.room_no, label:`ค้างชำระ ${daysOv} วัน (${baht(penalty)})`, urgent:true }, msgOverdue(c, due, daysOv, penalty, cyc.id, false, daysOv>=5));
        await sbPatch('rent_cycles', { id:cyc.id }, { penalty_snapshot:penalty });
        log.rent++;
      }
    } else {
      // ครบ/เกินเกณฑ์ late_terminate_days → แจ้ง "มีสิทธิ์บอกเลิกสัญญา" ครั้งเดียวต่อรอบ แล้วหยุดเตือน
      // (claim ผูกกับ due date → ยิงครั้งเดียวแม้ cron ข้ามวันที่ครบเกณฑ์พอดี)
      if (await claim(c.id, 'rent_terminate', due, { daysOv, lt, penalty })) {
        for (const t of tnIds) await linePush(t, msgTerminate(c, daysOv, lt, penalty, cyc.id, true));
        if (llId) addLL(LL, llId, { icon:'⛔', prop:c.prop_name, room:c.room_no, label:`ค้างครบ ${daysOv} วัน — มีสิทธิ์บอกเลิก`, urgent:true }, msgTerminate(c, daysOv, lt, penalty, cyc.id, false));
        await sbPatch('rent_cycles', { id:cyc.id }, { penalty_snapshot:penalty });
        log.rent++;
      }
      // daysOv > lt และแจ้งไปแล้ว → เงียบ (ไม่จิกซ้ำ)
    }
  }
}

// ── Case 2: สิ้นสุดสัญญา + ต่อสัญญา ──
async function processExpiry(c, today, log, LL) {
  const end = contractEnd(c.start_date, c.term);
  if (!end) return;
  const dte = daysBetween(today, end);
  if (dte < 0) return;
  const tnIds = [c.tn_line_user_id, c.tn2_line_user_id].filter(Boolean);
  const llId  = c.ll_line_user_id;

  if ((dte === 40 || dte === 35) && !c.renewal_status) {
    if (await claim(c.id, 'renewal', today, { dte })) {
      for (const t of tnIds) await linePush(t, msgRenewal(c, end, dte));
      log.renewal++;
    }
  }
  if (dte === 30) {
    if (await claim(c.id, 'expiry', today, { dte })) {
      for (const t of tnIds) await linePush(t, msgExpiry(c, end, dte));
      if (llId) addLL(LL, llId, { icon:'📅', prop:c.prop_name, room:c.room_no, label:`สัญญาใกล้หมด อีก ${dte} วัน`, urgent:false }, msgExpiry(c, end, dte));
      log.expiry++;
    }
  }
}

// ── Case 3: คืนเงินประกัน ──
async function processDeposit(c, today, log, LL) {
  if (!c.ll_line_user_id || !c.deposit) return;
  const end = contractEnd(c.start_date, c.term);
  if (!end) return;
  const dte = daysBetween(today, end);
  if (dte <= 30 && dte >= 2 && dte % 7 === 2 && c.renewal_status !== 'renew') {
    if (await claim(c.id, 'deposit', today, { dte })) {
      addLL(LL, c.ll_line_user_id, { icon:'💰', prop:c.prop_name, room:c.room_no, label:`เตรียมคืนประกัน (${baht(c.deposit)})`, urgent:false }, msgDeposit(c, end, dte));
      log.deposit++;
    }
  }
}

// ── Main ──
module.exports = async (req, res) => {
  const secret   = process.env.CRON_SECRET;
  const provided = (req.headers['x-cron-key'] || (req.query&&req.query.key) ||
    (req.headers['authorization']||'').replace(/^Bearer\s+/i,'')).toString();
  if (secret && provided !== secret) return res.status(401).json({ error:'unauthorized' });

  const today = todayICT();
  const log = { date:ymd(today), rent:0, expiry:0, renewal:0, deposit:0, digest:0, errors:[] };
  const LL = {}; // สะสมแจ้งเตือนผู้ให้เช่าต่อ ll_line_user_id

  try {
    const cols = ['id','prop_name','room_no','rent','deposit','start_date','term','pay_day',
      'late_penalty','late_terminate_days','tn_name','ll_name',
      'tn_line_user_id','tn2_line_user_id','ll_line_user_id',
      'renewal_status','reminders_enabled','payment_completed'].join(',');
    const contracts = await sbGet(
      `contracts?select=${cols}&payment_completed=eq.true&start_date=not.is.null&limit=2000`
    );
    for (const c of contracts) {
      if (c.reminders_enabled === false) continue;
      try {
        await processRent(c, today, log, LL);
        await processExpiry(c, today, log, LL);
        await processDeposit(c, today, log, LL);
      } catch(e) { log.errors.push({ contract:c.id, detail:String(e.message||e) }); }
    }
    // ส่งสรุปให้ผู้ให้เช่า: 1 ห้อง → ข้อความละเอียด, หลายห้อง → รวมใบเดียว
    for (const llId of Object.keys(LL)) {
      const arr = LL[llId];
      if (!arr || !arr.length) continue;
      try {
        if (arr.length === 1) await linePush(llId, arr[0].full);
        else                  await linePush(llId, buildDigestFlex(arr.map(x => x.compact)));
        log.digest++;
      } catch(e) { log.errors.push({ landlord:llId, detail:String(e.message||e) }); }
    }
    return res.status(200).json({ ok:true, ...log });
  } catch(e) {
    return res.status(500).json({ error:'cron_failed', detail:String(e.message||e) });
  }
};
