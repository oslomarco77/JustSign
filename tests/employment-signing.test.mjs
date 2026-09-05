import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Authority from '../api/_employment_authority.js';
import authorityEndpoint from '../lib/employment-authority-handler.js';
import signingEndpoint from '../lib/employment-sign-handler.js';

const SQL=readFileSync(new URL('../api/employment_authority_signing.sql',import.meta.url),'utf8');
const VERSION='91000000-0000-4000-8000-000000000001';
const CAPABILITY='A'.repeat(43);

afterEach(()=>vi.restoreAllMocks());

describe('Employment A.2 request authority',()=>{
  it('accepts only capability, intent input, and consent at the signing boundary',()=>{
    expect(Authority.signingRequest({capability:CAPABILITY,signature_input:'drawn intent',consent:true}))
      .toEqual({capability:CAPABILITY,signatureInput:'drawn intent',consentSchema:'signdee.employment.signing-consent.v1'});
    for(const field of ['version_id','document_hash','signer_id','signer_role','signed_at','completed']){
      expect(()=>Authority.signingRequest({capability:CAPABILITY,signature_input:'x',consent:true,[field]:'forged'}))
        .toThrow('invalid_request');
    }
  });

  it('keeps signer authorization behind the existing backend authority key contract',()=>{
    expect(Authority.signerAuthorizationRequest({action:'authorize_signers',version_id:VERSION})).toEqual({versionId:VERSION});
    expect(()=>Authority.signerAuthorizationRequest({action:'authorize_signers',version_id:VERSION,role:'employee'})).toThrow();
  });

  it('hashes capability and signature input before persistence and returns no raw input',async()=>{
    const calls=[];
    vi.stubGlobal('fetch',vi.fn(async(url,options)=>{calls.push([url,options]);return{ok:true,json:async()=>({created:true,
      employment_id:'e',version_id:'v',signer_id:'s',signer_role:'employee',document_hash:'sha256:h',signed_at:'now'})};}));
    const result=await signingEndpoint.persistSigning(Authority.signingRequest({capability:CAPABILITY,signature_input:'raw-signature',consent:true}));
    const body=JSON.parse(calls[0][1].body);
    expect(body.p_capability_digest).toBe(createHash('sha256').update(CAPABILITY).digest('hex'));
    expect(body.p_signature_input_digest).toBe(createHash('sha256').update('raw-signature').digest('hex'));
    expect(JSON.stringify(body)).not.toContain(CAPABILITY);
    expect(JSON.stringify(body)).not.toContain('raw-signature');
    expect(result.created).toBe(true);
  });

  it('issues cryptographically random capabilities without persisting plaintext',async()=>{
    const calls=[];
    vi.stubGlobal('fetch',vi.fn(async(url,options={})=>{
      calls.push([url,options]);
      return{ok:true,json:async()=>({employment_id:'e',version_id:VERSION,signers:[]})};
    }));
    const result=await authorityEndpoint.authorizeEmploymentSigners(VERSION);
    expect(result.signers).toHaveLength(2);
    expect(new Set(result.signers.map(x=>x.capability)).size).toBe(2);
    const persisted=JSON.parse(calls[0][1].body);
    expect(JSON.stringify(persisted)).not.toContain(result.signers[0].capability);
    expect(persisted.p_signers.every(x=>/^[0-9a-f]{64}$/.test(x.capability_digest))).toBe(true);
  });
});

describe('Employment A.2 database contract',()=>{
  it('binds signer and capability to the exact A.1 version with composite foreign keys',()=>{
    expect(SQL).toMatch(/foreign key \(employment_id,version_id\)\s+references public\.employment_authority_versions/);
    expect(SQL).toMatch(/foreign key \(employment_id,version_id,signer_id\)\s+references public\.employment_authority_signers/);
    expect(SQL).toContain('unique (employment_id,version_id,signer_role)');
  });
  it('locks, revalidates, atomically signs and consumes without completing A.3 evidence',()=>{
    expect(SQL).toMatch(/employment_authority_versions[\s\S]+for update/);
    expect(SQL).toMatch(/employment_authority_signers[\s\S]+for update/);
    expect(SQL).toMatch(/employment_authority_signing_capabilities[\s\S]+for update/);
    expect(SQL).toContain("signing_status='signed'");
    expect(SQL).toContain('set consumed_at=accepted');
    expect(SQL).toMatch(/newer\.version_number>v\.version_number[\s\S]+newer\.lifecycle_status='issued'/);
    expect(SQL).not.toMatch(/signed_document_reference|signed_evidence|workspace/i);
  });
  it('denies all direct client and service-role table access',()=>{
    expect(SQL).toMatch(/revoke all on public\.employment_authority_signers,public\.employment_authority_signing_capabilities,[\s\S]+from anon,authenticated,service_role/);
    expect(SQL).toMatch(/grant execute on function public\.employment_authority_sign_version\(text,text,text\) to service_role/);
    expect(SQL).toMatch(/grant execute on function public\.employment_authority_authorize_signers\(uuid,jsonb\) to service_role/);
  });
});
