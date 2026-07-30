-- ═══════════════════════════════════════════════════════════════
-- SignDee เช่า — ปิดช่องโหว่ RLS ตาราง contracts
-- ⚠️ ต้อง deploy index.html เวอร์ชันใหม่ (อ่านผ่าน RPC) พร้อมกัน/ก่อน
--    ไม่งั้นหน้าที่ยังอ่าน anon ตรงจะพัง
-- รันใน Supabase SQL Editor · ปลอดภัยต่อการรันซ้ำ
-- ═══════════════════════════════════════════════════════════════

-- 1) RPC อ่านสัญญาสำหรับผู้สร้าง (creator reload/status) ด้วย id
--    SECURITY DEFINER → bypass RLS อย่างปลอดภัย, คืนแถวเดียวตาม id เท่านั้น
--    (กัน mass-dump: ต้องรู้ id ที่แน่นอน อ่านทีละแถว)
create or replace function public.get_contract_for_edit(p_id text)
returns setof public.contracts
language sql
security definer
set search_path to public
as $$
  select * from public.contracts where id::text = p_id limit 1;
$$;

grant execute on function public.get_contract_for_edit(text) to anon;

-- 2) ลบ policy เปิดโล่ง (ต้นเหตุ anon อ่าน/ลบ ทุกแถวได้)
drop policy if exists "allow_all" on public.contracts;                          -- ALL true (อ่าน/แก้/ลบ ทุกแถว)
drop policy if exists "tenant can read contract by token" on public.contracts;  -- SELECT อ่าน mass ได้

-- คงไว้ (แอปยังต้องใช้): "anon insert" (INSERT), "anon update" (UPDATE),
--   "tenant can confirm read" (UPDATE token) · trigger กัน payment ยังทำงาน
-- ผลลัพธ์: anon SELECT ตรง = ไม่ได้ (อ่านผ่าน RPC เท่านั้น) · anon DELETE = ไม่ได้

-- 3) ตรวจผลลัพธ์ — ต้องไม่มี policy SELECT/DELETE/ALL ของ anon เหลือ
select policyname, cmd, roles, qual
from pg_policies where tablename = 'contracts'
order by cmd, policyname;
