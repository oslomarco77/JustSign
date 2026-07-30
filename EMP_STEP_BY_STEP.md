# SignDee Employment — ลงทีละสเต็ป

ทำเรียงจากบนลงล่าง **ห้ามข้าม** แต่ละสเต็ปมี "ต้องเห็นอะไร" บอกไว้ ถ้าไม่ตรง หยุดตรงนั้นก่อน

เวลาโดยประมาณทั้งหมด: **40–60 นาที** (ไม่รวมรอทนายตรวจ)

---

# สเต็ป 1 — รัน SQL ใน Supabase (10 นาที)

**ต้องทำก่อนทุกอย่าง** ถ้าข้ามไป deploy เลย แอปจะพังตอนกดสร้างสัญญา

### 1.1 เปิด SQL Editor

1. ไปที่ https://supabase.com/dashboard
2. เลือกโปรเจกต์ `vopercafgleteuahwvkf`
3. เมนูซ้าย → **SQL Editor** → ปุ่ม **+ New query**

### 1.2 วางและรัน

1. เปิดไฟล์ `D:\justsign-api\api\emp_contracts.sql`
2. **Ctrl+A → Ctrl+C** (เอาทั้งไฟล์ ห้ามตัด)
3. วางในช่อง SQL Editor
4. กด **Run** (หรือ Ctrl+Enter)

### 1.3 ✅ ต้องเห็นอะไร

ด้านล่างจะมีผลลัพธ์ 2 ตาราง

**ตารางที่ 1 — policies** ต้องมี **2 แถวเท่านั้น**

| tablename | policyname | cmd | roles |
|---|---|---|---|
| emp_contracts | emp_anon_insert | INSERT | {anon} |
| emp_contracts | emp_anon_update | UPDATE | {anon} |

> 🚨 **ถ้ามีแถว `SELECT` โผล่มา** = มี policy เก่าค้าง ให้รัน:
> `drop policy if exists "ชื่อ policy นั้น" on public.emp_contracts;` แล้วเช็คใหม่

**ตารางที่ 2 — routines** ต้องมี 6 แถว ทุกแถว `security_type = DEFINER`

```
emp_get_contract        DEFINER
emp_issue_tokens        DEFINER
emp_new_contract        DEFINER
emp_purge_old           DEFINER
emp_sign_status         DEFINER
emp_submit_signature    DEFINER
```

> ถ้าขาดตัวไหน = SQL รันไม่ครบ ให้เลื่อนขึ้นไปดู error สีแดง แล้วรันใหม่ทั้งไฟล์ (รันซ้ำได้ ไม่พัง)

### 1.4 เปิด pg_cron (ถ้ายังไม่เปิด)

ถ้าเห็นข้อความ `extension pg_cron does not exist` หรืออยากให้ลบข้อมูลอัตโนมัติ 60 วัน:

1. เมนูซ้าย → **Database** → **Extensions**
2. ค้น `pg_cron` → เปิดสวิตช์
3. กลับไป SQL Editor → รันเฉพาะ **block ที่ 6** ของไฟล์ (`-- 6) RETENTION`) ซ้ำอีกรอบ

> ข้ามได้ ไม่กระทบการใช้งาน แต่ข้อมูลบัตรประชาชนจะไม่ถูกลบอัตโนมัติ

---

# สเต็ป 2 — เช็ค ENV ใน Vercel (5 นาที)

### 2.1 เปิดหน้า Environment Variables

https://vercel.com → project `justsign-api` → **Settings** → **Environment Variables**

### 2.2 ที่ต้องมีอยู่แล้ว (ไม่ต้องเพิ่ม แค่เช็คว่ามี)

```
SUPABASE_URL
SUPABASE_SERVICE_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
TURNSTILE_SECRET
BEAM_MERCHANT_ID
BEAM_API_KEY
BEAM_ENV
ADMIN_PASSWORD
```

