# NDA authority foundation (SD-407A.2A)

This foundation is intentionally separate from legacy `nda_contracts`. Legacy
rows and browser-written signing state are not authoritative and are not
backfilled or reinterpreted by this migration.

## Local review and later rollout

`nda_authority_foundation.sql` is an additive migration intended for review. It
was not applied to any remote database by this ticket. A later authorized
rollout must apply it before enabling `/api/nda-authority` and must configure:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `NDA_AUTHORITY_API_KEY` (a server-to-server credential)

The endpoint accepts only `POST` action `create_initial_version` authenticated
by `x-signdee-authority-key`. It returns each random signing capability exactly
once to that privileged caller; only SHA-256 capability digests are sent to and
stored by the database. Responses are marked `Cache-Control: no-store`.

The database function creates the authority aggregate, immutable version, two
backend-mapped signer records, capability digests, and initial audit events in
one transaction. Exact canonical UTF-8 text is retained and the database checks
that its SHA-256 matches `document_hash`.

Direct table privileges are revoked from `anon`, `authenticated`, and
`service_role`. The service role may execute only the reviewed security-definer
authority functions; it cannot bypass the intended boundary with direct table
mutation.

## Compatibility boundary

The current `index-nda.html` flow still writes legacy `nda_contracts` directly.
It is not connected to this endpoint because a browser cannot hold the internal
authority key. Do not weaken RLS or expose that key to restore compatibility.
Migrating the browser to mediated draft creation and implementing atomic signing
and capability consumption are follow-up work. No Workspace integration,
signature submission, completion, PDF, certificate, or download behavior is
implemented here.

An issued version may be superseded only by a different issued version of the
same NDA with a strictly greater `version_number`. This ordering prevents
self-reference, replacement by an older/same version, cross-NDA replacement,
and replacement cycles. Invalidation atomically revokes active capabilities;
canonical payload and hash fields remain trigger-protected and immutable.

## Presented-document coverage map

This mapping was traced from `api/myip.js` (`NDA_T`, `partyDetailLine`,
`buildNdaClauses`, `handleNdaGenerate`) through `index-nda.html` (`_jurText`,
`partyBlock`, `renderDoc`). A displayed hash prefix is derived from the canonical
hash, and blank signature lines are not independent pre-signing material.

| Actual presented value | Canonical document field | Validation rule | Hash coverage test |
|---|---|---|---|
| Thai/English NDA title and selected type | `title`, `nda_type` | required bounded strings | material mutation loop |
| Introductory agreement text | `document_intro` | required; max 5,000 | material mutation loop |
| Closing/read-and-understood text | `document_closing` | required; max 5,000 | material mutation loop |
| “ทำที่” execution location | `place_of_execution` | required; max 1,000 | material mutation loop |
| Displayed Thai date and effective date | `display_date`, `effective_date` | required bounded strings | material mutation loop |
| Discloser and recipient roles | `parties[].role` | backend constants | signer authority test |
| Individual name, age, ID, address, phone | `parties[].identity.*` | allowlisted fields; name required; age 1–129 | party shape and mutation tests |
| Juristic entity, registration, representative, registry/certificate/POA dates, structured address | `parties[].identity.juristic.*` | required entity, registration, representative and location fields; bounded optional dates/road/office | juristic shape and mutation tests |
| Confidential-information subject/scope and permitted purpose generated from user purpose | `confidential_information_scope`, `permitted_purpose`; exact final wording also in clause 1 | required; max 5,000 | material mutation loop and clause test |
| Duration, start and end dates | `term.*`; exact final wording also in clause 7 | integer 1–1,200 and required dates | material mutation loop and clause test |
| Obligations, exclusions, return/termination, remedies, and all generated legal text | ordered `clauses[0..7]` | exactly eight required strings; max 30,000 each | every clause index mutated independently |
| Governing law and jurisdiction | `governing_law`, `jurisdiction` | bounded optional strings; currently empty because the UI presents neither | material mutation loop |
| Material options and exceptions | `material_options`, `exceptions` | canonical object; evidence/secret/image keys rejected | mutation and prohibited-material tests |
| Additional terms | `additional_terms` | bounded optional string; currently empty because the UI presents none | material mutation loop |
| Authority/version/signer references | IDs and `version_number` | backend-generated | authority identifier test |

Signatures, consent evidence, signing timestamps, certificate data, audit data,
and completed-document evidence are deliberately excluded from the pre-signing
hash.

## Transactional signing extension (SD-407A.2B)

`nda_authority_signing.sql` is applied after the foundation migration. The
public endpoint accepts `POST` action `sign` with the three authority UUIDs, a
one-time capability, and explicit `consent: true`. This signer operation does
not use the internal creation credential: possession of the exact random
capability is the narrowly scoped authorization. The server validates its
base64url encoding, derives SHA-256, discards the plaintext, and sends only the
digest to the reviewed database RPC. Sign requests are limited to 4 KiB and
responses remain `no-store`.

The signing RPC locks and revalidates the exact issued version, version-bound
signer, and digest-bound capability. It records a database timestamp, consent
schema, and SHA-256 evidence digest; consumes the capability; and appends
`signer.signed` and `capability.consumed` audit events in the same transaction.
No handwritten signature, image, base64 data, request body, capability, or
capability digest is audit metadata.

Existing signers become required by default. A version completes only when it
has at least one required signer and no required signer on that exact NDA and
version remains pending. The final signer transaction moves that version and
its parent authority contract to `completed` and appends version/authority
completion events. `completed`, `void`, and `superseded` versions are terminal;
canonical payload and hash remain immutable. Row locks, status constraints,
the one-row signer state, and the capability state transition make repeated or
concurrent submissions conflict without partial state.

Direct authority-table access remains revoked from `anon`, `authenticated`,
and `service_role`; only `service_role` may execute the security-definer signing
RPC. This extension does not connect the legacy browser signing UI, Workspace,
Claim/Redeem, PDFs, certificates, downloads, invitations, or notifications.
