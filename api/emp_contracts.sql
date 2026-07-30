-- ═══════════════════════════════════════════════════════════════════════
--  SignDee Employment — schema + RLS + RPC + trigger
--  รันใน Supabase → SQL Editor → New query → วางทั้งหมด → Run
--  ปลอดภัยต่อการรันซ้ำ (idempotent)
--
--  ออกแบบตามข้อเสนอใน SignDee_Security_Audit.md (23 ก.ค. 2026):
--    • ไม่มี anon SELECT — อ่านผ่าน RPC SECURITY DEFINER ที่ตรวจ token เท่านั้น
--      → กัน enumerate ข้อมูลบัตรประชาชน/ที่อยู่ ด้วย anon key (PDPA)
--    • token เป็น uuid ที่สร้างฝั่ง DB (ไม่ใช่ 'rt_'+rowId ที่เดาได้ — audit M3)
--    • payment / signature / token columns เขียนได้เฉพาะ service_role
--    • เนื้อสัญญาแก้ไม่ได้อีกเมื่อเริ่มมีลายเซ็น
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- 1) TABLE
-- ─────────────────────────────────────────────────────────────
create table if not exists public.emp_contracts (
  id                 uuid primary key default gen_random_uuid(),
  contract_no        text,
  status             text not null default 'draft',
    -- draft | ocr_done | generated | paid | reviewed | sent | completed

  -- ── STEP 1: ตำแหน่ง + Job Description ──
  position_th        text,
  position_en        text,
  position_code      text,
  jd                 jsonb,          -- {responsibilities:[],qualifications:[],kpis:[],_source:'ai'|'seed'}
  jd_edited          boolean not null default false,

  -- ── STEP 1b: รายละเอียดการจ้าง ──
  employment_type    text,           -- full_time | part_time | temporary | probation
  salary             numeric,
  allowance          numeric default 0,
  bonus_text         text,
  payday_text        text,
  probation_days     int default 0,
  work_days          jsonb,          -- ['mon','tue',...]
  work_start         text,           -- '09.00'
  work_end           text,           -- '18.00'
  work_hours         numeric,
  work_location      text,
  client_site        text,           -- โหมดรับเหมาบริการ (ม.11/1) — null = ไม่ใช้
  start_date         date,
  end_date           date,
  restrict_level     text default 'none',   -- none | nonsolicit | noncompete
  restrict_months    int default 12,
  restrict_area      text,

  -- ── STEP 2: คู่สัญญา ──
  party_a            jsonb,          -- นายจ้าง {name,id13,address,phone,expiry,issue,age,jur,edited}
  party_b            jsonb,          -- ลูกจ้าง
  a_card             jsonb,          -- {image, ocr_raw, cert_image, seal_image}
  b_card             jsonb,
  creator_party      text,           -- 'a' | 'b' | 'third'

  -- ── generate ──
  clauses            jsonb,
  meta               jsonb,
  doc_hash           text,
  cert_no            text,

  -- ── payment (PROTECTED) ──
  payment_completed  boolean not null default false,
  payment_ref        text,
  paid_at            timestamptz,

  -- ── tokens (PROTECTED) ──
  creator_token      uuid not null default gen_random_uuid(),
  a_read_token       uuid,
  b_read_token       uuid,

  -- ── signing (PROTECTED) ──
  a_signature        text,
  b_signature        text,
  a_signed_at        timestamptz,
  b_signed_at        timestamptz,
  a_sign_ip          text,
  b_sign_ip          text,
  a_sign_device      text,
  b_sign_device      text,

  -- ── LINE (optional) ──
  a_line_user_id     text,
  b_line_user_id     text,
  creator_line_user_id text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists emp_contracts_created_at_idx on public.emp_contracts (created_at);
create index if not exists emp_contracts_a_token_idx    on public.emp_contracts (a_read_token);
create index if not exists emp_contracts_b_token_idx    on public.emp_contracts (b_read_token);
create index if not exists emp_contracts_payref_idx     on public.emp_contracts (payment_ref);

-- ── เพิ่มคอลัมน์ทีหลังได้โดยไม่พังของเดิม ──
alter table public.emp_contracts add column if not exists client_site text;
alter table public.emp_contracts add column if not exists restrict_area text;
alter table public.emp_contracts add column if not exists payday_text text;

-- ─────────────────────────────────────────────────────────────
-- 2) TRIGGER — กันคอลัมน์ที่ client ห้ามเขียน + ล็อกเนื้อหาหลังเซ็น
-- ─────────────────────────────────────────────────────────────
create or replace function public.emp_protect_columns()
returns trigger as $$
begin
  -- บล็อกเฉพาะ role ฝั่ง client เท่านั้น
  -- (service_role = backend Vercel · postgres/owner = RPC SECURITY DEFINER ในไฟล์นี้ → ต้องเขียนได้)
  if current_user in ('anon', 'authenticated') then

    if (tg_op = 'INSERT') then
      new.payment_completed := false;
      new.payment_ref       := null;
      new.paid_at           := null;
      new.a_signature       := null;  new.b_signature := null;
      new.a_signed_at       := null;  new.b_signed_at := null;
      new.a_sign_ip         := null;  new.b_sign_ip   := null;
      new.a_sign_device     := null;  new.b_sign_device := null;
      new.a_read_token      := null;  new.b_read_token := null;
      new.cert_no           := null;

    elsif (tg_op = 'UPDATE') then
      -- คอลัมน์ที่ client แก้ไม่ได้เด็ดขาด
      new.payment_completed := old.payment_completed;
      new.payment_ref       := old.payment_ref;
      new.paid_at           := old.paid_at;
      new.a_signature       := old.a_signature;   new.b_signature   := old.b_signature;
      new.a_signed_at       := old.a_signed_at;   new.b_signed_at   := old.b_signed_at;
      new.a_sign_ip         := old.a_sign_ip;     new.b_sign_ip     := old.b_sign_ip;
      new.a_sign_device     := old.a_sign_device; new.b_sign_device := old.b_sign_device;
      new.creator_token     := old.creator_token;
      new.a_read_token      := old.a_read_token;  new.b_read_token  := old.b_read_token;
      new.cert_no           := old.cert_no;
      new.id                := old.id;
      new.created_at        := old.created_at;

      -- ล็อกเนื้อสัญญาเมื่อเริ่มมีลายเซ็นแล้ว (แก้ได้เฉพาะ status)
      if old.a_signed_at is not null or old.b_signed_at is not null then
        new.position_th := old.position_th;  new.position_en := old.position_en;
        new.position_code := old.position_code;
        new.jd := old.jd;
        new.employment_type := old.employment_type;
        new.salary := old.salary;            new.allowance := old.allowance;
        new.bonus_text := old.bonus_text;    new.payday_text := old.payday_text;
        new.probation_days := old.probation_days;
        new.work_days := old.work_days;      new.work_start := old.work_start;
        new.work_end := old.work_end;        new.work_hours := old.work_hours;
        new.work_location := old.work_location;  new.client_site := old.client_site;
        new.start_date := old.start_date;    new.end_date := old.end_date;
        new.restrict_level := old.restrict_level;
        new.restrict_months := old.restrict_months;
        new.restrict_area := old.restrict_area;
        new.party_a := old.party_a;          new.party_b := old.party_b;
        new.a_card := old.a_card;            new.b_card := old.b_card;
        new.clauses := old.clauses;          new.meta := old.meta;
        new.doc_hash := old.doc_hash;
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$ language plpgsql;
-- ไม่ใช้ SECURITY DEFINER โดยตั้งใจ เพื่อให้ current_user สะท้อน role ของผู้เรียกจริง

