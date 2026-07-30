-- ═══════════════════════════════════════════════════════════════
-- SignDee Sale — มัดจำผ่านบัตรเครดิต (Stripe Connect Express)
-- รันใน Supabase SQL Editor · ปลอดภัยต่อการรันซ้ำ (idempotent)
-- ═══════════════════════════════════════════════════════════════

-- ── ตารางผูก "ผู้ขาย (member) ↔ Stripe connected account" ──
create table if not exists sd_connect_accounts (
  id                uuid primary key default gen_random_uuid(),
  member_uid        text unique,          -- 'line:Uxxx' / 'google:...' จาก cookie member
  email             text,
  line_user_id      text,
  stripe_account_id text unique,          -- acct_xxx
  charges_enabled   boolean default false,
  payouts_enabled   boolean default false,
  details_submitted boolean default false,
  requirements_due  jsonb,                -- Stripe requirements.currently_due (ถ้ามี)
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists sd_connect_member_idx  on sd_connect_accounts (member_uid);
create index if not exists sd_connect_stripe_idx  on sd_connect_accounts (stripe_account_id);

-- ── คอลัมน์ deposit ใน sale_contracts (ใช้ prefix ใหม่ ไม่ชนของเดิม) ──
-- ช่องทางที่ผู้ขายเปิดให้ (JSON: {transfer:true, card:true})
alter table sale_contracts add column if not exists deposit_channels        jsonb;
-- บัญชีธนาคารผู้ขาย (สำหรับกรณีโอนเอง) {bank, no, name}
alter table sale_contracts add column if not exists seller_bank_account     jsonb;
-- Stripe connected account ของผู้ขายที่จะรับมัดจำ (snapshot ตอนสร้างสัญญา)
alter table sale_contracts add column if not exists deposit_stripe_account  text;

-- วิธีที่ผู้ซื้อเลือกจ่ายจริง
alter table sale_contracts add column if not exists deposit_pay_via         text;   -- 'transfer' | 'card'
alter table sale_contracts add column if not exists deposit_paid_at         timestamptz;
alter table sale_contracts add column if not exists deposit_amount_paid     integer;-- ยอดผู้ซื้อจ่ายจริง (บัตร = รวม fee) หน่วยสตางค์
alter table sale_contracts add column if not exists deposit_charge_id       text;   -- Stripe charge/PI id (กรณีบัตร)

-- payout tracking (เงินเข้าบัญชีผู้ขายจริง)
alter table sale_contracts add column if not exists deposit_payout_status   text;   -- 'pending'|'in_transit'|'paid'|'failed'
alter table sale_contracts add column if not exists deposit_payout_eta      date;
alter table sale_contracts add column if not exists deposit_payout_id       text;

-- ── ตรวจผลลัพธ์ ──
select column_name, data_type
from information_schema.columns
where table_name = 'sale_contracts'
  and (column_name like 'deposit_%' or column_name like 'seller_bank%')
order by column_name;
