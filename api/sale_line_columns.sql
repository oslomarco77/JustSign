-- SignDee Sale — คอลัมน์เสริมสำหรับส่งสัญญาทาง LINE
-- รันใน Supabase SQL Editor · ปลอดภัยต่อการรันซ้ำ
alter table sale_contracts add column if not exists line_notified_at timestamptz;
alter table sale_contracts add column if not exists creator_line_name        text;
alter table sale_contracts add column if not exists creator_line_verified_at timestamptz;

create index if not exists sale_contracts_s_line_uid_idx on sale_contracts (s_line_user_id);
create index if not exists sale_contracts_b_line_uid_idx on sale_contracts (b_line_user_id);
create index if not exists sale_contracts_creator_line_uid_idx on sale_contracts (creator_line_user_id);

select column_name, data_type from information_schema.columns
where table_name = 'sale_contracts' and column_name like '%line%'
order by column_name;
