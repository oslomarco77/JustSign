import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,describe,expect,it,vi} from 'vitest';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const Authority=require(resolve(ROOT,'api/_employment_authority.js'));
const SQL=readFileSync(resolve(ROOT,'api/employment_workspace_binding_authority.sql'),'utf8');
const ids={employment_id:'95000000-0000-4000-8000-000000000001',
  version_id:'95000000-0000-4000-8000-000000000002',
  workspace_id:'95000000-0000-4000-8000-000000000003'};
const binding='95000000-0000-4000-8000-000000000004';
const result='95000000-0000-4000-8000-000000000005';
const evidence=`sde_emp_${'a'.repeat(64)}`;

function loadEndpoint(){const path=resolve(ROOT,'lib/employment-authority-handler.js');
  delete require.cache[require.resolve(path)];return require(path);}
function response(){return{headers:{},statusCode:0,body:null,setHeader(k,v){this.headers[k]=v;},
  status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};}
afterEach(()=>{vi.unstubAllGlobals();for(const key of ['SUPABASE_URL','SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY','EMPLOYMENT_AUTHORITY_API_KEY','EMPLOYMENT_WORKSPACE_BINDING_API_KEY',
  'EMPLOYMENT_WORKSPACE_BINDING_PRINCIPAL'])delete process.env[key];});

describe('Employment Workspace binding API',()=>{
  it('accepts only minimal reservation authority and a trusted configured principal',()=>{
    expect(Authority.workspaceBindingRequest({action:'reserve_workspace_binding',...ids},'workspace-adapter:v1'))
      .toEqual({action:'reserve_workspace_binding',employmentId:ids.employment_id,
        versionId:ids.version_id,workspaceId:ids.workspace_id,actorPrincipal:'workspace-adapter:v1'});
    for(const forged of [{document_hash:`sha256:${'0'.repeat(64)}`},{signed_document_reference:evidence},
      {completed:true},{binding_status:'bound'},{actor_principal:'browser'},{workspace_result_reference:result}]){
      expect(()=>Authority.workspaceBindingRequest({action:'reserve_workspace_binding',...ids,...forged},
        'workspace-adapter:v1')).toThrow('invalid_request');
    }
  });

  it('accepts exact resolution and confirmation locators',()=>{
    expect(Authority.workspaceBindingRequest({action:'resolve_workspace_acceptance',binding_id:binding,
      signed_document_reference:evidence})).toEqual({action:'resolve_workspace_acceptance',bindingId:binding,
      signedDocumentReference:evidence});
    expect(Authority.workspaceBindingRequest({action:'confirm_workspace_acceptance',binding_id:binding,
      workspace_id:ids.workspace_id,workspace_result_reference:result})).toEqual({
      action:'confirm_workspace_acceptance',bindingId:binding,workspaceId:ids.workspace_id,
      workspaceResultReference:result});
  });

  it('sends only minimized selectors to binding RPCs',async()=>{
    process.env.SUPABASE_URL='http://127.0.0.1:54321';process.env.SUPABASE_SERVICE_KEY='local';
    const endpoint=loadEndpoint();const calls=[];
    vi.stubGlobal('fetch',vi.fn(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);
      return{ok:true,json:async()=>({created:true})};}));
    await endpoint.persistEmploymentWorkspaceBinding(Authority.workspaceBindingRequest(
      {action:'reserve_workspace_binding',...ids},'workspace-adapter:v1'));
    await endpoint.persistEmploymentWorkspaceBinding(Authority.workspaceBindingRequest(
      {action:'resolve_workspace_acceptance',binding_id:binding,signed_document_reference:evidence}));
    await endpoint.persistEmploymentWorkspaceBinding(Authority.workspaceBindingRequest(
      {action:'confirm_workspace_acceptance',binding_id:binding,workspace_id:ids.workspace_id,
        workspace_result_reference:result}));
    expect(calls.map(x=>x[1])).toEqual([
      {p_employment_id:ids.employment_id,p_version_id:ids.version_id,
        p_workspace_id:ids.workspace_id,p_actor_principal:'workspace-adapter:v1'},
      {p_binding_id:binding,p_signed_document_reference:evidence},
      {p_binding_id:binding,p_workspace_id:ids.workspace_id,p_workspace_result_reference:result},
    ]);
  });

  it('requires the dedicated binding credential for reservation',async()=>{
    Object.assign(process.env,{SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_SERVICE_KEY:'local',
      EMPLOYMENT_AUTHORITY_API_KEY:'authority',EMPLOYMENT_WORKSPACE_BINDING_API_KEY:'binding',
      EMPLOYMENT_WORKSPACE_BINDING_PRINCIPAL:'workspace-adapter:v1'});
    const endpoint=loadEndpoint();const denied=response();
    await endpoint({method:'POST',headers:{'content-type':'application/json'},
      body:{action:'reserve_workspace_binding',...ids}},denied);
    expect(denied.statusCode).toBe(403);
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({outcome:'reserved',created:true,
      binding_id:binding,...ids,binding_status:'reserved',signed_document_reference:evidence})})));
    const accepted=response();await endpoint({method:'POST',headers:{'content-type':'application/json',
      'x-signdee-employment-binding-key':'binding'},body:{action:'reserve_workspace_binding',...ids}},accepted);
    expect(accepted.statusCode).toBe(201);expect(accepted.body).not.toHaveProperty('actor_principal');
  });
});

describe('Employment Workspace binding database contract',()=>{
  it('binds one Employment aggregate and exact A.3 evidence tuple',()=>{
    expect(SQL).toMatch(/employment_id uuid not null unique/);
    expect(SQL).toMatch(/version_id uuid not null unique/);
    expect(SQL).toMatch(/foreign key \(employment_id,version_id,document_hash,signed_document_reference\)[\s\S]*employment_signed_evidence_authorities/);
    expect(SQL).toMatch(/employment_signed_evidence_binding_fk_unique[\s\S]*unique \(employment_id,version_id,document_hash,signed_document_reference\)/);
  });
  it('derives finalized A.3 evidence without inspecting A.2 signers',()=>{
    expect(SQL).toMatch(/employment_signed_evidence_authorities[\s\S]*where employment_id=p_employment_id and version_id=p_version_id for update/);
    expect(SQL).not.toMatch(/employment_authority_signers|signing_status|consent_schema/);
  });
  it('enforces reserved to bound lifecycle and closed privileges',()=>{
    expect(SQL).toMatch(/binding_status in \('reserved','bound'\)/);
    expect(SQL).toMatch(/old\.binding_status<>'reserved' or new\.binding_status<>'bound'/);
    expect(SQL).toMatch(/enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.employment_workspace_binding_authorities from anon,authenticated,service_role/);
    expect(SQL).toMatch(/from public,anon,authenticated/);
    expect(SQL).toMatch(/to service_role/);
  });
});
