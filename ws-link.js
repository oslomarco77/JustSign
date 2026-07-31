/* =============================================================================
 * ws-link.js — เชื่อมสัญญาที่สร้างจาก Agreement OS กลับเข้า Workspace
 *
 * ทำไมต้องมีไฟล์นี้
 * ---------------------------------------------------------------------------
 * ผู้ใช้เริ่มจาก Workspace (คุยกัน ตกลงกัน ระบุสถานการณ์) แล้วกด "สร้างสัญญา"
 * ระบบพามาที่หน้า e-sign พร้อม ?ws=<token> พอสร้างแถวสัญญาเสร็จ ไฟล์นี้จะบอก
 * Agreement OS ว่าได้ id อะไร เพื่อผูกกลับเข้า Workspace ให้อัตโนมัติ
 *
 * ทำเป็นไฟล์กลางด้วยเหตุผลเดียวกับ img-safe.js — ถ้าเขียนแยก 6 ไฟล์ จะแก้ครบ
 * ห้าไฟล์แล้วลืมไฟล์ที่หก แล้วไม่มีใครรู้จนกว่าผู้ใช้จะเจอเอง
 *
 * ═══ สัญญาที่ไฟล์นี้ต้องรักษา — สำคัญกว่าฟีเจอร์ ═══
 *
 * 1. **ห้ามทำให้หน้า e-sign พังไม่ว่ากรณีใด** ระบบนี้ทำรายได้จริง ส่วน
 *    Agreement OS เป็นของเสริม ถ้ามันล่ม ตอบช้า โดน CORS บล็อก หรือยังไม่ได้
 *    deploy หน้า e-sign ต้องทำงานครบทุกขั้นเหมือนไม่มีไฟล์นี้อยู่
 *    → ทุกอย่างห่อ try/catch, มี timeout, ไม่มี await ที่ block flow
 *
 * 2. **ไม่ตั้งค่า = ปิดตัวเอง** ถ้าไม่มี window.AGREEMENT_OS_BASE ทุกฟังก์ชัน
 *    คืนทันทีโดยไม่ยิงเน็ตเลย (Agreement OS ยังไม่ deploy ณ 31 ก.ค. 2569)
 *
 * 3. **ไม่ส่งข้อมูลสัญญาออกไป** ส่งแค่ contract id ที่ Agreement OS จะเอาไป
 *    ดึงข้อมูลเองด้วยสิทธิ์ของมัน ไม่ส่งชื่อ เบอร์ ยอดเงิน หรือรูปบัตร
 *
 * โหลดคู่กับ img-safe.js:  <script src="/ws-link.js"></script>
 * ============================================================================= */
