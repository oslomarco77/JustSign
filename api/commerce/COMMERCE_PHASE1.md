# SignDee Commerce Core — Phase 1

ขาย eBook อัตโนมัติโดยไม่ผูกกับช่องทางใดช่องทางหนึ่ง

```
CHANNEL   Facebook · LINE · Website · QR · TikTok · Google · manual
              ↓  (source / source_reference / utm_*)
        SIGNDEE COMMERCE CORE
              ↓
           ORDER  →  BEAM  →  PAYMENT CONFIRMED  →  DELIVERY  →  SECURE DOWNLOAD
```

Facebook และ LINE เป็นช่องทางหา traffic เท่านั้น ไม่ใช่แกนของระบบ — ทั้งคู่เรียก API ชุดเดียวกันนี้ โดยส่ง `source: "facebook"` / `"line"` เข้ามา

---

## 1 · สิ่งที่พบจากการตรวจสถาปัตยกรรมเดิม

> **ข้อจำกัดที่ต้องบอกก่อน** — repo `oslomarco77/JustSign` ไม่ได้อยู่ในเครื่องที่รันงานนี้ และไม่มีโฟลเดอร์เชื่อมจาก `oslo-laptop` จึงรัน `git status` / `git log` / `npm run build` / commit / push **ไม่ได้** ข้อมูลสถาปัตยกรรมด้านล่างมาจากไฟล์จริงในโปรเจกต์ที่อ่านได้ (`package.json`, `vercel.json`, `api/create-payment-intent.js`, `api/line-webhook.js`, `rls_harden_*.sql`, `admin-stats.js`)

**สถาปัตยกรรมปัจจุบัน**

| เรื่อง | สภาพจริง |
|---|---|
| Framework | ไม่มี — Vercel serverless functions ล้วน (`api/*.js`) CommonJS `module.exports = async (req,res)` |
| Build | ไม่มี · `vercel.json` ตั้ง `installCommand: "echo skip"` |
| Dependencies | `package.json` มีแค่ `@supabase/supabase-js` และโค้ดจริง **ไม่ได้ใช้** — ทุกไฟล์เรียก Supabase ผ่าน REST + `fetch` |
| Database | Supabase Postgres · เข้าถึงด้วย `SUPABASE_SERVICE_KEY` ฝั่ง server เท่านั้น |
| RLS | มี pattern ชัดเจนใน `rls_harden_contracts.sql` / `rls_harden_sale_nda.sql` — เปิด RLS + `revoke all from anon, authenticated` + ไม่สร้าง policy |
| Migrations | ไฟล์ `.sql` วางไว้ที่ root แล้วรันมือใน SQL Editor · ไม่มี migration runner |
| Auth | ไม่มี user auth · endpoint ผู้ดูแลใช้ `ADMIN_PASSWORD` ผ่าน query (`admin-stats.js`) |
| Payment | **มี Beam อยู่แล้ว** ใน `create-payment-intent.js` — charges API, auth `Basic base64(merchantId:apiKey)`, ยอดเป็นสตางค์, `BEAM_MERCHANT_ID` / `BEAM_API_KEY` / `BEAM_ENV` |
| Storage | Supabase Storage + signed URL (`send-contract-pdf.js`) |
| Logging | `console.log` / `console.error` ธรรมดา ไม่มี structured logging |
| Tests / lint / typecheck | **ไม่มีเลย** — ไม่มี test runner, ไม่มี ESLint, ไม่มี TypeScript |
| Order / product / customer model | **ไม่มี** — มีแต่ `contracts`, `emp_contracts` ซึ่งเป็นคนละโดเมน |

**ชิ้นส่วนที่นำกลับมาใช้ได้เลย**

- Beam auth + base URL + หน่วยเงินสตางค์ จาก `create-payment-intent.js`
- pattern RLS จาก `rls_harden_*.sql`
- pattern signed URL จาก `send-contract-pdf.js`
- `ADMIN_PASSWORD` pattern จาก `admin-stats.js`
- ข้อจำกัด "ห้ามมี dependency ใหม่" จาก `installCommand: "echo skip"`

