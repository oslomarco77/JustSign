/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth: sign-dee/lib/integration/contract/canonical.json
 * Regenerate with: node scripts/emit-esign-contract.mjs --out <target>
 *
 * Self-contained CommonJS consumer of the Sign Dee canonical integration
 * contract (SD-403). Uses Node built-ins only — safe for justsign-api, where
 * vercel.json sets "installCommand": "echo skip" and nothing is installed.
 *
 * Both systems assert SCHEMA_VERSION and CONTRACT_CHECKSUM match. If this file
 * drifts from the source, assertContractCompatible() throws and the integration
 * fails closed rather than silently disagreeing about the contract.
 */
'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');

const CONTRACT = Object.freeze({
  "binding_statuses": [
    "unbound",
    "bound",
    "unlinked"
  ],
  "binding_transitions": {
    "bound": [
      "unlinked"
    ],
    "unbound": [
      "bound"
    ],
    "unlinked": []
  },
  "completed_evidence_required_fields": [
    "document_version",
    "document_hash",
    "signed_document_reference",
    "source_completed_at"
  ],
  "document_hash": {
    "algorithm": "sha256",
    "encoding": "hex",
    "pattern": "^sha256:[0-9a-f]{64}$"
  },
  "error_codes": [
    "INVALID_PAYLOAD",
    "UNSUPPORTED_SCHEMA_VERSION",
    "UNSUPPORTED_PRODUCT_TYPE",
    "UNSUPPORTED_EVENT_TYPE",
    "INVALID_STATUS_TRANSITION",
    "MISSING_SIGNED_EVIDENCE",
    "FORBIDDEN_PII",
    "AUTHENTICATION_REQUIRED",
    "INVALID_SIGNATURE",
    "EXPIRED_REQUEST",
    "REPLAY_DETECTED",
    "DUPLICATE_BINDING",
    "ALREADY_LINKED",
    "CONFLICT",
    "SOURCE_NOT_FOUND",
    "SOURCE_PURGED",
    "RATE_LIMITED",
    "INTERNAL_ERROR"
  ],
  "event_types": [
    "contract.created",
    "contract.bound",
    "signature.requested",
    "signature.partially_completed",
    "signature.completed",
    "signature.declined",
    "signature.expired",
    "contract.cancelled",
    "contract.unlinked"
  ],
  "forbidden_metadata_key_patterns": [
    "(?:^|_)signature(?:_|$)",
    "signature_image",
    "sig_image",
    "signature_base64",
    "drawn_signature",
    "(?:^|_)otp(?:_|$)",
    "one_time_password",
    "challenge_answer",
    "(?:^|_)(?:signing_)?token(?:_|$)",
    "claim_code",
    "access_token",
    "refresh_token",
    "session_token",
    "id_token",
    "bearer",
    "service_role",
    "service_key",
    "secret",
    "api_key",
    "apikey",
    "private_key",
    "password",
    "passwd",
    "national_id",
    "citizen_id",
    "id_card",
    "id13",
    "id_number",
    "passport",
    "tax_id",
    "ssn",
    "social_security",
    "biometric",
    "fingerprint",
    "face_scan",
    "bank_account",
    "account_no",
    "account_number",
    "card_number",
    "iban",
    "swift",
    "payroll",
    "certificate_pem",
    "raw_certificate",
    "cert_content",
    "signed_url",
    "presigned_url",
    "download_url",
    "full_address",
    "street_address",
    "address_line",
    "home_address"
  ],
  "forbidden_value_patterns": {
    "base64_image_data_url": "^data:image\\/[a-z0-9.+-]+;base64,",
    "jwt": "^ey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}$",
    "pem_block": "-----BEGIN [A-Z ]*(?:CERTIFICATE|PRIVATE KEY|PUBLIC KEY)-----",
    "presigned_url": "[?&](?:X-Amz-Signature|X-Goog-Signature|sig|signature|token)=",
    "supabase_service_key": "^sb(?:p|_)[A-Za-z0-9_-]{20,}$",
    "thai_national_id": "^\\d{13}$"
  },
  "idempotency": {
    "canonical_payload_fields": [
      "schema_version",
      "event_type",
      "source_system",
      "product_type",
      "external_contract_id",
      "workspace_id",
      "agreement_id",
      "agreement_version_id",
      "signing_status",
      "binding_status",
      "document_version",
      "document_hash",
      "signed_document_reference",
      "certificate_reference",
      "occurred_at",
      "metadata"
    ],
    "hash_algorithm": "sha256",
    "hash_encoding": "hex",
    "key_prefix": "sdi_"
  },
  "identifier_patterns": {
    "correlation_id": "^[A-Za-z0-9._:-]{8,128}$",
    "external_contract_id": "^[A-Za-z0-9._:-]{8,128}$",
    "idempotency_key": "^[A-Za-z0-9._:-]{16,128}$",
    "opaque_reference": "^[A-Za-z0-9._:/-]{8,256}$",
    "uuid": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  },
  "metadata_allowlist": [
    "display_label",
    "product_label",
    "signer_count",
    "signed_count",
    "source_created_at",
    "source_purged",
    "include_amounts",
    "document_version_label"
  ],
  "product_types": [
    "sale",
    "rental",
    "nda",
    "employment"
  ],
  "retryable_error_codes": [
    "RATE_LIMITED",
    "INTERNAL_ERROR"
  ],
  "schema_version": "1.0.0",
  "service_auth": {
    "algorithm": "sha256",
    "canonical_string_fields": [
      "version",
      "key_id",
      "timestamp",
      "nonce",
      "method",
      "path",
      "content_sha256"
    ],
    "canonical_string_separator": "\n",
    "clock_tolerance_seconds": 300,
    "headers": {
      "content_sha256": "x-signdee-content-sha256",
      "key_id": "x-signdee-key-id",
      "nonce": "x-signdee-nonce",
      "signature": "x-signdee-signature",
      "timestamp": "x-signdee-timestamp"
    },
    "key_id_pattern": "^[A-Za-z0-9_-]{3,64}$",
    "nonce_pattern": "^[A-Za-z0-9_-]{16,64}$",
    "nonce_ttl_seconds": 900,
    "signature_encoding": "hex",
    "version": "SIGNDEE-HMAC-V1"
  },
  "signing_statuses": [
    "draft",
    "awaiting_signature",
    "partially_signed",
    "completed",
    "declined",
    "expired",
    "cancelled"
  ],
  "signing_transitions": {
    "awaiting_signature": [
      "partially_signed",
      "completed",
      "declined",
      "expired",
      "cancelled"
    ],
    "cancelled": [],
    "completed": [],
    "declined": [],
    "draft": [
      "awaiting_signature",
      "cancelled"
    ],
    "expired": [],
    "partially_signed": [
      "completed",
      "declined",
      "expired",
      "cancelled"
    ]
  },
  "source_systems": [
    "justsign",
    "workspace"
  ],
  "terminal_binding_statuses": [
    "unlinked"
  ],
  "terminal_signing_statuses": [
    "completed",
    "declined",
    "expired",
    "cancelled"
  ]
});

