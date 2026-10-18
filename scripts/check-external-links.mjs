// BASE-DOC-006 / WF-DOC-002: kiểm LIÊN KẾT NGOÀI trong tài liệu (README, PROJECT, RUNBOOK, docs/**) — chạy theo lịch (`link-check.yml`),
// có cache thành công, thử lại có lùi, danh sách loại trừ (link cục bộ/ví dụ, domain chặn bot). Liên kết NỘI BỘ do
// `.xtemplates/scripts/check-links.py` + scripts/repo-hygiene.test.mjs chặn merge. Test: scripts/check-external-links.test.mjs (không gọi mạng).
// Dùng: `node scripts/check-external-links.mjs [--cache .cache/link-check.json] [--config scripts/link-check.config.json]`
// Mã thoát 1 khi có link CHẾT (404/410/4xx khác/DNS sai); 401/403/429/5xx/hết giờ chỉ cảnh báo (máy chủ chặn bot hoặc sự cố tạm).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue, isMain } from "./git-history.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WARN_STATUS = new Set([401, 403, 405, 429, 451, 999]);
/** Luôn loại trừ: không phải địa chỉ công khai kiểm được. */
const BUILTIN_EXCLUDE = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "*.test",
  "*.example",
  "*.invalid",
  "*.local",
  "example.com",
  "example.org",
  "example.net",
];

/** Các liên kết http(s) trong Markdown, bỏ khối code rào và đoạn code dòng. Trả về [{url, line}] không trùng URL. */
export function extractUrls(md) {
  const found = new Map();
  let fence = null;
  md.split("\n").forEach((raw, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return;
    }
    if (m) {
      fence = m[1];
      return;
    }
    const line = raw.replace(/`+[^`]*`+/g, "");
    for (const u of line.matchAll(/https?:\/\/[^\s<>"'\]`]+/g)) {
      let url = u[0];
      // `[t](https://x/a_(b))`: giữ ngoặc đóng cân bằng, bỏ phần thừa ở cuối.
      while (
        /[.,;:!?)]$/.test(url) &&
        !(url.endsWith(")") && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length)
      ) {
        url = url.slice(0, -1);
      }
      url = url.split("#")[0];
      if (/^https?:\/\/[^/]+/.test(url) && !found.has(url)) found.set(url, i + 1);
    }
  });
  return [...found].map(([url, line]) => ({ url, line }));
}

/** `host` khớp một mục loại trừ (đúng tên hoặc `*.hậu-tố`). */
export function hostMatches(host, entry) {
  const h = host.toLowerCase();
  const e = entry.toLowerCase();
  return e.startsWith("*.") ? h.endsWith(e.slice(1)) : h === e || h.endsWith(`.${e}`);
}

/** Loại trừ theo cấu hình: `excludeHosts` (tên/`*.hậu-tố`) và `excludePatterns` (regex trên URL). */
export function isExcluded(url, config = {}) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (!host.includes(".")) return true; // tên một nhãn (http://x, http://db): không phải địa chỉ công khai
  if ([...BUILTIN_EXCLUDE, ...(config.excludeHosts ?? [])].some((e) => hostMatches(host, e))) return true;
  return (config.excludePatterns ?? []).some((p) => new RegExp(p).test(url));
}

