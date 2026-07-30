-- ═══════════════════════════════════════════════════════════════
-- SignDee — ปิดช่องโหว่ RLS: sale_contracts + nda_contracts
-- ⚠️ sale: ต้อง deploy index-sale.html เวอร์ชันใหม่ (insert ใช้ client uuid) พร้อมกัน/ก่อน
--    nda: ปลอดภัย (frontend ไม่แตะ table — ใช้ backend service_role)
-- รันใน Supabase SQL Editor · ปลอดภัยต่อการรันซ้ำ
-- ═══════════════════════════════════════════════════════════════

-- ── NDA: frontend ไม่เข้าถึง nda_contracts เลย → บล็อก anon ทั้งหมด ──
--    (backend ใช้ service_role ซึ่ง bypass RLS อยู่แล้ว)
drop policy if exists "nda_anon_all" on public.nda_contracts;

-- ── SALE: อ่านผ่าน RPC get_sale_contract_for_read, insert ใช้ client uuid ──
--    → ปิด SELECT เปิดโล่ง (anon อ่านทุกแถวไม่ได้อีก)
drop policy if exists "sale_anon_select" on public.sale_contracts;
-- คงไว้: sale_anon_insert (INSERT), sale_anon_update (UPDATE)

-- ── ตรวจผลลัพธ์ — ต้องไม่มี SELECT/ALL ของ anon เหลือใน 2 ตารางนี้ ──
select tablename, policyname, cmd, roles, qual
from pg_policies
where tablename in ('sale_contracts','nda_contracts')
order by tablename, cmd;