drop trigger if exists trg_emp_protect on public.emp_contracts;
create trigger trg_emp_protect
  before insert or update on public.emp_contracts
  for each row execute function public.emp_protect_columns();

-- ─────────────────────────────────────────────────────────────
-- 3) RLS — anon: INSERT + UPDATE เท่านั้น  ไม่มี SELECT
-- ─────────────────────────────────────────────────────────────
alter table public.emp_contracts enable row level security;

drop policy if exists emp_anon_insert on public.emp_contracts;
create policy emp_anon_insert on public.emp_contracts
  for insert to anon with check (true);

-- ❌ ไม่มี UPDATE ให้ anon แล้ว
-- frontend ไม่เขียนตารางนี้ตรง ๆ อีกต่อไป — ทุกการเขียนผ่าน
--   (ก) backend /api/myip ด้วย service_role (whitelist คอลัมน์ที่ EMP_WRITABLE)
--   (ข) RPC SECURITY DEFINER ในไฟล์นี้
-- ถ้าเปิด UPDATE ให้ anon ไว้ ใครรู้ UUID ของสัญญาก็แก้เนื้อหาสัญญาคนอื่นได้
drop policy if exists emp_anon_update on public.emp_contracts;

-- ไม่มี policy SELECT / DELETE ให้ anon โดยตั้งใจ
drop policy if exists emp_anon_select on public.emp_contracts;
drop policy if exists emp_anon_all    on public.emp_contracts;

