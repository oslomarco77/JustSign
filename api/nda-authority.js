'use strict';

const Authority = require('./_nda_authority.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const AUTHORITY_KEY = process.env.NDA_AUTHORITY_API_KEY || '';
const BINDING_KEY = process.env.NDA_WORKSPACE_BINDING_API_KEY || '';
const BINDING_PRINCIPAL = process.env.NDA_WORKSPACE_BINDING_PRINCIPAL || '';

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

async function persistSignature(signing) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/nda_authority_sign_version`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_nda_id: signing.ndaId,
      p_version_id: signing.versionId,
      p_signer_id: signing.signerId,
      p_capability_digest: signing.capabilityDigest,
      p_consent_schema: signing.consentSchema,
    }),
  });
  if (!response.ok) {
    let databaseCode = '';
    try { databaseCode = String((await response.json()).message || ''); } catch (_) { /* sanitized below */ }
    const error = new Error('signature_persistence_failed');
    if (databaseCode === 'nda_signing_conflict') {
      error.publicStatus = 409;
      error.publicCode = 'signing_conflict';
    } else if (databaseCode === 'nda_signing_not_authorized') {
      error.publicStatus = 403;
      error.publicCode = 'signing_not_authorized';
    }
    throw error;
  }
  return response.json();
}

async function persistBinding(binding) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/nda_authority_reserve_workspace_binding`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_nda_id: binding.ndaId,
      p_version_id: binding.versionId,
      p_workspace_id: binding.workspaceId,
      p_actor_principal: binding.actorPrincipal,
    }),
  });
  if (!response.ok) {
    let databaseCode = '';
    try { databaseCode = String((await response.json()).message || ''); } catch (_) { /* sanitized below */ }
    const error = new Error('binding_persistence_failed');
    if (databaseCode === 'nda_binding_not_eligible') {
      error.publicStatus = 403;
      error.publicCode = 'binding_not_authorized';
    }
    throw error;
  }
  return response.json();
}

async function persistSignedEvidence(request) {
  const operations = {
    issue_signed_evidence: ['nda_authority_issue_signed_evidence',
      { p_nda_id: request.ndaId, p_version_id: request.versionId }],
    resolve_signed_evidence: ['nda_authority_resolve_signed_evidence',
      { p_signed_document_reference: request.signedDocumentReference }],
    resolve_workspace_acceptance: ['nda_authority_resolve_workspace_acceptance',
      { p_binding_id: request.bindingId, p_signed_document_reference: request.signedDocumentReference }],
    confirm_workspace_acceptance: ['nda_authority_confirm_workspace_acceptance',
      { p_binding_id: request.bindingId, p_workspace_id: request.workspaceId,
        p_workspace_result_reference: request.workspaceResultReference }],
  };
  const [rpc, body] = operations[request.action];
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpc}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let databaseCode = '';
    try { databaseCode = String((await response.json()).message || ''); } catch (_) { /* sanitized below */ }
    const error = new Error('signed_evidence_persistence_failed');
    if (databaseCode === 'nda_signed_evidence_not_eligible'
        || databaseCode === 'nda_workspace_acceptance_not_authorized') {
      error.publicStatus = 403;
      error.publicCode = 'signed_evidence_not_eligible';
    } else if (databaseCode === 'nda_signed_evidence_not_found') {
      error.publicStatus = 404;
      error.publicCode = 'signed_evidence_not_found';
    } else if (databaseCode === 'nda_workspace_confirmation_conflict') {
      error.publicStatus = 409;
      error.publicCode = 'workspace_confirmation_conflict';
    }
    throw error;
  }
  return response.json();
}

