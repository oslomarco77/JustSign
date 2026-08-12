import{createRequire}from"node:module";import{readFileSync}from"node:fs";import{resolve}from"node:path";
import{describe,it,expect,vi,afterEach}from"vitest";
const require=createRequire(import.meta.url);const A=require(resolve("api/_nda_authority.js"));
const SQL=readFileSync(resolve("api/nda_workspace_receiver_authority.sql"),"utf8");
const binding="90000000-0000-4000-8000-000000000001",workspace="90000000-0000-4000-8000-000000000002";
const result="90000000-0000-4000-8000-000000000003",ref=`sde_${"a".repeat(64)}`;
afterEach(()=>{vi.unstubAllGlobals();for(const k of["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","NDA_AUTHORITY_API_KEY"])delete process.env[k];});
describe("receiver source API",()=>{
 it("accepts locators only",()=>{expect(A.signedEvidenceRequest({action:"resolve_workspace_acceptance",binding_id:binding,signed_document_reference:ref})).toEqual({action:"resolve_workspace_acceptance",bindingId:binding,signedDocumentReference:ref});expect(()=>A.signedEvidenceRequest({action:"resolve_workspace_acceptance",binding_id:binding,signed_document_reference:ref,completed:true})).toThrow(/invalid_request/);});
 it("validates exact confirmation identifiers",()=>{expect(A.signedEvidenceRequest({action:"confirm_workspace_acceptance",binding_id:binding,workspace_id:workspace,workspace_result_reference:result})).toEqual({action:"confirm_workspace_acceptance",bindingId:binding,workspaceId:workspace,workspaceResultReference:result});});
});
describe("receiver source database contract",()=>{
 it("locks and compares independent authorities",()=>{expect(SQL).toMatch(/nda_workspace_binding_authorities[\s\S]*where id=p_binding_id for update/i);expect(SQL).toMatch(/nda_signed_evidence_authorities[\s\S]*signed_document_reference=p_signed_document_reference/i);expect(SQL).toMatch(/b\.nda_id,b\.version_id,b\.document_hash[\s\S]*e\.nda_id,e\.version_id,e\.document_hash/i);});
 it("confirms only the same Workspace result",()=>{expect(SQL).toMatch(/old\.binding_status<>'reserved'[\s\S]*new\.binding_status<>'bound'/i);expect(SQL).toContain("workspace_binding.bound_replay");expect(SQL).toContain("workspace_binding.bound_conflict");expect(SQL).toMatch(/workspace_result_reference<>p_workspace_result_reference/i);});
 it("keeps authority and evidence references distinct",()=>{expect(SQL).not.toMatch(/authority_package_reference\s*=\s*[^;]*signed_document_reference/i);});
});