-- ─────────────────────────────────────────────────────────────
-- 4) RPC — อ่าน/เซ็น ผ่าน token เท่านั้น
-- ─────────────────────────────────────────────────────────────

-- 4.1 สร้างแถวใหม่ → คืน id + creator_token (client เก็บใน localStorage)
create or replace function public.emp_new_contract()
returns table (id uuid, creator_token uuid, contract_no text)
language plpgsql security definer set search_path = public as $$
declare v_no text;
begin
  v_no := 'EMP-' || (extract(year from now())::int + 543)::text || '-' ||
          upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 4));
  return query
    insert into public.emp_contracts (contract_no, status)
    values (v_no, 'draft')
    returning emp_contracts.id, emp_contracts.creator_token, emp_contracts.contract_no;
end;
$$;

-- 4.2 ตรวจ token → คืนบทบาท ('creator' | 'a' | 'b' | null)
create or replace function public._emp_role(p_id uuid, p_token uuid)
returns text
language sql stable security definer set search_path = public as $$
  select case
           when p_token is null then null
           when c.creator_token = p_token then 'creator'
           when c.a_read_token  = p_token then 'a'
           when c.b_read_token  = p_token then 'b'
           else null
         end
  from public.emp_contracts c where c.id = p_id;
$$;

-- 4.3 อ่านสัญญา — creator ได้ครบ, ผู้เซ็นทางไกลได้เท่าที่จำเป็น
create or replace function public.emp_get_contract(p_id uuid, p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.emp_contracts%rowtype; v_role text;
begin
  v_role := public._emp_role(p_id, p_token);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  select * into r from public.emp_contracts where id = p_id;

  if v_role = 'creator' then
    return jsonb_build_object('ok', true, 'role', v_role, 'row', to_jsonb(r) - 'creator_token');
  end if;

  -- ผู้เซ็นทางไกล: ไม่ให้รูปบัตรของอีกฝ่าย ไม่ให้ token ใด ๆ
  return jsonb_build_object('ok', true, 'role', v_role, 'row', jsonb_build_object(
    'id', r.id, 'contract_no', r.contract_no, 'status', r.status,
    'position_th', r.position_th, 'jd', r.jd,
    'employment_type', r.employment_type, 'salary', r.salary, 'allowance', r.allowance,
    'bonus_text', r.bonus_text, 'payday_text', r.payday_text,
    'probation_days', r.probation_days, 'work_days', r.work_days,
    'work_start', r.work_start, 'work_end', r.work_end, 'work_hours', r.work_hours,
    'work_location', r.work_location, 'client_site', r.client_site,
    'start_date', r.start_date, 'end_date', r.end_date,
    'restrict_level', r.restrict_level, 'restrict_months', r.restrict_months,
    'restrict_area', r.restrict_area,
    'party_a', r.party_a, 'party_b', r.party_b,
    'clauses', r.clauses, 'meta', r.meta, 'doc_hash', r.doc_hash, 'cert_no', r.cert_no,
    'payment_completed', r.payment_completed,
    'a_signature', r.a_signature, 'b_signature', r.b_signature,
    'a_signed_at', r.a_signed_at, 'b_signed_at', r.b_signed_at
  ));
end;
$$;

-- 4.4 สถานะการลงนาม (ใช้ polling — เบากว่า emp_get_contract)
create or replace function public.emp_sign_status(p_id uuid, p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.emp_contracts%rowtype;
begin
  if public._emp_role(p_id, p_token) is null then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  select * into r from public.emp_contracts where id = p_id;
  return jsonb_build_object('ok', true,
    'status', r.status, 'cert_no', r.cert_no, 'doc_hash', r.doc_hash,
    'payment_completed', r.payment_completed,
    'a_signed_at', r.a_signed_at, 'b_signed_at', r.b_signed_at,
    'a_signature', r.a_signature, 'b_signature', r.b_signature);
end;
$$;

-- 4.5 ออก read token ให้คู่สัญญา (เรียกได้เฉพาะ creator และเฉพาะเมื่อชำระเงินแล้ว)
create or replace function public.emp_issue_tokens(p_id uuid, p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.emp_contracts%rowtype;
begin
  if public._emp_role(p_id, p_token) <> 'creator' then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  select * into r from public.emp_contracts where id = p_id;
  if not r.payment_completed then
    return jsonb_build_object('ok', false, 'code', 'unpaid');
  end if;
  update public.emp_contracts set
    a_read_token = coalesce(a_read_token, gen_random_uuid()),
    b_read_token = coalesce(b_read_token, gen_random_uuid()),
    status       = case when status in ('draft','ocr_done','generated','paid') then 'sent' else status end
  where id = p_id
  returning a_read_token, b_read_token into r.a_read_token, r.b_read_token;
  return jsonb_build_object('ok', true, 'a_read_token', r.a_read_token, 'b_read_token', r.b_read_token);
end;
$$;

-- 4.6 บันทึกลายเซ็น — ต้องมี token ที่ตรงกับฝ่ายที่จะเซ็น และห้ามทับของเดิม
create or replace function public.emp_submit_signature(
  p_id uuid, p_token uuid, p_party text,
  p_signature text, p_device text default null, p_ip text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.emp_contracts%rowtype; v_role text;
begin
  v_role := public._emp_role(p_id, p_token);
  if v_role is null then return jsonb_build_object('ok', false, 'code', 'forbidden'); end if;
  if p_party not in ('a','b') then return jsonb_build_object('ok', false, 'code', 'bad_party'); end if;
  -- creator เซ็นแทนฝ่ายที่ตนเป็นได้ · ผู้ถือ read token เซ็นได้เฉพาะฝ่ายของตน
  if v_role <> 'creator' and v_role <> p_party then
    return jsonb_build_object('ok', false, 'code', 'wrong_party');
  end if;
  if p_signature is null or length(p_signature) < 100 then
    return jsonb_build_object('ok', false, 'code', 'bad_signature');
  end if;

  select * into r from public.emp_contracts where id = p_id;
  if not r.payment_completed then return jsonb_build_object('ok', false, 'code', 'unpaid'); end if;
  if (p_party = 'a' and r.a_signed_at is not null)
     or (p_party = 'b' and r.b_signed_at is not null) then
    return jsonb_build_object('ok', false, 'code', 'already_signed');
  end if;
  if r.creator_party = 'a' and p_party = 'a' and v_role <> 'creator' then
    return jsonb_build_object('ok', false, 'code', 'wrong_party');
  end if;

  if p_party = 'a' then
    update public.emp_contracts set a_signature = p_signature, a_signed_at = now(),
      a_sign_device = p_device, a_sign_ip = p_ip where id = p_id;
  else
    update public.emp_contracts set b_signature = p_signature, b_signed_at = now(),
      b_sign_device = p_device, b_sign_ip = p_ip where id = p_id;
  end if;

  select * into r from public.emp_contracts where id = p_id;
  if r.a_signed_at is not null and r.b_signed_at is not null then
    update public.emp_contracts set status = 'completed',
      cert_no = coalesce(cert_no, 'SDE-' || (extract(year from now())::int + 543)::text || '-' ||
                upper(substr(coalesce(doc_hash, replace(gen_random_uuid()::text,'-','')), 1, 12)))
    where id = p_id;
    select * into r from public.emp_contracts where id = p_id;
  end if;

  return jsonb_build_object('ok', true, 'party', p_party,
    'a_signed_at', r.a_signed_at, 'b_signed_at', r.b_signed_at,
    'status', r.status, 'cert_no', r.cert_no);
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- 5) GRANTS — anon เรียกได้เฉพาะ RPC ที่ตั้งใจเปิด
-- ─────────────────────────────────────────────────────────────
revoke all on function public._emp_role(uuid, uuid) from public, anon;

grant execute on function public.emp_new_contract()                                    to anon;
grant execute on function public.emp_get_contract(uuid, uuid)                          to anon;
grant execute on function public.emp_sign_status(uuid, uuid)                           to anon;
grant execute on function public.emp_issue_tokens(uuid, uuid)                          to anon;
grant execute on function public.emp_submit_signature(uuid, uuid, text, text, text, text) to anon;

-- ─────────────────────────────────────────────────────────────
-- 6) RETENTION — ลบอัตโนมัติหลัง 60 วัน (เหมือน contracts)
-- ─────────────────────────────────────────────────────────────
create or replace function public.emp_purge_old()
returns void language sql security definer set search_path = public as $$
  delete from public.emp_contracts where created_at < now() - interval '60 days';
$$;

-- ต้องมี extension pg_cron (Supabase: Database → Extensions → เปิด pg_cron)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('emp_purge_old') where exists (
      select 1 from cron.job where jobname = 'emp_purge_old');
    perform cron.schedule('emp_purge_old', '17 3 * * *', 'select public.emp_purge_old()');
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 7) ตรวจผลลัพธ์
-- ─────────────────────────────────────────────────────────────
select tablename, policyname, cmd, roles
from pg_policies where tablename = 'emp_contracts' order by cmd;

select routine_name, security_type
from information_schema.routines
where routine_schema = 'public' and routine_name like 'emp\_%'
order by routine_name;
