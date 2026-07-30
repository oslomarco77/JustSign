-- ═══════════════════════════════════════════════════════════════════════
--  SignDee Employment — ผูกบัญชีนายจ้างกับ LINE (แทน magic link ทางอีเมล)
--  รันใน Supabase → SQL Editor → New query → วางทั้งหมด → Run
--  ปลอดภัยต่อการรันซ้ำ
--
--  กลไก: แอปสุ่มรหัส 6 ตัว → นายจ้างส่งรหัสในแชต OA → webhook จับคู่
--        line_user_id กับรหัส → แอป poll แล้วได้ session (HMAC จาก backend)
--        สัญญาที่สร้างหลังจากนั้นจะถูกผูก owner_line_id ให้อัตโนมัติ
--
--  ทุกตารางในไฟล์นี้ anon เข้าไม่ถึงเลย — อ่าน/เขียนผ่าน backend service_role เท่านั้น
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) เจ้าของสัญญา ──
alter table public.emp_contracts add column if not exists owner_line_id   text;
alter table public.emp_contracts add column if not exists owner_line_name text;
alter table public.emp_contracts add column if not exists owner_linked_at timestamptz;

create index if not exists emp_contracts_owner_idx on public.emp_contracts (owner_line_id);

-- ── 2) รหัสผูกบัญชีชั่วคราว ──
create table if not exists public.emp_line_link (
  code           text primary key,              -- 6 ตัวอักษร ตัวพิมพ์ใหญ่+ตัวเลข
  line_user_id   text,                          -- เติมโดย webhook เมื่อผู้ใช้ส่งรหัสในแชต
  line_name      text,
  created_at     timestamptz not null default now(),
  linked_at      timestamptz,
  consumed_at    timestamptz                    -- แอปดึงไปออก session แล้ว
);

create index if not exists emp_line_link_created_idx on public.emp_line_link (created_at);

alter table public.emp_line_link enable row level security;
-- ไม่มี policy ใด ๆ ให้ anon → เข้าถึงได้เฉพาะ service_role (bypass RLS)
drop policy if exists emp_line_link_anon on public.emp_line_link;

-- ── 3) กันคอลัมน์เจ้าของไม่ให้ client แก้ (เพิ่มเข้า trigger เดิม) ──
--     owner_* เขียนได้เฉพาะ backend service_role เท่านั้น
create or replace function public.emp_protect_columns()
returns trigger as $$
begin
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
      new.owner_line_id     := null;  new.owner_line_name := null;
      new.owner_linked_at   := null;

    elsif (tg_op = 'UPDATE') then
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
      new.owner_line_id     := old.owner_line_id;
      new.owner_line_name   := old.owner_line_name;
      new.owner_linked_at   := old.owner_linked_at;

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

drop trigger if exists trg_emp_protect on public.emp_contracts;
create trigger trg_emp_protect
  before insert or update on public.emp_contracts
  for each row execute function public.emp_protect_columns();

-- ── 4) ล้างรหัสที่หมดอายุ (เก็บไว้ 1 วันพอ) ──
create or replace function public.emp_purge_links()
returns void language sql security definer set search_path = public as $$
  delete from public.emp_line_link where created_at < now() - interval '1 day';
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('emp_purge_links') where exists (
      select 1 from cron.job where jobname = 'emp_purge_links');
    perform cron.schedule('emp_purge_links', '23 4 * * *', 'select public.emp_purge_links()');
  end if;
end $$;

-- ── 5) ตรวจผลลัพธ์ ──
select column_name from information_schema.columns
where table_name = 'emp_contracts' and column_name like 'owner\_%'
order by column_name;

select tablename, policyname, cmd from pg_policies
where tablename in ('emp_contracts','emp_line_link') order by tablename, cmd;