> ถ้า `ANTHROPIC_API_KEY` หายไป → Job Description จะใช้ seed แทน (ยังใช้งานได้ แค่ไม่ได้ AI)

### 2.3 เพิ่ม 1 ตัว — เฉพาะ Preview

| Key | Value | Environment |
|---|---|---|
| `EMP_ALLOW_SKIP` | `1` | ✅ Preview เท่านั้น ❌ ห้ามติ๊ก Production |

ใช้ข้ามการจ่ายเงินตอนทดสอบ

> 🚨 **ย้ำ: ห้ามติ๊ก Production** ไม่งั้นใครก็ได้สัญญาฟรี

### 2.4 ✅ ต้องเห็นอะไร

`EMP_ALLOW_SKIP` ขึ้นในลิสต์ โดยคอลัมน์ Environments แสดงแค่ **Preview**

---

# สเต็ป 3 — Deploy ขึ้น Preview (5 นาที)

### 3.1 รันคำสั่ง

เปิด PowerShell หรือ Command Prompt:

```bash
cd D:\justsign-api
vercel
```

ถ้าถามอะไรมา ตอบตามนี้:

| คำถาม | ตอบ |
|---|---|
| Set up and deploy? | **Y** |
| Which scope? | เลือก account ของคุณ |
| Link to existing project? | **Y** |
| What's the name of your existing project? | `justsign-api` |

### 3.2 ✅ ต้องเห็นอะไร

```
✅  Production: https://justsign-api-xxxxxxx.vercel.app  [copied to clipboard]
```

**คัดลอก URL นี้ไว้** เรียกมันว่า `<PREVIEW>` ในสเต็ปถัดไป

> ถ้าเจอ error `npm-install-254` → ลบ `D:\justsign-api\package.json` ออกแล้วรันใหม่
> ถ้า `vercel login` ไม่ผ่าน → เลือก **Continue with Email** แล้วกดลิงก์ในอีเมล

---

# สเต็ป 4 — เทสต์ flow หลัก (15 นาที)

**เปิดใน Incognito เสมอ** (กัน localStorage เก่ารบกวน)

เปิด `<PREVIEW>/index-emp.html`

### 4.1 หน้าแรก
✅ เห็นหัวข้อ "สร้างสัญญาจ้างงานใน 2 ขั้นตอน" + ปุ่ม "เริ่มสร้างสัญญา"

### 4.2 STEP 1 — ตำแหน่งงาน

| ทำ | ✅ ต้องเห็น |
|---|---|
| พิมพ์ `พนัก` ในช่องตำแหน่ง | dropdown กรองเหลือไม่กี่ตัว |
| เลือก "พนักงานขาย" | JD ขึ้น **ทันที** (seed) แล้วเปลี่ยนเป็นของ AI ใน 3–8 วินาที |
| ลบ 1 บรรทัดในขอบเขตงาน | บรรทัดหาย ปุ่ม "ถัดไป" ยัง active (เหลือ ≥3) |
| ลบจนเหลือ 2 บรรทัด | ปุ่ม "ถัดไป" **เทา** |
| พิมพ์ `ช่างซ่อมแอร์` (ไม่มีในลิสต์) | มีแถว `+ ใช้ "ช่างซ่อมแอร์" เป็นตำแหน่งงาน` → กดแล้ว AI ร่างให้ |

> 🚨 ถ้า JD ไม่เปลี่ยนจาก seed เลยภายใน 10 วิ → เปิด DevTools (F12) → Console ดู error
> น่าจะ `ANTHROPIC_API_KEY` ไม่มี หรือ Turnstile บล็อก — **ไม่บล็อกการใช้งาน ไปต่อได้**

### 4.3 STEP 1b — รายละเอียดการจ้าง

ทดสอบ warning ทีละอันก่อนกรอกของจริง:

