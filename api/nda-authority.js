'use strict';

const Authority = require('./_nda_authority.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const AUTHORITY_KEY = process.env.NDA_AUTHORITY_API_KEY || '';

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

async function persistAuthority(pkg) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/nda_authority_create_initial_version`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_nda_id: pkg.ndaId,
      p_version_id: pkg.versionId,
      p_canonical_schema: Authority.CANONICAL_SCHEMA,
      p_canonical_payload: pkg.canonical.canonical,
      p_canonical_document: pkg.canonical.document,
      p_document_hash: pkg.canonical.hash,
      p_signers: [
        {
          id: pkg.signerA.id, party_ref: pkg.signerA.partyRef, role: pkg.signerA.role,
          capability_digest: pkg.capA.digest, expires_at: pkg.capA.expiresAt,
        },
        {
          id: pkg.signerB.id, party_ref: pkg.signerB.partyRef, role: pkg.signerB.role,
          capability_digest: pkg.capB.digest, expires_at: pkg.capB.expiresAt,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error('authority_persistence_failed');
}

async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'method_not_allowed' });
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return reply(res, 415, { ok: false, code: 'unsupported_media_type' });
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > Authority.MAX_REQUEST_BYTES) {
    return reply(res, 413, { ok: false, code: 'request_too_large' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !AUTHORITY_KEY) {
    return reply(res, 503, { ok: false, code: 'authority_not_configured' });
  }
  if (!Authority.secretMatches(req.headers['x-signdee-authority-key'], AUTHORITY_KEY)) {
    return reply(res, 403, { ok: false, code: 'authorization_failed' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (_) { return reply(res, 400, { ok: false, code: 'malformed_request' }); }
  let bodyBytes;
  try { bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8'); }
  catch (_) { return reply(res, 400, { ok: false, code: 'malformed_request' }); }
  if (bodyBytes > Authority.MAX_REQUEST_BYTES) {
    return reply(res, 413, { ok: false, code: 'request_too_large' });
  }
  if (body.action !== 'create_initial_version') {
    return reply(res, 400, { ok: false, code: 'unsupported_action' });
  }

  try {
    const pkg = Authority.createAuthorityPackage(body);
    await persistAuthority(pkg);
    return reply(res, 201, {
      ok: true,
      nda_id: pkg.ndaId,
      version_id: pkg.versionId,
      version_number: 1,
      canonical_schema: Authority.CANONICAL_SCHEMA,
      document_hash: `sha256:${pkg.canonical.hash}`,
      capabilities: [
        { signer_id: pkg.signerA.id, role: pkg.signerA.role, capability: pkg.capA.plaintext, expires_at: pkg.capA.expiresAt },
        { signer_id: pkg.signerB.id, role: pkg.signerB.role, capability: pkg.capB.plaintext, expires_at: pkg.capB.expiresAt },
      ],
    });
  } catch (error) {
    if (error instanceof TypeError) {
      const candidate = String(error.message || '');
      const code = /^(?:invalid_|forbidden_|document_too_large$|non_finite_number$|non_plain_object$|unsupported_canonical_type$)/.test(candidate)
        ? candidate : 'invalid_request';
      return reply(res, 400, { ok: false, code });
    }
    return reply(res, 500, { ok: false, code: 'internal_error' });
  }
}

module.exports = handler;
module.exports.persistAuthority = persistAuthority;
