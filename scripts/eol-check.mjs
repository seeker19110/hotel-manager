// Theo dõi hết hạn hỗ trợ (EOL) bằng máy (BASE-DEP-003, OPS-MAINT-003; PLAN đợt 9 T-802).
// Đọc phiên bản đang dùng từ file thật của repo (.nvmrc, package.json engines/next, Dockerfile, compose, service image của
// workflow) và đối chiếu với https://endoflife.date/api/<sản phẩm>.json. Luật:
//   · đã EOL → ĐỎ (exit 1) · runtime (Node) còn ≤ 90 ngày → ĐỎ (BASE-DEP-003: eol > hôm nay + 90 ngày)
//   · mọi sản phẩm còn < 6 tháng (180 ngày) → CẢNH BÁO `::warning::` (OPS-MAINT-003), không đỏ
//   · không tìm thấy chu kỳ trong API → ĐỎ (không xanh giả); sản phẩm endoflife.date không theo dõi → ghi vào UNTRACKED.
// Chạy hằng tuần ở .github/workflows/eol-check.yml. Dùng: node scripts/eol-check.mjs [--today YYYY-MM-DD]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RED_DAYS_RUNTIME = 90;
export const WARN_DAYS = 180;
/** Sản phẩm là runtime/ngôn ngữ: ngưỡng đỏ 90 ngày (BASE-DEP-003). */
export const RUNTIME_PRODUCTS = new Set(["nodejs"]);
/** Thành phần đang dùng mà endoflife.date không có trang: ghi rõ để không bị tưởng là đã kiểm. */
export const UNTRACKED = {
  seaweedfs:
    "SeaweedFS (deploy/compose.yaml) — endoflife.date không có sản phẩm; theo dõi qua Dependabot + quét lỗ hổng image",
  pgbackrest: "pgBackRest — endoflife.date không có sản phẩm; ghim bản và quét lỗ hổng image",
};
const IMAGE_PRODUCT = {
  node: "nodejs",
  postgres: "postgresql",
  caddy: "caddy",
  // Image nền của caddy/seaweedfs tự dựng (D-110).
  golang: "go",
  alpine: "alpine-linux",
};
/** Module Go dựng thành nhị phân trong deploy/ (go.mod của image tự dựng, D-110) → sản phẩm endoflife.date. */
const GO_MODULE_PRODUCT = { "github.com/caddyserver/caddy/v2": "caddy" };

const DAY = 86_400_000;
const parseDay = (s) => Date.parse(`${s}T00:00:00Z`);
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** `24.22.0` | `v24.22.0` | `>=24.11.0 <25` → ["24.22", "24"] (ứng viên chu kỳ, cụ thể → chung); không có số → []. */
export function cycleCandidates(version) {
  const m = /(\d+)(?:\.(\d+))?/.exec(String(version ?? ""));
  if (!m) return [];
  return m[2] === undefined ? [m[1]] : [`${m[1]}.${m[2]}`, m[1]];
}

/** Dòng `image: x:tag@digest` / `FROM x:tag` → {name, tag} | null; bỏ biểu thức `${…}` và `scratch`. */
export function parseImageRef(ref) {
  const clean = String(ref).replace(/@sha256:[0-9a-f]+$/i, "");
  if (clean.includes("${") || clean === "scratch") return null;
  const i = clean.lastIndexOf(":");
  const name = (i > clean.lastIndexOf("/") ? clean.slice(0, i) : clean).split("/").pop();
  const tag = i > clean.lastIndexOf("/") ? clean.slice(i + 1) : "";
  return { name, tag };
}

/** Các lần dùng ({product, version, codename?, source}) rút từ nội dung một file text (Dockerfile/compose/workflow). */
export function usagesFromImageLines(text, source) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m =
      /^(?:-\s*)?image:\s*["']?([^"'\s]+)["']?$/.exec(line) ??
      /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (!m) continue;
    const ref = parseImageRef(m[1]);
    const product = ref && IMAGE_PRODUCT[ref.name];
    if (!product) continue;
    const version = /^\d/.test(ref.tag) ? ref.tag : "";
    if (version) out.push({ product, version, source });
    const suite = /-(trixie|bookworm|bullseye|forky)(?:-|$)/.exec(ref.tag);
    if (suite) out.push({ product: "debian", codename: suite[1], source });
  }
  return out;
}

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, pred, out);
    } else if (pred(e.name)) out.push(p);
  }
  return out.sort();
}

/** Các lần dùng rút từ dòng `require` của một go.mod (chỉ module trong GO_MODULE_PRODUCT). */
export function usagesFromGoMod(text, source) {
  const out = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:require\s+)?(\S+)\s+v(\d\S*)/.exec(raw.replace(/\s*\/\/.*$/, ""));
    const product = m && GO_MODULE_PRODUCT[m[1]];
    if (product) out.push({ product, version: m[2], source });
  }
  return out;
}

