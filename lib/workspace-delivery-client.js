'use strict';

/**
 * SD-407C — outbound delivery of authoritative workspace acceptance.
 *
 * JustSign is the source of authority; Sign Dee is the receiver. Until now
 * nothing in this repository ever called the receiver, so the last hop of the
 * integration was manual. This module is that hop and nothing more.
 *
 * Scope discipline — what this module deliberately does NOT do:
 *   • it never creates a binding or a signed-evidence reference; it only
 *     delivers two identifiers that already exist and are already durable
 *   • it never retries on its own. Retry is the caller's decision, so a
 *     transient failure can never fan out into duplicate Workspace effects
 *   • it never accepts or transmits workspace_id. Sign Dee resolves that from
 *     its own call back into JustSign, which is what keeps
 *     "service authentication != workspace authorization" true
 *   • it never logs. Errors carry a stable code and no detail that could leak
 *     a secret, a signature, the receiver host, or an evidence reference
 *
 * The wire protocol is not defined here. Every constant comes from the
 * committed generated contract, so this file cannot drift from Sign Dee.
 */

const { randomBytes } = require('node:crypto');

const Contract = require('../api/_esign_contract.generated.js');

const AUTH = Contract.CONTRACT.service_auth;
const KEY_ID_PATTERN = new RegExp(AUTH.key_id_pattern);
const NONCE_PATTERN = new RegExp(AUTH.nonce_pattern);
const RETRYABLE_CODES = new Set(Contract.CONTRACT.retryable_error_codes);

/** Receiver path per product. Sign Dee owns these; they are not configurable. */
const RECEIVER_PATHS = Object.freeze({
  nda: '/api/integration/justsign/nda-workspace-acceptance',
  employment: '/api/integration/justsign/employment-workspace-acceptance',
});