**สิ่งที่ขาดและต้องสร้างใหม่ทั้งหมด**

product catalog · order · payment · delivery · secure download · webhook verification · idempotency · structured logging · tests

---

## 2 · สิ่งที่สร้าง

```
api/_commerce.js                        shared lib (ขึ้นต้นด้วย _ → Vercel ไม่นับเป็น function)
api/commerce/orders/index.js            POST   /api/commerce/orders
api/commerce/orders/[id]/payment.js     POST   /api/commerce/orders/:id/payment
api/commerce/orders/[id]/status.js      GET    /api/commerce/orders/:id/status
api/commerce/admin/orders.js            GET    /api/commerce/admin/orders
api/webhooks/beam.js                    POST   /api/webhooks/beam
api/download/[token].js                 GET    /api/download/:token
public/landlord-guide.html              หน้าขาย
public/purchase-success.html            หน้ายืนยัน + poll สถานะ
commerce_core.sql                       migration ทั้งหมด
tests/commerce.test.js                  37 tests
tests/harness.js                        mini-PostgREST + Beam mock
.env.example                            ตัวแปรที่ต้องตั้ง
vercel.functions.snippet.json           บล็อกที่ต้องเพิ่มใน vercel.json
package.scripts.snippet.json            script test ที่ต้องเพิ่ม
```

> `[id]` ใช้ชื่อ slug เดียวกันทั้ง `payment.js` และ `status.js` โดยตั้งใจ — Vercel ไม่ยอมให้ path segment เดียวกันมี slug คนละชื่อ · endpoint รับได้ทั้ง order id (uuid) และ `order_number`

---

## 3 · Migration

รัน `commerce_core.sql` ทั้งไฟล์ใน Supabase SQL Editor — idempotent รันซ้ำได้

| สร้าง | หมายเหตุ |
|---|---|
| enum × 4 | `commerce_order_status`, `commerce_payment_status`, `commerce_delivery_status`, `commerce_pain_category` |
| `products` | seed `LANDLORD_AI_GUIDE` · 29900 สตางค์ · v1.3 · `ebooks/SignDee_Landlord_AI_Guide_v1_3.pdf` |
| `orders` | + `source`, `utm_*`, `pain_category`, `notice_opportunity`, `notice_lead_status`, `lookup_token_hash` |
| `payments` | + unique partial index `payments_one_active_per_order` |
| `deliveries` | + unique index หนึ่ง order หนึ่ง delivery · เก็บแค่ `download_token_hash` |
| `payment_webhook_events` | unique `(provider, event_fingerprint)` → กัน webhook ซ้ำระดับ DB |
| `commerce_events` | structured log |
| `order_number_counters` + `next_order_number()` | ออกเลข `SD-EBOOK-YYYYMMDD-000001` แบบ atomic ตามเวลาไทย |
| view `commerce_orders_admin`, `commerce_sales_daily` | สำหรับดูใน Supabase / admin endpoint |
| bucket `ebooks` (private) | ไม่มี policy ให้ anon |

**เรื่องเวอร์ชัน** — spec เขียน `current_version: v1.2` แต่ไฟล์ที่ขายจริงตอนนี้คือ **v1.3 (30 หน้า)** ที่แก้ Legal Snapshot ให้ระบุ 15/30 วันแล้ว จึง seed เป็น v1.3 ถ้าต้องการ v1.2 ให้แก้แถวใน `products` แถวเดียว ไม่ต้องแตะโค้ด

---

## 4 · API

