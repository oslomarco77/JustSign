---
name: "signdee"
description: "ใช้ skill นี้ทุกครั้งที่ทำงานกับโปรเจกต์ SignDee — แพลตฟอร์ม e-signing/เอกสารกฎหมายไทยของ Ken ครอบคลุม 5 ผลิตภัณฑ์: สัญญาเช่า (index.html/index-test.html/index-test-liff.html), ซื้อขายคอนโด (index-sale.html), NDA (index-nda.html), สัญญาจ้าง (index-emp.html), Notice ทวงถาม/บอกเลิกสัญญาเช่า (index-notice.html + landing page แยกโปรเจกต์ notice.signdee.com) รวมถึง Vercel backend (justsign-api), Supabase DB + RLS/RPC/trigger, PDF/ใบรับรอง, role-based signing, remote sign token, payment (Stripe/Opn/Beam/Stripe Connect), LINE OA/LIFF, admin dashboard, deploy workflow Trigger เมื่อ: user พูดถึง SignDee, justsign-api, index-*.html, สัญญาเช่า/จ้าง, NDA, ทวงถามค่าเช่า, บอกเลิกสัญญาเช่า, ป.133, ใบตอบรับ, ลงบันทึกประจำวัน, ลายเซ็น, ใบรับรอง, QR signing, notice_cases/emp_contracts/sale_contracts/nda_contracts, Beam, RLS harden, landing page, deploy Vercel — และใช้เป็นต้นแบบเมื่อสร้าง webapp/ผลิตภัณฑ์ใหม่ของ SignDee"
---

# SignDee — Thai E-Signing Platform

แพลตฟอร์ม e-signing / เอกสารกฎหมายไทย 5 ผลิตภัณฑ์ · ตอบเป็นภาษาไทยเสมอ

> **สร้างผลิตภัณฑ์ใหม่?** → อ่าน `# Playbook: สร้างผลิตภัณฑ์ใหม่` ท้ายไฟล์ก่อนเขียนโค้ดบรรทัดแรก

## โครงสร้างโปรเจกต์

```
app.signdee.com/
├── index.html            ← Production สัญญาเช่า (Stripe primary)
├── index-test.html       ← Staging สัญญาเช่า (Omise test + ⚡ skip)
├── index-test-liff.html  ← เวอร์ชัน LINE LIFF (เซ็นในแอป LINE)
├── index-sale.html       ← ซื้อขายคอนโด (sale.signdee.com — redirect ใน vercel.json)
├── index-nda-test.html   ← NDA staging  (index-nda.html = production, ยังไม่เสร็จ)
├── index-emp.html        ← สัญญาจ้าง (Employment)
├── index-notice.html     ← Notice: ทวงถาม/บอกเลิกสัญญาเช่า (Case Management System)
└── dashboard-k9x2.html   ← Admin dashboard

notice.signdee.com/       ← **Vercel project แยก** `signdee-notice` (D:\signdee-notice)
├── index.html            ← Landing page ยิงแอด (quiz 4 ข้อ → ส่ง query params เข้าแอป)
└── assets/hero-video.mp4

justsign-api.vercel.app/  ← Vercel backend (D:\justsign-api) — Hobby cap 12 functions
├── api/verify-charge.js         ← Omise/Opn verify (service_role) · รองรับ table whitelist
├── api/verify-payment-intent.js ← Stripe verify (service_role)
├── api/create-payment-intent.js ← สร้าง+confirm Stripe PaymentIntent (PromptPay) ฿790
│                                   + action=dev_skip (ตรวจ env DEV_SKIP_SECRET)
├── api/create-charge.js         ← Omise charge
├── api/myip.js                  ← GET: คืน IP · POST: OCR บัตร (Gemini/Anthropic)
│                                   + NDA handlers + EMP handlers + `notice_doc`
├── api/admin-stats.js           ← Admin dashboard (ADMIN_PASSWORD)
├── api/line-webhook.js          ← LINE OA webhook + AI chat
├── api/save-liff-signature.js   ← บันทึกลายเซ็นจาก LIFF
├── api/send-contract-pdf.js     ← ส่งลิงก์ PDF ผ่าน LINE เมื่อเซ็นครบ
├── api/start-reminder.js        ← เริ่ม reminder timer ตอนส่งลิงก์เซ็น
├── api/sign-reminder.js         ← เตือนเซ็นทุก 10 นาที · หยุดที่ 30 นาที
├── api/reminder-cron.js         ← cron 02:00 ทุกวัน (vercel.json crons)
└── api/_emp_templates.js        ← helper: clause 19 ข้อ (ขึ้นต้น _ → ไม่นับเป็น function)
    api/_emp_positions.json      ← seed JD 24 ตำแหน่ง / 11 หมวด

Supabase tables:
├── notice_cases       ← Notice (1 เคส = 1 row ทอดยาว 3 ขั้น)
├── contracts          ← สัญญาเช่า
├── sale_contracts     ← ซื้อขายคอนโด
├── nda_contracts      ← NDA
├── emp_contracts      ← สัญญาจ้าง
├── emp_line_link      ← รหัสผูกบัญชี LINE (6 ตัว)
└── sd_connect_accounts← Stripe Connect Express ของผู้ขาย (มัดจำผ่านบัตร)
```

**⚠️ ไฟล์ที่ขึ้นต้นด้วย `_` ใน `api/` = helper ไม่ถูกนับเป็น serverless function** — ใช้เทคนิคนี้เลี่ยง Hobby cap 12 functions

## Deploy Workflow (สำคัญมาก — ห้ามลืม)

```bash
cd D:\justsign-api

# 1) Preview ก่อนเสมอ
vercel

# 2) ทดสอบจาก Preview URL (https://justsign-api-xxxx.vercel.app)
#    → Geo fetch, payment, signing ต้องผ่าน domain จริง (ไม่ใช่ file:///)

# 3) ถ้าผ่าน → production
vercel --prod

# 4) อัปโหลดไฟล์ที่แก้ขึ้น GitHub repo JustSign ทุกครั้ง
#    github.com/oslomarco77/JustSign
```

**ถ้า `vercel login` ไม่ผ่าน:** เลือก "Continue with Email" → link ใน email
**ถ้าถามว่า link to existing project:** เลือก Y → project `justsign-api`

**⚠️ ลำดับ deploy กับ SQL:** ไฟล์ SQL หลายตัวต้องรัน **ก่อน/พร้อม** deploy frontend ใหม่ ไม่งั้นหน้าเว็บพัง (ดูหัวข้อ Security Hardening)

## Syntax Check (บังคับก่อนส่ง output ทุกครั้ง)

```javascript
node -e '
const fs=require("fs");
const html=fs.readFileSync("index.html","utf8");
const re=/<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m,i=0,bad=0;
while((m=re.exec(html))){
  const attrs=m[1]||""; if(/\bsrc\s*=/.test(attrs)) continue;
  i++;
  try { new Function(m[2]); }
  catch(e){ bad++; console.log("Block #"+i+" FAILED:", e.message); }
}
console.log("Blocks:", i, "| failures:", bad, bad===0?"✅":"❌");
'
```

ต้องผ่าน (failures: 0) ก่อนส่งไฟล์ให้ user ทุกครั้ง

---

# 1) สัญญาเช่า — index.html / index-test.html

## ตัวแปรชื่อสำคัญ (ห้ามเปลี่ยน)

| ชื่อ | หน้าที่ |
|---|---|
| `justsign_draft` | localStorage key สำหรับ autosave |
| `_justsign_init` | flag กัน double-init canvas |
| `JUSTSIGN_API` | ตัวแปร JS ชี้ไปที่ backend |
| `JustSign_WithSkip.html` | ชื่อไฟล์ staging เก่า (อย่าเปลี่ยน) |
| `ps_contract_row_id` | localStorage key สำหรับ Supabase row UUID |
| `signdee_creator_role` | localStorage key สำหรับ creator role |

