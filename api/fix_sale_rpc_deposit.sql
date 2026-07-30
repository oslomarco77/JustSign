-- ═══════════════════════════════════════════════════════════════
-- Fix: get_sale_contract_for_read ให้ส่งคอลัมน์ deposit ใหม่กลับด้วย
-- (เดิมขาด deposit_stripe_account/seller_bank_account/deposit_paid_at/
--  deposit_channels/deposit_pay_via → ฝั่งผู้ซื้อไม่เห็นช่องบัตร)
-- รันใน Supabase SQL Editor · ปลอดภัยต่อการรันซ้ำ
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_sale_contract_for_read(p_token text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
declare r public.sale_contracts; party text;
begin
  select * into r from public.sale_contracts
    where seller_read_token = p_token or buyer_read_token = p_token limit 1;
  if not found then return null; end if;
  party := case when r.seller_read_token = p_token then 'seller' else 'buyer' end;
  return jsonb_build_object(
    'id', r.id, 'party', party, 'created_at', r.created_at,
    'condo_name', r.condo_name, 'unit_no', r.unit_no, 'floor', r.floor, 'building', r.building,
    'area', r.area, 'units', r.units, 'deed_no', r.deed_no,
    'subdistrict', r.subdistrict, 'district', r.district, 'province', r.province,
    'place_made', r.place_made, 'contract_date', r.contract_date,
    's_name', r.s_name, 's_age', r.s_age, 's_id', r.s_id, 's_addr', r.s_addr, 's_phone', r.s_phone,
    'b_name', r.b_name, 'b_age', r.b_age, 'b_id', r.b_id, 'b_addr', r.b_addr, 'b_phone', r.b_phone,
    'total_price', r.total_price, 'deposit_amt', r.deposit_amt, 'deposit_date', r.deposit_date,
    'deposit_method', r.deposit_method, 'remaining', r.remaining,
    'transfer_deadline', r.transfer_deadline, 'fee_transfer', r.fee_transfer, 'fee_mortgage', r.fee_mortgage,
    'deposit_slip', r.deposit_slip, 'unit_photos', r.unit_photos,
    's_card', r.s_card, 'b_card', r.b_card,
    's_signature', r.s_signature, 'b_signature', r.b_signature,
    's_signed_at', r.s_signed_at, 'b_signed_at', r.b_signed_at,
    's_sign_ip', r.s_sign_ip, 's_sign_device', r.s_sign_device,
    'b_sign_ip', r.b_sign_ip, 'b_sign_device', r.b_sign_device,
    's_signed', (r.s_signature is not null), 'b_signed', (r.b_signature is not null),
    'payment_completed', r.payment_completed
  )
  -- ── deposit (มัดจำผ่านบัตร/โอน) ── ต่อด้วย || เพราะ jsonb_build_object จำกัด 100 args
  || jsonb_build_object(
    'seller_bank_account',    r.seller_bank_account,
    'deposit_stripe_account', r.deposit_stripe_account,
    'deposit_channels',       r.deposit_channels,
    'deposit_pay_via',        r.deposit_pay_via,
    'deposit_paid_at',        r.deposit_paid_at
  );
end; $function$;

-- ── ตรวจว่าคืนคอลัมน์ใหม่แล้ว (ใส่ buyer_read_token จริง) ──
-- select get_sale_contract_for_read('rb_fe101ad8-3aba-41df-becf-418a72d13f8c')
--   -> 'deposit_stripe_account';
