-- ============================================================
--  SignDee Commerce Core — Phase 1
--  ช่องทางไหนก็เรียกใช้ได้ (website / facebook / line / qr / tiktok / manual)
--
--  ตาม convention เดิมของโปรเจกต์ (ดู rls_harden_*.sql):
--    เปิด RLS ทุกตาราง · ไม่สร้าง policy → เข้าถึงได้เฉพาะ service_role เท่านั้น
--  เงินเก็บเป็น integer minor unit (สตางค์) ห้ามใช้ float
--
--  รันไฟล์นี้ทั้งไฟล์ใน Supabase SQL Editor · idempotent รันซ้ำได้
-- ============================================================

-- ══════════ ENUMS ══════════
do $$ begin
  create type commerce_order_status as enum
    ('PENDING_PAYMENT','PAID','DELIVERED','CANCELLED','PAYMENT_FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type commerce_payment_status as enum
    ('CREATED','PENDING','PAID','FAILED','EXPIRED','REFUNDED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type commerce_delivery_status as enum
    ('PENDING','READY','DELIVERED','DOWNLOADED','EXPIRED','FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type commerce_pain_category as enum
    ('VACANT_ROOM','TENANT_SCREENING','NORMAL_TENANCY','LATE_PAYMENT',
     'RENT_ARREARS','BREACH','TERMINATION','WONT_LEAVE','OTHER');
exception when duplicate_object then null; end $$;


-- ══════════ PRODUCTS ══════════
create table if not exists public.products (
  product_code     text primary key,
  name             text not null,
  price            bigint not null check (price > 0),   -- minor unit (สตางค์)
  currency         text not null default 'THB',
  current_version  text not null,
  storage_bucket   text not null default 'ebooks',
  storage_path     text not null,
  status           text not null default 'ACTIVE',      -- ACTIVE | INACTIVE
  max_downloads    int  not null default 5,
  download_ttl_hours int not null default 720,          -- 30 วัน
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

insert into public.products
  (product_code, name, price, currency, current_version, storage_bucket, storage_path)
values
  ('LANDLORD_AI_GUIDE',
   'คู่มือเอาตัวรอดของเจ้าของห้องเช่าในยุค AI',
   29900, 'THB', 'v1.3',
   'ebooks', 'SignDee_Landlord_AI_Guide_v1_3.pdf')
on conflict (product_code) do update
  set name = excluded.name,
      price = excluded.price,
      current_version = excluded.current_version,
      storage_path = excluded.storage_path,
      updated_at = now();


-- ══════════ ORDERS ══════════
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null unique,
  product_code      text not null references public.products(product_code),
  product_version   text,
  amount            bigint not null check (amount > 0),   -- minor unit
  currency          text not null default 'THB',

  -- ── ช่องทาง: Commerce Core ไม่ผูกกับ channel ใด ใช้ metadata แทน ──
  source            text not null default 'website',      -- website|facebook|line|qr|tiktok|manual|...
  source_reference  text,                                 -- psid / lineUserId / ad id / ฯลฯ
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  utm_content       text,

  customer_name     text,
  customer_email    text,
  customer_phone    text,
  pain_category     commerce_pain_category,

  -- ── สำหรับ SignDee Notice ในอนาคต (ยังไม่ใช้ใน Phase 1) ──
  notice_opportunity  boolean not null default false,
  notice_lead_status  text,

  status            commerce_order_status not null default 'PENDING_PAYMENT',
  lookup_token_hash text not null,      -- sha256 ของ token ที่ใช้เปิดดูสถานะ (ไม่เก็บ token ดิบ)

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  paid_at           timestamptz
);

create index if not exists orders_status_idx  on public.orders (status, created_at desc);
create index if not exists orders_source_idx  on public.orders (source, created_at desc);
create index if not exists orders_product_idx on public.orders (product_code, created_at desc);


-- ══════════ PAYMENTS ══════════
create table if not exists public.payments (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  uuid not null references public.orders(id) on delete cascade,
  provider                  text not null default 'beam',
  provider_payment_id       text,
  provider_payment_link_id  text,
  provider_reference        text,                    -- referenceId ที่ส่งให้ provider (= order_number)
  status                    commerce_payment_status not null default 'CREATED',
  amount                    bigint not null,
  currency                  text not null default 'THB',
  payment_url               text,
  provider_payload          jsonb,
  failure_reason            text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  paid_at                   timestamptz
);

create index if not exists payments_order_idx on public.payments (order_id, created_at desc);
create index if not exists payments_link_idx  on public.payments (provider_payment_link_id);
create index if not exists payments_ref_idx   on public.payments (provider_reference);

-- IDEMPOTENCY: หนึ่ง order มี payment ที่ยัง "เปิดอยู่" ได้ครั้งละหนึ่งใบเท่านั้น
create unique index if not exists payments_one_active_per_order
  on public.payments (order_id)
  where status in ('CREATED','PENDING');


-- ══════════ DELIVERIES ══════════
create table if not exists public.deliveries (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete cascade,
  product_code         text not null references public.products(product_code),
  product_version      text not null,
  delivery_status      commerce_delivery_status not null default 'PENDING',
  download_token_hash  text,                  -- sha256 ของ token ดิบ · ไม่เก็บ token ดิบ
  download_expires_at  timestamptz,
  max_downloads        int not null default 5,
  download_count       int not null default 0,
  delivered_at         timestamptz,
  downloaded_at        timestamptz,           -- ครั้งแรกที่ดาวน์โหลด
  last_download_at     timestamptz,
  last_download_ip     text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- IDEMPOTENCY: หนึ่ง order มี delivery ได้ใบเดียว
create unique index if not exists deliveries_one_per_order on public.deliveries (order_id);
create index if not exists deliveries_token_idx on public.deliveries (download_token_hash);


-- ══════════ PROVIDER WEBHOOK EVENTS (กันยิงซ้ำ / replay) ══════════
create table if not exists public.payment_webhook_events (
  id                 bigserial primary key,
  provider           text not null default 'beam',
  event_type         text,
  event_fingerprint  text not null,          -- sha256 ของ raw body (ใช้กันซ้ำเมื่อ provider ไม่ส่ง event id)
  provider_event_id  text,
  provider_reference text,
  payment_link_id    text,
  payload            jsonb,
  processed          boolean not null default false,
  result             text,                    -- PROCESSED | DUPLICATE | MISMATCH | UNKNOWN_ORDER | REJECTED
  received_at        timestamptz not null default now()
);

create unique index if not exists payment_webhook_events_fp
  on public.payment_webhook_events (provider, event_fingerprint);
create index if not exists payment_webhook_events_ref_idx
  on public.payment_webhook_events (provider_reference, received_at desc);


-- ══════════ STRUCTURED EVENT LOG ══════════
create table if not exists public.commerce_events (
  id           bigserial primary key,
  event        text not null,   -- ORDER_CREATED | PAYMENT_CREATED | BEAM_WEBHOOK_RECEIVED | ...
  order_id     uuid,
  order_number text,
  level        text not null default 'info',   -- info | warn | error
  data         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists commerce_events_order_idx on public.commerce_events (order_number, created_at desc);
create index if not exists commerce_events_type_idx  on public.commerce_events (event, created_at desc);


-- ══════════ ORDER NUMBER: SD-EBOOK-YYYYMMDD-000001 ══════════
-- ใช้ counter รายวันแบบ atomic · เรียกผ่าน PostgREST: POST /rest/v1/rpc/next_order_number
create table if not exists public.order_number_counters (
  prefix   text not null,
  day      date not null,
  n        bigint not null default 0,
  primary key (prefix, day)
);

create or replace function public.next_order_number(p_prefix text default 'SD-EBOOK')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Bangkok')::date;
  v_n   bigint;
begin
  insert into public.order_number_counters (prefix, day, n)
  values (p_prefix, v_day, 1)
  on conflict (prefix, day) do update set n = public.order_number_counters.n + 1
  returning n into v_n;

  return p_prefix || '-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_n::text, 6, '0');
end $$;


-- ══════════ RLS: ปิดหมด ให้เฉพาะ service_role ══════════
alter table public.products               enable row level security;
alter table public.orders                 enable row level security;
alter table public.payments               enable row level security;
alter table public.deliveries             enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.commerce_events        enable row level security;
alter table public.order_number_counters  enable row level security;

revoke all on public.products               from anon, authenticated;
revoke all on public.orders                 from anon, authenticated;
revoke all on public.payments               from anon, authenticated;
revoke all on public.deliveries             from anon, authenticated;
revoke all on public.payment_webhook_events from anon, authenticated;
revoke all on public.commerce_events        from anon, authenticated;
revoke all on public.order_number_counters  from anon, authenticated;
revoke all on function public.next_order_number(text) from anon, authenticated;

-- ไม่สร้าง policy ใด ๆ = anon/authenticated เข้าไม่ได้เลย
-- service_role bypass RLS โดยธรรมชาติ ตรงกับที่ api/*.js ใช้ SUPABASE_SERVICE_KEY


-- ══════════ STORAGE: bucket ส่วนตัว ══════════
insert into storage.buckets (id, name, public)
values ('ebooks', 'ebooks', false)
on conflict (id) do nothing;
-- ไม่สร้าง policy ให้ anon — ไฟล์เข้าถึงได้ผ่าน signed URL ที่สร้างด้วย service key เท่านั้น


-- ══════════ ADMIN VIEW ══════════
create or replace view public.commerce_orders_admin as
select
  o.order_number,
  o.product_code,
  o.product_version,
  o.source,
  o.source_reference,
  o.utm_source,
  o.utm_campaign,
  o.pain_category,
  (o.amount / 100.0)              as amount_thb,
  o.currency,
  o.status                        as order_status,
  p.status                        as payment_status,
  p.provider_payment_link_id,
  o.paid_at,
  d.delivery_status,
  d.download_count,
  d.downloaded_at,
  d.download_expires_at,
  o.created_at
from public.orders o
left join lateral (
  select * from public.payments where order_id = o.id order by created_at desc limit 1
) p on true
left join public.deliveries d on d.order_id = o.id
order by o.created_at desc;

revoke all on public.commerce_orders_admin from anon, authenticated;


-- ══════════ รายงานยอดขายรายวัน ══════════
create or replace view public.commerce_sales_daily as
select
  date_trunc('day', o.paid_at)                                   as day,
  o.product_code,
  o.source,
  count(*)                                                       as orders_paid,
  sum(o.amount) / 100.0                                          as revenue_thb
from public.orders o
where o.status in ('PAID','DELIVERED')
group by 1, 2, 3
order by 1 desc;

revoke all on public.commerce_sales_daily from anon, authenticated;