### `POST /api/commerce/orders`
```json
{ "product_code": "LANDLORD_AI_GUIDE", "source": "facebook",
  "source_reference": "psid_123", "utm_campaign": "aug-ebook",
  "pain_category": "RENT_ARREARS" }
```
→ `201`
```json
{ "order_id": "...", "order_number": "SD-EBOOK-20260901-000001",
  "product_code": "LANDLORD_AI_GUIDE", "amount": 29900, "currency": "THB",
  "status": "PENDING_PAYMENT", "lookup_token": "..." }
```
ราคามาจากตาราง `products` เท่านั้น · `amount` ที่ client ส่งมาถูกทิ้งทิ้งเสมอ · `lookup_token` แสดงครั้งเดียว เก็บใน DB เป็น hash

### `POST /api/commerce/orders/:id/payment`
→ `200` `{ order_number, payment_id, payment_url, status: "PENDING", reused }`
**Idempotent** — ถ้ามี payment ที่ยัง `CREATED`/`PENDING` จะคืนใบเดิมและไม่เรียก Beam ซ้ำ · Beam ล่ม → `502` โดย order ไม่ถูกทำลาย ลองใหม่ได้

### `GET /api/commerce/orders/:id/status?t=<lookup_token>`
→ `200` `{ order_number, status, payment_status, delivery_status, amount, currency, payment_url?, download_url? }`
ต้องมี token เสมอ (เลขที่คำสั่งซื้อเดาได้) · token ผิดตอบ `404` เหมือนกรณีไม่มี order เพื่อไม่ให้เดา · ไม่คืนข้อมูลลูกค้าและไม่คืน internal id

### `POST /api/webhooks/beam`
ตั้งใน Beam Dashboard · event `payment_link.paid` (รับ `charge.succeeded` ด้วย)

### `GET /api/download/:token`
ตรวจ token → order ต้อง PAID → ยังไม่หมดอายุ → ยังไม่ครบจำนวน → `302` ไป signed URL อายุ 60 วินาที

### `GET /api/commerce/admin/orders?key=<ADMIN_PASSWORD>`
คืน `commerce_orders_admin` + ยอดขายรายวัน · ไม่มีข้อมูลส่วนตัวและไม่มี token

---

## 5 · Environment variables

ทั้งหมดอยู่ใน `.env.example` · ที่ **ต้องเพิ่มใหม่จริง ๆ มีตัวเดียว** คือ `BEAM_WEBHOOK_SECRET` ที่เหลือมีอยู่แล้วในโปรเจกต์

```
SUPABASE_URL · SUPABASE_SERVICE_KEY          (มีแล้ว)
BEAM_MERCHANT_ID · BEAM_API_KEY · BEAM_ENV   (มีแล้ว — ชุดเดียวกับ create-payment-intent.js)
ADMIN_PASSWORD · APP_BASE_URL                (มีแล้ว)
BEAM_WEBHOOK_SECRET                          ← ใหม่ · ไม่ตั้ง = webhook ถูกปฏิเสธทั้งหมด
BEAM_AMOUNT_UNIT=minor                       ทางเลือก · เปลี่ยนเป็น major ถ้าพบว่า Beam รับเป็นบาท
BEAM_WEBHOOK_VERIFY=strict                   ทางเลือก · ค่าเริ่มต้นคือ strict
```

---

## 6 · ผลการทดสอบ

```
$ node --test tests/commerce.test.js
# tests 37   # pass 37   # fail 0   duration_ms ~180
```

ครอบคลุม: order creation · product price authority · unknown/inactive product · source & pain tracking · payment idempotency (เรียกซ้ำ → payment เดิม, Beam ถูกเรียกครั้งเดียว) · Beam ล่มแล้วลองใหม่ · order ที่จ่ายแล้วสร้าง payment ซ้ำไม่ได้ · webhook signature ผิด/ไม่มี → 401 · happy path → PAID + delivery · duplicate webhook → ไม่ fulfill ซ้ำ · amount mismatch · currency mismatch · unknown order · ยืนยันกับ Beam ไม่ได้ · payload บอก PAID แต่ Beam บอก ACTIVE · event ที่ไม่เกี่ยว · delivery idempotency · download สำเร็จ + นับครั้ง · token มั่ว/สั้น · order ยังไม่จ่าย · ครบจำนวนครั้ง · หมดอายุ · storage ล่ม · status ต้องมี token · money เป็น integer · logging ครบและไม่มีความลับหลุด

