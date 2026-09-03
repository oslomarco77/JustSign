// ============================================================
//  Test harness — mini PostgREST + Beam mock
//  ไม่ยิง Beam จริง ไม่แตะ Supabase จริง
// ============================================================
'use strict';
const crypto = require('crypto');

const SB = 'https://test.supabase.co';
const BEAM = 'https://playground.api.beamcheckout.com';

/* ══════════ in-memory DB ══════════ */
function newDb() {
  return {
    products: [{
      product_code: 'LANDLORD_AI_GUIDE',
      name: 'คู่มือเอาตัวรอดของเจ้าของห้องเช่าในยุค AI',
      price: 29900, currency: 'THB', current_version: 'v1.3',
      storage_bucket: 'ebooks', storage_path: 'SignDee_Landlord_AI_Guide_v1_3.pdf',
      status: 'ACTIVE', max_downloads: 5, download_ttl_hours: 720,
    }],
    orders: [], payments: [], deliveries: [],
    payment_webhook_events: [], commerce_events: [],
    _seq: 0,
  };
}

/* ══════════ beam mock state ══════════ */
function newBeam() {
  return {
    links: {},                 // id → { status, order:{netAmount,currency,referenceId} }
    charges: {},               // id → { status, amount, currency, referenceId }
    chargeFails: false,
    createFails: false,
    getReturnsNull: false,
    rejectCard: false,         // บัญชียังเปิด CREDIT_CARD ไม่ได้
    promptPayOnly: false,      // บัญชีรับได้เฉพาะ PromptPay
    createCalls: 0,
    lastPayload: null,
  };
}

const uuid = () => crypto.randomUUID();

/** แปลง querystring แบบ PostgREST เป็น filter */
function applyFilters(rows, qs) {
  let out = rows.slice();
  let limit = null, orderDesc = null;
  for (const [k, v] of qs.entries()) {
    if (k === 'select') continue;
    if (k === 'limit') { limit = parseInt(v, 10); continue; }
    if (k === 'order') { orderDesc = v; continue; }
    if (v.startsWith('eq.')) {
      const want = decodeURIComponent(v.slice(3));
      out = out.filter(r => String(r[k]) === want);
    } else if (v.startsWith('in.')) {
      const list = v.slice(3).replace(/^\(|\)$/g, '').split(',').map(s => s.trim());
      out = out.filter(r => list.includes(String(r[k])));
    }
  }
  if (orderDesc) {
    const [col, dir] = orderDesc.split('.');
    out.sort((a, b) => (dir === 'desc'
      ? String(b[col] || '').localeCompare(String(a[col] || ''))
      : String(a[col] || '').localeCompare(String(b[col] || ''))));
  }
  if (limit != null) out = out.slice(0, limit);
  return out;
}

/** ตรวจ unique constraint ที่ schema จริงมี */
function violatesUnique(db, table, row) {
  if (table === 'payments') {
    return db.payments.some(p => p.order_id === row.order_id
      && ['CREATED', 'PENDING'].includes(p.status));
  }
  if (table === 'deliveries') {
    return db.deliveries.some(d => d.order_id === row.order_id);
  }
  if (table === 'payment_webhook_events') {
    return db.payment_webhook_events.some(e => e.provider === (row.provider || 'beam')
      && e.event_fingerprint === row.event_fingerprint);
  }
  if (table === 'orders') {
    return db.orders.some(o => o.order_number === row.order_number);
  }
  return false;
}

