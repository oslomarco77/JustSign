\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION public.sd407br_doc(n uuid,v uuid,a uuid,b uuid)RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('canonical_schema','signdee.nda.document.v1','nda_id',n::text,'version_id',v::text,'version_number',1,'parties',jsonb_build_array(jsonb_build_object('signer_id',a,'party_ref',a,'role','discloser'),jsonb_build_object('signer_id',b,'party_ref',b,'role','recipient')),'title','Receiver','clauses',jsonb_build_array('one','two'))$$;
SET LOCAL ROLE service_role;
DO $$DECLARE d jsonb;n uuid:='b1000000-0000-4000-8000-000000000001';v uuid:='b2000000-0000-4000-8000-000000000001';a uuid:='b3000000-0000-4000-8000-000000000001';b uuid:='b3000000-0000-4000-8000-000000000002';BEGIN d:=public.sd407br_doc(n,v,a,b);PERFORM public.nda_authority_create_initial_version(n,v,'signdee.nda.document.v1',d::text,d,encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex'),jsonb_build_array(jsonb_build_object('id',a,'party_ref',a,'role','discloser','capability_digest',repeat('a1',32),'expires_at','2099-01-01Z'),jsonb_build_object('id',b,'party_ref',b,'role','recipient','capability_digest',repeat('a2',32),'expires_at','2099-01-01Z')));PERFORM public.nda_authority_sign_version(n,v,a,repeat('a1',32),'signdee.nda.signing-consent.v1');PERFORM public.nda_authority_sign_version(n,v,b,repeat('a2',32),'signdee.nda.signing-consent.v1');PERFORM public.nda_authority_reserve_workspace_binding(n,v,'b4000000-0000-4000-8000-000000000001','workspace-receiver:v1');PERFORM public.nda_authority_issue_signed_evidence(n,v);END$$;
RESET ROLE;SELECT id binding_id FROM public.nda_workspace_binding_authorities WHERE nda_id='b1000000-0000-4000-8000-000000000001' \gset
SELECT signed_document_reference evidence_ref FROM public.nda_signed_evidence_authorities WHERE nda_id='b1000000-0000-4000-8000-000000000001' \gset
SET LOCAL ROLE service_role;
CREATE TEMP TABLE source_package AS SELECT public.nda_authority_resolve_workspace_acceptance(:'binding_id',:'evidence_ref') r;
CREATE TEMP TABLE confirmations AS SELECT public.nda_authority_confirm_workspace_acceptance(
:'binding_id',
'b4000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001') r;
INSERT INTO confirmations SELECT public.nda_authority_confirm_workspace_acceptance(
:'binding_id',
'b4000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001');RESET ROLE;
DO $$BEGIN
 IF (SELECT r->>'nda_id' FROM source_package)<>'b1000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'source mismatch';END IF;
 IF (SELECT count(distinct r->>'workspace_result_reference') FROM confirmations)<>1 THEN RAISE EXCEPTION 'confirmation drift';END IF;
 IF (SELECT binding_status FROM public.nda_workspace_binding_authorities WHERE nda_id='b1000000-0000-4000-8000-000000000001')<>'bound' THEN RAISE EXCEPTION 'not bound';END IF;
 IF (SELECT count(*) FROM public.nda_workspace_binding_audit_events WHERE nda_id='b1000000-0000-4000-8000-000000000001' AND event_type IN('workspace_binding.bound','workspace_binding.bound_replay'))<>2 THEN RAISE EXCEPTION 'bound audit missing';END IF;
END$$;
DO $$DECLARE bid uuid;BEGIN SELECT id INTO bid FROM public.nda_workspace_binding_authorities WHERE nda_id='b1000000-0000-4000-8000-000000000001';BEGIN SET LOCAL ROLE service_role;PERFORM public.nda_authority_confirm_workspace_acceptance(bid,'b4000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000002');RAISE EXCEPTION 'conflict accepted';EXCEPTION WHEN OTHERS THEN RESET ROLE;END;END$$;
ROLLBACK;
\echo 'SD-407B.1 JustSign receiver assertions passed'
