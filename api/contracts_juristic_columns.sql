-- ═══════════════════════════════════════════════════════════════
-- SignDee เช่า (contracts) — คอลัมน์นิติบุคคล (ผู้ให้เช่า / ผู้เช่า)
-- รันใน Supabase SQL Editor ครั้งเดียว · ปลอดภัยต่อการรันซ้ำ (idempotent)
-- ⚠️ ต้องรัน SQL นี้ก่อน deploy index.html เวอร์ชันใหม่
--    (ไม่งั้น insert/update จะ error เพราะคอลัมน์ยังไม่มี)
-- ═══════════════════════════════════════════════════════════════

-- ── ผู้ให้เช่า ──
alter table contracts add column if not exists ll_is_juristic boolean default false;
alter table contracts add column if not exists ll_jur_name    text;
alter table contracts add column if not exists ll_jur_regno   text;   -- เลขทะเบียนนิติบุคคล 13 หลัก
alter table contracts add column if not exists ll_jur_signer  text;   -- ผู้มีอำนาจลงนาม

-- ── ผู้เช่า ──
alter table contracts add column if not exists tn_is_juristic boolean default false;
alter table contracts add column if not exists tn_jur_name    text;
alter table contracts add column if not exists tn_jur_regno   text;
alter table contracts add column if not exists tn_jur_signer  text;

-- ── ตรวจผลลัพธ์ ──
select column_name, data_type
from information_schema.columns
where table_name = 'contracts'
  and (column_name like '%_jur_%' or column_name like '%is_juristic%')
order by column_name;