const SCHEMA_VERSION = CONTRACT.schema_version;
const CONTRACT_CHECKSUM = "70f133a0b62fb6ec754999935e7eddeff236b0584706b3c721ca9ae3cdcb01e3";

/* ── canonical membership ─────────────────────────────────────────────────── */

const has = (list, value) => Array.isArray(list) && list.indexOf(value) !== -1;

const isProductType = (v) => has(CONTRACT.product_types, v);
const isSigningStatus = (v) => has(CONTRACT.signing_statuses, v);
const isBindingStatus = (v) => has(CONTRACT.binding_statuses, v);
const isEventType = (v) => has(CONTRACT.event_types, v);
const isErrorCode = (v) => has(CONTRACT.error_codes, v);

/* ── transitions ──────────────────────────────────────────────────────────── */

function evaluateTransition(table, terminal, from, to) {
  if (!(from in table) || !(to in table)) return { kind: 'reject', reason: 'unknown_status' };
  if (from === to) return { kind: 'noop', reason: 'same_status' };
  if (terminal.indexOf(from) !== -1) return { kind: 'reject', reason: 'terminal_source' };
  if (table[from].indexOf(to) === -1) return { kind: 'reject', reason: 'not_allowed' };
  return { kind: 'apply' };
}

const evaluateSigningTransition = (from, to) =>
  evaluateTransition(CONTRACT.signing_transitions, CONTRACT.terminal_signing_statuses, from, to);