function install({ db, beam }) {
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;

    /* ── Supabase RPC ── */
    if (u.pathname === '/rest/v1/rpc/next_order_number') {
      db._seq += 1;
      return res(200, `SD-EBOOK-20260901-${String(db._seq).padStart(6, '0')}`);
    }

    /* ── Supabase Storage sign ── */
    if (u.pathname.startsWith('/storage/v1/object/sign/')) {
      const obj = u.pathname.replace('/storage/v1/object/sign/', '');
      if (db._storageFails) return res(500, { error: 'storage down' });
      return res(200, { signedURL: `/object/sign/${obj}?token=fake` });
    }

    /* ── Supabase REST tables ── */
    if (u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.replace('/rest/v1/', '');
      const store = db[table];
      if (!store) return res(404, { message: 'no table ' + table });

      if (method === 'GET') return res(200, applyFilters(store, u.searchParams));

      if (method === 'POST') {
        const row = { ...body };
        if (violatesUnique(db, table, row)) return res(409, { message: 'duplicate key' });
        row.id = row.id || (table === 'payment_webhook_events' || table === 'commerce_events'
          ? store.length + 1 : uuid());
        row.created_at = row.created_at || new Date().toISOString();
        row.updated_at = row.updated_at || row.created_at;
        if (table === 'deliveries') {
          row.download_count = row.download_count ?? 0;
          row.max_downloads = row.max_downloads ?? 5;
        }
        if (table === 'payment_webhook_events') row.processed = row.processed ?? false;
        store.push(row);
        const prefer = (opts.headers && opts.headers.Prefer) || '';
        return res(201, prefer.includes('return=minimal') ? null : [row]);
      }

      if (method === 'PATCH') {
        const target = applyFilters(store, u.searchParams);
        target.forEach(r => Object.assign(r, body));
        const prefer = (opts.headers && opts.headers.Prefer) || '';
        return res(200, prefer.includes('return=representation') ? target : null);
      }
    }

    /* ── Beam Charges (QR PromptPay) ── */
    if (u.origin === BEAM && u.pathname === '/api/v1/charges' && method === 'POST') {
      beam.createCalls += 1;
      beam.lastPayload = body;
      if (beam.chargeFails) return res(500, { message: 'beam down' });
      const id = 'CH' + Math.random().toString(36).slice(2, 10);
      beam.charges[id] = { status: 'PENDING', amount: body.amount, currency: body.currency,
        referenceId: body.referenceId };
      return res(200, {
        chargeId: id, status: 'PENDING', actionRequired: 'ENCODED_IMAGE',
        amount: body.amount, currency: body.currency,
        encodedImage: {
          imageBase64Encoded: 'iVBORw0KGgoAAAANSUhEUg==',
          rawData: '00020101021229370016A0000006770101110213' + id,
          expiry: body.paymentMethod.qrPromptPay.expiryTime,
        },
      });
    }
    if (u.origin === BEAM && u.pathname.startsWith('/api/v1/charges/') && method === 'GET') {
      if (beam.getReturnsNull) return res(500, { message: 'beam down' });
      const id = u.pathname.split('/').pop();
      const c = beam.charges[id];
      if (!c) return res(404, { message: 'not found' });
      return res(200, { chargeId: id, ...c });
    }

    /* ── Beam Payment Links ── */
    if (u.origin === BEAM && u.pathname === '/api/v1/payment-links' && method === 'POST') {
      beam.createCalls += 1;
      beam.lastPayload = body;
      if (beam.createFails) return res(500, { message: 'beam down' });
      // จำลองบัญชีที่รับได้เฉพาะ PromptPay — ต้องปิด card และเปิด qrPromptPay เท่านั้น
      if (beam.promptPayOnly) {
        const ls = body.linkSettings;
        const ok = ls && ls.card && ls.card.isEnabled === false
          && ls.qrPromptPay && ls.qrPromptPay.isEnabled === true;
        if (!ok) {
          return res(400, {
            code: 400,
            error: { errorCode: 'API_VALIDATION_ERROR',
              errorMessage: 'inputs are failing validation; cannot enable CREDIT_CARD' },
          });
        }
      }
      // จำลองบัญชีที่ยังเปิดบัตรไม่ได้ — ตอบเหมือน Beam ของจริง
      if (beam.rejectCard && body.linkSettings && body.linkSettings.card && body.linkSettings.card.isEnabled) {
        return res(400, {
          code: 400,
          error: { errorCode: 'API_VALIDATION_ERROR',
            errorMessage: 'inputs are failing validation; cannot enable CREDIT_CARD' },
        });
      }
      const id = 'PL' + Math.random().toString(36).slice(2, 10);
      beam.links[id] = { status: 'ACTIVE', order: body.order };
      return res(200, { paymentLinkId: id, url: `${BEAM}/pay/${id}`, status: 'ACTIVE' });
    }
    if (u.origin === BEAM && u.pathname.startsWith('/api/v1/payment-links/') && method === 'GET') {
      if (beam.getReturnsNull) return res(500, { message: 'beam down' });
      const id = u.pathname.split('/').pop();
      const link = beam.links[id];
      if (!link) return res(404, { message: 'not found' });
      return res(200, { paymentLinkId: id, status: link.status, order: link.order });
    }

    return res(404, { message: 'unmocked ' + u.href });
  };
}

/* ══════════ req / res mocks ══════════ */
function mkRes() {
  const r = {
    statusCode: 200, body: null, headers: {}, ended: false,
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; r.ended = true; return r; },
    send(b) { r.body = b; r.ended = true; return r; },
    setHeader(k, v) { r.headers[k] = v; },
    writeHead(c, h) { r.statusCode = c; Object.assign(r.headers, h || {}); return r; },
    end() { r.ended = true; return r; },
  };
  return r;
}
const mkReq = (o = {}) => ({ method: 'GET', query: {}, headers: {}, body: null, ...o });

const sign = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

module.exports = { SB, BEAM, newDb, newBeam, install, mkRes, mkReq, sign, uuid };