## Clause System (15 ข้อ + ข้อ 16 optional)

มี 4 array/function ที่ต้องซิงค์กันทุกครั้งที่แก้ clause:

| ชื่อ | บรรทัดโดยประมาณ |
|---|---|
| preview array | ~3575 |
| review array | ~3743 |
| `_buildClauses()` | ~7713 |
| HTML template (PDF renderer) | ~5622 |

**Dynamic fields:** `term`/`startD`/`endDate` → ข้อ 5 · `petsAllowed` → ข้อ 6 · `latePenalty = Math.round(rent/30)` → ข้อ 11 · `lateTermDays` → ข้อ 12 · `dep`/`rent`/`bahtText()` → ข้อ 4/4.1

## Role System — Creator Roles

```
window._creatorRole = 'landlord' | 'agent' | 'tenant'
localStorage key: 'signdee_creator_role'
```

| โหมด | ผู้ร่างสัญญา | ผู้ให้เช่า | ผู้เช่าคนที่ 1 |
|---|---|---|---|
| `landlord` | ผู้ให้เช่า | เซ็นในแอป (step 12) | เซ็นทางไกล `rt_` |
| `agent` | เอเจนท์ | เซ็นทางไกล `rl_` | เซ็นทางไกล `rt_` |
| `tenant` | ผู้เช่า | เซ็นทางไกล `rl_` | **เซ็นในแอป (step 12)** |

```javascript
function _roleNow()           { return window._creatorRole || 'landlord'; }
function _landlordIsRemote()  { const r = _roleNow(); return r === 'agent' || r === 'tenant'; }
function _tenant1IsRemote()   { return _roleNow() !== 'tenant'; }
```

**กฎ:** ใช้ `_landlordIsRemote()` / `_tenant1IsRemote()` เสมอ ห้ามใช้ `window._creatorRole === 'agent'` ตรงๆ (ยกเว้น agent-only logic เช่น dispatch banner)

### 15 touchpoints ที่ต้อง update ทุกครั้งที่เพิ่ม/แก้ role

1. Role card UI (`rc-card onclick`)
2. `_chooseRole(role)` — ternary guard
3. `_updateRolePill()` — pill text + role helpers บรรทัดถัดจาก closing brace
4. `initSignatureStep` — landlord remote vs in-app
5. `canvas.onmouseup/ontouchend` — tn signature capture (`_tnSigImgLocal`)
6. canvas clear — `window._tnSigImgLocal = null`
7. `_saveTenantCreatorSignature()` — definition (mirror `_saveLandlordCreatorSignature`)
8. 3 จุดที่เรียก `_saveLandlordCreatorSignature()` — เพิ่ม tenant call คู่กัน
9. PDF `llSigImg` — remote condition
10. Preview `_llRemoteSig` + lazy fetch — remote condition
11. `initContractReview` wrapper — QR panel show/hide + polling
12. `_upsertReadTokenToSupabase` — landlord token write gate
13. `_maybeUnlockAfterTenants()` — unlock logic
14. Completion toast
15. Draft restore (2 จุด) — accept new role value

## Signing Token Patterns (เช่า — legacy)

```
rt_<rowId>  → ผู้เช่าคนที่ 1
rt2_<rowId> → ผู้เช่าคนที่ 2
rl_<rowId>  → ผู้ให้เช่า
```

**⚠️ รูปแบบนี้เดาได้ (audit M3)** — ผลิตภัณฑ์ใหม่ (emp) ใช้ uuid ที่ DB สร้างแทน

**Supabase RPCs (SECURITY DEFINER):**
- `get_contract_for_edit(p_id text)` → อ่านสัญญาสำหรับ creator (reload/status)
- `check_landlord_signature` / `submit_landlord_signature(row_id, sig, device, ip)`
- `check_tenant_signature` / `submit_tenant_signature`

## Signature Save Functions

```javascript
async function _saveLandlordCreatorSignature()  // โหมด landlord/agent
async function _saveTenantCreatorSignature()    // โหมด tenant
```

**Pattern ทั้งคู่:** (1) ถ้า `window._reloadMode` → return · (2) check role guard · (3) หา rowId จาก `contractRowId` หรือ localStorage · (4) ดึง sig จาก `window._llSigImgLocal`/canvas · (5) ตรวจ DB ว่ามีแล้วหรือยัง (ไม่ทับของเดิม) · (6) ดึง IP จาก `/api/myip` (best-effort) · (7) update Supabase

## Supabase Schema — contracts (key columns)

```sql
-- Signing
landlord_signature / tenant_signature      text    -- base64 PNG
landlord_signed_at / tenant_signed_at      timestamptz
ll_sign_ip / tn_sign_ip / tn2_sign_ip      text
ll_sign_device / tn_sign_device / tn2_sign_device  text

-- Tokens
read_token          text  -- rt_  ผู้เช่าคนที่ 1
read_token2         text  -- rt2_ ผู้เช่าคนที่ 2
landlord_read_token text  -- rl_  ผู้ให้เช่า

-- Payment
payment_completed   boolean -- PROTECTED (trigger block anon write)
payment_ref         text

-- Role & State
creator_role        text    -- 'landlord' | 'agent' | 'tenant'
has_tenant2         boolean
extra_clause        text    -- ข้อ 16 optional

-- นิติบุคคล (contracts_juristic_columns.sql)
ll_is_juristic / tn_is_juristic  boolean default false
ll_jur_name    / tn_jur_name     text
ll_jur_regno   / tn_jur_regno    text   -- เลขทะเบียน 13 หลัก
ll_jur_signer  / tn_jur_signer   text   -- ผู้มีอำนาจลงนาม

-- Media (jsonb)
ll_card / tn_card / pay_slips / deposit_slips

-- Retention
created_at  timestamptz
-- pg_cron ลบอัตโนมัติหลัง 60 วัน
-- ?reload=<rowId> กู้คืน contract ทั้งหมดได้
```

## Staging Rules (index-test.html)

| สภาพแวดล้อม | ผล |
|---|---|
| `file:///` | UI เท่านั้น (CORS block API) |
| Vercel Preview URL | ทดสอบ API / geo ได้ครบ |
| `vercel --prod` | production จริง |

- **Skip button (staging only):** ต้องผ่าน `await saveToSupabase()` ก่อนถึงจะ active · `_isTestEnv()` ใน production hardcode `return false`
- **identifier เฉพาะ test ที่ห้ามมีใน production:** `skipToolbar`, `skipToStep`, `toggleSkipMenu`, `_fillMockData`, `_fillMockSignatures`
- **กฎแก้ไข:** แก้ logic ใหม่ → เทสต์ใน `index-test.html` ก่อนเสมอ → ผ่านแล้วค่อย apply ซ้ำใน `index.html` (โครงสร้างเหมือนกันเป๊ะ → ใช้ str_replace ชุดเดิมได้)

---

# 2) ซื้อขายคอนโด — index-sale.html

- Domain: `sale.signdee.com` → redirect ไป `/index-sale.html` (ตั้งใน `vercel.json`)
- Token: `seller_read_token` (`rs_`) / `buyer_read_token` (`rb_`)
- RPC อ่าน: `get_sale_contract_for_read(p_token text)` → jsonb (SECURITY DEFINER)
  - **ข้อจำกัด:** `jsonb_build_object` รับ argument ได้สูงสุด 100 → ถ้าจะเพิ่ม field ต้องต่อด้วย `|| jsonb_build_object(...)` ก้อนที่สอง
- Trigger: `protect_sale_payment_columns` → `trg_protect_sale_payment`