| ทำ | ✅ ต้องเห็น warning |
|---|---|
| เงินเดือน `8000` + วันทำงาน จ–ศ | "อาจต่ำกว่าค่าจ้างขั้นต่ำ" |
| เวลา `08:00`–`19:00` | "เกินเวลาทำงานปกติตามกฎหมาย" |
| กด pill "ชั่วคราว" | "สัญญาจ้างที่มีกำหนดระยะเวลา…ยังต้องจ่ายค่าชดเชย" |
| ติ๊ก "ปฏิบัติงานที่สถานประกอบการของลูกค้า" | ช่องกรอกชื่อหน่วยงาน + warning **ม.11/1** |
| ติ๊ก "เพิ่มข้อจำกัดหลังพ้นสภาพ" | pill 2 ตัว + warning ข้อสัญญาที่ไม่เป็นธรรม |

แล้วกรอกของจริง: เงินเดือน `25000` · เต็มเวลา · จ–ศ · 09:00–18:00 · สถานที่ `สำนักงานใหญ่ กรุงเทพฯ` · วันเริ่มงานตาม default

✅ บรรทัดสรุปด้านล่างอ่านเป็นประโยคได้ถูกต้อง · ปุ่ม "ถัดไป" active

### 4.4 STEP 2 — บัตรประชาชน

ใช้รูปบัตรจริง 2 ใบ (คนละคน)

| ทำ | ✅ ต้องเห็น |
|---|---|
| อัปโหลดบัตรนายจ้าง | รูปย่อขึ้น + ฟอร์มมีชื่อ/เลขบัตร/ที่อยู่/**วันออกบัตร**/บัตรหมดอายุ |
| แก้เลขบัตรให้ผิด 1 ตัว | ช่องเป็นสีแดง + "เลขบัตร 13 หลักตรวจไม่ผ่าน" |
| ใช้บัตรใบเดียวกันทั้ง 2 ฝ่าย | กด "สร้างสัญญา" แล้วเด้ง "ต้องเป็นคนละบุคคล" |
| ติ๊ก "นายจ้างเป็นนิติบุคคล" | ฟอร์มบริษัทขึ้น · ไม่กรอกครบ → ปุ่มเทา + บอกว่าขาดช่องไหน |
| ติ๊ก PDPA + ข้อมูลครบ | ปุ่ม "สร้างสัญญา" active |

### 4.5 Processing + Preview

✅ เห็น 9 บรรทัดวิ่งทีละอัน → เข้าหน้า preview

**🔒 จุดสำคัญที่สุดของการเทสต์:**

- เห็นหัวสัญญา "หนังสือสัญญาจ้าง" + คู่สัญญา + **ข้อ 1 กับข้อ 2 อ่านได้ชัด**
- **ข้อ 3 ขึ้นไปเบลอหมด** มีไอคอนกุญแจ
- เอกสารแนบท้าย ก. เบลอด้วย

### 4.6 ตรวจว่า paywall ไม่รั่ว (ห้ามข้าม)

1. กด **F12** → แท็บ **Network**
2. กด **F5** โหลดหน้าใหม่ แล้วทำซ้ำจนถึงหน้า preview (หรือหา request ที่ค้างอยู่)
3. หา request ไปที่ `myip` ที่มี `emp_generate`
4. คลิก → แท็บ **Response**

✅ **ต้องเห็น** `"c3": "3. 🔒 ปลดล็อกสัญญาฉบับเต็ม..."` — คือมีแต่ข้อความ placeholder

🚨 **ถ้าเห็นเนื้อกฎหมายจริงของข้อ 3–18 ใน response** = paywall รั่ว **หยุดทันที** อย่า deploy prod

---

# สเต็ป 5 — เทสต์การจ่ายเงิน + ลงนาม (10 นาที)

### 5.1 ข้ามการจ่ายเงิน (Preview เท่านั้น)

เปิด Console (F12) แล้ววาง:

```js
fetch('/api/myip',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({action:'emp_content',row_id:localStorage.emp_contract_row_id,skip:true})})
 .then(r=>r.json()).then(j=>{console.log(j.ok?'✅ unlocked':'❌',j.code||'');});
```