/** Phân loại mã HTTP: ok · dead · warn. */
export function classifyStatus(status) {
  if (status >= 200 && status < 400) return "ok";
  if (WARN_STATUS.has(status) || status >= 500) return "warn";
  return "dead";
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kiểm một URL: HEAD, lỗi ≥ 400 thì GET; thử lại `retries` lần có lùi (`backoffMs` × 2^n) với kết quả "warn" hoặc lỗi mạng.
 * @returns {Promise<{url: string, kind: "ok"|"dead"|"warn", detail: string}>}
 */
export async function checkUrl(
  url,
  { fetchImpl = fetch, retries = 2, timeoutMs = 15000, backoffMs = 1000, sleep = sleepReal } = {},
) {
  const headers = { "user-agent": "Mozilla/5.0 (compatible; hm-link-check/1.0)", accept: "*/*" };
  const attempt = async (method) => {
    const res = await fetchImpl(url, {
      method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    res.body?.cancel?.();
    return res.status;
  };
  let last = { url, kind: "warn", detail: "chưa kiểm" };
  for (let n = 0; n <= retries; n++) {
    if (n > 0) await sleep(backoffMs * 2 ** (n - 1));
    try {
      let status = await attempt("HEAD");
      if (status >= 400) status = await attempt("GET");
      last = { url, kind: classifyStatus(status), detail: `HTTP ${status}` };
    } catch (e) {
      const code = e?.cause?.code ?? e?.name ?? "LỖI";
      last = { url, kind: code === "ENOTFOUND" ? "dead" : "warn", detail: `mạng: ${code}` };
    }
    if (last.kind === "ok" || last.kind === "dead") return last;
  }
  return last;
}

/** Cache `{ [url]: { at: ms } }` chỉ giữ kết quả ok còn hạn. */
export function freshInCache(cache, url, now, ttlMs) {
  const hit = cache[url];
  return hit !== undefined && now - hit.at < ttlMs;
}

/** Kiểm nhiều URL song song (`concurrency`), bỏ qua URL còn hạn trong cache; cập nhật cache với kết quả ok. */
export async function runChecks(
  urls,
  { cache = {}, now = Date.now(), ttlMs = 7 * 24 * 3600 * 1000, concurrency = 6, ...opts } = {},
) {
  const results = [];
  const queue = [...urls];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (freshInCache(cache, item, now, ttlMs)) {
        results.push({ url: item, kind: "ok", detail: "cache" });
        continue;
      }
      const r = await checkUrl(item, opts);
      if (r.kind === "ok") cache[item] = { at: now };
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(urls.length, 1)) }, worker));
  return results.sort((a, b) => a.url.localeCompare(b.url));
}

function markdownFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === "docs/autopilot/archive" || name === "node_modules") continue;
      if (statSync(join(root, r)).isDirectory()) walk(r);
      else if (name.endsWith(".md")) out.push(r);
    }
  };
  for (const top of ["README.md", "PROJECT.md", "RUNBOOK.md"]) if (existsSync(join(root, top))) out.push(top);
  if (existsSync(join(root, "docs"))) walk("docs");
  return out;
}

/** Mọi URL cần kiểm trong repo: {url → [file:dòng…]}, đã bỏ loại trừ. */
export function collectUrls(root, config) {
  const where = new Map();
  for (const file of markdownFiles(root)) {
    for (const { url, line } of extractUrls(readFileSync(join(root, file), "utf8"))) {
      if (isExcluded(url, config)) continue;
      where.set(url, [...(where.get(url) ?? []), `${file}:${line}`]);
    }
  }
  return where;
}

async function main() {
  const configPath = argValue(process.argv, "--config", join(ROOT, "scripts/link-check.config.json"));
  const cachePath = argValue(process.argv, "--cache", join(ROOT, ".cache/link-check.json"));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  let cache = {};
  if (existsSync(cachePath)) {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      cache = {};
    }
  }
  const where = collectUrls(ROOT, config);
  const results = await runChecks([...where.keys()], {
    cache,
    ttlMs: (config.cacheDays ?? 7) * 24 * 3600 * 1000,
    retries: config.retries ?? 2,
  });
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);
  let dead = 0;
  for (const r of results) {
    const at = (where.get(r.url) ?? []).slice(0, 3).join(", ");
    if (r.kind === "dead") {
      dead++;
      process.stdout.write(`::error::Link chết ${r.url} (${r.detail}) — ${at}\n`);
    } else if (r.kind === "warn") {
      process.stdout.write(`::warning::Link chưa xác nhận ${r.url} (${r.detail}) — ${at}\n`);
    }
  }
  process.stdout.write(`${results.length} link ngoài đã kiểm, ${dead} chết.\n`);
  return dead ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(await main());