Beam และ Supabase ถูก mock ทั้งหมด ไม่มีการยิงของจริง

**ไม่ได้รัน** `npm run lint` / `npm run typecheck` / `npm run build` เพราะโปรเจกต์ไม่มี script เหล่านี้และไม่มี build step (`installCommand: "echo skip"`) · แทนที่ด้วย `node --check` ทุกไฟล์ → ผ่านหมด

---

## 7 · Security notes

| ประเด็น | การจัดการ |
|---|---|
| ราคา | อ่านจาก `products` ฝั่ง server เท่านั้น ไม่เคยรับจาก client |
| paid=true จาก browser | ไม่ใช้เลย — หน้า success แค่ poll สถานะ ไม่มีสิทธิเปลี่ยนอะไร |
| redirect success | ไม่ถือเป็นหลักฐานการจ่าย |
| สลิป / screenshot | ไม่รับใน Commerce Core |
| webhook ปลอม | ตรวจ HMAC-SHA256 ของ raw body + **ยืนยันซ้ำกับ Beam API ทุกครั้ง** ก่อน fulfill |
| ยังไม่ตั้ง webhook secret | `strict` (ค่าเริ่มต้น) → ตอบ `503` ไม่รับ event เลย ปลอดภัยกว่าเดา |
| replay / retry | fingerprint = sha256(raw body) มี unique index → ครั้งที่สองตอบ 200 พร้อม `duplicate: true` |
| ยอด/สกุลเงินไม่ตรง | หยุดที่ `MISMATCH` ไม่สร้าง delivery และบันทึก `PAYMENT_MISMATCH` |
| Beam API key | อยู่ฝั่ง server เท่านั้น · ไม่มีใน `public/` |
| Supabase service role | อยู่ฝั่ง server เท่านั้น · ทุกตารางเปิด RLS + revoke anon/authenticated + ไม่มี policy |
| eBook | bucket private · เข้าถึงผ่าน signed URL 60 วินาทีที่สร้างด้วย service key เท่านั้น |
| download token | 32 bytes สุ่ม · **เก็บแค่ sha256** ไม่เก็บ token ดิบ · จำกัด 5 ครั้ง · หมดอายุ 30 วัน |
| ดูสถานะ order | ต้องมี lookup token · ตอบ 404 เมื่อ token ผิดเพื่อไม่ให้เดาเลขที่คำสั่งซื้อ |
| ข้อมูลบัตร | ไม่แตะเลย Beam จัดการทั้งหมด |
| logging | redact คีย์ที่เข้าข่ายความลับก่อนเขียนทุกครั้ง · มีเทสต์ยืนยันว่าไม่มีคีย์หลุด |
| PDPA | เก็บเฉพาะที่จำเป็น · ชื่อ/อีเมล/เบอร์เป็น optional ทั้งหมด ไม่บังคับกรอกเพื่อซื้อของ 299 บาท |

---

## 8 · ทดสอบกับ Beam จริง (manual)

ใช้ `BEAM_ENV=playground` เท่านั้น อย่ารูดบัตรจริงเพื่อทดสอบ

