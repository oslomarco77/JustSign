import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import A from '../api/_employment_authority.js';
import endpoint from '../api/employment-authority.js';

const SQL = readFileSync(new URL('../api/employment_authority_version.sql', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index-emp.html', import.meta.url), 'utf8');
const MYIP = readFileSync(new URL('../api/myip.js', import.meta.url), 'utf8');
const ids = { employmentId: '81000000-0000-4000-8000-000000000001', versionId: '81000000-0000-4000-8000-000000000002' };

function row() {
  return {
    id: '81000000-0000-4000-8000-000000000003', contract_no: 'EMP-1',
    created_at: '2026-08-06T00:00:00Z', updated_at: '2026-08-06T01:00:00Z', paid_at: '2026-08-06T00:30:00Z',
    position_th: 'วิศวกร', position_en: 'Engineer', position_code: 'eng', employment_type: 'full_time',
    salary: 30000, allowance: 1000, bonus_text: 'ตามผลงาน', payday_text: 'วันที่ 5', probation_days: 119,
    work_days: ['mon', 'tue', 'wed', 'thu', 'fri'], work_start: '09.00', work_end: '18.00', work_hours: 8,
    work_location: 'สำนักงานใหญ่', client_site: null, start_date: '2026-09-01', end_date: null,
    restrict_level: 'none', restrict_months: 12, restrict_area: null,
    party_a: { name: 'ผู้แทน ก', id13: '1100000000000', address: 'ที่อยู่ผู้แทน', phone: '020000000',
      jur: { name: 'บริษัท ก', regNo: '0100000000001', signer: 'นาย ก', signerTitle: 'กรรมการ',
        regOffice: 'ไม่แสดง', certDate: '2020-01-01', poaDate: '2020-02-01', addrNo: '1', subdistrict: 'สีลม', district: 'บางรัก', province: 'กรุงเทพ' } },
    party_b: { name: 'นาย ข', id13: '1100000000001', address: 'นนทบุรี', phone: '0800000000', issue: '2020-01-01', expiry: '2028-01-01' },
    a_card: { image: 'data:image/png;base64,QUFB', cert_image: 'data:image/png;base64,Q0VSVA==', seal_image: 'data:image/png;base64,U0VBTA==', ocr_raw: {} },
    b_card: { image: 'data:image/png;base64,QkJC', ocr_raw: { date_of_birth: '1990-01-01' } },
    jd: { responsibilities: ['พัฒนาระบบ'], qualifications: ['ปริญญาตรี'], kpis: ['ส่งมอบตรงเวลา'], _source: 'ai' },
    clauses: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`c${i + 1}`, `${i + 1}. ข้อสัญญา`])),
    status: 'generated', payment_completed: true, payment_ref: 'operational', creator_token: 'token',
    a_signature: null, a_signed_at: null, a_sign_ip: null,
  };
}

function build(r = row(), authority = ids) {
  return A.buildCanonicalEmploymentDocument(r, { ...authority, versionNumber: 1 });
}

afterEach(() => vi.restoreAllMocks());

