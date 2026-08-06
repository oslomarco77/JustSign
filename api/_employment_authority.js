'use strict';

const { createHash } = require('node:crypto');
const Templates = require('./_emp_templates.js');

const CANONICAL_SCHEMA = 'signdee.employment.document.v1';
const MAX_CANONICAL_BYTES = 512 * 1024;
const PRESENTATION_TEXT = Object.freeze({
  introduction: Templates.EMP_INTRO,
  closing: Templates.EMP_CLOSING,
  jobAppendixTitle: 'เอกสารแนบท้าย ก. — รายละเอียดตำแหน่งงาน',
  jobAppendixFooter: 'เอกสารแนบท้ายนี้เป็นส่วนหนึ่งของหนังสือสัญญาจ้าง',
  identityAppendixTitle: 'เอกสารแนบท้าย ข. — สำเนาบัตรประจำตัวประชาชนของคู่สัญญา',
  identityCertification: 'รับรองสำเนาถูกต้อง',
  identityPurpose: 'ใช้เพื่อประกอบหนังสือสัญญาจ้างเท่านั้น',
  identityRetention: 'สำเนาเอกสารแสดงตนนี้ใช้เพื่อประกอบหนังสือสัญญาจ้างเท่านั้น และถูกลบออกจากระบบอัตโนมัติภายใน 60 วัน',
  juristicCertificateTitle: 'ภาคผนวก — หนังสือรับรองนิติบุคคล',
  juristicCertificateRetention: 'รูปเอกสารแสดงตนถูกลบออกจากระบบอัตโนมัติภายใน 60 วัน',
});

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('non_plain_object');
    return '{' + Object.keys(value).sort().map((key) =>
      canonicalize(key) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  throw new TypeError('unsupported_canonical_type');
}

function text(value, max = 30000) {
  const result = String(value == null ? '' : value).normalize('NFC').trim();
  if (result.length > max) throw new TypeError('invalid_employment_document');
  return result;
}

function nullableText(value, max = 30000) {
  const result = text(value, max);
  return result || null;
}

function orderedStrings(value, maxItems, maxLength = 30000) {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError('invalid_employment_document');
  return value.map((item) => text(item, maxLength));
}

function digestReferencedImage(value) {
  if (value === undefined || value === null || value === '') return null;
  const source = String(value);
  if (source.length > 15 * 1024 * 1024) throw new TypeError('invalid_employment_image');
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(source);
  if (!match) throw new TypeError('invalid_employment_image');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/,'') !== match[2].replace(/=+$/,'')) {
    throw new TypeError('invalid_employment_image');
  }
  return { media_type: match[1].toLowerCase().replace('jpg','jpeg'),
    sha256: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length };
}

function documentDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid_employment_document_date');
  return date.toISOString().slice(0, 10);
}

function ageOnDate(value, referenceDate) {
  if (value === undefined || value === null || value === '') return null;
  const birth = new Date(value);
  const reference = new Date(referenceDate + 'T00:00:00.000Z');
  if (!Number.isFinite(birth.getTime()) || !Number.isFinite(reference.getTime())) {
    throw new TypeError('invalid_employment_birth_date');
  }
  let age = reference.getUTCFullYear() - birth.getUTCFullYear();
  const month = reference.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && reference.getUTCDate() < birth.getUTCDate())) age--;
  if (age < 0 || age >= 130) throw new TypeError('invalid_employment_birth_date');
  return age;
}

function juristic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    name: nullableText(value.name, 300),
    registration_number: nullableText(value.regNo || value.registration_number, 80),
    authorized_signer: nullableText(value.signer || value.authorized_signer, 300),
    authorized_signer_title: nullableText(value.signerTitle || value.authorized_signer_title, 200),
    address_number: nullableText(value.addrNo || value.address_number, 100),
    road: nullableText(value.road, 300),
    subdistrict: nullableText(value.subdistrict, 300),
    district: nullableText(value.district, 300),
    province: nullableText(value.province, 300),
  };
}

function party(value, card, role, referenceDate) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid_employment_party');
  }
  const raw = card && typeof card === 'object' && !Array.isArray(card) && card.ocr_raw
    && typeof card.ocr_raw === 'object' ? card.ocr_raw : {};
  const isJuristic = Boolean(value.jur);
  return {
    role,
    identity_type: isJuristic ? 'juristic' : 'individual',
    display_name: isJuristic ? null : text(value.name, 300),
    national_id: isJuristic ? null : nullableText(value.id13, 40),
    address: isJuristic ? null : nullableText(value.address, 1000),
    displayed_age: isJuristic ? null : ageOnDate(raw.date_of_birth, referenceDate),
    juristic: juristic(value.jur),
    identity_document: digestReferencedImage(card && card.image),
    juristic_certificate: digestReferencedImage(card && card.cert_image),
  };
}

