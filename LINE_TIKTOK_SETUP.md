# LINE OA + TikTok — คู่มือติดตั้ง

## 1. LINE OA — ขาย eBook ในแชท

### ไฟล์
| ไฟล์ | สถานะ |
|---|---|
| `api/_line_ebook.js` | **ใหม่** — ขึ้นต้นด้วย `_` ไม่นับเป็น Vercel function |
| `api/line-webhook.js` | **แก้ 2 จุด** (ดูด้านล่าง) |
| `api/webhooks/beam.js` | แก้แล้วในไฟล์ที่ส่งมา — push ลิงก์ดาวน์โหลดกลับเข้าแชท |
| `public/pay.html` | แก้แล้ว — รับ `?t=` จาก URL ได้ (เบราว์เซอร์ใน LINE ไม่มี localStorage ของเรา) |

**เพิ่ม Vercel function 0 ตัว**

### แก้ `api/line-webhook.js`

**จุดที่ 1** — เพิ่มบรรทัดนี้ไว้ใกล้ ๆ `const crypto = require('crypto');` ด้านบนไฟล์:

```js
const EBOOK = require('./_line_ebook.js');
```

**จุดที่ 2** — ใน `module.exports` หา loop นี้:

```js
  for (const ev of events) {
    try {
      if (ev.type === 'postback') await handlePostback(ev);
```

แทรกบรรทัด `EBOOK` เข้าไปเป็นอันแรกของ `try`:

```js
  for (const ev of events) {
    try {
      if (await EBOOK.handleEvent(ev)) continue;   // ← eBook จัดการแล้ว ข้ามไป event ถัดไป

      if (ev.type === 'postback') await handlePostback(ev);
```

`handleEvent` คืน `false` เมื่อไม่เกี่ยวกับ eBook → flow เดิม (ผูกบัญชี / สลิป / NDA) ทำงานต่อตามปกติ
ไม่แตะโค้ดเดิมสักบรรทัด

### ENV
ใช้ของเดิมทั้งหมด — `LINE_CHANNEL_TOKEN` ที่มีอยู่แล้ว
optional: `LINE_EBOOK_PRODUCT` (ค่าเริ่มต้น `LANDLORD_AI_GUIDE`)

### flow ที่ลูกค้าเจอ
```
ลูกค้าพิมพ์ "คู่มือ" / "ราคา" / "สนใจ" / "ebook"
  → บอทส่ง Flex การ์ดสินค้า + ปุ่ม "ซื้อคู่มือ 299 บาท"
  → กดปุ่ม → สร้าง order (source=line, ผูก LINE userId)
  → ส่ง Flex "เปิด QR พร้อมเพย์" → เปิดหน้า pay.html ในเบราว์เซอร์ LINE
  → สแกนจ่าย → Beam webhook → ยืนยัน → สร้าง delivery
  → บอท push Flex ปุ่มดาวน์โหลดกลับเข้าแชทเอง
```

พิมพ์ "สถานะ" / "ดาวน์โหลด" / "ยังไม่ได้รับ" ได้ตลอด → ออกลิงก์ดาวน์โหลดใบใหม่ให้
(กดซื้อซ้ำไม่สร้าง order ใหม่ · ซื้อไปแล้วกดซื้ออีกได้ลิงก์เดิมกลับไป)

### Rich Menu (ทำเองในหน้า LINE OA Manager)
ปุ่มที่คุ้มที่สุด 2 ปุ่ม — ตั้งเป็น **postback**:
- `action=ebook_buy` → ซื้อคู่มือ
- `action=ebook_status` → เช็คสถานะ / ขอลิงก์ดาวน์โหลด

---

## 2. TikTok

**TikTok ไม่มี API ให้ตอบ DM หรือคอมเมนต์อัตโนมัติ** สำหรับบัญชีธุรกิจทั่วไป
เครื่องมือที่อ้างว่าทำได้ส่วนใหญ่คือ automate หน้าเว็บ ซึ่งผิด ToS และเสี่ยงโดนแบนบัญชี
เราจึงไม่ทำบอท แต่ทำฝั่งปลายทางให้แน่นแทน