## มัดจำผ่านบัตรเครดิต — Stripe Connect Express

ตาราง `sd_connect_accounts`: `member_uid` (`line:Uxxx`/`google:...`) ↔ `stripe_account_id` (`acct_xxx`) + `charges_enabled` / `payouts_enabled` / `details_submitted` / `requirements_due`

คอลัมน์ใน `sale_contracts` (prefix `deposit_` ใหม่ ไม่ชนของเดิม):

```sql
deposit_channels        jsonb   -- {transfer:true, card:true} ช่องทางที่ผู้ขายเปิด
seller_bank_account     jsonb   -- {bank, no, name} กรณีโอนเอง
deposit_stripe_account  text    -- snapshot acct_xxx ตอนสร้างสัญญา
deposit_pay_via         text    -- 'transfer' | 'card' (ผู้ซื้อเลือกจริง)
deposit_paid_at         timestamptz
deposit_amount_paid     integer -- หน่วยสตางค์ (บัตร = รวม fee)
deposit_charge_id       text    -- Stripe charge/PI id
deposit_payout_status   text    -- 'pending'|'in_transit'|'paid'|'failed'
deposit_payout_eta      date
deposit_payout_id       text
```

---

# 3) NDA — index-nda-test.html

Flow: `landing→step1→step2(OCR)→proc→preview(blur c2-8)→pay→review→sign→status→remote→done`

- **8 ข้อจากไฟล์ Word เท่านั้น** — AI เติม slot ผ่าน `extractSlots` ไม่ร่างเนื้อหาเอง (หลังลองใช้ AI ร่าง 16 ข้อแล้วล้มเลิก)
- Party label: **"ผู้ให้ข้อมูล/ผู้รับข้อมูล"** เสมอ (ห้ามใช้ "ฝ่าย ก./ข.")
- Backend: NDA `generate`/`content`/`notify` handlers รวมอยู่ใน `myip.js` routed via POST `{action}` · model `claude-haiku-4-5-20251001`, `max_tokens 5000` (assistant prefill ใช้ไม่ได้)
- `verify-charge.js` รับ `table:'nda_contracts'` ผ่าน whitelist
- Evidence PDF = หน้าสัญญาแบบ Word + certificate สไตล์ SignDee + ภาคผนวกบัตร ปชช. พร้อมลายน้ำ
- **frontend ไม่แตะตารางเลย** — เขียนผ่าน backend service_role ทั้งหมด
- LINE columns: `a_line_user_id` / `b_line_user_id` / `creator_line_user_id` + `*_line_name` / `*_line_verified_at` / `*_verify_method` (`'line_login'`|`'id_last4'`) + `line_notified_at` (กันส่งซ้ำ) + index บน a/b line uid สำหรับ `line-webhook`

**Mock OCR IDs (checksum ถูกต้อง):** `1101700207277` / `1101700207285`

---

# 4) สัญญาจ้าง — index-emp.html (Employment)

ไฟล์: `index-emp.html` (240 KB) · `_emp_templates.js` (61 KB) · `_emp_positions.json` (42 KB) · SQL: `emp_contracts.sql` + `emp_line_link.sql`

## Phase state machine (13 phase)

```
ph-landing → ph-sso → ph-step1 (ตำแหน่ง+JD) → ph-step1b (เงื่อนไขจ้าง)
→ ph-step2 (OCR บัตร) → ph-proc → ph-preview → ph-pay → ph-review
→ ph-sign → ph-status → ph-remote → ph-done      (+ ph-dash = สัญญาของฉัน)
```

## Clause 19 ข้อ (18 + ข้อ 19 optional) — `_emp_templates.js`

**หลักการ:** เนื้อกฎหมายเป็น template คงที่ **AI ไม่แตะ** · AI ทำแค่ Job Description (เอกสารแนบท้าย ก.) ซึ่งเป็น business content · slot ทุกตัวมาจากฟอร์ม → output deterministic → `doc_hash` เสถียร

Export: `buildEmpClauses(ctx)` / `empClauseCount(clauses)` / `bahtText()` / `thDateFull()` / `workDaysText()` / `restDaysText()` / `wageRates()` / `EMP_T` / `EMP_INTRO` / `EMP_CLOSING`

**Dynamic logic ที่ต้องระวัง:**
- ข้อ 2 — เลขข้อย่อยเลื่อนอัตโนมัติตามว่ามี `allowance` / `bonus` หรือไม่ (`{PAY_N}` / `{RCPT_N}`)
- ข้อ 3 — `probation_days > 0` ใช้ `c3` · = 0 ใช้ `c3_none`
- ข้อ 4 — `client_site` → เติม `EMP_T.clientSite` (โหมดรับเหมาบริการ ม.11/1)
- ข้อ 6 — `restDaysText(work_days)` คำนวณวันหยุดจากวันทำงาน
- ข้อ 9 — `is_minor` → ต่อท้ายด้วย `EMP_T.minor` (บทแรงงานเด็ก)
- ข้อ 19 — `restrict_level`: `'none'` (ไม่มีข้อ 19) | `'nonsolicit'` | `'noncompete'` (+ `restrict_area`) · `clampMonths(restrict_months)`

อ้างอิงกฎหมาย: พ.ร.บ.คุ้มครองแรงงาน พ.ศ. 2541 (ม.118 ค่าชดเชย, ม.11/1 รับเหมาบริการ)

**⚠️ ต้องให้ทนายตรวจก่อนเปิดขาย โดยเฉพาะข้อ 10, 11, 12, 15, 16, 19**

## Seed JD — `_emp_positions.json`

24 ตำแหน่ง / 11 หมวด (`sales`, `tech`, `hr`, `finance`, `health`, `marketing`, `operations`, `service`, `admin`, `creative`, `education`)
โครงสร้าง: `{code, th, en, category, chip, jd:{responsibilities[], qualifications[], kpis[]}}`
ใช้เป็น (ก) fallback เมื่อ AI ล่ม (ข) optimistic render ระหว่างรอ AI (ค) ชุดทดสอบ
**ทุกรายการเลี่ยงการระบุเพศ อายุ ศาสนา เชื้อชาติ รูปลักษณ์**

## API actions (POST → `/api/myip`)

`emp_jd` · `emp_generate` · `emp_content` · `emp_link_start` · `emp_link_poll` · `emp_claim` · `emp_my_contracts`

## Security model (ยกระดับจากของเดิม — ตาม SignDee_Security_Audit.md 23 ก.ค. 2026)

| หลักการ | รายละเอียด |
|---|---|
| **ไม่มี anon SELECT เลย** | อ่านผ่าน RPC SECURITY DEFINER ที่ตรวจ token เท่านั้น → กัน enumerate ข้อมูลบัตร ปชช. (PDPA) |
| **ไม่มี anon UPDATE** | เขียนผ่าน backend service_role (whitelist `EMP_WRITABLE`) หรือ RPC เท่านั้น |
| **token = uuid สร้างฝั่ง DB** | ไม่ใช่ `'rt_'+rowId` ที่เดาได้ (audit M3) |
| **ล็อกเนื้อสัญญาหลังเซ็น** | trigger คืนค่าเก่าทุกคอลัมน์เนื้อหาเมื่อ `a_signed_at`/`b_signed_at` ไม่ null |

**Tokens:** `creator_token` (default `gen_random_uuid()`) · `a_read_token` / `b_read_token` (ออกโดย `emp_issue_tokens` เฉพาะเมื่อจ่ายเงินแล้ว)

**Trigger `emp_protect_columns` → `trg_emp_protect`** — ไม่ใช้ SECURITY DEFINER โดยตั้งใจ เพื่อให้ `current_user` สะท้อน role ผู้เรียกจริง · บล็อกเฉพาะ `anon`/`authenticated`

**RPC (grant execute to anon):**

