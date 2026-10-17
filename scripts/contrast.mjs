// Kiểm tương phản token màu (UX-DS-003, UX-A11Y-002; PLAN đợt 8 T-701, D-054). Không phụ thuộc thư viện ngoài.
// Đọc MỌI khối khai token `--c-*` trong `apps/web/app/globals.css` (`:root`, và mọi khối theme khác nếu có —
// `:root[data-theme=…]`, `@media (prefers-color-scheme: dark)`), tính tỷ lệ theo công thức WCAG 2.x
// (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio) cho các cặp chữ/nền và viền-focus/nền.
// Chạy:  pnpm check:contrast  (= vitest unit `contrast`)  — test `contrast.test.mjs` là cổng.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CSS_FILE = fileURLToPath(new URL("../apps/web/app/globals.css", import.meta.url));

/** Ngưỡng WCAG 2.2: chữ thường SC 1.4.3 ≥ 4.5; chữ lớn SC 1.4.3 và thành phần UI SC 1.4.11 ≥ 3. */
export const THRESHOLD = { text: 4.5, large: 3, ui: 3 };

/**
 * Các cặp (nền, tiền cảnh) lấy từ cách `globals.css` dùng token. `kind`: text (chữ thường) · ui (viền điều khiển,
 * focus, icon). Mọi token màu phải xuất hiện ở ≥ 1 cặp hoặc nằm trong `EXEMPT` kèm lý do — token mới thêm mà không
 * khai cặp thì test đỏ (không để token "lọt" khỏi kiểm).
 */
export const PAIRS = [
  // chữ thân trang và chữ phụ trên các nền mà CSS đặt chữ lên
  { fg: "text", bg: "bg", kind: "text", use: "body" },
  { fg: "text", bg: "surface", kind: "text", use: ".state, .badge" },
  { fg: "text", bg: "info-bg", kind: "text", use: ".banner--info, nav hiện tại" },
  { fg: "text", bg: "danger-bg", kind: "text", use: ".state--error .state__text" },
  { fg: "text-muted", bg: "bg", kind: "text", use: ".field__hint, .card__meta, .facts dt" },
  { fg: "text-muted", bg: "surface", kind: "text", use: ".state__text, .badge" },
  { fg: "text-muted", bg: "info-bg", kind: "text", use: "chữ phụ trên nav hiện tại" },
  // thương hiệu: nút đặc, tiêu đề ứng dụng, skip-link; nút phụ và liên kết điều hướng
  { fg: "brand-contrast", bg: "brand", kind: "text", use: ".btn, .app-header, .skip-link" },
  { fg: "brand", bg: "bg", kind: "text", use: ".btn--secondary, .app-nav a, .bell" },
  { fg: "brand", bg: "info-bg", kind: "text", use: '.app-nav a[aria-current="page"], .bell[aria-current]' },
  { fg: "brand", bg: "surface", kind: "text", use: "liên kết trên khối .state" },
  // trạng thái
  { fg: "danger", bg: "bg", kind: "text", use: ".field__error" },
  { fg: "danger", bg: "surface", kind: "text", use: ".field__error trong khối" },
  { fg: "danger", bg: "danger-bg", kind: "text", use: ".state--error" },
  { fg: "warn-text", bg: "warn-bg", kind: "text", use: ".banner--warn" },
  { fg: "brand-contrast", bg: "danger", kind: "text", use: ".bell__count" },
  { fg: "ok", bg: "bg", kind: "text", use: ".command-form__status--ok" },
  { fg: "ok", bg: "surface", kind: "text", use: "trạng thái OK trong khối" },
  // thành phần UI và trạng thái (SC 1.4.11): viền điều khiển, viền lỗi, vòng focus, nút
  { fg: "border", bg: "bg", kind: "ui", use: "viền input/card/bảng/nav" },
  { fg: "danger", bg: "bg", kind: "ui", use: '.field [aria-invalid="true"]' },
  { fg: "brand", bg: "bg", kind: "ui", use: "viền .btn" },
  { fg: "focus", bg: "bg", kind: "ui", use: ":focus-visible" },
  { fg: "focus", bg: "surface", kind: "ui", use: ":focus-visible trên khối" },
  { fg: "focus", bg: "info-bg", kind: "ui", use: ":focus-visible trên nav hiện tại" },
  { fg: "focus", bg: "warn-bg", kind: "ui", use: ":focus-visible trên banner cảnh báo" },
  { fg: "focus", bg: "danger-bg", kind: "ui", use: ":focus-visible trên khối lỗi" },
  // skip-link nằm đè thanh tiêu đề (cùng nền thương hiệu) — vòng focus màu --c-focus chỉ đạt 1,88:1 ở đó nên
  // `.skip-link:focus-visible` đổi sang màu chữ-trên-thương-hiệu (test kiểm quy tắc CSS này tồn tại).
  { fg: "brand-contrast", bg: "brand", kind: "ui", use: ".skip-link:focus-visible trên thanh tiêu đề" },
];

