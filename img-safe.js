/* =============================================================================
 * img-safe.js — ตัวจัดการรูปภาพกลางของ SignDee
 *
 * ทำไมต้องมีไฟล์นี้
 * ---------------------------------------------------------------------------
 * เดิมแต่ละผลิตภัณฑ์เขียนฟังก์ชันบีบอัดรูปของตัวเอง แล้วพลาดคนละแบบ:
 *
 *   rent / sale  : img.onerror → resolve(dataUrl)  = เก็บไฟล์ดิบลง DB
 *                  ผู้ใช้เห็นว่าสำเร็จ แต่ได้ HEIC 1.9 MB ที่เปิดไม่ขึ้น
 *                  ทั้งบนเว็บและใน PDF — ตรวจพบ 32 รูป กิน 60 MB
 *   nda / emp    : img.onerror → reject แต่ไม่มีใครรับ error
 *                  กดแล้วไม่มีอะไรเกิดขึ้นเลย ไม่มีข้อความบอก
 *
 * บทเรียน: reject ที่ไม่มีคนรับ แย่พอ ๆ กับ fallback ที่ผิด
 *          ทั้งสองแบบทำให้หลักฐานหายโดยไม่มีใครรู้
 *
 * สัญญาของไฟล์นี้
 * ---------------------------------------------------------------------------
 *   - รับได้ทั้ง File/Blob และ dataURL string
 *   - คืน dataURL ของ JPEG เสมอ หรือ null ถ้าถอดรหัสไม่ได้
 *   - ไม่คืนไฟล์ต้นฉบับกลับไปเด็ดขาด
 *   - ไม่ throw — ผู้เรียกเช็ค null แล้วเรียก SignDeeImg.explainFailure() ได้เลย
 *
 * โหลดก่อนสคริปต์อื่นที่ใช้งาน:  <script src="/img-safe.js"></script>
 * ============================================================================= */