| RPC | หน้าที่ |
|---|---|
| `emp_new_contract()` | สร้างแถวใหม่ → คืน `id` + `creator_token` + `contract_no` (`EMP-{ปีพ.ศ.}-XXXX`) |
| `_emp_role(p_id, p_token)` | ตรวจ token → `'creator'`\|`'a'`\|`'b'`\|null · **revoke จาก anon** |
| `emp_get_contract(p_id, p_token)` | creator ได้ครบ (ลบ `creator_token`) · ผู้เซ็นทางไกลไม่ได้รูปบัตรอีกฝ่ายและไม่ได้ token ใดๆ |
| `emp_sign_status(p_id, p_token)` | สำหรับ polling — เบากว่า `emp_get_contract` |
| `emp_issue_tokens(p_id, p_token)` | creator เท่านั้น + ต้อง `payment_completed` → ออก a/b read token, set status `'sent'` |
| `emp_submit_signature(p_id, p_token, p_party, p_signature, p_device, p_ip)` | ตรวจ role ตรงฝ่าย · ต้องจ่ายเงินแล้ว · ห้ามทับของเดิม · sig ต้อง ≥ 100 ตัวอักษร · เซ็นครบ → status `'completed'` + `cert_no` |

**Cert No.:** `SDE-{ปีพ.ศ.}-{doc_hash 12 ตัวแรก uppercase}`
**Status:** `draft | ocr_done | generated | paid | reviewed | sent | completed`
**Retention:** `emp_purge_old()` ลบหลัง 60 วัน (pg_cron `17 3 * * *`)

## ผูกบัญชีนายจ้างกับ LINE (`emp_line_link.sql`)

กลไก: แอปสุ่มรหัส 6 ตัว → นายจ้างส่งรหัสในแชต OA → webhook จับคู่ `line_user_id` กับรหัส → แอป poll แล้วได้ session (HMAC จาก backend) → สัญญาที่สร้างหลังจากนั้นผูก `owner_line_id` อัตโนมัติ

- ตาราง `emp_line_link` — RLS เปิด **ไม่มี policy ใดๆ** ให้ anon → เข้าถึงได้เฉพาะ service_role
- คอลัมน์ใหม่ใน `emp_contracts`: `owner_line_id` / `owner_line_name` / `owner_linked_at` (เพิ่มเข้า trigger แล้ว — client แก้ไม่ได้)
- `emp_purge_links()` ลบรหัสเก่าเกิน 1 วัน (pg_cron `23 4 * * *`)

---

# 5) Notice — index-notice.html (ทวงถาม / บอกเลิกสัญญาเช่า)

**Positioning:** *Case Management System* ไม่ใช่ "ระบบสร้างเอกสาร"
1 เคส = 1 row = 1 Timeline ทอดยาวเป็นเดือน · ฿2,990/เคส ครอบ 3 เอกสาร

**จุดต่างจาก 4 ผลิตภัณฑ์เดิม** — เดิมคือ "สัญญา 1 ฉบับ เซ็น 2 ฝ่าย จบ" แต่ Notice คือ
**state machine ที่ขับด้วยวันที่** ปลดล็อกขั้นถัดไปตาม deadline · ไม่มีการเซ็น · คุณค่าหลักคือ
**หลักฐานการส่งและการนับวัน** ไม่ใช่ลายเซ็น

## 3 ขั้นตอน (state machine)

```
draft → demand_ready → demand_sent → (ครบกำหนด)
      → terminate_ready → terminate_sent → evidence → closed
```

| ขั้น | เอกสาร | ปลดล็อกเมื่อ |
|---|---|---|
| 1 | หนังสือทวงถามค่าเช่า | จ่ายเงินแล้ว |
| 2 | หนังสือบอกเลิกสัญญาเช่า | ทำล่วงหน้าได้ทันที **แต่เตือน 3 ชั้น**ว่าต้องลงวันที่/ส่งหลังครบกำหนดขั้น 1 |
| 3 | หนังสือแจ้งตำรวจ (ลงบันทึกประจำวัน) | แถมฟรีในแพ็ก |

## เหตุแห่งการบอกเลิก 2 ทาง (เลือกได้ทั้งคู่)

`arrears.total > 0` (ค้างชำระ) และ/หรือ `breaches[]` (ผิดเงื่อนไขสัญญา 6 ตัวเลือก + "อื่นๆ")
→ **ข้อความในหนังสือปรับตามเหตุอัตโนมัติ** ทั้งชื่อเรื่องและย่อหน้า:

| เหตุ | ชื่อเรื่อง |
|---|---|
| ค้างค่าเช่า | ขอให้ชำระค่าเช่าค้างชำระและค่าน้ำประปา/ค่าไฟฟ้า |
| ผิดสัญญา | ขอให้ปฏิบัติตามสัญญาเช่าให้ถูกต้อง |
| ทั้งสอง | ขอให้ชำระค่าเช่าค้างชำระ และปฏิบัติตามสัญญาเช่าให้ถูกต้อง |

## ตัวเลือกข้อความท้ายหนังสือ — ผูกกับ "ข้อสัญญา" ไม่ใช่ "โทน"

- **กรณีสัญญาระบุให้กลับเข้าครอบครองและตัดน้ำไฟได้** → ใส่ข้อความตัดสาธารณูปโภค
- **กรณีสัญญาไม่ระบุ** → สงวนสิทธิ์บอกเลิก + ดำเนินการตามกฎหมาย เท่านั้น

> สิทธิตัดน้ำไฟ/กลับเข้าครอบครองมาจาก**ข้อสัญญา** ไม่ใช่การเลือกโทนข้อความ
> ผู้ใช้ต้องกลับไปเปิดสัญญาดูก่อนเลือก (`S.softTone` / `S.tmSoftTone`)

## ⚖️ กรอบกฎหมายที่ห้ามหลุด (สำคัญที่สุดของผลิตภัณฑ์นี้)

- **บันทึกประจำวันไม่ให้อำนาจเข้าไปขนของ** — เป็นแค่การบันทึกเหตุการณ์ ตำรวจไม่ได้อนุญาตอะไร
  → เอกสารต้องเขียนว่า *"ขอความอนุเคราะห์ลงบันทึกประจำวันไว้เป็นหลักฐาน"*
  **ห้าม**เขียน *"ขออนุญาตเข้าขนย้ายทรัพย์สิน"* (จะกลายเป็นหลักฐานมัดตัวว่าเจตนาบุกรุก)
- **ขับไล่ด้วยตนเอง (ล็อกประตู/ตัดน้ำไฟ/ขนของ) โดยไม่มีคำพิพากษา** เสี่ยงผิด บุกรุก · ทำให้เสียทรัพย์ · ลักทรัพย์ · กรรโชก
- **ห้ามใช้คำโฆษณารับประกันผล** — "ไล่ผู้เช่าออกได้" · "ครบทุกขั้นตอนที่กฎหมายต้องการ" · "รับประกันใช้ในศาล"
  ให้ใช้แนว *"ช่วยจัดเตรียมเอกสารและหลักฐานของเคสอย่างเป็นระบบ"*
- **ห้ามสื่อว่า SignDee แจ้งตำรวจแทน user** หรือตำรวจจะไล่ผู้เช่าให้อัตโนมัติ

## ป.133 — ใบตอบรับไปรษณีย์ (หัวใจของขั้น 1)