async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'method_not_allowed' });
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return reply(res, 415, { ok: false, code: 'unsupported_media_type' });
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > Authority.MAX_REQUEST_BYTES) {
    return reply(res, 413, { ok: false, code: 'request_too_large' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return reply(res, 503, { ok: false, code: 'authority_not_configured' });
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
  if (!['create_initial_version', 'sign', 'reserve_workspace_binding',
    'issue_signed_evidence', 'resolve_signed_evidence', 'resolve_workspace_acceptance',
    'confirm_workspace_acceptance'].includes(body.action)) {
    return reply(res, 400, { ok: false, code: 'unsupported_action' });
  }

  if (['issue_signed_evidence','resolve_signed_evidence','resolve_workspace_acceptance',
    'confirm_workspace_acceptance'].includes(body.action)) {
    if (bodyBytes > Authority.MAX_EVIDENCE_REQUEST_BYTES) {
      return reply(res, 413, { ok: false, code: 'request_too_large' });
    }
    if (!AUTHORITY_KEY) return reply(res, 503, { ok: false, code: 'authority_not_configured' });
    if (!Authority.secretMatches(req.headers['x-signdee-authority-key'], AUTHORITY_KEY)) {
      return reply(res, 403, { ok: false, code: 'authorization_failed' });
    }
    try {
      const result = await persistSignedEvidence(Authority.signedEvidenceRequest(body));
      return reply(res, body.action === 'issue_signed_evidence' && result.created ? 201 : 200,
        { ok: true, ...result });
    } catch (error) {
      if (error instanceof TypeError) {
        const candidate = String(error.message || '');
        const code = /^(?:invalid_)/.test(candidate) ? candidate : 'invalid_request';
        return reply(res, 400, { ok: false, code });
      }
      if (error.publicStatus) return reply(res, error.publicStatus, { ok: false, code: error.publicCode });
      return reply(res, 500, { ok: false, code: 'internal_error' });
    }
  }

  if (body.action === 'sign') {
    if (bodyBytes > Authority.MAX_SIGN_REQUEST_BYTES) {
      return reply(res, 413, { ok: false, code: 'request_too_large' });
    }
    try {
      const result = await persistSignature(Authority.signingRequest(body));
      return reply(res, 200, {
        ok: true,
        nda_id: result.nda_id,
        version_id: result.version_id,
        signer_id: result.signer_id,
        signed_at: result.signed_at,
        completed: result.completed,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        const candidate = String(error.message || '');
        const code = /^(?:invalid_|consent_required$)/.test(candidate) ? candidate : 'invalid_request';
        return reply(res, 400, { ok: false, code });
      }
      if (error.publicStatus) return reply(res, error.publicStatus, { ok: false, code: error.publicCode });
      return reply(res, 500, { ok: false, code: 'internal_error' });
    }
  }

  if (body.action === 'reserve_workspace_binding') {
    if (bodyBytes > Authority.MAX_BIND_REQUEST_BYTES) {
      return reply(res, 413, { ok: false, code: 'request_too_large' });
    }
    if (!BINDING_KEY || !BINDING_PRINCIPAL) {
      return reply(res, 503, { ok: false, code: 'binding_not_configured' });
    }
    if (!Authority.secretMatches(req.headers['x-signdee-binding-key'], BINDING_KEY)) {
      return reply(res, 403, { ok: false, code: 'authorization_failed' });
    }
    try {
      const result = await persistBinding(Authority.bindingRequest(body, BINDING_PRINCIPAL));
      if (result.outcome === 'conflict') {
        return reply(res, 409, { ok: false, code: 'workspace_binding_conflict' });
      }
      return reply(res, result.created ? 201 : 200, {
        ok: true,
        binding_id: result.binding_id,
        nda_id: result.nda_id,
        version_id: result.version_id,
        workspace_id: result.workspace_id,
        binding_status: result.binding_status,
        document_hash: result.document_hash,
        authority_package_reference: result.authority_package_reference,
        created: result.created,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        const candidate = String(error.message || '');
        const code = /^(?:invalid_)/.test(candidate) ? candidate : 'invalid_request';
        return reply(res, 400, { ok: false, code });
      }
      if (error.publicStatus) return reply(res, error.publicStatus, { ok: false, code: error.publicCode });
      return reply(res, 500, { ok: false, code: 'internal_error' });
    }
  }

  if (!AUTHORITY_KEY) return reply(res, 503, { ok: false, code: 'authority_not_configured' });
  if (!Authority.secretMatches(req.headers['x-signdee-authority-key'], AUTHORITY_KEY)) {
    return reply(res, 403, { ok: false, code: 'authorization_failed' });
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
module.exports.persistSignature = persistSignature;
module.exports.persistBinding = persistBinding;
module.exports.persistSignedEvidence = persistSignedEvidence;
