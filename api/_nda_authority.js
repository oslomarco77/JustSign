'use strict';

const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const CANONICAL_SCHEMA = 'signdee.nda.document.v1';
const CAPABILITY_BYTES = 32;
const MAX_CANONICAL_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 300 * 1024;
const MAX_SIGN_REQUEST_BYTES = 4 * 1024;
const MAX_BIND_REQUEST_BYTES = 4 * 1024;
const MAX_EVIDENCE_REQUEST_BYTES = 4 * 1024;
const SIGNING_CONSENT_SCHEMA = 'signdee.nda.signing-consent.v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['issued', 'void']),
  issued: Object.freeze(['completed', 'void', 'superseded']),
  completed: Object.freeze([]),
  void: Object.freeze([]),
  superseded: Object.freeze([]),
});

function isVersionTransitionAllowed(from, to) {
  return !!VERSION_TRANSITIONS[from] && VERSION_TRANSITIONS[from].includes(to);
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('non_plain_object');
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => canonicalize(key) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  throw new TypeError('unsupported_canonical_type');
}

function requiredString(value, field, max) {
  const out = String(value == null ? '' : value).normalize('NFC').trim();
  if (!out || out.length > max) throw new TypeError('invalid_' + field);
  return out;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null || value === '') return '';
  return requiredString(value, field, max);
}

function materialObject(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_' + field);
  const forbidden = /(?:^|_)(?:signature|signed|token|capability|secret|password|certificate|otp|image|base64)(?:_|$)/i;
  const walk = (node, depth) => {
    if (depth > 8) throw new TypeError('invalid_' + field);
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (forbidden.test(key)) throw new TypeError('forbidden_' + field);
        walk(node[key], depth + 1);
      }
    }
    if (typeof node === 'string' && node.length > 30000) throw new TypeError('invalid_' + field);
  };
  walk(value, 0);
  canonicalize(value);
  return value;
}

function partyIdentity(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_' + field);
  const identityType = requiredString(value.identity_type, field + '_identity_type', 20);
  if (!['individual', 'juristic'].includes(identityType)) throw new TypeError('invalid_' + field + '_identity_type');
  const juristic = value.juristic || {};
  const age = value.age_years === undefined || value.age_years === null || value.age_years === ''
    ? null : Number(value.age_years);
  if (age !== null && (!Number.isInteger(age) || age < 1 || age > 129)) throw new TypeError('invalid_' + field + '_age_years');
  return {
    identity_type: identityType,
    display_name: requiredString(value.display_name, field + '_display_name', 300),
    national_id: optionalString(value.national_id, field + '_national_id', 40),
    age_years: age,
    address: optionalString(value.address, field + '_address', 1000),
    phone: optionalString(value.phone, field + '_phone', 40),
    juristic: identityType === 'juristic' ? {
      name: requiredString(juristic.name, field + '_juristic_name', 300),
      registration_number: requiredString(juristic.registration_number, field + '_registration_number', 80),
      authorized_signer: requiredString(juristic.authorized_signer, field + '_authorized_signer', 300),
      registration_office: optionalString(juristic.registration_office, field + '_registration_office', 300),
      certificate_date: optionalString(juristic.certificate_date, field + '_certificate_date', 40),
      power_of_attorney_date: optionalString(juristic.power_of_attorney_date, field + '_power_of_attorney_date', 40),
      address_number: requiredString(juristic.address_number, field + '_address_number', 100),
      road: optionalString(juristic.road, field + '_road', 300),
      subdistrict: requiredString(juristic.subdistrict, field + '_subdistrict', 300),
      district: requiredString(juristic.district, field + '_district', 300),
      province: requiredString(juristic.province, field + '_province', 300),
    } : null,
  };
}