/** Mọi phiên bản đang dùng, đọc từ repo thật. */
export function collectUsages(root = ROOT) {
  const out = [];
  const rel = (p) => relative(root, p);
  if (existsSync(join(root, ".nvmrc")))
    out.push({
      product: "nodejs",
      version: readFileSync(join(root, ".nvmrc"), "utf8").trim(),
      source: ".nvmrc",
    });
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (rootPkg.engines?.node)
    out.push({ product: "nodejs", version: rootPkg.engines.node, source: "package.json engines.node" });
  for (const f of walk(join(root, "apps"), (n) => n === "package.json")) {
    const next = JSON.parse(readFileSync(f, "utf8")).dependencies?.next;
    if (next) out.push({ product: "nextjs", version: next, source: `${rel(f)} next` });
  }
  const imageFiles = [
    ...walk(
      join(root, "deploy"),
      (n) => /^(compose|docker-compose).*\.ya?ml$/.test(n) || /^Dockerfile|\.Dockerfile$/.test(n),
    ),
    ...walk(join(root, ".github/workflows"), (n) => /\.ya?ml$/.test(n)),
  ];
  for (const f of imageFiles)
    if (statSync(f).isFile()) out.push(...usagesFromImageLines(readFileSync(f, "utf8"), rel(f)));
  for (const f of walk(join(root, "deploy"), (n) => n === "go.mod"))
    out.push(...usagesFromGoMod(readFileSync(f, "utf8"), rel(f)));
  return out;
}

/**
 * Đánh giá một lần dùng với danh sách chu kỳ của endoflife.date.
 * Trả {status: "ok"|"warn"|"error", message, eol}. `cycles` = mảng `[{cycle, codename?, eol: "YYYY-MM-DD"|boolean}]`.
 */
export function evaluate(usage, cycles, today = todayUtc()) {
  const label = `${usage.product} ${usage.codename ?? usage.version} (${usage.source})`;
  if (!Array.isArray(cycles))
    return { status: "error", message: `${label}: không đọc được dữ liệu endoflife.date` };
  const wanted = usage.codename
    ? [(c) => String(c.codename ?? "").toLowerCase() === usage.codename]
    : cycleCandidates(usage.version).map((cand) => (c) => String(c.cycle) === cand);
  let entry;
  for (const match of wanted) {
    entry = cycles.find(match);
    if (entry) break;
  }
  if (!entry) return { status: "error", message: `${label}: không tìm thấy chu kỳ trong endoflife.date` };
  const { eol } = entry;
  if (eol === false || eol === undefined || eol === null)
    return { status: "ok", message: `${label}: chưa có ngày EOL`, eol: null };
  if (eol === true) return { status: "error", message: `${label}: đã EOL`, eol: "true" };
  const days = Math.floor((parseDay(eol) - parseDay(today)) / DAY);
  if (Number.isNaN(days))
    return { status: "error", message: `${label}: ngày EOL không hợp lệ (${eol})`, eol };
  if (days <= 0) return { status: "error", message: `${label}: đã EOL từ ${eol}`, eol };
  if (RUNTIME_PRODUCTS.has(usage.product) && days <= RED_DAYS_RUNTIME)
    return {
      status: "error",
      message: `${label}: EOL ${eol}, còn ${days} ngày ≤ ${RED_DAYS_RUNTIME} (BASE-DEP-003)`,
      eol,
    };
  if (days < WARN_DAYS)
    return {
      status: "warn",
      message: `${label}: EOL ${eol}, còn ${days} ngày < ${WARN_DAYS} — lên kế hoạch nâng`,
      eol,
    };
  return { status: "ok", message: `${label}: EOL ${eol} (còn ${days} ngày)`, eol };
}

async function fetchCycles(product, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://endoflife.date/api/${product}.json`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`không tải được endoflife.date/${product}: ${last?.message}`);
}

async function main(argv) {
  const ti = argv.indexOf("--today");
  const today = ti >= 0 ? argv[ti + 1] : todayUtc();
  const usages = collectUsages();
  const products = [...new Set(usages.map((u) => u.product))];
  const data = {};
  let failed = false;
  for (const p of products) {
    try {
      data[p] = await fetchCycles(p);
    } catch (e) {
      process.stderr.write(`::error::${e.message}\n`);
      failed = true;
    }
  }
  for (const u of usages) {
    const r = evaluate(u, data[u.product], today);
    if (r.status === "error") failed = true;
    const prefix = r.status === "error" ? "::error::" : r.status === "warn" ? "::warning::" : "";
    process.stdout.write(`${prefix}${r.message}\n`);
  }
  for (const note of Object.values(UNTRACKED)) process.stdout.write(`(không tự động kiểm) ${note}\n`);
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