/** Token màu không phải cặp chữ/viền, kèm lý do (ngoại lệ chỉ co, không nở). */
export const EXEMPT = {
  skeleton: "nền khung chờ trang trí (không mang thông tin, SC 1.4.11 không áp)",
  "skeleton-hi": "dải sáng của khung chờ trang trí",
  scrim: "lớp phủ mờ sau hộp thoại (không phải thành phần mang thông tin)",
};

/** Bỏ comment `/* … *\/`, giữ nguyên độ dài/dòng. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/**
 * Các khối CSS (đệ quy theo `@media`…): [{selector, context, body}] với `body` là phần khai báo trực tiếp của khối
 * (đã bỏ khối con). `context` = chuỗi at-rule bao ngoài (vd `@media (prefers-color-scheme: dark)`).
 */
export function parseBlocks(css, context = "") {
  const text = context === "" ? stripComments(css) : css;
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const selector = text
      .slice(i, open)
      .replace(/^[\s;}]+/, "")
      .trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const inner = text.slice(open + 1, j - 1);
    if (selector.startsWith("@")) {
      if (/^@(media|supports|layer|container)\b/.test(selector))
        out.push(...parseBlocks(inner, context ? `${context} ${selector}` : selector));
    } else {
      const direct = inner.replace(/\{[^{}]*\}/g, "");
      out.push({ selector, context, body: direct });
    }
    i = j;
  }
  return out;
}

/** Token `--c-*` khai trong thân khối: Map tên (không `--c-`) → giá trị chuỗi. */
export function colorTokens(body) {
  const map = new Map();
  for (const m of body.matchAll(/--c-([^\s:;{}]+)\s*:\s*([^;]+)(?:;|$)/gi))
    map.set(m[1].toLowerCase(), m[2].trim());
  return map;
}

/**
 * Các theme trong CSS: `base` = khối `:root` gốc (không at-rule), mỗi khối khác khai `--c-*` là một theme ghi đè lên
 * base (ví dụ khối tối thêm sau này). Trả [{name, tokens: Map}] — tokens đã gộp base + ghi đè.
 */
export function themes(css) {
  const blocks = parseBlocks(css).filter((b) => colorTokens(b.body).size > 0);
  const base = blocks.find((b) => b.context === "" && /^:root$/.test(b.selector));
  if (!base) throw new Error("Thiếu khối :root khai token --c-* trong globals.css");
  const baseTokens = colorTokens(base.body);
  const out = [{ name: ":root", tokens: resolveAliases(baseTokens) }];
  for (const b of blocks) {
    if (b === base) continue;
    const name = `${b.context ? `${b.context} ` : ""}${b.selector}`.trim();
    out.push({ name, tokens: resolveAliases(new Map([...baseTokens, ...colorTokens(b.body)])) });
  }
  return out;
}

/**
 * Giải alias `--c-a: var(--c-b)` (kể cả `var(--c-b, #fff)` — dùng dự phòng khi `--c-b` không có) thành giá trị màu thật.
 * Vòng alias hoặc alias tới token không tồn tại (không dự phòng) giữ nguyên chuỗi `var(...)` → `parseColor` ném lỗi, test đỏ.
 */
