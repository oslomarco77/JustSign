'use strict';

const { createHash, timingSafeEqual, randomUUID } = require('node:crypto');
const Employment = require('./_employment_authority.js');

const SUPABASE_URL=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SERVICE_KEY=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const AUTHORITY_KEY=process.env.EMPLOYMENT_AUTHORITY_API_KEY||'';
const MAX_BODY_BYTES=2048;

function secretMatches(a,b){if(!a||!b)return false;const x=createHash('sha256').update(String(a)).digest();const y=createHash('sha256').update(String(b)).digest();return timingSafeEqual(x,y);}
function reply(res,status,body){res.setHeader('Cache-Control','no-store');return res.status(status).json(body);}
function headers(){return{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json'};}
async function supabase(path,options={}){const response=await fetch(`${SUPABASE_URL}${path}`,{...options,headers:{...headers(),...(options.headers||{})}});if(!response.ok)throw new Error('employment_authority_persistence_failed');return response.json();}

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

async function handler(req,res){
  if(req.method!=='POST')return reply(res,405,{ok:false,code:'method_not_allowed'});
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return reply(res,415,{ok:false,code:'unsupported_media_type'});
  const declared=Number(req.headers['content-length']||0);if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES)return reply(res,413,{ok:false,code:'request_too_large'});
  if(!SUPABASE_URL||!SERVICE_KEY||!AUTHORITY_KEY)return reply(res,503,{ok:false,code:'authority_not_configured'});
  if(!secretMatches(req.headers['x-signdee-employment-authority-key'],AUTHORITY_KEY))return reply(res,403,{ok:false,code:'authorization_failed'});
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});}catch{return reply(res,400,{ok:false,code:'malformed_request'});}
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_BODY_BYTES)return reply(res,413,{ok:false,code:'request_too_large'});
  let request;try{request=Employment.versionRequest(body);}catch{return reply(res,400,{ok:false,code:'invalid_request'});}
  try{const result=await issueEmploymentVersion(request.legacyContractId);return reply(res,result.created?201:200,{ok:true,...result});}
  catch(error){if(error instanceof TypeError)return reply(res,400,{ok:false,code:'invalid_employment_document'});if(error.message==='employment_source_not_found')return reply(res,404,{ok:false,code:'source_not_found'});return reply(res,409,{ok:false,code:'employment_version_not_issued'});}
}

module.exports=handler;
module.exports.issueEmploymentVersion=issueEmploymentVersion;
module.exports.loadLegacyEmployment=loadLegacyEmployment;
module.exports.secretMatches=secretMatches;