✅ ต้องขึ้น `✅ unlocked` → กด **F5** แล้วกดปุ่ม "กลับไปที่สัญญาที่ค้างอยู่"

> ถ้าได้ `❌ locked` แปลว่า `EMP_ALLOW_SKIP` ไม่ได้ผล — เช็คว่าตั้งใน **Preview** environment แล้ว redeploy

**หรือ** จ่ายจริง ฿790 ผ่าน QR PromptPay ก็ได้ (แนะนำทำอย่างน้อย 1 ครั้งก่อนขึ้น prod)

### 5.2 หน้า Review

✅ เห็นครบ **18 ข้อ** (หรือ 19 ถ้าเปิดข้อจำกัดหลังพ้นสภาพ) + เอกสารแนบท้าย ก. ไม่เบลอ
✅ มีการ์ดข้อมูลนายจ้าง/ลูกจ้าง + SHA-256

### 5.3 เซ็นฝั่งผู้ร่าง

1. เลือก "นายจ้าง" → กด "ยืนยันและไปลงนาม"
2. ติ๊กยินยอม → เซ็นในกรอบ → กด "บันทึกลายเซ็น"

✅ ไปหน้า status · มีลิงก์ของ "ลูกจ้าง" 1 ลิงก์ · แถวสถานะ "นายจ้าง ลงนามแล้ว ✓"

> 🚨 ถ้าเด้ง "ออกลิงก์ลงนามไม่สำเร็จ (unpaid)" = สเต็ป 5.1 ยังไม่ผ่านจริง

### 5.4 เซ็นทางไกล

1. กด "คัดลอกลิงก์" → เปิดใน **เบราว์เซอร์อื่น หรือ Incognito หน้าต่างใหม่**
2. ลองกรอก 4 ตัวท้าย **ผิด** → ✅ ขึ้น "เลขไม่ตรงกับข้อมูลในสัญญา"
3. กรอกให้ถูก → ติ๊กยินยอม → เซ็น → กด "ลงนาม"

✅ ขึ้น "ลงนามเรียบร้อย ✓" แล้วเด้งไปหน้า done พร้อมเลขใบรับรอง `SDE-2569-XXXXXXXXXXXX`
✅ กลับไปดูหน้าต่างแรก — ภายใน 5 วิ สถานะ "ลูกจ้าง ลงนามแล้ว ✓" และปุ่มดาวน์โหลดโผล่

### 5.5 PDF

กด "ดาวน์โหลด PDF ฉบับสมบูรณ์" → รอ 5–15 วิ

✅ ไฟล์ต้องมีหน้าเหล่านี้ครบ:
1. หนังสือสัญญาจ้าง (หัว "ทำที่" + "วันที่" + คู่สัญญา + ข้อ 1–6)
2. ข้อ 7–18 (แบ่งหน้าอัตโนมัติ)
3. หน้าลงนาม — **มีลายเซ็นทั้ง 2 ฝ่ายเป็นรูป**
4. เอกสารแนบท้าย ก. — Job Description
5. ใบรับรองการลงลายมือชื่อ — เลขที่ใบรับรอง · เวลาลงนาม (ไทย + UTC) · IP · อุปกรณ์ · SHA-256
6. ภาคผนวก — รูปบัตร 2 ใบ **มีลายน้ำแดงทับ**

> 🚨 ถ้าลายเซ็นไม่ขึ้นใน PDF → เช็ค Console หา error ของ html2canvas
> 🚨 ถ้า PDF ว่างเปล่า → ลองใหม่บนเดสก์ท็อป (มือถือบางรุ่น html2canvas มีปัญหา)

---

# สเต็ป 6 — เทสต์ความปลอดภัย (5 นาที · ห้ามข้าม)

เปิด Console บนหน้า `<PREVIEW>/index-emp.html` แล้ววางทีละชุด

### 6.1 anon อ่านตารางตรง ๆ ไม่ได้

