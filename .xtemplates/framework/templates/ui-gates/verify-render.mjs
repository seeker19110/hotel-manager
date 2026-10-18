#!/usr/bin/env node
// Cổng render (UX-A11Y-001, 013, 028, 029): đo trên bản RENDER thật bằng Playwright + axe-core, không đọc CSS.
//   1. axe-core theo tag WCAG (gồm `target-size` của WCAG 2.2) — 0 vi phạm.
//   2. Tràn ngang ở từng bề rộng (mặc định 320 và 280 px) — scrollWidth <= innerWidth.
//   3. Tương phản chữ của điều khiển ở trạng thái mặc định, hover, focus-visible (>= 4,5:1; chữ lớn >= 3:1).
// Dùng:  node verify-render.mjs <url|file.html>... [--widths 320,280] [--limit 60] [--tags wcag2a,wcag2aa,wcag21aa,wcag22aa] [--strict]
// Cài:   npm i -D playwright@1.64.0 @axe-core/playwright@4.13.0 && npx playwright install chromium
// Chromium có sẵn nhưng khác bản Playwright (sandbox/CI tự dựng): đặt XT_CHROMIUM=/đường/dẫn/chromium.
// Exit: 0 đạt · 1 có vi phạm (hoặc có UNMEASURED khi --strict) · 2 không chạy được (goto lỗi, không mở được Chromium).
// Phép đo không thực hiện được (nền ảnh/gradient, điều khiển bị che) in "UNMEASURED" và dòng kết quả không ghi "đạt".
// Mã tự viết cho khung X-Templates (không chép mã của dự án khác); ý tưởng cổng "đo bản render" tham khảo stored 06 §7d.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const targets = argv.filter((a, i) => !a.startsWith('--') && (a === '' || !(argv[i - 1]?.startsWith('--') && argv[i - 1] !== '--strict')));
const widths = opt('--widths', '320,280').split(',').map(Number);
const limit = Number(opt('--limit', '60'));
const tags = opt('--tags', 'wcag2a,wcag2aa,wcag21aa,wcag22aa').split(',');
if (!targets.length) {
  console.error('Thiếu đích: node verify-render.mjs <url|file.html>...');
  process.exit(2);
}
const toUrl = (t) => (/^https?:|^file:/.test(t) ? t : 'file://' + resolve(t));
const INTERACTIVE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=button], [tabindex]:not([tabindex="-1"])';

// Chạy trong trang: màu chữ hiệu dụng trên nền hiệu dụng của phần tử (canvas chuyển mọi màu CSS về sRGB).
const measure = (el) => {
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const layers = [];
  for (let n = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.backgroundImage !== 'none') return { unmeasured: 'nền là ảnh/gradient' };
    const bg = rgba(s.backgroundColor);
    if (bg[3] > 0) layers.push(bg);
    if (bg[3] === 1) break;
  }
  let base = [255, 255, 255];
  for (const [r, g, b, a] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
  const s = getComputedStyle(el);
  const fg = rgba(s.color);
  const text = [0, 1, 2].map((i) => fg[i] * fg[3] + base[i] * (1 - fg[3]));
  const [hi, lo] = [lum(text), lum(base)].sort((x, y) => y - x);
  const px = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
  const large = px >= 24 || (px >= 18.66 && bold);
  return { ratio: (hi + 0.05) / (lo + 0.05), need: large ? 3 : 4.5, label: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40) };
};

const fails = [];
let unmeasured = 0;
process.on('unhandledRejection', (e) => { console.error('Lỗi khi chạy cổng:', e?.message ?? e); process.exit(2); });
const browser = await chromium.launch({ executablePath: process.env.XT_CHROMIUM || undefined }).catch((e) => { console.error('Không mở được Chromium:', e.message); process.exit(2); });
let fatal = '';
try {
  for (const target of targets) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // axe đòi page từ newContext()
    try {
      const page = await context.newPage();
      await page.goto(toUrl(target));
      const axe = await new AxeBuilder({ page }).withTags(tags).analyze();
      for (const v of axe.violations) fails.push(`${target}: axe ${v.id} (${v.impact}) — ${v.nodes.length} phần tử`);
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 800 });
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 0) fails.push(`${target}: tràn ngang +${over}px ở ${w}px`);
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      const els = (await page.locator(INTERACTIVE).all()).slice(0, limit);
      for (const el of els) {
        if (!(await el.isVisible())) continue;
        for (const state of ['mặc định', 'hover', 'focus']) {
          if (state === 'hover') {
            // hover không tới được (bị che bởi header dính/overlay): không đo giả bằng trạng thái mặc định
            try { await el.hover({ timeout: 1000 }); } catch { unmeasured++; continue; }
          }
          if (state === 'focus') { await page.mouse.move(0, 0); await el.focus().catch(() => {}); } // bỏ hover trước khi đo focus
          const m = await el.evaluate(measure);
          if (m.unmeasured) { unmeasured++; break; }
          if (m.ratio < m.need) fails.push(`${target}: "${m.label}" ${state} ${(Math.floor(m.ratio * 100) / 100).toFixed(2)}:1 < ${m.need}:1`);
        }
      }
    } finally {
      await context.close();
    }
  }
} catch (e) {
  fatal = `Không chạy được cổng: ${e?.message ?? e}`; // goto lỗi (server chưa lên), Chromium chết…: exit 2, không phải "có vi phạm"
} finally {
  await browser.close();
}
if (fatal) { console.error(fatal); process.exit(2); }
if (unmeasured) console.log(`UNMEASURED: ${unmeasured} phép đo không thực hiện được (nền ảnh/gradient, hoặc điều khiển bị che nên không hover được) — đo tay.`);
for (const f of fails) console.log('✗ ' + f);
const strict = argv.includes('--strict') && unmeasured > 0; // --strict: phép đo không thực hiện được cũng làm đỏ
if (!fails.length) console.log(unmeasured ? `⚠ phần đo được đạt; ${unmeasured} phép đo chưa thực hiện (UNMEASURED).` : `✓ ${targets.length} trang đạt (axe, tràn ngang ${widths.join('/')}px, tương phản theo trạng thái).`);
else console.log(`${fails.length} vi phạm.`);
process.exit(fails.length || strict ? 1 : 0);