- ส่ง **ตามที่อยู่ในบัตรประชาชนผู้เช่า** (ไม่ใช่ที่อยู่ทรัพย์ที่เช่า — ถ้าย้ายออกแล้วจะอ้างว่าไม่ได้รับ)
- เก็บ: วิธีส่ง · เลขพัสดุ · วันฝากส่ง · **วันที่ผู้รับได้รับ** ← ตัวเริ่มนับ deadline (ไม่ใช่วันส่ง)
- คำนวณ deadline จากใบตอบรับ **ใบหลังสุด** (`effectiveRecvDate`) — ปลอดภัยสุดในทางคดี
- **PDF ป้ายตัดแปะขนาดจริงหน่วย มม.** — `PX_MM = 794/210` (3.781 px/มม.) + `addImage(img,'JPEG',0,0,210,297)`
  map เต็ม A4 → สเกลตรง · มีไม้บรรทัด 50 มม. ให้สอบเทียบ · ผู้ใช้ปรับขนาดชดเชยได้
  ⚠️ ห้ามใช้หน่วย `mm` ใน CSS ของ `#printDoc` (html2canvas ตีสเกลผิด) — ใช้ px ที่คำนวณจาก มม.

## Paywall — server-side จริง (ต่างจาก NDA)

`POST /api/myip {action:'notice_doc', row_id, doc:'demand'|'terminate'|'police'}`
→ อ่าน `notice_cases` ด้วย service_role → เช็ค `payment_completed`

| จ่ายแล้ว | ส่ง `paras` เนื้อหาจริง |
|---|---|
| ยังไม่จ่าย | ส่ง `ntDecoy(3)` = **ข้อความตัวอย่าง** ความยาวใกล้เคียง + `locked:true` |

frontend เบลอ decoy (`.doc-blur`) + ชิป 🔒 โปร่งใสทับกลาง → เห็นรูปทรงเอกสารแต่เนื้อหาจริงไม่เคยออกจาก server
มี **fallback ฝั่ง client** (`LOCK_PLACEHOLDER`) เผื่อ backend ยังไม่ deploy เวอร์ชันที่ส่ง decoy

**⚠️ ผลข้างเคียง:** ข้อความหนังสือทั้ง 3 ฉบับอยู่ใน `myip.js` → ตอนทนายขอแก้ถ้อยคำ ต้องแก้ที่ backend และ deploy ใหม่ (ไม่ใช่แก้ HTML)

## Payment — Beam Lighthouse (PromptPay QR)

```
create-payment-intent  {contract_id, gateway:'beam', product:'notice'} → {charge_id, qr_image_png, expiry}
verify-payment-intent  {payment_intent_id, contract_id, gateway:'beam', product:'notice'} → {paid}
```
- `PRICE_BY_PRODUCT` / `PRODUCT_MAP` เป็น map กลางใน 2 ไฟล์ — **ราคาต้องตรงกัน** (notice = 299000 สตางค์)
- frontend poll ทุก 4 วิ · หยุด poll เมื่อออกจากหน้า
- จ่ายสำเร็จเขียน: `payment_completed` + `payment_ref` + `payment_provider` + `paid_at` + `status='demand_ready'`

## Case Management UX (ผลลัพธ์ UX refactor 3 batch)

- **Case Bar ถาวร** — CASE # + สถานะ + timeline 6 จุด · แสดงตั้งแต่ขั้นกรอกข้อมูล (ไม่รอ `rowId`)
- **Case Dashboard** (หลังจ่าย) — ขั้นตอนปัจจุบันเป็น hero การ์ดสีเข้ม (เลขใหญ่ + CTA) → Timeline → การ์ดเอกสาร 3 ฉบับ
- **`caseStages()`** = แหล่งความจริงเดียวของสถานะเคส (แยกจาก `buildTimeline` เดิม) ใช้ร่วมกัน 3 ที่
  → `caseStatus()` / `currentStage()` / `cbNodeStates()` ต่อยอดจากตัวนี้ **ห้ามคำนวณสถานะซ้ำที่อื่น**
- **Case Summary พับได้** — มือถือ sticky บน · desktop ≥900px ลอยมุมขวาล่าง · ดึงจาก `caseData()`/`arrearTotals()` เดิม
- **Progressive disclosure** ขั้น 4 — เลือกเหตุก่อน ค่อยแสดงการ์ดที่เกี่ยว
  ⚠️ ซ่อนบล็อกแล้ว **ห้ามล้างข้อมูลเงียบ ๆ** — ข้อมูลที่ซ่อนยังเข้า `caseData()` → ต้องขึ้นเตือน + ปุ่มล้างให้ผู้ใช้กดเอง
- ทุกหน้าต้องตอบ 3 คำถาม: **อยู่ขั้นไหน · ต้องทำอะไร · ต่อไปคืออะไร**

## Landing Page (Vercel project แยก)

`D:\signdee-notice` → project `signdee-notice` → `notice.signdee.com`

**ทำไมต้องแยก project:** `rewrites` ของ Vercel ทำงาน**หลัง**เช็คไฟล์จริง — ถ้าอยู่ repo เดียวกัน
`/` จะเจอ `index.html` ของสัญญาเช่าก่อนเสมอ · แยก project ให้ landing เป็น `index.html` ของตัวเอง → URL สะอาด

**Quiz → App handoff:**
```
notice.signdee.com  → quiz 4 ข้อ → ?problem=&contract=&overdue=&status=&theme=&utm_*
app.signdee.com/index-notice.html → readQuizParams() เก็บลง localStorage
   → renderQuizBanner()   แสดงสรุปคำตอบ
   → applyQuizToNewCase()  preset S.cause + จำนวนแถวยอดค้าง
```
| quiz `problem` | → `S.cause` |
|---|---|
| `rent` | rent |
| `leave` / `breach` | breach |
| `both` | both |

---

# Security Hardening — ชุด SQL (ก.ค. 2026)

**⚠️ ทุกไฟล์ idempotent รันซ้ำได้ · แต่ลำดับกับ deploy สำคัญมาก**

| ไฟล์ | ทำอะไร | ต้อง deploy อะไรก่อน/พร้อม |
|---|---|---|
| `fix_c1_payment_bypass.sql` | **C1 — payment bypass** · เพิ่ม trigger `protect_sale_payment_columns` ให้ `sale_contracts` (เดิมมีแต่ `contracts`) · **ลบ RPC `dev_mark_sale_paid`** (secret หลุดใน client) | `index.html` + `index-sale.html` + `create-payment-intent.js` เวอร์ชันใหม่ + ตั้ง env `DEV_SKIP_SECRET` (Production) |
| `rls_harden_contracts.sql` | เพิ่ม RPC `get_contract_for_edit(p_id)` · **ลบ policy `allow_all`** (anon อ่าน/แก้/ลบทุกแถวได้!) และ `tenant can read contract by token` (mass SELECT) · คงไว้ `anon insert` / `anon update` / `tenant can confirm read` | `index.html` เวอร์ชันใหม่ (อ่านผ่าน RPC) — ไม่งั้นหน้าที่อ่าน anon ตรงพัง |
| `rls_harden_sale_nda.sql` | **NDA:** ลบ `nda_anon_all` → บล็อก anon ทั้งหมด (ปลอดภัย frontend ไม่แตะ table) · **SALE:** ลบ `sale_anon_select` → อ่านผ่าน `get_sale_contract_for_read` เท่านั้น | `index-sale.html` เวอร์ชันใหม่ (insert ใช้ client uuid) |
| `fix_sale_rpc_deposit.sql` | แก้ `get_sale_contract_for_read` ให้คืนคอลัมน์ deposit ใหม่ (เดิมขาด → ฝั่งผู้ซื้อไม่เห็นช่องบัตร) · ใช้ `\|\| jsonb_build_object(...)` ก้อนที่สองเพราะเกิน 100 args | — |
| `sale_stripe_deposit.sql` | ตาราง `sd_connect_accounts` + คอลัมน์ `deposit_*` ใน `sale_contracts` | — |
| `contracts_juristic_columns.sql` | คอลัมน์นิติบุคคล `ll_*`/`tn_*` ใน `contracts` | **ต้องรันก่อน** deploy `index.html` ใหม่ ไม่งั้น insert/update error |
| `nda_line_columns.sql` | LINE Login/LIFF columns + index ใน `nda_contracts` | — |
| `sale_line_columns.sql` | `line_notified_at`, `creator_line_*` + index ใน `sale_contracts` | — |
| `emp_contracts.sql` / `emp_line_link.sql` | schema + RLS + RPC + trigger ของสัญญาจ้าง | ก่อน deploy `index-emp.html` |