```js
sb.from('emp_contracts').select('*').limit(5)
 .then(r=>console.log(!r.data||r.data.length===0 ? '✅ อ่านไม่ได้ (ถูกต้อง)' : '🚨 รั่ว! อ่านได้ '+r.data.length+' แถว', r.error?.message||''));
```

✅ ต้องได้ `✅ อ่านไม่ได้ (ถูกต้อง)`

### 6.2 token มั่วเข้าไม่ได้

```js
sb.rpc('emp_get_contract',{p_id:localStorage.emp_contract_row_id,
  p_token:'00000000-0000-0000-0000-000000000000'})
 .then(r=>console.log(r.data?.ok===false ? '✅ ถูกปฏิเสธ (ถูกต้อง)' : '🚨 รั่ว!', r.data));
```

✅ ต้องได้ `✅ ถูกปฏิเสธ` พร้อม `code: "forbidden"`

### 6.3 anon แก้สถานะจ่ายเงินไม่ได้

```js
sb.from('emp_contracts').update({payment_completed:true,salary:1})
 .eq('id',localStorage.emp_contract_row_id)
 .then(()=>sb.rpc('emp_sign_status',{p_id:localStorage.emp_contract_row_id,p_token:localStorage.emp_creator_token}))
 .then(r=>console.log('payment_completed =',r.data.payment_completed,'(ต้องเป็นค่าเดิม ไม่ใช่เปลี่ยนเพราะคำสั่งนี้)'));
```

✅ ค่าต้องเท่าเดิม — ถ้าก่อนหน้ายังไม่จ่าย ต้องยัง `false`

### 6.4 แก้เนื้อสัญญาหลังเซ็นไม่ได้

```js
sb.from('emp_contracts').update({salary:1,position_th:'แฮ็ก'})
 .eq('id',localStorage.emp_contract_row_id)
 .then(()=>fetch('/api/myip',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({action:'emp_content',row_id:localStorage.emp_contract_row_id})}))
 .then(r=>r.json())
 .then(j=>console.log('ตำแหน่งใน meta =',j.meta?.position,'(ต้องไม่ใช่ "แฮ็ก")'));
```

✅ ต้องเป็นตำแหน่งเดิม

> 🚨 **ถ้าข้อไหนใน 6.1–6.4 ไม่ผ่าน อย่า deploy production** ส่งผลลัพธ์มาให้ผมดูก่อน

---

# สเต็ป 7 — Deploy Production (5 นาที)

**ทำต่อเมื่อสเต็ป 4, 5, 6 ผ่านหมดแล้วเท่านั้น**

### 7.1 เช็คก่อนกด

- [ ] `EMP_ALLOW_SKIP` **ไม่ได้ติ๊ก Production**
- [ ] สเต็ป 6 ผ่านครบ 4 ข้อ
- [ ] สเต็ป 4.6 (paywall ไม่รั่ว) ผ่าน

### 7.2 รัน

```bash
cd D:\justsign-api
vercel --prod
```

### 7.3 ผูก subdomain (ถ้าอยากใช้ `emp.signdee.com`)

`vercel.json` เพิ่ม redirect ให้แล้ว เหลือแค่:

1. Vercel → project → **Settings** → **Domains** → **Add**
2. ใส่ `emp.signdee.com` → Vercel จะบอกว่าต้องตั้ง DNS อะไร
3. ไปที่ **Z.com** (ที่จดโดเมน) → เพิ่ม **CNAME** `emp` → `cname.vercel-dns.com`
4. รอ 5–30 นาที แล้วเปิด `https://emp.signdee.com`

✅ ต้องเด้งไป `/index-emp.html` อัตโนมัติ

> ถ้ายังไม่ผูก subdomain ก็ใช้ `https://justsign-api.vercel.app/index-emp.html` ได้เลย

### 7.4 เทสต์ production 1 รอบด้วยเงินจริง