```bash
BASE=https://<domain>

# 1) สร้าง order
curl -s -X POST $BASE/api/commerce/orders \
  -H 'Content-Type: application/json' \
  -d '{"product_code":"LANDLORD_AI_GUIDE","source":"manual"}' | tee /tmp/o.json
# → เก็บ order_id, order_number, lookup_token

# 2) ยืนยันว่า PENDING_PAYMENT + ราคา 29900
#    (อย่าลืม: amount ต้องเป็น 29900 เสมอ ต่อให้ส่ง amount อื่นมาใน body)

# 3) สร้าง payment
ORDER_ID=$(jq -r .order_id /tmp/o.json)
curl -s -X POST $BASE/api/commerce/orders/$ORDER_ID/payment | tee /tmp/p.json

# 4) เปิด payment_url  ← ตรวจด้วยตาว่ายอดขึ้น ฿299 ไม่ใช่ ฿29,900
#    ถ้าขึ้น ฿29,900 → ตั้ง env BEAM_AMOUNT_UNIT=major แล้ว redeploy

# 5) จ่ายด้วยบัตรทดสอบของ Beam playground

# 6) ดู Vercel Logs — ต้องเห็น BEAM_WEBHOOK_RECEIVED แล้วตามด้วย PAYMENT_CONFIRMED และ DELIVERY_CREATED

# 7-8) เช็กสถานะ
TOKEN=$(jq -r .lookup_token /tmp/o.json); NUM=$(jq -r .order_number /tmp/o.json)
curl -s "$BASE/api/commerce/orders/$NUM/status?t=$TOKEN"
# → status PAID/DELIVERED · delivery_status READY · มี download_url

# 9-10) เปิด download_url → ได้ไฟล์ แล้วเช็กซ้ำว่า download_count เพิ่มและ downloaded_at ถูกบันทึก
curl -s "$BASE/api/commerce/admin/orders?key=$ADMIN_PASSWORD&limit=5" | jq '.orders[0]'
```

**ทดสอบ idempotency ด้วยมือ:** เรียกข้อ 3 ซ้ำ → ต้องได้ `payment_id` เดิมและ `reused: true` · ให้ Beam ส่ง webhook ซ้ำ (ปุ่ม resend ใน dashboard) → ต้องได้ `duplicate: true` และ `deliveries` ยังมีใบเดียว

---

## 9 · ที่ต้องทำเองต่อ (ผมทำแทนไม่ได้จากที่นี่)

```bash
# ในโฟลเดอร์ repo JustSign
git status --short --branch
git checkout -b feat/commerce-core-phase1

# วางไฟล์: api/**, public/**, tests/**, commerce_core.sql, .env.example
# แก้ vercel.json + package.json ตาม snippet ที่ให้มา

npm test                 # ต้องได้ 37 pass
git diff --stat && git diff | less
git add -A && git commit -m "feat: add ebook commerce and beam payment flow"
git push -u origin feat/commerce-core-phase1
```

จากนั้น: รัน `commerce_core.sql` → อัป PDF เข้า bucket `ebooks` → ตั้ง env → ตั้ง webhook ใน Beam Dashboard → ทำ manual test ข้อ 8

---

## 10 · เลื่อนไปเฟสถัดไปโดยตั้งใจ

Facebook Messenger bot · Meta API · LINE OA · CRM UI · marketing automation · email · analytics dashboard · subscription · coupon · cart · multi-item checkout · customer portal · SignDee Notice automation

โครงสร้างรองรับไว้แล้วโดยไม่ต้องแก้ schema: `orders.source` / `source_reference` ให้ทุกช่องทางเรียก API ชุดเดียวกัน และ `notice_opportunity` / `notice_lead_status` เตรียมไว้ให้ SignDee Notice ต่อยอด

---

## Definition of Done

| | |
|---|---|
| ✅ | Product exists · Order created · price server-controlled |
| ✅ | Beam payment created · payment URL returned |
| ✅ | Webhook verified · paid event idempotent · wrong amount ไม่ fulfill |
| ✅ | Order → PAID · delivery created · secure download ใช้ได้ · unpaid ดาวน์โหลดไม่ได้ |
| ✅ | Delivery tracked · source tracking ใช้ได้ |
| ✅ | Tests pass (37/37) · migrations valid · RLS ตรวจแล้ว · ไม่มี secret ในโค้ด |
| ⛔ | **Lint / typecheck / build** — โปรเจกต์ไม่มี script เหล่านี้ (ใช้ `node --check` แทน ผ่านทุกไฟล์) |
| ⛔ | **git diff review / commit / push** — ทำไม่ได้จากที่นี่ เพราะไม่มี repo ในเครื่องที่รันงาน |