**dev-skip pattern ใหม่:** ย้ายจาก RPC ฝั่ง DB (secret หลุด) → backend `/api/create-payment-intent` (`action=dev_skip`) ตรวจ env `DEV_SKIP_SECRET`

## Payment Security (Level B)

```
Stripe → /api/verify-payment-intent.js → เขียน payment_completed via service_role
Opn    → /api/verify-charge.js          → เขียน payment_completed via service_role
Trigger: protect_payment_columns (contracts) / trg_protect_sale_payment (sale)
         / trg_emp_protect (emp) → block client write
```

**Env vars ใน Vercel:** `OMISE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `LINE_CHANNEL_TOKEN`, `ADMIN_PASSWORD`, `DEV_SKIP_SECRET`, `GEMINI_API_KEY`, `OCR_PROVIDER`, `OCR_MODEL`, `ANTHROPIC_API_KEY`

**หลักการ:** paywall ต้องบังคับฝั่ง server — CSS blur อย่างเดียว bypass ได้ด้วย DevTools

---

# ใบรับรองการลงนาม (Certificate)

```javascript
async function _fetchSignGeo()  // ดึง geo จาก IP ผ่าน ipwho.is (best-effort, AbortController 3.5s)
function _geoForIp(ip)          // คืนตำแหน่งจาก cache, fallback '—'
function _tzToLocation()        // timezone → "Bangkok, Thailand"
function _fmtUTC(ts)            // ISO string → "2026-06-24 02:12:48 UTC"
function _certNumber()          // "SDC-{ปี}-{12 ตัวแรกของ SHA-256}"
function _buildCertPage()       // สร้าง HTML ใบรับรอง
```

**6 องค์ประกอบ:** Certificate No. · Contract ID (`#contractIdDisplay`) · Transaction ID (Supabase row UUID) · UTC Timestamp คู่ local time ทุก row · Geolocation (`ipwho.is` per IP) · Legal Disclaimer (พ.ร.บ. ธุรกรรมทางอิเล็กทรอนิกส์ พ.ศ. 2544 + SHA-256)

**Cert prefix ตามผลิตภัณฑ์:** `SDC-` (เช่า) · `SDE-` (จ้าง)

**PDF prep — เรียงตามลำดับ:**
```javascript
await _fetchSignCertData();   // ดึง IP/Device/เวลา ลงนาม
await _computeDocHash();      // คำนวณ SHA-256
await _fetchSignGeo();        // ดึงตำแหน่งจาก IP (best-effort, ไม่ทำ PDF พัง)
```

**CSS ต้องเพิ่มใน 2 ที่เสมอ:**
```css
/* 1) #printDoc.pd-render .cert-* { ... } — ใช้โดย html2canvas สร้าง PDF */
/* 2) @media print .cert-* { ... }        — fallback สำหรับ browser print */
```

**PDF layout conventions:** Thai distributed justify + `text-align-last:left` · margin 76px · "ทำที่" split 2 บรรทัดที่ อำเภอ/เขต · "วันที่" centered · สีดำ

---

# Design Tokens

```css
--bg:#F1F0EA; --white:#FEFEFC; --surf2:#EAE8DF;
--border:#E6E4DC; --border2:#D2D0C6;
--text:#14171F; --text2:#5B6270; --text3:#8E95A3;
--primary:#0B1220; --accent:#2E86C6; --accent2:#6EC3EA;
--green:#1a7f5a; --red:#c0392b;
--r:16px; --r-lg:24px;
```

Fonts: Anuphan (heading) · Sarabun (body) · IBM Plex Mono (`.mono`)
Libs (CDN): LIFF SDK 2 · supabase-js 2 · html2canvas 1.4.1 · jsPDF 2.5.1 · SignaturePad

---

# LINE Integration

- **Webhook:** `/api/line-webhook` — รวม lib ในไฟล์เดียว (ห้ามมี `api/lib/` เพราะทุก `.js` ใน `api/` นับเป็น function)
- **Reminder chain:** `start-reminder` (ตอนส่งลิงก์เซ็น) → `sign-reminder` (ทุก 10 นาที, หยุดที่ 30 นาที, mark `reminder_stopped`) → เซ็นครบ → `send-contract-pdf` (LINE ไม่รองรับ push PDF → ส่ง download link แทน)
- **Cron:** `reminder-cron` ที่ `0 2 * * *` (ตั้งใน `vercel.json`)
- **LIFF:** `index-test-liff.html` + `/api/save-liff-signature`

---

# ยังค้างก่อน Launch

1. **Opn Live mode** (~30 วันทำการจาก มิ.ย. 2569) → swap `OMISE_SECRET_KEY` เป็น `skey_live` + redeploy + live webhook
2. **Privacy Policy (PDPA)** — ยังไม่ได้สร้าง (ToS + Refund Policy มีแล้วในแอป) · จำเป็นมากเพราะเก็บรูปบัตร ปชช.
3. **ทนายรีวิว** — Refund Policy (wording ไม่ตรงกับ ฿790/contract) · NDA 8 ข้อ · EMP ข้อ 10/11/12/15/16/19
4. ทดสอบโหมด `tenant` (ผู้เช่าร่างสัญญา) ให้ครบ flow ก่อน promote production
5. `index-nda.html` production (live Stripe) + parameterize `verify-payment-intent.js` ให้รับ `nda_contracts`
6. ตรวจว่า `myip.js` ที่ deploy มี EMP handlers ครบ (`emp_jd`/`emp_generate`/`emp_content`/`emp_link_*`/`emp_claim`/`emp_my_contracts`)

**Notice (ส.ค. 2569):**
7. **ทนายรีวิวข้อความ 3 ฉบับ** ← บล็อกการเปิดขาย · โดยเฉพาะตัวเลือก "กรณีสัญญาระบุให้กลับเข้าครอบครองและตัดน้ำไฟได้" ว่าถ้อยคำ 2 แบบครอบคลุมพอไหม
8. **ทดสอบจ่ายเงิน Beam production mode** จริง 1 เคส (ตอนนี้ `BEAM_ENV=playground`)
9. ตั้ง env `DEV_SKIP_SECRET` ใน Vercel + deploy `create-payment-intent.js` ที่มี `handleDevSkip`
10. deploy `myip.js` ตัวที่ส่ง `ntDecoy` (ตอนนี้ frontend ใช้ fallback อยู่)
11. ยังไม่มีขั้น "ฟ้องขับไล่ / เข้าตรวจกรณีทิ้งห้อง" เต็มรูปแบบ (การ์ดที่ 3 ครอบแค่หนังสือแจ้งตำรวจ)
12. เกาะ `reminder-cron.js` เช็ค `demand.deadlineDate` แล้วแจ้ง LINE ตอนครบกำหนด (ยังไม่ได้ทำ)

---

# Email & Domain

- Zoho free plan: `admin@signdee.com` + `support@signdee.com`
- DNS ที่ Z.com: TXT, MX, SPF, DKIM verified แล้ว

# Common Gotchas