(function (global) {
  'use strict';

  /* sessionStorage เพราะ flow ของ e-sign มีการ reload (?reload=<id>) ระหว่างทาง
   * ถ้าอ่านจาก URL อย่างเดียว token จะหายตั้งแต่ก้าวที่สอง
   * ใช้ sessionStorage ไม่ใช่ localStorage — ปิดแท็บแล้วต้องหมดไป ไม่ค้างข้ามวัน
   * แล้วไปผูกสัญญาผิดฉบับในภายหลัง */
  var KEY = 'signdee_ws_token';
  var TIMEOUT_MS = 4000;

  function base() {
    var b = global.AGREEMENT_OS_BASE;
    return (typeof b === 'string' && b) ? b.replace(/\/+$/, '') : '';
  }

  function enabled() {
    return !!base();
  }

  /**
   * ย้าย token ออกจาก URL มาเก็บใน sessionStorage — ทำครั้งเดียวตอนโหลด
   *
   * ทำไมต้องลบออกจากแถบที่อยู่:
   *   1. token ค้างใน URL = ค้างใน history, Referer header และ log ของ CDN
   *      ผู้ใช้แคปหน้าจอส่งให้เพื่อนแล้วแนบ token ไปด้วยโดยไม่รู้ตัว
   *   2. ถ้าไม่ลบ clearToken() ไม่มีผลจริง เพราะ token() จะอ่านกลับจาก URL
   *      ได้ใหม่ทุกครั้ง — ผูกสัญญาฉบับที่สองด้วย token เก่าโดยไม่ตั้งใจ
   *
   * ลบเฉพาะ ws เท่านั้น ห้ามแตะ query อื่น (?reload= ใช้กู้ร่างสัญญา)
   */
  function absorbFromUrl() {
    var raw = '';

    try {
      var url = new URL(global.location.href);
      raw = url.searchParams.get('ws') || '';

      if (raw) {
        url.searchParams.delete('ws');
        if (global.history && global.history.replaceState) {
          global.history.replaceState(null, '', url.toString());
        }
      }
    } catch (e) { /* URL แปลก ๆ — ไม่ใช่เรื่องคอขาดบาดตาย */ }

    if (!raw) return;

    try { sessionStorage.setItem(KEY, raw); } catch (e) { _memToken = raw; }
  }

  /* สำรองไว้เผื่อ sessionStorage เขียนไม่ได้ (โหมดส่วนตัวบางเบราว์เซอร์) */
  var _memToken = '';

  /* อ่าน token ที่เก็บไว้ — เรียกกี่ครั้งก็ได้ */
  function token() {
    try {
      return sessionStorage.getItem(KEY) || _memToken || '';
    } catch (e) {
      return _memToken || '';
    }
  }

  function clearToken() {
    _memToken = '';
    try { sessionStorage.removeItem(KEY); } catch (e) {}
  }

  /* fetch ที่มี timeout — AbortSignal.timeout ยังไม่ทั่วถึงพอในเบราว์เซอร์ไทย
   * จึงใช้ AbortController + setTimeout แบบเดียวกับ _fetchSignGeo */
  function fetchWithTimeout(url, options) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var opts = options || {};
    opts.signal = ctrl.signal;

    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  /**
   * ดึงข้อมูลกรอกล่วงหน้า — เรียกครั้งเดียวตอนโหลดหน้า
   * คืน null เสมอเมื่อมีปัญหา ผู้เรียกไม่ต้องดักอะไร
   */
  function prefill() {
    if (!enabled()) return Promise.resolve(null);

    var t = token();
    if (!t) return Promise.resolve(null);

    return fetchWithTimeout(base() + '/api/handoff/' + encodeURIComponent(t))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) {
          global._wsPrefill = j;
          return j;
        }
        return null;
      })
      .catch(function () { return null; });
  }

  /**
   * บอก Agreement OS ว่าสร้างสัญญาเป็น id ไหน
   *
   * ⚠️ เรียกแบบไม่ต้อง await — ผู้เรียกต้องไม่รอผลลัพธ์นี้เด็ดขาด
   * ถ้าล้ม ผู้ใช้ยังผูกสัญญาย้อนหลังเองได้ด้วยเบอร์โทรใน Agreement OS
   */
  function bind(contractId) {
    if (!enabled()) return Promise.resolve(false);
    if (!contractId) return Promise.resolve(false);

    var t = token();
    if (!t) return Promise.resolve(false);

    return fetchWithTimeout(
      base() + '/api/handoff/' + encodeURIComponent(t) + '/bind',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractId: String(contractId) })
      }
    )
      .then(function (r) { return r.ok; })
      .then(function (ok) {
        /* ผูกแล้วต้องล้าง token ทิ้ง ไม่งั้นถ้าผู้ใช้สร้างสัญญาฉบับที่สอง
         * ในแท็บเดิม จะยิง bind ด้วย token เก่า (ฝั่ง server ปฏิเสธอยู่แล้ว
         * เพราะใช้ครั้งเดียว แต่ไม่ควรพึ่งด่านเดียว) */
        if (ok) clearToken();
        return ok;
      })
      .catch(function () { return false; });
  }

  global.SignDeeWS = {
    enabled: enabled,
    token: token,
    prefill: prefill,
    bind: bind,
    clearToken: clearToken
  };

  /* ย้าย token ออกจาก URL ทันที ทำแม้ยังไม่ได้ตั้งค่า Agreement OS
   * เพราะการเก็บกวาดแถบที่อยู่ไม่ควรขึ้นกับว่าปลายทางพร้อมหรือยัง */
  absorbFromUrl();

  /* ดึง prefill ทันทีที่โหลด เพื่อให้พร้อมก่อนผู้ใช้กรอกถึงขั้นที่ต้องใช้
   * ไม่ await ไม่ throw — ล้มก็เงียบ */
  if (enabled()) {
    try { prefill(); } catch (e) {}
  }
})(typeof window !== 'undefined' ? window : this);
