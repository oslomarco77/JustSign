import { readFileSync } from 'node:fs';
import { afterEach,describe,expect,it,vi } from 'vitest';
import Authority from '../api/_employment_authority.js';
import endpoint from '../lib/employment-authority-handler.js';

const SQL=readFileSync(new URL('../api/employment_signed_evidence_authority.sql',import.meta.url),'utf8');
const EMPLOYMENT='94000000-0000-4000-8000-000000000001';
const VERSION='94000000-0000-4000-8000-000000000002';
const REFERENCE=`sde_emp_${'a'.repeat(64)}`;

afterEach(()=>vi.restoreAllMocks());

describe('Employment signed-evidence API authority',()=>{
  it('accepts only minimized issue and resolve authority selectors',()=>{
    expect(Authority.signedEvidenceRequest({action:'issue_signed_evidence',employment_id:EMPLOYMENT,version_id:VERSION}))
      .toEqual({action:'issue_signed_evidence',employmentId:EMPLOYMENT,versionId:VERSION});
    expect(Authority.signedEvidenceRequest({action:'resolve_signed_evidence',signed_document_reference:REFERENCE}))
      .toEqual({action:'resolve_signed_evidence',signedDocumentReference:REFERENCE});
    for(const forged of [{completed:true},{document_hash:'sha256:fake'},{signed_at:'now'},
      {signer_count:2},{signer_role:'employee'},{signer_evidence_manifest:[]}]){
      expect(()=>Authority.signedEvidenceRequest({action:'issue_signed_evidence',employment_id:EMPLOYMENT,
        version_id:VERSION,...forged})).toThrow();
    }
    expect(()=>Authority.signedEvidenceRequest({action:'resolve_signed_evidence',
      signed_document_reference:`sde_${'a'.repeat(64)}`})).toThrow('invalid_signed_document_reference');
  });

  it('sends only identifiers to issue and only the opaque reference to resolve',async()=>{
    const calls=[];
    vi.stubGlobal('fetch',vi.fn(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);
      return{ok:true,json:async()=>({created:true,signed_document_reference:REFERENCE})};}));
    await endpoint.persistEmploymentSignedEvidence(Authority.signedEvidenceRequest({
      action:'issue_signed_evidence',employment_id:EMPLOYMENT,version_id:VERSION}));
    await endpoint.persistEmploymentSignedEvidence(Authority.signedEvidenceRequest({
      action:'resolve_signed_evidence',signed_document_reference:REFERENCE}));
    expect(calls[0][0]).toContain('employment_authority_issue_signed_evidence');
    expect(calls[0][1]).toEqual({p_employment_id:EMPLOYMENT,p_version_id:VERSION});
    expect(calls[1][0]).toContain('employment_authority_resolve_signed_evidence');
    expect(calls[1][1]).toEqual({p_signed_document_reference:REFERENCE});
    expect(JSON.stringify(calls)).not.toMatch(/capability|signature_input|manifest|completed_at/);
  });

  it('sanitizes eligibility and lookup failures',async()=>{
    for(const [message,status,code] of [
      ['employment_signed_evidence_not_eligible',403,'signed_evidence_not_eligible'],
      ['employment_signed_evidence_not_found',404,'signed_evidence_not_found']]){
      vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({message})})));
      const request=message.endsWith('not_found')
        ?Authority.signedEvidenceRequest({action:'resolve_signed_evidence',signed_document_reference:REFERENCE})
        :Authority.signedEvidenceRequest({action:'issue_signed_evidence',employment_id:EMPLOYMENT,version_id:VERSION});
      await expect(endpoint.persistEmploymentSignedEvidence(request)).rejects.toMatchObject({publicStatus:status,publicCode:code});
    }
  });
});

describe('Employment signed-evidence database contract',()=>{
  it('binds one immutable artifact to the exact A.1 version and hash',()=>{
    expect(SQL).toMatch(/unique \(employment_id,version_id\)/);
    expect(SQL).toMatch(/foreign key \(employment_id,version_id,document_hash\)[\s\S]*employment_authority_versions\(employment_id,id,document_hash\)/);
    expect(SQL).toMatch(/before update or delete[\s\S]*employment_signed_evidence_authorities/);
    expect(SQL).toMatch(/signed_document_reference~'\^sde_emp_/);
  });

  it('derives and validates exact required signer completion and action bindings',()=>{
    expect(SQL).toMatch(/required_count<>2[\s\S]*employer_count<>1[\s\S]*employee_count<>1/);
    expect(SQL).toContain('SIGNDEE-EMPLOYMENT-SIGNING-ACTION-V1');
    expect(SQL).toContain('signdee.employment.signing-consent.v1');
    expect(SQL).toMatch(/max\(signed_at\) filter\(where is_required\)/);
    expect(SQL).toMatch(/jsonb_agg\([\s\S]*order by signer_role,id/);
    expect(SQL).toMatch(/signer_evidence_set_digest=extensions\.digest/);
  });

  it('keeps direct tables closed and exposes only service-role RPCs',()=>{
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.employment_signed_evidence_authorities from anon,authenticated,service_role/);
    expect(SQL).toMatch(/grant execute on function public\.employment_authority_issue_signed_evidence\(uuid,uuid\) to service_role/);
    expect(SQL).toMatch(/grant execute on function public\.employment_authority_resolve_signed_evidence\(text\) to service_role/);
    expect(SQL).not.toMatch(/raw_capability|capability_digest|signature_input[^_]/);
  });
});