### ไฟล์
`public/tiktok.html` — **ใหม่** หน้า landing สำหรับคนมาจาก TikTok โดยเฉพาะ

ต่างจาก `landlord-guide.html`:
- ธีมเข้ม อ่านง่ายบนมือถือกลางแดด ต่อเนื่องจากฟีด TikTok
- พาดหัวเป็น**ปัญหา** ("ผู้เช่าไม่จ่าย คุณทำอะไรได้บ้าง") ไม่ใช่ชื่อสินค้า
- ปุ่มซื้อลอยติดขอบล่างตลอด — ไม่ต้องเลื่อนหา
- สั้นกว่า อ่านจบใน 20 วินาที
- **ล็อก `source: 'tiktok'` ไว้ในโค้ด** ไม่ต้องพึ่ง query string

### ลิงก์ที่เอาไปใส่
```
https://app.signdee.com/tiktok.html
```

ใส่ใน bio ได้เลย ระบบรู้เองว่ามาจาก TikTok

**แยกตามคลิป** — เติม `?ref=` เข้าไป:
```
https://app.signdee.com/tiktok.html?ref=clip-tenant-wont-pay
https://app.signdee.com/tiktok.html?ref=clip-notice-15day
```
ค่านี้เก็บใน `orders.source_reference` → รู้ว่าคลิปไหนขายได้จริง

**แยกตามปัญหา** — เติม `?pain=` (ใช้กับคลิปที่พูดถึงปัญหาเฉพาะ):
`RENT_ARREARS` · `WONT_LEAVE` · `VACANT_ROOM` · `TENANT_SCREENING` · `LATE_PAYMENT` · `BREACH` · `TERMINATION`

### ดูยอดขายแยกช่องทาง
```sql
select source, count(*) as orders,
       count(*) filter (where status in ('PAID','DELIVERED')) as paid,
       sum(amount) filter (where status in ('PAID','DELIVERED'))/100 as baht
from public.orders group by source order by paid desc;

-- คลิปไหนขายได้
select source_reference, count(*) filter (where status in ('PAID','DELIVERED')) as paid
from public.orders where source = 'tiktok'
group by source_reference order by paid desc;
```

---

## 3. หลัง deploy — ทดสอบ

**LINE**
1. ทักแชท OA พิมพ์ว่า `คู่มือ` → ต้องได้การ์ดสินค้า
2. กดปุ่มซื้อ → ต้องได้การ์ด "เปิด QR พร้อมเพย์"
3. กดเปิด → เห็น QR 299 บาท
4. จ่าย → **ลิงก์ดาวน์โหลดต้องเด้งกลับเข้าแชทเอง**
5. พิมพ์ `สถานะ` → ได้ลิงก์ใหม่อีกใบ

ถ้าข้อ 1 ไม่ตอบ → ยังไม่ได้แทรก `EBOOK.handleEvent` ใน `line-webhook.js`
ถ้าข้อ 4 ไม่เด้ง → ดู log `LINE_PUSH_FAILED` ใน Vercel (มักเป็นเพราะ `LINE_CHANNEL_TOKEN` ไม่มีสิทธิ์ push)

**TikTok**
เปิด `https://app.signdee.com/tiktok.html?ref=test` → กดซื้อ → ต้องเด้งไปหน้า QR
แล้วเช็คว่า `orders.source = 'tiktok'` และ `source_reference = 'test'`

---

## 4. เทส
```
node --test tests/commerce.test.js
```
52 tests — เพิ่ม 8 ตัวสำหรับ LINE (กดซื้อ, กดซ้ำ, push หลังจ่าย, ขอลิงก์ใหม่,
ข้อความที่ไม่เกี่ยวต้องไม่ถูกดักไป, และผู้ใช้คนอื่นต้องไม่เห็น order ของคนแรก)