const evaluateBindingTransition = (from, to) =>
  evaluateTransition(CONTRACT.binding_transitions, CONTRACT.terminal_binding_statuses, from, to);

const isSigningTransitionAllowed = (from, to) => evaluateSigningTransition(from, to).kind === 'apply';
const isBindingTransitionAllowed = (from, to) => evaluateBindingTransition(from, to).kind === 'apply';

/* ── data minimisation ────────────────────────────────────────────────────── */

const FORBIDDEN_KEY_RE = CONTRACT.forbidden_metadata_key_patterns.map((p) => new RegExp(p));
const FORBIDDEN_VALUE_RE = Object.keys(CONTRACT.forbidden_value_patterns).map((name) => ({
  name,
  re: new RegExp(CONTRACT.forbidden_value_patterns[name]),
}));

function normaliseKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const isForbiddenKey = (key) => {
  const n = normaliseKey(key);
  return FORBIDDEN_KEY_RE.some((re) => re.test(n));
};

function detectForbiddenValue(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const hit = FORBIDDEN_VALUE_RE.find((entry) => entry.re.test(value));
  return hit ? hit.name : null;
}

/** Returns [{path, reason}] — never the offending value. Does not mutate input. */
function scanForbidden(value, basePath) {
  const findings = [];
  const walk = (node, path, depth) => {
    if (depth > 8) { findings.push({ path: path || '(root)', reason: 'max_depth_exceeded' }); return; }
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, path + '[' + i + ']', depth + 1)); return; }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const childPath = path ? path + '.' + key : key;
        if (isForbiddenKey(key)) { findings.push({ path: childPath, reason: 'forbidden_key' }); continue; }
        walk(node[key], childPath, depth + 1);
      }
      return;
    }
    const reason = detectForbiddenValue(node);
    if (reason) findings.push({ path: path || '(root)', reason: 'forbidden_value:' + reason });
  };
  walk(value, basePath || '', 0);
  return findings;
}

function validateMetadata(metadata) {
  if (metadata === undefined || metadata === null) return [];
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [{ path: 'metadata', reason: 'must_be_object' }];
  }
  const findings = [];
  for (const key of Object.keys(metadata)) {
    if (CONTRACT.metadata_allowlist.indexOf(key) === -1) {
      findings.push({ path: 'metadata.' + key, reason: 'not_allowlisted' });
    }
  }
  return findings.concat(scanForbidden(metadata, 'metadata'));
}

/* ── signed evidence ──────────────────────────────────────────────────────── */

function missingCompletedEvidence(envelope) {
  if (!envelope || envelope.signing_status !== 'completed') return [];
  return CONTRACT.completed_evidence_required_fields
    .filter((field) => envelope[field] === null || envelope[field] === undefined)
    .map((field) => ({ path: field, reason: 'required_when_completed' }));
}

/* ── idempotency ──────────────────────────────────────────────────────────── */

function sortValue(value, depth) {
  const d = depth || 0;
  if (d > 16) throw new Error('canonicalize_depth_exceeded');
  if (Array.isArray(value)) return value.map((item) => sortValue(item, d + 1));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key], d + 1);
    return out;
  }
  if (typeof value === 'number' && !isFinite(value)) throw new Error('canonicalize_non_finite_number');
  return value;
}