สร้างสัญญา 1 ฉบับ จ่าย ฿790 จริง เซ็นครบ 2 ฝ่าย ดาวน์โหลด PDF

> ไม่ใช่ความสิ้นเปลือง — นี่คือการเช็คว่า Beam production key ทำงาน ซึ่งเทสต์บน preview ไม่ครอบคลุม

---

# สเต็ป 8 — เก็บงาน (5 นาที)

### 8.1 อัปขึ้น GitHub

```bash
cd D:\justsign-api
git add index-emp.html api/_emp_templates.js api/_emp_positions.json api/emp_contracts.sql api/myip.js api/create-payment-intent.js api/verify-payment-intent.js vercel.json EMP_DEPLOY_CHECKLIST.md EMP_STEP_BY_STEP.md
git commit -m "feat: SignDee Employment contract (index-emp.html + 19-clause templates + emp_contracts RLS/RPC)"
git push
```

repo: `github.com/oslomarco77/JustSign`

### 8.2 ลบไฟล์สำรอง

ลบด้วย File Explorer:

```
D:\justsign-api\api\myip.js.bak-emp
D:\justsign-api\api\create-payment-intent.js.bak-emp
D:\justsign-api\api\verify-payment-intent.js.bak-emp
```

> ไม่ใช่ `.js` เลย Vercel ไม่นับเป็น function — ลบเพื่อความสะอาดเท่านั้น เก็บไว้ก่อนก็ได้

### 8.3 เช็คว่า NDA ยังปกติ

ผมแก้บั๊กใน `myip.js` ที่ NDA ใช้ร่วมกัน (`parseGenJson` → `extractJson`)
เดิมฟังก์ชันนี้พังเงียบ ๆ ทำให้ NDA ไม่เคยได้ใช้ AI เติมข้อ 1 เลย ตอนนี้ใช้ได้แล้ว

- [ ] สร้าง NDA ทดสอบ 1 ฉบับที่ `nda.signdee.com`
- [ ] ดูข้อ 1 ว่าอ่านแล้วเป็นภาษาสัญญาที่ถูกต้อง ไม่ใช่ประโยคที่ผู้ใช้พิมพ์มาดิบ ๆ

> ถ้าอ่านแล้วแย่กว่าเดิม บอกผม จะ revert ให้ (แก้บรรทัดเดียว)

---

# 🔴 ยังต้องทำก่อนเปิดขายให้คนนอก

เรียงตามความเร่งด่วน

1. **ทนายตรวจ clause 19 ข้อ** — ไฟล์ `api/_emp_templates.js` เน้นข้อ **10, 11, 12, 15, 16, 19**
   ข้อ 12 (ความรับผิดในทรัพย์สิน) และ 15 (การหักค่าจ้าง) ผมเขียนให้แคบกว่าที่นายจ้างทั่วไปอยากได้ **โดยตั้งใจ** เพราะเวอร์ชันกว้างกว่านี้ขัด ม.76
2. **Privacy Policy ของ Employment** — ใช้ของ NDA ไม่ได้ เพราะเก็บข้อมูลการจ้างงานซึ่งอ่อนไหวกว่า
3. **ตารางค่าจ้างขั้นต่ำรายจังหวัด** — ตอนนี้เทียบกับ 337 บาท/วัน (ต่ำสุดทั้งประเทศ) เท่านั้น กรุงเทพฯ จริง ๆ คือ 400
4. **ตัดสินใจเรื่องพยาน 2 คน** — ต้นแบบของ นอแมด มี ปัจจุบันใช้ Audit Trail แทน

---

# ถ้าติดตรงไหน

ส่งมาให้ผม 3 อย่างนี้จะช่วยได้เร็วที่สุด:

1. **สเต็ปที่** ติด (เช่น "ติดสเต็ป 5.3")
2. **ข้อความ error** ที่เห็นบนหน้าจอ
3. **Console log** — F12 → Console → คัดลอกบรรทัดสีแดง
