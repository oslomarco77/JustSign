'use strict';

const { createHash } = require('node:crypto');
const Employment = require('./_employment_authority.js');

const SUPABASE_URL=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SERVICE_KEY=process.env.SUPABASE_SERVICE_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const MAX_BODY_BYTES=270000;

function reply(res,status,body){res.setHeader('Cache-Control','no-store');return res.status(status).json(body);}

async function persistSigning(request){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/employment_authority_sign_version`,{
    method:'POST',headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      p_capability_digest:createHash('sha256').update(request.capability,'utf8').digest('hex'),
      p_signature_input_digest:createHash('sha256').update(request.signatureInput,'utf8').digest('hex'),
      p_consent_schema:request.consentSchema,
    }),
  });
  if(!response.ok){
    let databaseCode='';try{databaseCode=String((await response.json()).message||'');}catch{/* sanitized */}
    const error=new Error('employment_signing_failed');
    if(databaseCode==='employment_signing_conflict'){error.publicStatus=409;error.publicCode='signing_conflict';}
    else if(databaseCode==='employment_signing_not_authorized'){
      error.publicStatus=403;error.publicCode='signing_not_authorized';
    }
    throw error;
  }
  return response.json();
}

async function handler(req,res){
  if(req.method!=='POST')return reply(res,405,{ok:false,code:'method_not_allowed'});
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))
    return reply(res,415,{ok:false,code:'unsupported_media_type'});
  const declared=Number(req.headers['content-length']||0);
  if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES)return reply(res,413,{ok:false,code:'request_too_large'});
  if(!SUPABASE_URL||!SERVICE_KEY)return reply(res,503,{ok:false,code:'signing_not_configured'});
  let body;try{body=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});}catch{
    return reply(res,400,{ok:false,code:'malformed_request'});
  }
  let bytes;try{bytes=Buffer.byteLength(JSON.stringify(body),'utf8');}catch{
    return reply(res,400,{ok:false,code:'malformed_request'});
  }
  if(bytes>MAX_BODY_BYTES)return reply(res,413,{ok:false,code:'request_too_large'});
  let request;try{request=Employment.signingRequest(body);}catch{
    return reply(res,400,{ok:false,code:'invalid_request'});
  }
  try{
    const result=await persistSigning(request);
    return reply(res,result.created?201:200,{ok:true,created:result.created,
      employment_id:result.employment_id,version_id:result.version_id,signer_id:result.signer_id,
      signer_role:result.signer_role,document_hash:result.document_hash,signed_at:result.signed_at});
  }catch(error){
    if(error.publicStatus)return reply(res,error.publicStatus,{ok:false,code:error.publicCode});
    return reply(res,500,{ok:false,code:'internal_error'});
  }
}

module.exports=handler;
module.exports.persistSigning=persistSigning;