/** Evidence reference shape differs per product and is enforced both sides. */
const EVIDENCE_PATTERNS = Object.freeze({
  nda: /^sde_[0-9a-f]{64}$/,
  employment: /^sde_emp_[0-9a-f]{64}$/,
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_RESPONSE_BYTES = 8192;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * A delivery outcome that is not success.
 *
 * `retryable` is the only signal the caller needs: true means the same
 * binding_id and signed_document_reference may be sent again unchanged.
 * The message is a fixed code — never interpolated with response content.
 */
class DeliveryError extends Error {
  constructor(code, retryable) {
    super(code);
    this.name = 'DeliveryError';
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

/**
 * 24 random bytes → 32 base64url characters, inside the contract's
 * ^[A-Za-z0-9_-]{16,64}$. Fresh per HTTP attempt: the receiver consumes each
 * nonce exactly once, so reusing one turns a legitimate retry into a
 * REPLAY_DETECTED.
 */
function newNonce() {
  return randomBytes(24).toString('base64url');
}

/**
 * Reads and validates configuration. Throws before any network activity, and
 * never includes a value in the error — only the variable name.
 */
function readConfig(env) {
  const source = env || process.env;

  const baseUrl = String(source.SIGNDEE_RECEIVER_BASE_URL || '').trim().replace(/\/+$/, '');
  const keyId = String(source.SIGNDEE_RECEIVER_HMAC_KEY_ID || '').trim();
  const secret = String(source.SIGNDEE_RECEIVER_HMAC_SECRET || '').trim();

  if (!baseUrl || !keyId || !secret) {
    throw new DeliveryError('delivery_not_configured', false);
  }

  // A malformed base URL must fail here rather than inside fetch, where the
  // thrown message would contain the URL.
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (_) {
    throw new DeliveryError('delivery_misconfigured', false);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DeliveryError('delivery_misconfigured', false);
  }

  // Invariant: validate the key id against the committed contract pattern
  // before signing. Sending a malformed key id would leak one bit about the
  // configuration for no benefit — the receiver would reject it anyway.
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new DeliveryError('delivery_misconfigured', false);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = source.SIGNDEE_RECEIVER_TIMEOUT_MS;
  if (rawTimeout !== undefined && String(rawTimeout).trim() !== '') {
    const candidate = Number(String(rawTimeout).trim());
    if (!Number.isInteger(candidate) || candidate < 1000 || candidate > 60000) {
      throw new DeliveryError('delivery_misconfigured', false);
    }
    timeoutMs = candidate;
  }

  return { baseUrl, keyId, secret, timeoutMs };
}

/**
 * Validates the two locators. Anything else in the input is a programming
 * error and is rejected — in particular workspace_id, which must never reach
 * the wire from this side.
 */
function buildPayload(product, input) {
  if (!Object.prototype.hasOwnProperty.call(RECEIVER_PATHS, product)) {
    throw new DeliveryError('invalid_product', false);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeliveryError('invalid_delivery_input', false);
  }

  const allowed = new Set(['binding_id', 'signed_document_reference']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new DeliveryError('invalid_delivery_input', false);
  }

  const bindingId = input.binding_id;
  const reference = input.signed_document_reference;

  if (typeof bindingId !== 'string' || !UUID_PATTERN.test(bindingId)) {
    throw new DeliveryError('invalid_binding_id', false);
  }
  if (typeof reference !== 'string' || !EVIDENCE_PATTERNS[product].test(reference)) {
    throw new DeliveryError('invalid_signed_document_reference', false);
  }

  // Key order is fixed so the serialised bytes are deterministic.
  return { binding_id: bindingId.toLowerCase(), signed_document_reference: reference };
}

/** Retryable if the transport failed or the receiver said it may be retried. */
function classifyStatus(status, code) {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;
  return false;
}

/**
 * Delivers one already-authoritative acceptance to the Sign Dee receiver.
 *
 * Resolves with { created, binding_id, workspace_id, external_contract_id }.
 * Rejects with a DeliveryError carrying `code` and `retryable`.
 *
 * `deps` exists only so tests can supply a stub fetch and a fixed clock. It is
 * never used in production, where the Node built-ins are correct.
 */
async function deliverWorkspaceAcceptance(product, input, deps) {
  const options = deps || {};
  const config = readConfig(options.env);
  const payload = buildPayload(product, input);

  const path = RECEIVER_PATHS[product];

  // Sign the exact bytes that are sent. Serialise once, hash that string, and
  // hand the same string to fetch — re-serialising would change key order or
  // spacing and silently invalidate the signature.
  const rawBody = JSON.stringify(payload);

  const nonce = typeof options.nonce === 'string' ? options.nonce : newNonce();
  if (!NONCE_PATTERN.test(nonce)) {
    throw new DeliveryError('delivery_misconfigured', false);
  }

  const headers = Contract.buildAuthHeaders({
    keyId: config.keyId,
    secret: config.secret,
    method: 'POST',
    path,
    rawBody,
    nonce,
    nowSeconds: typeof options.nowSeconds === 'number' ? options.nowSeconds : undefined,
  });
  headers['content-type'] = 'application/json';
  headers.accept = 'application/json';

  const doFetch = options.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response;
  try {
    response = await doFetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
    });
  } catch (error) {
    // AbortError and any transport failure are both worth another attempt with
    // the same identity. The underlying error is never surfaced: its message
    // can contain the full receiver URL.
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
    throw new DeliveryError(aborted ? 'delivery_timeout' : 'delivery_network_error', true);
  } finally {
    clearTimeout(timer);
  }

  const status = Number(response.status);

  // Reject an oversized body before reading it where the server declares it.
  const declaredLength = Number(response.headers && response.headers.get
    ? response.headers.get('content-length')
    : null);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new DeliveryError('delivery_response_too_large', false);
  }

  const contentType = String(
    (response.headers && response.headers.get ? response.headers.get('content-type') : '') || '',
  ).toLowerCase();
  if (!contentType.split(';', 1)[0].trim().startsWith('application/json')) {
    throw new DeliveryError('delivery_invalid_response', classifyStatus(status, null));
  }

  let text;
  try {
    text = await response.text();
  } catch (_) {
    throw new DeliveryError('delivery_network_error', true);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new DeliveryError('delivery_response_too_large', false);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // The raw body is deliberately not attached — it is attacker-influenced.
    throw new DeliveryError('delivery_invalid_response', classifyStatus(status, null));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeliveryError('delivery_invalid_response', classifyStatus(status, null));
  }

  if (status !== 200 || parsed.ok !== true) {
    const code = typeof parsed.code === 'string' ? parsed.code : null;
    throw new DeliveryError(
      code && /^[A-Z_]{3,64}$/.test(code) ? `receiver_${code.toLowerCase()}` : 'delivery_rejected',
      classifyStatus(status, code),
    );
  }

  if (
    typeof parsed.external_contract_id !== 'string'
    || !UUID_PATTERN.test(parsed.external_contract_id)
    || typeof parsed.created !== 'boolean'
    || parsed.binding_id !== payload.binding_id
  ) {
    throw new DeliveryError('delivery_invalid_response', false);
  }

  return {
    created: parsed.created,
    binding_id: parsed.binding_id,
    workspace_id: typeof parsed.workspace_id === 'string' ? parsed.workspace_id : null,
    external_contract_id: parsed.external_contract_id,
  };
}

module.exports = {
  DeliveryError,
  MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  RECEIVER_PATHS,
  EVIDENCE_PATTERNS,
  newNonce,
  readConfig,
  buildPayload,
  classifyStatus,
  deliverWorkspaceAcceptance,
};