function canonicalizePayload(envelope) {
  const subset = {};
  for (const field of CONTRACT.idempotency.canonical_payload_fields) {
    subset[field] = Object.prototype.hasOwnProperty.call(envelope, field) ? envelope[field] : null;
  }
  return JSON.stringify(sortValue(subset, 0));
}

function idempotencyIdentity(envelope) {
  return [
    envelope.schema_version,
    envelope.source_system,
    envelope.product_type,
    envelope.external_contract_id,
    envelope.event_type,
    envelope.signing_status,
    envelope.binding_status,
    envelope.document_version || '',
    envelope.document_hash || '',
  ].map((p) => String(p === null || p === undefined ? '' : p)).join('|');
}

const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');
const computeIdempotencyKey = (identity) => CONTRACT.idempotency.key_prefix + sha256Hex(identity);

/* ── service auth (SIGNDEE-HMAC-V1) ───────────────────────────────────────── */

const AUTH = CONTRACT.service_auth;

function buildCanonicalString(parts) {
  return [
    AUTH.version,
    parts.keyId,
    parts.timestamp,
    parts.nonce,
    String(parts.method).toUpperCase(),
    parts.path,
    String(parts.contentSha256).toLowerCase(),
  ].join(AUTH.canonical_string_separator);
}

function signRequest(parts, secret) {
  if (!secret) throw new Error('service auth secret is empty');
  return createHmac('sha256', secret).update(buildCanonicalString(parts)).digest('hex');
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) { timingSafeEqual(bufA, bufA); return false; }
  return timingSafeEqual(bufA, bufB);
}

function buildAuthHeaders(args) {
  const timestamp = String(args.nowSeconds || Math.floor(Date.now() / 1000));
  const nonce = args.nonce;
  const contentSha256 = sha256Hex(args.rawBody);
  const signature = signRequest({
    keyId: args.keyId, timestamp: timestamp, nonce: nonce,
    method: args.method, path: args.path, contentSha256: contentSha256,
  }, args.secret);
  const h = {};
  h[AUTH.headers.key_id] = args.keyId;
  h[AUTH.headers.timestamp] = timestamp;
  h[AUTH.headers.nonce] = nonce;
  h[AUTH.headers.content_sha256] = contentSha256;
  h[AUTH.headers.signature] = signature;
  return h;
}

/* ── compatibility assertion ──────────────────────────────────────────────── */

function assertContractCompatible(peer) {
  if (!peer || peer.schema_version !== SCHEMA_VERSION || peer.contract_checksum !== CONTRACT_CHECKSUM) {
    const err = new Error('esign contract mismatch');
    err.code = 'UNSUPPORTED_SCHEMA_VERSION';
    throw err;
  }
  return true;
}

module.exports = {
  CONTRACT: CONTRACT,
  SCHEMA_VERSION: SCHEMA_VERSION,
  CONTRACT_CHECKSUM: CONTRACT_CHECKSUM,
  isProductType: isProductType,
  isSigningStatus: isSigningStatus,
  isBindingStatus: isBindingStatus,
  isEventType: isEventType,
  isErrorCode: isErrorCode,
  evaluateSigningTransition: evaluateSigningTransition,
  evaluateBindingTransition: evaluateBindingTransition,
  isSigningTransitionAllowed: isSigningTransitionAllowed,
  isBindingTransitionAllowed: isBindingTransitionAllowed,
  normaliseKey: normaliseKey,
  isForbiddenKey: isForbiddenKey,
  detectForbiddenValue: detectForbiddenValue,
  scanForbidden: scanForbidden,
  validateMetadata: validateMetadata,
  missingCompletedEvidence: missingCompletedEvidence,
  canonicalizePayload: canonicalizePayload,
  idempotencyIdentity: idempotencyIdentity,
  computeIdempotencyKey: computeIdempotencyKey,
  sha256Hex: sha256Hex,
  buildCanonicalString: buildCanonicalString,
  signRequest: signRequest,
  constantTimeEquals: constantTimeEquals,
  buildAuthHeaders: buildAuthHeaders,
  assertContractCompatible: assertContractCompatible,
};