| ปัญหา | วิธีแก้ |
|---|---|
| vercel npm-install-254 error | ลบ `package.json` ออกจาก `D:\justsign-api` (หรือใช้ `installCommand:"echo skip"` ใน vercel.json) |
| เกิน 12 functions (Hobby) | ตั้งชื่อไฟล์ helper ขึ้นต้นด้วย `_` หรือรวม logic เข้า `myip.js` |
| Geo ไม่ทำงาน | ต้องเปิดจาก domain จริง (Preview URL) ไม่ใช่ `file:///` |
| "ชำระเงินสำเร็จ" ทันทีโดยไม่จ่าย | draft ค้างที่ `payment_completed=true` → `localStorage.clear()` หรือ Incognito |
| canvas ไม่รับ touch | ตรวจ `_justsign_init` flag กัน double-init |
| ลายเซ็น remote ไม่ตรงตำแหน่ง | ต้องมี `#rmCanvas` ใน CSS selector คู่กับ `#sigCanvas` |
| PDF ไม่โชว์ลายเซ็น | ตรวจ `_llSigImgLocal` / `window._llSigImg` ว่า populate แล้ว |
| วันที่/ลายน้ำว่างใน PDF | `thDate()` ต้องมีฝั่ง frontend ด้วย (อย่าพึ่ง backend อย่างเดียว) — ทำ `_pdDateTh` ให้ self-contained |
| QR ผู้ให้เช่าไม่โชว์ | ตรวจ `_landlordIsRemote()` return true ถูกต้อง |
| draft ไม่กู้ role 'tenant' | ตรวจ restore block ทั้ง 2 จุดว่า whitelist 'tenant' แล้ว |
| หน้าเว็บอ่านสัญญาไม่ได้หลังรัน RLS harden | frontend ยังอ่าน anon ตรงอยู่ → ต้อง deploy เวอร์ชันที่อ่านผ่าน RPC |
| `jsonb_build_object` error ใน RPC sale | เกิน 100 args → แยกเป็นก้อนที่สองต่อด้วย `||` |
| **แก้ไฟล์แล้วฟังก์ชันหายเงียบ ๆ** | เกิดตอนแทนบล็อกใหญ่ด้วย index-based slice → ต้อง `comm -23` ฟังก์ชันเดิม/ใหม่ทุกครั้ง (เคยทำ `buildTimeline`/`downloadDemandPDF`/`sigBlock` หาย) |
| **ฟังก์ชันนิยามซ้ำ 2 ครั้ง** | ตัวหลังทับตัวแรกเงียบ ๆ → เช็ค `names.filter((v,i)=>names.indexOf(v)!==i)` |
| ตรวจ onclick handler ไม่ครบ | regex ที่จับแค่ฟังก์ชันตัวแรกใน attribute จะพลาด `onclick="go('x');renderY()"` → ต้องวนทุก match ใน attribute |
| Vercel `rewrites` ไม่ทำงาน | rewrites ทำงาน**หลัง**เช็คไฟล์จริง — `/` เจอ `index.html` ก่อนเสมอ → ใช้ `redirects` (ทำงานก่อน) หรือแยก Vercel project |
| หน้า landing URL ไม่สะอาด | แยก Vercel project ให้ landing เป็น `index.html` ของตัวเอง → `notice.signdee.com` ล้วน ๆ |
| ย้ายโดเมนข้าม project | Vercel ขึ้น "Move Domain" → กดยืนยันได้ ถ้า CNAME target เดิมเป็น account เดียวกัน **ไม่ต้องแก้ DNS** |
| PDF ขนาดไม่ตรงจริง | ห้ามใช้หน่วย `mm` ใน CSS ของ `#printDoc` · คำนวณ px เอง (`794/210`) + `addImage(...,0,0,210,297)` · พิมพ์ต้องเลือก 100% ห้าม Fit to page |
| เบลอแล้วไม่เห็นข้อความ | veil การ์ดทึบทับย่อหน้าหมด → ทำเป็นชิปเล็กโปร่งใส + `pointer-events:none` |
| decoy ไม่ขึ้น (paras ว่าง) | backend ที่ deploy ยังไม่ส่ง decoy → ทำ fallback ฝั่ง client (`LOCK_PLACEHOLDER`) |
| รูปตัวอย่างทำไฟล์บวม | ครอบขอบขาว + ย่อ 900px + JPEG q72 → ~136KB แล้วฝัง base64 (ไม่ต้อง deploy ไฟล์แยก) |
| Case bar ไม่ขึ้นตอนขั้นแรก | อย่าผูกกับ `S.rowId` (เกิดตอนกดถัดไปครั้งแรก) → ผูกกับ `_phase !== 'landing'` |
| OCR อ่านวันที่ผิด | prompt ต้องแยก วันออกบัตร (ช่องซ้าย) vs วันบัตรหมดอายุ (ช่องขวา) · NDA ไม่ใช้วันหมดอายุ · ที่อยู่ไทย ต./อ./จ. parse ด้วย `parseAddr` |

# Playbook: สร้างผลิตภัณฑ์ใหม่ของ SignDee

ลำดับนี้กลั่นจากการสร้างจริง 5 ผลิตภัณฑ์ · ทำตามลำดับ อย่าข้าม

## 0. ก่อนเขียนโค้ด — ถามให้ครบ

1. **ราคา** คิดรายฉบับ หรือรายเคส? (Notice เลือกรายเคสเพราะถ้าคิดแยกจะจูงใจให้ข้ามขั้น 1 ซึ่งทำให้ขั้น 2 อ่อนทางกฎหมาย)
2. **โมเดล** สัญญาเซ็น 2 ฝ่ายจบ (แบบ 1-4) หรือเคสทอดยาวขับด้วยวันที่ (แบบ Notice)?
3. **ต้นแบบ Word** ขอไฟล์จริงจาก Ken เสมอ — **AI ห้ามร่างเนื้อกฎหมาย**
4. **มีประเด็นกฎหมายที่ต้องเตือนไหม** — ถ้าดีไซน์กำลังไกด์ผู้ใช้ไปสู่การทำผิด **ต้องยกขึ้นก่อนลงมือ** (ดูเคส "ลงบันทึกประจำวันก่อนขนของ")

## 1. SQL schema ก่อน (ครอบทุกขั้นทีเดียว จะได้ไม่ต้อง migrate)

```sql
create table if not exists public.<product>_x (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  case_no text, status text default 'draft',
  <ก้อนข้อมูล jsonb แยกตามขั้นตอน>,
  payment_completed boolean default false,
  payment_ref text, payment_provider text, paid_at timestamptz,
  audit_log jsonb default '[]'::jsonb, read_token text
);
-- reuse trigger เดิม 100%
create trigger trg_protect_payment_<x> before insert or update on public.<product>_x
  for each row execute function public.protect_payment_columns();
alter table ... enable row level security;
create policy <x>_anon_all on ... for all to anon using (true) with check (true);
revoke update (payment_completed, payment_ref, payment_provider, paid_at, audit_log) on ... from anon;
revoke insert (...) on ... from anon;
```

## 2. Backend — ยัดเข้า `myip.js` เสมอ

**⚠️ ก่อนแตะ `myip.js` ต้องขอไฟล์ปัจจุบันจาก Ken ก่อนทุกครั้ง**
snapshot ในโปรเจกต์มักเก่ากว่าที่ deploy จริง — เคยเกือบทำ NDA พังเพราะเรื่องนี้

```js
// ใน routing (ก่อน handler เดิม)
if (body.action === '<x>_doc') return await handle<X>Doc(req, res, body);
```
- ใช้ prefix เฉพาะผลิตภัณฑ์ (`nt*` สำหรับ notice) กันชื่อฟังก์ชันชนกัน
- reuse `sbGetT(table,id)` / `sbPatchT` ที่มีอยู่
- **ตรวจ regression ทุกครั้ง:**
```bash
# ⚠️ process substitution ใช้ได้เฉพาะ bash — ถ้ารันใน sh ให้เขียนลงไฟล์ก่อน
grep -o "action === '[a-z_]*'" old.js | sort > /tmp/a.txt
grep -o "action === '[a-z_]*'" new.js | sort > /tmp/b.txt
comm -23 /tmp/a.txt /tmp/b.txt      # ต้องว่าง = ไม่มี action เดิมหาย
```