function buildCanonicalDocument(input, authority) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_document');
  const parties = input.parties || {};
  const clauses = input.clauses || {};
  const duration = Number(input.duration_months);
  if (!Number.isInteger(duration) || duration < 1 || duration > 1200) throw new TypeError('invalid_duration_months');
  if (!['one_way', 'mutual'].includes(input.nda_type)) throw new TypeError('invalid_nda_type');

  const document = {
    canonical_schema: CANONICAL_SCHEMA,
    nda_id: requiredString(authority.ndaId, 'nda_id', 64),
    version_id: requiredString(authority.versionId, 'version_id', 64),
    version_number: authority.versionNumber,
    title: requiredString(input.title, 'title', 200),
    nda_type: requiredString(input.nda_type, 'nda_type', 40),
    document_intro: requiredString(input.document_intro, 'document_intro', 5000),
    document_closing: requiredString(input.document_closing, 'document_closing', 5000),
    place_of_execution: requiredString(input.place_of_execution, 'place_of_execution', 1000),
    parties: [
      {
        signer_id: requiredString(authority.signers.a.id, 'signer_id', 64),
        party_ref: requiredString(authority.signers.a.partyRef, 'party_ref', 128),
        role: 'discloser',
        identity: partyIdentity(parties.a, 'party_a'),
      },
      {
        signer_id: requiredString(authority.signers.b.id, 'signer_id', 64),
        party_ref: requiredString(authority.signers.b.partyRef, 'party_ref', 128),
        role: 'recipient',
        identity: partyIdentity(parties.b, 'party_b'),
      },
    ],
    effective_date: requiredString(input.effective_date, 'effective_date', 40),
    display_date: requiredString(input.display_date, 'display_date', 100),
    confidential_information_scope: requiredString(input.confidential_information_scope, 'confidential_information_scope', 5000),
    permitted_purpose: requiredString(input.permitted_purpose, 'permitted_purpose', 5000),
    term: {
      duration_months: duration,
      start_date: requiredString(input.start_date, 'start_date', 40),
      end_date: requiredString(input.end_date, 'end_date', 40),
    },
    clauses: Array.from({ length: 8 }, (_, index) =>
      requiredString(clauses['c' + (index + 1)], 'clause_' + (index + 1), 30000)),
    governing_law: optionalString(input.governing_law, 'governing_law', 500),
    jurisdiction: optionalString(input.jurisdiction, 'jurisdiction', 500),
    material_options: materialObject(input.material_options, 'material_options'),
    exceptions: materialObject(input.exceptions, 'exceptions'),
    additional_terms: optionalString(input.additional_terms, 'additional_terms', 30000),
  };

  if (!Number.isInteger(document.version_number) || document.version_number < 1) {
    throw new TypeError('invalid_version_number');
  }
  const canonical = canonicalize(document);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_BYTES) throw new TypeError('document_too_large');
  return { document, canonical, hash: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

function issueCapability(now, ttlSeconds) {
  const ttl = Number(ttlSeconds);
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > 60 * 60 * 24 * 30) throw new TypeError('invalid_capability_ttl');
  const plaintext = randomBytes(CAPABILITY_BYTES).toString('base64url');
  return {
    plaintext,
    digest: createHash('sha256').update(plaintext, 'utf8').digest('hex'),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
}

function digestCapability(plaintext) {
  if (typeof plaintext !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(plaintext)) {
    throw new TypeError('invalid_signing_capability');
  }
  let decoded;
  try { decoded = Buffer.from(plaintext, 'base64url'); }
  catch (_) { throw new TypeError('invalid_signing_capability'); }
  if (decoded.length !== CAPABILITY_BYTES || decoded.toString('base64url') !== plaintext) {
    throw new TypeError('invalid_signing_capability');
  }
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

function signingRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_request');
  const allowed = new Set(['action', 'nda_id', 'version_id', 'signer_id', 'capability', 'consent']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_request');
  for (const field of ['nda_id', 'version_id', 'signer_id']) {
    if (typeof input[field] !== 'string' || !UUID_PATTERN.test(input[field])) throw new TypeError('invalid_' + field);
  }
  if (input.consent !== true) throw new TypeError('consent_required');
  return {
    ndaId: input.nda_id.toLowerCase(),
    versionId: input.version_id.toLowerCase(),
    signerId: input.signer_id.toLowerCase(),
    capabilityDigest: digestCapability(input.capability),
    consentSchema: SIGNING_CONSENT_SCHEMA,
  };
}

function bindingRequest(input, actorPrincipal) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_request');
  const allowed = new Set(['action', 'nda_id', 'version_id', 'workspace_id']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_request');
  for (const field of ['nda_id', 'version_id', 'workspace_id']) {
    if (typeof input[field] !== 'string' || !UUID_PATTERN.test(input[field])) throw new TypeError('invalid_' + field);
  }
  if (typeof actorPrincipal !== 'string' || !/^[A-Za-z0-9._:-]{3,128}$/.test(actorPrincipal)) {
    throw new TypeError('invalid_binding_principal');
  }
  return {
    ndaId: input.nda_id.toLowerCase(),
    versionId: input.version_id.toLowerCase(),
    workspaceId: input.workspace_id.toLowerCase(),
    actorPrincipal,
  };
}

function signedEvidenceRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_request');
  if (input.action === 'issue_signed_evidence') {
    const allowed = new Set(['action', 'nda_id', 'version_id']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_request');
    for (const field of ['nda_id', 'version_id']) {
      if (typeof input[field] !== 'string' || !UUID_PATTERN.test(input[field])) {
        throw new TypeError('invalid_' + field);
      }
    }
    return { action: input.action, ndaId: input.nda_id.toLowerCase(), versionId: input.version_id.toLowerCase() };
  }
  if (input.action === 'resolve_signed_evidence') {
    const allowed = new Set(['action', 'signed_document_reference']);
    if (Object.keys(input).some((key) => !allowed.has(key))
        || typeof input.signed_document_reference !== 'string'
        || !/^sde_[0-9a-f]{64}$/.test(input.signed_document_reference)) {
      throw new TypeError('invalid_signed_document_reference');
    }
    return { action: input.action, signedDocumentReference: input.signed_document_reference };
  }
  if (input.action === 'resolve_workspace_acceptance') {
    const allowed = new Set(['action', 'binding_id', 'signed_document_reference']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_request');
    if (typeof input.binding_id !== 'string' || !UUID_PATTERN.test(input.binding_id)) {
      throw new TypeError('invalid_binding_id');
    }
    if (typeof input.signed_document_reference !== 'string'
        || !/^sde_[0-9a-f]{64}$/.test(input.signed_document_reference)) {
      throw new TypeError('invalid_signed_document_reference');
    }
    return { action: input.action, bindingId: input.binding_id.toLowerCase(),
      signedDocumentReference: input.signed_document_reference };
  }
  if (input.action === 'confirm_workspace_acceptance') {
    const allowed = new Set(['action', 'binding_id', 'workspace_id', 'workspace_result_reference']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_request');
    for (const field of ['binding_id', 'workspace_id', 'workspace_result_reference']) {
      if (typeof input[field] !== 'string' || !UUID_PATTERN.test(input[field])) {
        throw new TypeError('invalid_' + field);
      }
    }
    return { action: input.action, bindingId: input.binding_id.toLowerCase(),
      workspaceId: input.workspace_id.toLowerCase(),
      workspaceResultReference: input.workspace_result_reference.toLowerCase() };
  }
  // SD-407C — outbound delivery. Exactly the two locators the Sign Dee
  // receiver accepts, and nothing else: workspace_id is deliberately absent
  // from the allowlist so this side can never assert a Workspace.
  if (input.action === 'deliver_workspace_acceptance') {
    const allowed = new Set(['action', 'binding_id', 'signed_document_reference']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_request');
    if (typeof input.binding_id !== 'string' || !UUID_PATTERN.test(input.binding_id)) {
      throw new TypeError('invalid_binding_id');
    }
    if (typeof input.signed_document_reference !== 'string'
        || !/^sde_[0-9a-f]{64}$/.test(input.signed_document_reference)) {
      throw new TypeError('invalid_signed_document_reference');
    }
    return { action: input.action, bindingId: input.binding_id.toLowerCase(),
      signedDocumentReference: input.signed_document_reference };
  }
  throw new TypeError('invalid_request');
}

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(String(provided), 'utf8').digest();
  const b = createHash('sha256').update(String(expected), 'utf8').digest();
  return timingSafeEqual(a, b);
}

function createAuthorityPackage(input, options = {}) {
  const now = options.now || new Date();
  const uuid = options.randomUUID || randomUUID;
  const ndaId = uuid();
  const versionId = uuid();
  const signerA = { id: uuid(), partyRef: uuid(), role: 'discloser' };
  const signerB = { id: uuid(), partyRef: uuid(), role: 'recipient' };
  const capA = issueCapability(now, input.capability_ttl_seconds || 86400);
  const capB = issueCapability(now, input.capability_ttl_seconds || 86400);
  const canonical = buildCanonicalDocument(input.document, {
    ndaId, versionId, versionNumber: 1, signers: { a: signerA, b: signerB },
  });
  return { ndaId, versionId, signerA, signerB, capA, capB, canonical, now: now.toISOString() };
}

module.exports = {
  CANONICAL_SCHEMA,
  CAPABILITY_BYTES,
  MAX_REQUEST_BYTES,
  MAX_SIGN_REQUEST_BYTES,
  MAX_BIND_REQUEST_BYTES,
  MAX_EVIDENCE_REQUEST_BYTES,
  SIGNING_CONSENT_SCHEMA,
  VERSION_TRANSITIONS,
  isVersionTransitionAllowed,
  canonicalize,
  buildCanonicalDocument,
  issueCapability,
  digestCapability,
  signingRequest,
  bindingRequest,
  signedEvidenceRequest,
  secretMatches,
  createAuthorityPackage,
};
