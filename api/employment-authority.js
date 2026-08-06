'use strict';

const { createHash, timingSafeEqual, randomUUID, randomBytes } = require('node:crypto');
const Employment = require('./_employment_authority.js');

const SUPABASE_URL=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SERVICE_KEY=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const AUTHORITY_KEY=process.env.EMPLOYMENT_AUTHORITY_API_KEY||'';
const MAX_BODY_BYTES=2048;

function secretMatches(a,b){if(!a||!b)return false;const x=createHash('sha256').update(String(a)).digest();const y=createHash('sha256').update(String(b)).digest();return timingSafeEqual(x,y);}
function reply(res,status,body){res.setHeader('Cache-Control','no-store');return res.status(status).json(body);}
function headers(){return{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json'};}
async function supabase(path,options={}){const response=await fetch(`${SUPABASE_URL}${path}`,{...options,headers:{...headers(),...(options.headers||{})}});if(!response.ok){const error=new Error('employment_authority_persistence_failed');error.response=response;throw error;}return response.json();}

async function loadLegacyEmployment(id){const rows=await supabase(`/rest/v1/emp_contracts?id=eq.${encodeURIComponent(id)}&select=*`);if(!Array.isArray(rows)||rows.length!==1)throw new Error('employment_source_not_found');return rows[0];}
async function rpc(name,body){return supabase(`/rest/v1/rpc/${name}`,{method:'POST',body:JSON.stringify(body)});}

async function issueEmploymentVersion(legacyId){
  const row=await loadLegacyEmployment(legacyId);
  if(!row.updated_at)throw new Error('employment_source_not_ready');
  const source=Employment.buildEmploymentSourceDocument(row);
  const sourceCanonical=Employment.canonicalize(source);
  const sourceDigest=createHash('sha256').update(sourceCanonical,'utf8').digest('hex');
  const prepared=await rpc('employment_authority_prepare_version',{p_legacy_contract_id:legacyId,
    p_employment_id:randomUUID(),p_version_id:randomUUID(),p_source_updated_at:row.updated_at,
    p_canonical_schema:Employment.CANONICAL_SCHEMA,p_source_canonical_payload:sourceCanonical,
    p_source_content_digest:sourceDigest});
  const canonical=Employment.buildCanonicalEmploymentDocument(row,{employmentId:prepared.employment_id,
    versionId:prepared.version_id,versionNumber:prepared.version_number},source);
  return rpc('employment_authority_issue_version',{p_employment_id:prepared.employment_id,
    p_version_id:prepared.version_id,p_source_updated_at:row.updated_at,
    p_canonical_schema:Employment.CANONICAL_SCHEMA,p_canonical_payload:canonical.canonical,
    p_canonical_document:canonical.document,p_document_hash:canonical.hash});
}

async function authorizeEmploymentSigners(versionId){
  const expiresAt=new Date(Date.now()+72*60*60*1000).toISOString();
  const signers=['employer','employee'].map((role)=>{
    const capability=randomBytes(32).toString('base64url');
    return {id:randomUUID(),capability_id:randomUUID(),role,capability,
      capability_digest:createHash('sha256').update(capability,'utf8').digest('hex'),expires_at:expiresAt};
  });
  const result=await rpc('employment_authority_authorize_signers',{p_version_id:versionId,
    p_signers:signers.map(({capability,...signer})=>signer)});
  return {...result,signers:signers.map(({id,role,capability})=>({signer_id:id,role,capability,expires_at:expiresAt}))};
}

async function persistEmploymentSignedEvidence(request){
  const operations={
    issue_signed_evidence:['employment_authority_issue_signed_evidence',{
      p_employment_id:request.employmentId,p_version_id:request.versionId}],
    resolve_signed_evidence:['employment_authority_resolve_signed_evidence',{
      p_signed_document_reference:request.signedDocumentReference}],
  };
  const [name,body]=operations[request.action];
  try{return await rpc(name,body);}catch(error){
    const response=error.response;
    let databaseCode='';
    if(response)try{databaseCode=String((await response.json()).message||'');}catch{/* sanitized */}
    const failure=new Error('employment_signed_evidence_failed');
    if(databaseCode==='employment_signed_evidence_not_eligible'){
      failure.publicStatus=403;failure.publicCode='signed_evidence_not_eligible';
    }else if(databaseCode==='employment_signed_evidence_not_found'){
      failure.publicStatus=404;failure.publicCode='signed_evidence_not_found';
    }
    throw failure;
  }
}

async function handler(req,res){
  if(req.method!=='POST')return reply(res,405,{ok:false,code:'method_not_allowed'});
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return reply(res,415,{ok:false,code:'unsupported_media_type'});
  const declared=Number(req.headers['content-length']||0);if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES)return reply(res,413,{ok:false,code:'request_too_large'});
  if(!SUPABASE_URL||!SERVICE_KEY||!AUTHORITY_KEY)return reply(res,503,{ok:false,code:'authority_not_configured'});
  if(!secretMatches(req.headers['x-signdee-employment-authority-key'],AUTHORITY_KEY))return reply(res,403,{ok:false,code:'authorization_failed'});
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});}catch{return reply(res,400,{ok:false,code:'malformed_request'});}
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_BODY_BYTES)return reply(res,413,{ok:false,code:'request_too_large'});
  let request;try{request=['issue_signed_evidence','resolve_signed_evidence'].includes(body.action)
    ?Employment.signedEvidenceRequest(body):(body.action==='authorize_signers'
      ?Employment.signerAuthorizationRequest(body):Employment.versionRequest(body));}
  catch{return reply(res,400,{ok:false,code:'invalid_request'});}
  try{const result=['issue_signed_evidence','resolve_signed_evidence'].includes(body.action)
    ?await persistEmploymentSignedEvidence(request):(body.action==='authorize_signers'
      ?await authorizeEmploymentSigners(request.versionId):await issueEmploymentVersion(request.legacyContractId));
    return reply(res,body.action==='authorize_signers'||(body.action==='issue_signed_evidence'&&result.created)
      ?201:(result.created?201:200),{ok:true,...result});}
  catch(error){if(error instanceof TypeError)return reply(res,400,{ok:false,code:'invalid_employment_document'});
    if(error.publicStatus)return reply(res,error.publicStatus,{ok:false,code:error.publicCode});
    if(error.message==='employment_source_not_found')return reply(res,404,{ok:false,code:'source_not_found'});
    if(error.message==='employment_signed_evidence_failed')return reply(res,500,{ok:false,code:'internal_error'});
    return reply(res,409,{ok:false,code:'employment_version_not_issued'});}
}

module.exports=handler;
module.exports.issueEmploymentVersion=issueEmploymentVersion;
module.exports.authorizeEmploymentSigners=authorizeEmploymentSigners;
module.exports.persistEmploymentSignedEvidence=persistEmploymentSignedEvidence;
module.exports.loadLegacyEmployment=loadLegacyEmployment;
module.exports.secretMatches=secretMatches;
