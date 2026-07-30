# SignDee Employment — checklist ก่อน/หลัง deploy

## ไฟล์ที่เพิ่มใหม่

| ไฟล์ | หน้าที่ |
|---|---|
| `index-emp.html` | แอปทั้งหมด (single-file · 148 KB) |
| `api/_emp_templates.js` | clause template 18/19 ข้อ + `buildEmpClauses()` + `bahtText()` — **helper ไม่ใช่ serverless function** (ขึ้นต้น `_`) |
| `api/_emp_positions.json` | seed Job Description 24 ตำแหน่ง (fallback เมื่อ AI ล่ม) |
| `api/emp_contracts.sql` | schema + RLS + RPC + trigger + pg_cron |

## ไฟล์ที่แก้

| ไฟล์ | แก้อะไร |
|---|---|
| `api/myip.js` | + `emp_jd` / `emp_generate` / `emp_content` · + Turnstile gate · **แก้บั๊ก `parseGenJson` → `extractJson`** (ดูหมายเหตุ) |
| `api/create-payment-intent.js` | + `product:'emp'` (returnUrl + metadata) |
| `api/verify-payment-intent.js` | + `product:'emp'` → `emp_contracts` · เขียน `paid_at` + `status:'paid'` ให้ด้วย |

> จำนวน serverless function ยังเท่าเดิม **12 ตัว** — ไม่ชน Hobby limit

### หมายเหตุบั๊กที่เจอระหว่างทาง (ของ NDA ไม่ใช่ของใหม่)

`api/myip.js` บรรทัดเดิมเรียก `parseGenJson(text)` ซึ่ง **ไม่มีฟังก์ชันนี้อยู่จริง** (มีแต่ `extractJson`)
ผลคือ `extractSlots()` โยน ReferenceError ทุกครั้ง → ตกไป `fallback` เสมอ → **NDA ไม่เคยได้ใช้ AI เติมช่องว่างข้อ 1 เลย** ใช้ `purpose` ดิบมาตลอด
แก้เป็น `extractJson(text)` แล้ว → หลัง deploy NDA ข้อ 1 จะเปลี่ยนไปเล็กน้อย (ดีขึ้น) **ควรลองสร้าง NDA ทดสอบ 1 ฉบับดูก่อน**

---

## ลำดับการ deploy

### 1) Supabase (ทำก่อน — ไม่งั้นแอปพัง)

```
Supabase → SQL Editor → New query → วางทั้งไฟล์ api/emp_contracts.sql → Run
```

ตรวจผลท้ายสคริปต์:
- `pg_policies` ต้องมี **เฉพาะ** `emp_anon_insert` (INSERT) และ `emp_anon_update` (UPDATE)
  → **ต้องไม่มี SELECT ของ anon** ถ้ามีแปลว่าออกแบบผิด
- routines ต้องขึ้น `emp_new_contract`, `emp_get_contract`, `emp_sign_status`, `emp_issue_tokens`, `emp_submit_signature`, `emp_purge_old` เป็น `DEFINER`

ถ้ายังไม่ได้เปิด `pg_cron`: Database → Extensions → เปิด → รัน block ที่ 6 ซ้ำ

### 2) ENV ที่ต้องมีใน Vercel

มีอยู่แล้ว: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TURNSTILE_SECRET`, `BEAM_MERCHANT_ID`, `BEAM_API_KEY`, `BEAM_ENV`

เพิ่มได้ (ไม่บังคับ):

| ENV | ค่า | ใช้ทำอะไร |
|---|---|---|
| `EMP_JD_MODEL` | `claude-haiku-4-5-20251001` | ถ้าไม่ตั้ง ใช้ค่าเดียวกับ `NDA_GEN_MODEL` |
| `EMP_ALLOW_SKIP` | `1` | **เฉพาะ Preview** — ข้ามการจ่ายเงินตอนทดสอบ |
| `EMP_DEV_KEY` | ค่าลับ | ข้ามการจ่ายเงินบน production (ถ้าไม่ตั้ง ใช้ `ADMIN_PASSWORD` ได้) |

⚠️ **ห้ามตั้ง `EMP_ALLOW_SKIP=1` บน Production**

### 3) Deploy

```bash
cd D:\justsign-api
vercel                # preview ก่อนเสมอ
# ทดสอบตามข้อ 4 จาก Preview URL
vercel --prod
```

⚠️ ต้องทดสอบจาก **Preview URL จริง** ไม่ใช่ `file:///` — OCR / payment / geo ติด CORS

### 4) เทสต์ตามลำดับ (Preview URL + Incognito)