## 3. Paywall — server-side เท่านั้น

```js
if (row.payment_completed !== true)
  return res.json({ ok:true, locked:true, doc:{...header, paras: ntDecoy(3)} });
```
CSS blur อย่างเดียว **ไม่พอ** — ต้องไม่ส่งเนื้อหาจริงออกจาก server เลย
ส่ง decoy ความยาวใกล้เคียงมาให้เบลอ เพื่อให้เห็นรูปทรงเอกสาร (ขายได้ + ปลอดภัย)

## 4. Frontend — single-file HTML SPA

โครงมาตรฐาน (ก๊อปจาก `index-notice.html`):
```
phases: landing → wizard(N steps) → pay → doc/dashboard → [ขั้นเฉพาะผลิตภัณฑ์] → timeline
State S เดียว + localStorage + Supabase
go(name, push) + goBack() + history.pushState  ← รองรับปุ่ม back ของเบราว์เซอร์
_isTestEnv() = false + _isDev() (?dev=<secret>) ← ทดสอบบน production
```

**Component ที่ reuse ได้ทันที** (ก๊อปจาก Notice/Sale):
| ต้องการ | ก๊อปจาก |
|---|---|
| OCR บัตร ปชช. | `onCardPick()` + `_compress()` → `POST /api/myip {image}` |
| ที่อยู่ไทย autocomplete | `loadAddrDB()` / `searchAddr()` / `wireAddrAuto(pre)` + `_composeAddr(pre)` |
| แยกที่อยู่จากข้อความ | `splitAddr()` — รองรับ ต./อ./จ./ถ./ม. และ กทม.(แขวง/เขต) |
| จำนวนเงินเป็นตัวหนังสือ | `bahtText()` — จัดการ "เอ็ด"/"ยี่สิบ" ครบ |
| เดือน/ปี พ.ศ. dropdown | `monthOptions()` / `yearOptions()` / `monthLabel()` |
| PDF A4 | `#printDoc.pd-render` + html2canvas scale 2-3 + `addImage(img,'JPEG',0,0,210,297)` |
| Beam PromptPay | `startBeamPay()` / `checkBeamPay()` / `stopPayPoll()` |
| Timeline/สถานะ | `caseStages()` → `caseStatus()` / `currentStage()` |

## 5. Landing page (ถ้าจะยิงแอด)

แยก Vercel project เสมอ · quiz → query params → `readQuizParams()` + `applyQuizToNewCase()`

## 6. เช็คก่อนส่งไฟล์ทุกครั้ง

```bash
# 1) syntax ทุก script block — failures ต้อง = 0
node -e 'const fs=require("fs");const h=fs.readFileSync("x.html","utf8");
const re=/<script\b([^>]*)>([\s\S]*?)<\/script>/gi;let m,i=0,bad=0;
while((m=re.exec(h))){if(/\bsrc\s*=/.test(m[1]||""))continue;i++;
try{new Function(m[2]);}catch(e){bad++;console.log("FAILED:",e.message);}}
console.log("failures:",bad);'

# 2) handler ใน onclick ต้องมีนิยามครบ (จับ "ทุก" ตัวใน attribute เดียว ไม่ใช่แค่ตัวแรก)
# 3) ฟังก์ชันซ้ำ (นิยาม 2 ครั้ง → ตัวหลังทับเงียบ ๆ)
# 4) regression: comm -23 ฟังก์ชัน/id เดิม vs ใหม่ → ต้องว่าง
# 5) tag balance: div, section, details, select
```

## 7. Deploy

```
vercel (preview) → ทดสอบจาก Preview URL → vercel --prod → อัป GitHub
```
รัน SQL ใน Supabase **ก่อน** deploy เสมอ

---

# บทเรียนจากการ refactor UX (ใช้ซ้ำได้ทุกผลิตภัณฑ์)

เมื่อ Ken ขอ "ปรับ UX/UI ห้ามรื้อระบบเดิม" ให้ทำแบบนี้:

1. **Audit ก่อนแตะโค้ด** — เทียบไฟล์ที่ส่งมากับที่มีอยู่ (`diff -q`) · list phases/steps/functions/state
2. **แยก logic ออกจาก presentation** ก่อนสร้าง UI ใหม่ — เช่นแยก `caseStages()` ออกจาก `buildTimeline()`
   (ย้ายล้วน ไม่แก้เงื่อนไข) แล้วให้ UI ใหม่ทุกตัวกินจากแหล่งเดียวกัน
3. **แบ่งเป็น batch** — batch ที่แตะ validation/calculation ทำทีหลังสุดและแยกรอบ
4. **พิสูจน์ว่าไม่พัง** ทุก batch:
```bash
# ฟังก์ชันเดิมหายไหม (ต้องไม่มี output)
grep -oE "^(async )?function [A-Za-z0-9_$]+" old | sed 's/^async //;s/^function //' | sort > /tmp/f_old.txt
grep -oE "^(async )?function [A-Za-z0-9_$]+" new | sed 's/^async //;s/^function //' | sort > /tmp/f_new.txt
comm -23 /tmp/f_old.txt /tmp/f_new.txt

# id เดิมหายไหม (ต้องไม่มี output)
grep -oE 'id="[A-Za-z0-9_-]+"' old | sort -u > /tmp/i_old.txt
grep -oE 'id="[A-Za-z0-9_-]+"' new | sort -u > /tmp/i_new.txt
comm -23 /tmp/i_old.txt /tmp/i_new.txt

# API call ต้องเท่าเดิม
grep -c "api/myip" old new
```
5. **รายงานท้ายงาน**: สิ่งที่เปลี่ยน · reuse อะไร · ไม่ได้แตะอะไร · ควรทดสอบอะไร · **อะไรที่ยังไม่ทำเพราะเสี่ยง**

---

# หลักการทำงานประจำ

- **Reuse-first** — ~60% ของโค้ดใหม่ reuse จากของเดิม (payment verify, signing token, canvas signature, certificate builder, SHA-256 hash chain, trigger pattern)
- **Staging-first** — สร้าง `*-test.html` ก่อนเสมอ ผ่านแล้วค่อยทำ production
- **Append-only audit log** — หลักการออกแบบเพื่อความน่าเชื่อถือทางกฎหมาย
- **`_isTestEnv()` guard** — pattern มาตรฐานทั่วทั้ง codebase
- **AI ไม่ร่างเนื้อกฎหมาย** — ใช้ template คงที่ + slot filling เท่านั้น → deterministic → `doc_hash` เสถียร
- syntax-check ทุก script block ก่อนส่งไฟล์ทุกครั้ง
- **ขอไฟล์ปัจจุบันก่อนแก้ backend เสมอ** — snapshot ในโปรเจกต์มักเก่ากว่าที่ deploy จริง
- **Refactor > Rewrite** — แยก logic ออกจาก presentation ก่อน แล้วให้ UI ใหม่กินจากแหล่งเดียว
- **ยกประเด็นกฎหมายก่อนลงมือ** — ถ้าดีไซน์กำลังไกด์ผู้ใช้ไปสู่การทำผิด ต้องบอกก่อน ไม่ใช่ทำตามแล้วค่อยเตือน
- **ห้ามล้างข้อมูลผู้ใช้เงียบ ๆ** — ถ้าซ่อน UI แต่ข้อมูลยังเข้าเอกสาร ต้องเตือน + ให้ปุ่มล้างเอง

