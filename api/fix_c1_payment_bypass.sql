-- ═══════════════════════════════════════════════════════════════
-- SignDee — แก้ C1: payment bypass
--  1) เพิ่ม trigger กัน payment ให้ sale_contracts (เดิมมีแต่ contracts)
--  2) ลบ RPC dev_mark_sale_paid (secret หลุดใน client)
-- ⚠️ ต้อง deploy index.html + index-sale.html + create-payment-intent.js เวอร์ชันใหม่ก่อน
--    และตั้ง Vercel env: DEV_SKIP_SECRET = <รหัสลับใหม่ของคุณ> (Production)
-- รันใน Supabase SQL Editor · ปลอดภัยต่อการรันซ้ำ
-- ═══════════════════════════════════════════════════════════════

-- 1) sale_contracts: บังคับให้เฉพาะ service_role (backend) แก้ payment_completed ได้
alter table public.sale_contracts alter column payment_completed set default false;

create or replace function public.protect_sale_payment_columns()
returns trigger as $$
begin
  -- anon (client) แก้ payment_completed ไม่ได้ — คงค่าเดิม/false เสมอ
  if current_user <> 'service_role' then
    if (tg_op = 'INSERT') then
      new.payment_completed := false;
    elsif (tg_op = 'UPDATE') then
      new.payment_completed := old.payment_completed;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_protect_sale_payment on public.sale_contracts;
create trigger trg_protect_sale_payment
  before insert or update on public.sale_contracts
  for each row execute function public.protect_sale_payment_columns();

-- 2) ลบ RPC dev_mark_sale_paid (secret '6066Gift' หลุดใน frontend)
--    dev-skip ย้ายไป backend /api/create-payment-intent (action=dev_skip) ตรวจ env DEV_SKIP_SECRET
drop function if exists public.dev_mark_sale_paid(text, text);
drop function if exists public.dev_mark_sale_paid(uuid, text);

-- ── ตรวจผล ──
select tgname from pg_trigger where tgrelid = 'public.sale_contracts'::regclass and tgname = 'trg_protect_sale_payment';
select proname from pg_proc where proname = 'dev_mark_sale_paid';  -- ควรได้ 0 แถว