- [ ] เปิด `/index-emp.html` → หน้า landing ขึ้น
- [ ] STEP 1: พิมพ์ "พนัก" → dropdown กรอง → เลือก "พนักงานขาย" → JD seed ขึ้นทันที แล้ว AI เขียนทับใน 3–8 วิ
- [ ] พิมพ์ตำแหน่งที่ไม่มีในลิสต์ → ปุ่ม `+ ใช้ "..."` → JD ว่างแล้ว AI เติม
- [ ] แก้ / ลบ / เพิ่มบรรทัด JD ได้
- [ ] STEP 1b: กรอกเงินเดือน 8,000 กับ จ–ศ → ต้องขึ้น warning ค่าจ้างขั้นต่ำ
- [ ] ตั้งเวลา 08:00–19:00 → ต้องขึ้น warning เกิน 8 ชม.
- [ ] เลือก "ชั่วคราว" → ต้องขึ้น warning ค่าชดเชย
- [ ] ติ๊ก "ปฏิบัติงานที่สถานประกอบการของลูกค้า" → ต้องขึ้น warning ม.11/1
- [ ] STEP 2: อัปโหลดบัตร 2 ใบ → OCR อ่านได้ · แก้ชื่อ/เลขบัตร/วันออกบัตรได้ · เลขบัตรผิด checksum ต้องขึ้นเตือน
- [ ] ติ๊กนิติบุคคลฝั่งนายจ้าง → ฟอร์มขึ้น · ไม่กรอกครบต้องเตือนและปุ่มไม่ active
- [ ] ใช้บัตรใบเดียวกันทั้งสองฝ่าย → ต้องขึ้น "ต้องเป็นคนละบุคคล"
- [ ] กด "สร้างสัญญา" → processing 9 บรรทัด → preview ที่ **เห็นแค่ข้อ 1–2** ที่เหลือ blur
- [ ] เปิด DevTools → Network → response ของ `emp_generate` **ต้องไม่มีเนื้อข้อ 3+** (ถ้ามี = paywall รั่ว)
- [ ] จ่ายเงิน (หรือ `EMP_ALLOW_SKIP` บน preview) → review เห็นครบ 18/19 ข้อ + เอกสารแนบท้าย ก.
- [ ] เลือก role → เซ็น → หน้า status มีลิงก์ของอีกฝ่าย
- [ ] เปิดลิงก์ใน **เครื่อง/เบราว์เซอร์อื่น** → กรอก 4 ตัวท้ายผิด → ต้องเตือน · ถูก → เซ็นได้
- [ ] เซ็นครบ 2 ฝ่าย → หน้า done มีเลขใบรับรอง → ดาวน์โหลด PDF
- [ ] PDF ต้องมีครบ: สัญญา · เอกสารแนบท้าย ก. · ใบรับรอง+SHA-256 · ภาคผนวกบัตร (มีลายน้ำ)

### 5) เทสต์ความปลอดภัย (สำคัญ — ทำจริง อย่าข้าม)

- [ ] เอา `row_id` ของสัญญาคนอื่นมายิง `sb.from('emp_contracts').select('*')` ด้วย anon key → **ต้องได้ 0 แถว**
- [ ] ยิง `emp_content` ด้วย `row_id` ที่ยังไม่จ่ายเงิน → ต้องได้ `403 locked`
- [ ] ยิง `emp_get_contract` ด้วย token มั่ว → ต้องได้ `{ok:false,code:'forbidden'}`
- [ ] anon สั่ง `update({payment_completed:true})` → ค่าต้องไม่เปลี่ยน
- [ ] เซ็นแล้วลอง `update({salary:1})` → ค่าต้องไม่เปลี่ยน (trigger ล็อกเนื้อหา)

### 6) หลัง deploy prod

- [ ] อัปโหลด `index-emp.html` ขึ้น GitHub `oslomarco77/JustSign`
- [ ] ผูก subdomain `emp.signdee.com` → `index-emp.html` (returnUrl ของ Beam ชี้ไปที่นี่แล้ว)
- [ ] ลบไฟล์สำรอง `api/*.bak-emp` ออก (ผมลบจากที่นี่ไม่ได้ — permission)
- [ ] สร้าง NDA ทดสอบ 1 ฉบับ เช็คว่าการแก้บั๊ก `extractJson` ไม่ทำให้ข้อ 1 เพี้ยน

---

## 🔴 ยังต้องทำก่อนเปิดขายจริง

1. **ทนายตรวจ clause** — `api/_emp_templates.js` โดยเฉพาะข้อ **10, 11, 12, 15, 16, 19**
   ข้อ 12 (ความรับผิดในทรัพย์สิน) และ 15 (การหักค่าจ้าง) เขียนให้แคบกว่าที่นายจ้างส่วนใหญ่อยากได้ **โดยตั้งใจ** — เพราะข้อที่กว้างกว่านี้ขัด ม.76
2. **ตารางค่าจ้างขั้นต่ำรายจังหวัด** — ตอนนี้ hardcode เทียบกับ 337 บาท/วัน (ขั้นต่ำสุด) ในไฟล์ HTML เท่านั้น
   ควรย้ายไปตาราง `emp_config` แล้วเทียบตามจังหวัดจริงจากที่อยู่ในบัตร
3. **Privacy Policy / ToS ของ Employment** — ยังใช้ของ NDA ไม่ได้ (เก็บข้อมูลลูกจ้างซึ่งเป็นข้อมูลการจ้างงาน)
4. **ตัดสินใจเรื่องพยาน 2 คน** — ต้นแบบของ นอแมด มี ปัจจุบันยังไม่ทำ (ใช้ Audit Trail แทน)
