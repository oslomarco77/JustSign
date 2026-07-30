-- ════════════════════════════════════════════════════════════════
--  SignDee — ป้องกันการชำระเงิน (ระดับ B)
--  ทำให้มีแต่ backend (service_role) เท่านั้นที่เขียน
--  payment_completed / payment_ref ได้ — ฝั่ง client (anon) เขียนไม่ได้
--  รันใน Supabase → SQL Editor → New query → วางทั้งหมด → Run
-- ════════════════════════════════════════════════════════════════

-- 1) ให้คอลัมน์มีค่า default = false (กัน insert พังถ้าไม่ได้ส่งค่ามา)
ALTER TABLE public.contracts
  ALTER COLUMN payment_completed SET DEFAULT false;

-- 2) ฟังก์ชัน trigger: บังคับค่า payment ให้คงเดิมสำหรับทุก role ยกเว้น service_role
CREATE OR REPLACE FUNCTION public.protect_payment_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- current_user = role ที่ Supabase ใช้จริง:
  --   anon  → client (เว็บ)  |  service_role → backend (Vercel)
  IF current_user <> 'service_role' THEN
    IF (TG_OP = 'INSERT') THEN
      NEW.payment_completed := false;
      NEW.payment_ref := NULL;
    ELSIF (TG_OP = 'UPDATE') THEN
      -- ห้าม client แก้ค่าจ่ายเงิน — คงค่าเดิมไว้เสมอ
      NEW.payment_completed := OLD.payment_completed;
      NEW.payment_ref := OLD.payment_ref;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- หมายเหตุ: ไม่ใช้ SECURITY DEFINER โดยตั้งใจ เพื่อให้ current_user
-- สะท้อน role ของผู้เรียกจริง (anon / service_role)

-- 3) ผูก trigger เข้ากับตาราง contracts
DROP TRIGGER IF EXISTS trg_protect_payment ON public.contracts;
CREATE TRIGGER trg_protect_payment
  BEFORE INSERT OR UPDATE ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_payment_columns();

-- ════════════════════════════════════════════════════════════════
--  ทดสอบหลังรัน (ไม่บังคับ):
--  ลองใช้ anon key สั่ง update payment_completed = true ดู — ค่าต้องไม่เปลี่ยน
--  ส่วน backend (service_role) สั่ง update — ค่าต้องเปลี่ยนได้
-- ════════════════════════════════════════════════════════════════
