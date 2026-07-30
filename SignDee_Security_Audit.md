# SignDee — รายงานตรวจสอบความปลอดภัย + แผนป้องกัน
วันที่: 23 ก.ค. 2026 · ขอบเขต: index.html (เช่า), index-sale.html, index-nda.html, api/*.js, Supabase

---

## ✅ สิ่งที่ปลอดภัยดีอยู่แล้ว

- **ไม่มี secret รั่วใน frontend** — ใช้แค่ anon key (public ปกติ) · service_role/Stripe secret/OCR key อยู่ backend เท่านั้น
- **payment columns ป้องกันด้วย DB trigger** (`supabase_protect_payment.sql`) — anon (client) แก้ `payment_completed`/`payment_ref` ไม่ได้ มีแต่ service_role (backend) เขียนได้
- **admin-stats** ป้องกันด้วย `ADMIN_PASSWORD` (401 ถ้าไม่ผ่าน)
- **Turnstile กันบอท** บน OCR + NDA generate/content แล้ว (เพิ่งทำ)

---

## 🔴 CRITICAL — ควรแก้ก่อน

### C1. Payment bypass ผ่าน dev gate ฝั่ง client
- `_isTestEnv()` เช็ค `localStorage.signdee_dev === '6066Gift'` และ **`6066Gift` โผล่ใน frontend JS ตรงๆ** (`?dev=6066Gift`)
- ใครก็เปิด dev mode → กด "ข้ามการชำระเงิน" → `paymentCompleted=true` ฝั่ง client → สร้างสัญญา/PDF ได้ฟรี
- ที่ลึกกว่า: **การบังคับจ่ายเงินอยู่ฝั่ง client ล้วน** — ตั้ง `window._paidVerified=true` ผ่าน console ก็ข้ามได้ แม้ไม่มี dev key
- **แก้:** บังคับตรวจ `payment_completed` จาก DB (ผ่าน backend) ก่อนออก PDF/ก่อนเปิดลิงก์เซ็น · ย้าย dev key ออกจาก client (ให้ backend ถือ)

### C2. ยืนยันสถานะ RLS ของตาราง `contracts`
- frontend อ่านสัญญาด้วย anon: `sb.from('contracts').select('*').eq('id', rowId)`
- **ถ้า RLS ปิดอยู่** = ใครมี anon key (public) + เดา/รู้ UUID ของสัญญา → อ่านข้อมูลส่วนบุคคลทั้งหมดได้ (ชื่อ, เลขบัตร, ที่อยู่, รูปบัตร) = PDPA breach
- **ต้องตรวจ:** เปิด RLS แล้วหรือยัง? อ่านผ่าน token (rl_/rt_) หรืออ่านตรงด้วย id?
- **แก้:** เปิด RLS + policy ให้ anon อ่านได้เฉพาะผ่าน read_token (หรือย้ายการอ่านไป RPC SECURITY DEFINER เหมือน sale/nda)

---

## 🟠 HIGH

### H1. ไม่มี rate limiting
- endpoint สำคัญ (create-payment-intent, save-liff-signature, send-contract-pdf) ไม่มีการจำกัดจำนวนเรียก → เสี่ยง abuse/DoS + ค่าใช้จ่าย
- OCR/generate มี Turnstile ช่วยแล้ว แต่ตัวอื่นยังโล่ง
- **แก้:** เพิ่ม rate limit ต่อ IP (เช่น Upstash Redis / in-memory ต่อ instance) หรือใช้ Vercel Firewall / Cloudflare rate rules

### H2. CORS `*` ทุก endpoint
- `Access-Control-Allow-Origin: *` — ยอมรับจากทุกโดเมน
- ยอมรับได้ถ้าแต่ละ endpoint มี auth ของตัวเอง แต่ควรรัดเป็น allowlist โดเมน signdee เพื่อลดพื้นที่โจมตี
- **แก้:** จำกัด origin เป็น `*.signdee.com` (+ vercel.app preview เฉพาะช่วง dev)

---

## 🟡 MEDIUM

- **M1. Payload size** — endpoint รับรูป (OCR, สลิป, PDF) ควร cap ขนาด body ชัดเจน (myip มี MAX_B64_BYTES แล้ว — เช็คตัวอื่น)
- **M2. Input validation** — ตรวจ type/รูปแบบ field ก่อนเขียน DB (เลขบัตร, เบอร์, จำนวนเงิน)
- **M3. Token entropy** — read tokens (rl_/rt_) ต้องเป็น random ยาวพอ (UUID v4 โอเค); อย่าใช้ค่าคาดเดาได้
- **M4. Error leakage** — บาง endpoint คืน `detail: e.message` ควรตัด stack/ข้อความภายในบน production

---

## 🛡️ แผนป้องกันเป็นชั้น (เรียงตามความคุ้ม)

1. **ชั้น DB (Supabase)** — เปิด/ยืนยัน RLS ตาราง contracts + sale_contracts + nda_contracts · อ่านผ่าน token/RPC เท่านั้น · trigger กัน payment (มีแล้ว) ขยายกันคอลัมน์ signature/สถานะด้วย
2. **ชั้น Backend (Vercel)** — payment enforcement ฝั่ง server ก่อนออก PDF · rate limiting · CORS allowlist · ตัด error detail
3. **ชั้น Edge (Cloudflare)** — Turnstile (มีแล้ว) · WAF/rate rules หน้าโดเมน
4. **ชั้น Client** — เอา dev key ออกจาก source · validate input ก่อนส่ง

---

## หมายเหตุ regression จากงานที่เพิ่งแก้ (rent redesign 5 งาน)
- งาน 1 (landing ออก), 2 (chrome), 3 (OCR carryover) — เทสต์ผ่านบน preview แล้ว
- งาน 4 (นิติบุคคล), 5 (Turnstile) — syntax OK, รอเทสต์ flow เต็มบน preview
- routing edge cases (tenantRead / member / reload / resume) — ปรับให้ทำงานกับ role picker เป็นหน้าแรกแล้ว ควรเทสต์ยืนยัน