describe('Employment canonical document authority', () => {
  it('is deterministic across key order, Unicode NFC, and equivalent image encodings', () => {
    const x = row();
    const y = Object.fromEntries(Object.entries(x).reverse());
    y.party_b.name = 'นาย เ\u0301'; x.party_b.name = 'นาย é';
    y.b_card.image = 'data:image/png;base64,QkJC=';
    expect(build(x)).toEqual(build(y));
    expect(build(x).hash).toBe(createHash('sha256').update(build(x).canonical).digest('hex'));
  });

  it('uses backend created_at only and derives displayed age on that immutable date', () => {
    const x = row();
    const first = build(x);
    x.paid_at = '2030-01-01T00:00:00Z';
    expect(build(x).hash).toBe(first.hash);
    expect(first.document.document_header.document_date).toBe('2026-08-06');
    expect(first.document.parties[1].displayed_age).toBe(36);
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    expect(build(x)).toEqual(first);
    expect(HTML).not.toContain("localStorage.getItem('emp_paid_at_" );
    expect(MYIP).toMatch(/document_date:\s*referenceDate/);
  });

  it('changes for every presented dynamic material family', () => {
    const mutations = [
      r => { r.contract_no = 'EMP-2'; }, r => { r.created_at = '2026-08-07T00:00:00Z'; },
      r => { r.party_a.jur.name = 'บริษัทใหม่'; }, r => { r.party_a.jur.regNo = '0100000000002'; },
      r => { r.party_a.jur.signer = 'กรรมการใหม่'; }, r => { r.party_a.jur.signerTitle = 'ผู้รับมอบอำนาจ'; },
      r => { r.party_a.jur.addrNo = '2'; }, r => { r.party_b.name = 'นาย ค'; },
      r => { r.party_b.id13 = '1100000000002'; }, r => { r.party_b.address = 'กรุงเทพ'; },
      r => { r.b_card.ocr_raw.date_of_birth = '1991-01-01'; }, r => { r.clauses.c7 = '7. เนื้อหาใหม่'; },
      r => { r.position_th = 'หัวหน้าวิศวกร'; }, r => { r.jd.responsibilities[0] = 'งานใหม่'; },
      r => { r.jd.qualifications[0] = 'คุณสมบัติใหม่'; }, r => { r.jd.kpis[0] = 'ตัวชี้วัดใหม่'; },
      r => { r.b_card.image = 'data:image/png;base64,Q0ND'; }, r => { r.a_card.cert_image = 'data:image/png;base64,TkVX'; },
    ];
    for (const mutate of mutations) { const changed = row(); mutate(changed); expect(build(changed).hash).not.toBe(build().hash); }
  });

  it('excludes unrendered and operational encodings, including renderer-default source fields', () => {
    const changed = row();
    Object.assign(changed, { paid_at: '2030-01-01Z', status: 'completed', payment_completed: false,
      payment_ref: 'changed', creator_token: 'changed', a_signature: 'data:image/png;base64,SIG',
      a_signed_at: '2026-08-07Z', a_sign_ip: '127.0.0.1', position_code: 'changed', position_en: 'Changed',
      employment_type: null, salary: 99999, allowance: null, payday_text: null, work_start: null,
      work_end: null, work_hours: null, restrict_months: null });
    changed.party_a.name = 'unrendered representative OCR name'; changed.party_a.phone = 'changed';
    changed.party_a.jur.regOffice = 'changed'; changed.party_a.jur.certDate = 'changed'; changed.party_a.jur.poaDate = 'changed';
    changed.party_b.phone = 'changed'; changed.party_b.issue = 'changed'; changed.party_b.expiry = 'changed';
    changed.a_card.seal_image = 'data:image/png;base64,TkVXU0VBTA==';
    expect(build(changed).hash).toBe(build().hash);
  });

  it('defines static presented appendix and closing semantics in the canonical payload', () => {
    const document = build().document;
    expect(document.closing).toBe(A.PRESENTATION_TEXT.closing);
    expect(document.appendices.identity_documents.purpose).toBe(A.PRESENTATION_TEXT.identityPurpose);
    expect(document.appendices.identity_documents.retention_notice).toBe(A.PRESENTATION_TEXT.identityRetention);
    expect(document.appendices.juristic_certificate.document.sha256).toHaveLength(64);
  });

  it('gives separate version identities separate final hashes', () => {
    const one = build(), two = build(row(), { ...ids, versionId: '81000000-0000-4000-8000-000000000004' });
    expect(two.document.authority.version_id).not.toBe(one.document.authority.version_id);
    expect(two.hash).not.toBe(one.hash);
  });
});

describe('Employment version database authority', () => {
  it('keeps legacy rows non-authoritative and authority tables additive', () => {
    expect(SQL).toMatch(/legacy_contract_id uuid not null unique references public\.emp_contracts/);
    expect(SQL).not.toMatch(/insert into public\.employment_authority_contracts\s*\([^;]+\)\s*select/i);
  });
  it('binds prepared canonical material and schema to issuance', () => {
    expect(SQL).toMatch(/digest\(convert_to\(source_canonical_payload,'UTF8'\),'sha256'\)=source_content_digest/);
    expect(SQL).toMatch(/p_canonical_document-'canonical_schema'-'authority'\)<>v\.source_canonical_payload::jsonb/);
    expect(SQL).toMatch(/unique\(employment_id,canonical_schema,source_content_digest\)/);
  });
  it('preserves immutable issued state and restricted table authority', () => {
    expect(SQL).toContain('immutable employment authority version');
    expect(SQL).toMatch(/old\.source_canonical_payload<>new\.source_canonical_payload/);
    expect(SQL).toMatch(/revoke all on public\.employment_authority_contracts,public\.employment_authority_versions from anon,authenticated,service_role/);
  });
});

describe('Employment authority API', () => {
  it('rejects browser-supplied hash and lifecycle authority', () => {
    expect(() => A.versionRequest({ action: 'issue_version', legacy_contract_id: row().id, document_hash: 'fake' })).toThrow('invalid_request');
    expect(() => A.versionRequest({ action: 'issue_version', legacy_contract_id: row().id, lifecycle_status: 'issued' })).toThrow('invalid_request');
  });
  it('prepares exact canonical source bytes and persists the backend final hash', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push([url, options]);
      if (String(url).includes('/emp_contracts?')) return { ok: true, json: async () => [row()] };
      if (String(url).includes('prepare_version')) return { ok: true, json: async () => ({ employment_id: ids.employmentId, version_id: ids.versionId, version_number: 1, lifecycle_status: 'draft' }) };
      return { ok: true, json: async () => ({ created: true }) };
    }));
    await endpoint.issueEmploymentVersion(row().id);
    const prepared = JSON.parse(calls[1][1].body), issued = JSON.parse(calls[2][1].body);
    expect(prepared.p_source_content_digest).toBe(createHash('sha256').update(prepared.p_source_canonical_payload).digest('hex'));
    expect(prepared.p_canonical_schema).toBe(A.CANONICAL_SCHEMA);
    expect(issued.p_document_hash).toBe(createHash('sha256').update(issued.p_canonical_payload).digest('hex'));
  });
});