export function resolveAliases(tokens) {
  const out = new Map();
  const resolve = (name, seen) => {
    const raw = tokens.get(name);
    if (raw === undefined) return undefined;
    const m = /^var\(\s*--c-([^\s,)]+)\s*(?:,\s*(.+?))?\s*\)$/i.exec(raw);
    if (!m) return raw;
    const target = m[1].toLowerCase();
    if (seen.has(target)) return raw; // vòng alias
    const v = resolve(target, new Set([...seen, target]));
    return v ?? m[2] ?? raw;
  };
  for (const name of tokens.keys()) out.set(name, resolve(name, new Set([name])));
  return out;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b / a)`, `rgb(r, g, b, a)` → {r,g,b,a} (0–255, a 0–1); không hiểu → ném lỗi. */
export function parseColor(value) {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (k) => Number.parseInt(h.slice(k, k + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+)(%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  throw new Error(`Không phân tích được màu: ${value}`);
}

/** Độ chói tương đối WCAG của {r,g,b} (0–255). */
export function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Trộn màu trong suốt `fg` lên nền đặc `bg`. */
export function composite(fg, bg) {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** Tỷ lệ tương phản WCAG 2.x (1–21) của hai màu; nền phải đặc, tiền cảnh trong suốt được trộn lên nền. */
export function contrastRatio(fg, bg) {
  if (bg.a < 1) throw new Error("Nền không đặc — không xác định được tương phản");
  const f = composite(fg, bg);
  const [hi, lo] = [luminance(f), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Kiểm mọi theme × mọi cặp. Trả {results, errors}: `results` từng phép đo (theme, cặp, tỷ lệ, ngưỡng, đạt);
 * `errors` = lỗi cấu trúc (thiếu token, màu không hiểu, token chưa thuộc cặp nào và không miễn trừ).
 */
export function checkContrast(css, pairs = PAIRS, exempt = EXEMPT) {
  const results = [];
  const errors = [...uncoveredUsage(css, pairs, exempt)];
  for (const theme of themes(css)) {
    const used = new Set(Object.keys(exempt));
    for (const p of pairs) {
      used.add(p.fg);
      used.add(p.bg);
      const fgRaw = theme.tokens.get(p.fg);
      const bgRaw = theme.tokens.get(p.bg);
      if (fgRaw === undefined || bgRaw === undefined) {
        errors.push(
          `[${theme.name}] thiếu token --c-${fgRaw === undefined ? p.fg : p.bg} (cặp ${p.fg}/${p.bg})`,
        );
        continue;
      }
      try {
        const ratio = contrastRatio(parseColor(fgRaw), parseColor(bgRaw));
        const min = THRESHOLD[p.kind];
        results.push({ theme: theme.name, ...p, ratio, min, ok: ratio >= min });
      } catch (e) {
        errors.push(`[${theme.name}] cặp ${p.fg}/${p.bg}: ${e.message}`);
      }
    }
    for (const name of theme.tokens.keys())
      if (!used.has(name))
        errors.push(`[${theme.name}] token --c-${name} không thuộc cặp nào (khai vào PAIRS hoặc EXEMPT)`);
  }
  return { results, errors };
}

const TOKEN_REF = /var\(\s*--c-([^\s,)]+)/g;
const declsOf = (body) =>
  [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+)(?:;|$)/gi)].map((m) => ({
    prop: m[1].toLowerCase(),
    value: m[2],
  }));
const refs = (value) => [...value.matchAll(TOKEN_REF)].map((m) => m[1].toLowerCase());

/**
 * Cách `globals.css` THỰC SỰ dùng token (khác :root): trong cùng một quy tắc, `color: var(--c-X)` + `background[-color]:
 * var(--c-Y)` → cặp chữ X/Y; `color` không kèm nền → X phải được đo trên nền trang (`bg`); `border*`/`outline*` dùng token →
 * phải có cặp UI. Trả {textPairs, textOnly, ui}.
 */
export function usageOf(css) {
  const textPairs = [];
  const textOnly = [];
  const ui = [];
  for (const b of parseBlocks(css)) {
    if (/^:root\b/.test(b.selector) || colorTokens(b.body).size > 0) continue;
    const ds = declsOf(b.body);
    const fg = ds.filter((d) => d.prop === "color").flatMap((d) => refs(d.value));
    const bg = ds
      .filter((d) => d.prop === "background" || d.prop === "background-color")
      .flatMap((d) => refs(d.value));
    for (const f of fg) {
      if (bg.length === 0) textOnly.push({ fg: f, selector: b.selector });
      for (const g of bg) textPairs.push({ fg: f, bg: g, selector: b.selector });
    }
    for (const d of ds)
      if (/^(?:border|outline)(?:-[a-z]+)*$/.test(d.prop))
        for (const f of refs(d.value)) ui.push({ fg: f, selector: b.selector, prop: d.prop });
  }
  return { textPairs, textOnly, ui };
}

/** Cách dùng thật mà `pairs` chưa phủ: danh sách lỗi (chuỗi). Token trong `exempt` được bỏ qua. */
export function uncoveredUsage(css, pairs = PAIRS, exempt = EXEMPT) {
  const { textPairs, textOnly, ui } = usageOf(css);
  const errors = [];
  const has = (f, g, kind) => pairs.some((p) => p.fg === f && p.bg === g && p.kind === kind);
  for (const u of textPairs)
    if (!exempt[u.fg] && !exempt[u.bg] && !has(u.fg, u.bg, "text"))
      errors.push(`${u.selector}: chữ --c-${u.fg} trên nền --c-${u.bg} chưa có trong PAIRS`);
  for (const u of textOnly)
    if (!exempt[u.fg] && !has(u.fg, "bg", "text"))
      errors.push(`${u.selector}: chữ --c-${u.fg} (nền kế thừa) chưa có cặp chữ với --c-bg trong PAIRS`);
  for (const u of ui)
    if (!exempt[u.fg] && !pairs.some((p) => p.fg === u.fg && p.kind === "ui"))
      errors.push(`${u.selector}: ${u.prop} dùng --c-${u.fg} chưa có cặp UI trong PAIRS`);
  return [...new Set(errors)];
}

export const readCss = () => readFileSync(CSS_FILE, "utf8");
