-- ═══════════════════════════════════════════════════════════════
-- SignDee NDA — คอลัมน์สำหรับยืนยันตัวตนด้วย LINE Login (LIFF)
-- รันใน Supabase SQL Editor ครั้งเดียว · ปลอดภัยต่อการรันซ้ำ (idempotent)
-- ═══════════════════════════════════════════════════════════════

-- ── ฝ่าย A (ผู้ให้ข้อมูล) ──
alter table nda_contracts add column if not exists a_line_user_id     text;
alter table nda_contracts add column if not exists a_line_name        text;
alter table nda_contracts add column if not exists a_line_verified_at timestamptz;
alter table nda_contracts add column if not exists a_verify_method    text;   -- 'line_login' | 'id_last4'

-- ── ฝ่าย B (ผู้รับข้อมูล) ──
alter table nda_contracts add column if not exists b_line_user_id     text;
alter table nda_contracts add column if not exists b_line_name        text;
alter table nda_contracts add column if not exists b_line_verified_at timestamptz;
alter table nda_contracts add column if not exists b_verify_method    text;

-- ── ผู้ร่างสัญญา (เซ็นในแอป ไม่ผ่าน LIFF) ผูก LINE ทีหลังเพื่อรับสัญญา ──
alter table nda_contracts add column if not exists creator_line_user_id     text;
alter table nda_contracts add column if not exists creator_line_name        text;
alter table nda_contracts add column if not exists creator_line_verified_at timestamptz;

-- ── กันส่งสัญญาทาง LINE ซ้ำ ──
alter table nda_contracts add column if not exists line_notified_at   timestamptz;

-- ── index สำหรับ /api/line-webhook (ค้นสัญญาจาก userId ตอนมีคนเพิ่มเพื่อน OA) ──
create index if not exists nda_contracts_a_line_uid_idx on nda_contracts (a_line_user_id);
create index if not exists nda_contracts_b_line_uid_idx on nda_contracts (b_line_user_id);

-- ── ตรวจผลลัพธ์ ──
select column_name, data_type
from information_schema.columns
where table_name = 'nda_contracts'
  and (column_name like '%line%' or column_name like '%verify_method%')
order by column_name;