function clauseList(clauses) {
  if (!clauses || typeof clauses !== 'object' || Array.isArray(clauses)) {
    throw new TypeError('invalid_employment_clauses');
  }
  const count = clauses.c19 ? 19 : 18;
  return Array.from({ length: count }, (_, index) => {
    const value = text(clauses['c' + (index + 1)]);
    if (!value) throw new TypeError('invalid_employment_clause_' + (index + 1));
    return value;
  });
}

function buildEmploymentSourceDocument(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('invalid_employment_row');
  const jd = row.jd && typeof row.jd === 'object' && !Array.isArray(row.jd) ? row.jd : {};
  const clauses = clauseList(row.clauses);
  const referenceDate = documentDate(row.created_at);
  return {
    document_header: {
      title: 'หนังสือสัญญาจ้าง',
      contract_number: text(row.contract_no, 100),
      document_date: referenceDate,
      place_of_execution: nullableText((row.party_a && row.party_a.jur
        && [row.party_a.jur.addrNo, row.party_a.jur.road, row.party_a.jur.subdistrict,
          row.party_a.jur.district, row.party_a.jur.province].filter(Boolean).join(' '))
        || (row.party_a && row.party_a.address), 1000),
    },
    parties: [party(row.party_a, row.a_card, 'employer', referenceDate),
      party(row.party_b, row.b_card, 'employee', referenceDate)],
    introduction: PRESENTATION_TEXT.introduction,
    clauses,
    appendices: {
      job_description: {
        title: PRESENTATION_TEXT.jobAppendixTitle,
        position: text(row.position_th, 300),
        responsibilities: orderedStrings(jd.responsibilities || [], 8, 1000),
        qualifications: orderedStrings(jd.qualifications || [], 8, 1000),
        performance_indicators: orderedStrings(jd.kpis || [], 8, 1000),
        footer: PRESENTATION_TEXT.jobAppendixFooter,
      },
      identity_documents: {
        title: PRESENTATION_TEXT.identityAppendixTitle,
        certification: PRESENTATION_TEXT.identityCertification,
        purpose: PRESENTATION_TEXT.identityPurpose,
        retention_notice: PRESENTATION_TEXT.identityRetention,
        employer_document: digestReferencedImage(row.a_card && row.a_card.image),
        employee_document: digestReferencedImage(row.b_card && row.b_card.image),
      },
      juristic_certificate: row.a_card && row.a_card.cert_image ? {
        title: PRESENTATION_TEXT.juristicCertificateTitle,
        purpose: PRESENTATION_TEXT.identityPurpose,
        retention_notice: PRESENTATION_TEXT.juristicCertificateRetention,
        document: digestReferencedImage(row.a_card.cert_image),
      } : null,
    },
    closing: PRESENTATION_TEXT.closing,
  };
}

function buildCanonicalEmploymentDocument(row, authority, sourceDocument) {
  const versionNumber = Number(authority.versionNumber);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new TypeError('invalid_version_number');
  const source = sourceDocument || buildEmploymentSourceDocument(row);
  const document = {
    canonical_schema: CANONICAL_SCHEMA,
    authority: {
      employment_id: text(authority.employmentId, 64),
      legacy_contract_id: text(row.id, 64),
      version_id: text(authority.versionId, 64),
      version_number: versionNumber,
    },
    ...source,
  };

  const canonical = canonicalize(document);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_BYTES) throw new TypeError('employment_document_too_large');
  return { document, canonical, hash: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

function versionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'action,legacy_contract_id'
    || input.action !== 'issue_version' || typeof input.legacy_contract_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.legacy_contract_id)) {
    throw new TypeError('invalid_request');
  }
  return { legacyContractId: input.legacy_contract_id.toLowerCase() };
}

module.exports = { CANONICAL_SCHEMA, MAX_CANONICAL_BYTES, PRESENTATION_TEXT, canonicalize,
  buildEmploymentSourceDocument, buildCanonicalEmploymentDocument, digestReferencedImage, versionRequest };