(function (global) {
  'use strict';

  var DEFAULTS = { maxEdge: 1200, quality: 0.8, maxBytes: 700 * 1024 };

  /* ตรวจชนิดไฟล์จริงจาก magic bytes — ห้ามเชื่อ file.type
     iOS รายงานไฟล์ HEIC เป็น image/jpeg, image/bmp หรือ image/png ได้
     (ยืนยันจากข้อมูลจริง: 32 รูป HEIC ถูกติดป้ายเป็น 3 ชนิดนี้ปนกัน) */
  async function sniff(file) {
    if (!(file instanceof Blob)) return 'dataurl';
    try {
      var head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      var box  = String.fromCharCode.apply(null, head.slice(4, 12));

      if (box.indexOf('ftyp') === 0) {
        var brand = box.slice(4, 8);
        if (/heic|heix|hevc|hevx|mif1|msf1|heim|hevm/.test(brand)) return 'heic';
        if (/avif|avis/.test(brand)) return 'avif';
        return 'iso';
      }
      if (head[0] === 0xFF && head[1] === 0xD8) return 'jpeg';
      if (head[0] === 0x89 && head[1] === 0x50) return 'png';
      if (head[0] === 0x47 && head[1] === 0x49) return 'gif';
      if (head[0] === 0x42 && head[1] === 0x4D) return 'bmp';
      if (String.fromCharCode.apply(null, head.slice(0, 4)) === 'RIFF') return 'webp';
      return 'unknown';
    } catch (_) { return 'unknown'; }
  }

  /* ถอดรหัสรูปเป็น ImageBitmap หรือ HTMLImageElement — คืน null ถ้าไม่ได้ */
  async function decode(input) {
    var isBlob = (typeof Blob !== 'undefined') && (input instanceof Blob);

    // createImageBitmap รองรับฟอร์แมตกว้างกว่า <img> ในหลายเบราว์เซอร์
    if (isBlob && global.createImageBitmap) {
      try { return await global.createImageBitmap(input); } catch (_) {}
    }

    return await new Promise(function (resolve) {
      var url = '', revoke = false;
      if (isBlob) { url = URL.createObjectURL(input); revoke = true; }
      else { url = String(input || ''); }
      if (!url) { resolve(null); return; }

      var img = new Image();
      img.onload  = function () { if (revoke) URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { if (revoke) URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /* ย่อ + แปลงเป็น JPEG · คืน dataURL หรือ null */
  async function toJpeg(input, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var src = await decode(input);
    if (!src || !src.width || !src.height) return null;

    var w = src.width, h = src.height;
    if (Math.max(w, h) > o.maxEdge) {
      var s = o.maxEdge / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
    }

    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    if (src.close) src.close();

    var q = o.quality;
    var out = c.toDataURL('image/jpeg', q);
    while (out.length > o.maxBytes && q > 0.30) {
      q -= 0.12;
      out = c.toDataURL('image/jpeg', q);
    }

    // ผลลัพธ์ต้องเป็น JPEG จริงเสมอ ถ้าไม่ใช่แปลว่า canvas ว่าง
    if (out.indexOf('data:image/jpeg;base64,/9j/') !== 0) return null;
    return out;
  }

  /* แปลงพร้อมบอกชนิดไฟล์ที่ตรวจได้ — ใช้เมื่ออยากขึ้นข้อความที่แม่นยำ */
  async function process(input, opts) {
    var kind = await sniff(input);
    var url  = await toJpeg(input, opts);
    return { ok: !!url, dataUrl: url, kind: kind };
  }

  /* ข้อความอธิบายเมื่อแปลงไม่สำเร็จ — ภาษาไทย บอกวิธีแก้ที่ทำได้จริง */
  function failureMessage(list) {
    var items = Array.isArray(list) ? list : [list];
    var heic  = items.filter(function (r) { return r && (r.kind === 'heic' || r.kind === 'avif'); });

    if (heic.length === items.length && items.length > 0) {
      return 'อัปโหลดไม่สำเร็จ ' + items.length + ' ไฟล์\n\n'
           + 'ไฟล์เหล่านี้เป็นรูปแบบ HEIC ของ iPhone ซึ่งเบราว์เซอร์ที่ใช้อยู่เปิดไม่ได้\n\n'
           + 'วิธีแก้ เลือกอย่างใดอย่างหนึ่ง\n'
           + '1) ที่ iPhone: ตั้งค่า → กล้อง → รูปแบบ → เลือก "เข้ากันได้มากที่สุด" แล้วถ่ายใหม่\n'
           + '2) ส่งรูปให้ตัวเองผ่านแอปแชตก่อน แล้วบันทึกรูปที่ได้มาอัปโหลด\n'
           + '3) เปิดหน้านี้ด้วย Safari บน iPhone แทน';
    }

    return 'อัปโหลดไม่สำเร็จ ' + items.length + ' ไฟล์ กรุณาเลือกรูปใหม่\n\n'
         + items.map(function (r) {
             return '• ' + ((r && r.name) || 'ไฟล์รูป') + ' (' + ((r && r.kind) || 'unknown') + ')';
           }).join('\n');
  }

  /* แจ้งผู้ใช้ — ใช้ toast ของหน้านั้นถ้ามี ไม่งั้นใช้ alert */
  function explainFailure(list) {
    var msg = failureMessage(list);
    try {
      if (typeof global.toast === 'function' && (!Array.isArray(list) || list.length <= 1)) {
        global.toast('อัปโหลดรูปไม่สำเร็จ — รูปแบบไฟล์ไม่รองรับ');
      }
    } catch (_) {}
    alert(msg);
    return msg;
  }

  global.SignDeeImg = {
    sniff: sniff,
    decode: decode,
    toJpeg: toJpeg,
    process: process,
    failureMessage: failureMessage,
    explainFailure: explainFailure
  };
})(window);
