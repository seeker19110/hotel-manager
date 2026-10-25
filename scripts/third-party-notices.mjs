// THIRD_PARTY_NOTICES.md sinh tự động (CMP-LIC-001, D-111): ghi công cho mọi gói npm được PHÂN PHỐI — phụ thuộc production
// của các workspace chạy thật (web, worker và gói nội bộ chúng dùng; bỏ @hm/testkit chỉ dùng cho test) theo lockfile.
// Mỗi gói: tên, phiên bản, giấy phép SPDX, nguồn; nguyên văn NOTICE (Apache-2.0 §4(d)) và văn bản giấy phép — văn bản trùng
// nhau gom một lần. Thứ tự cố định để CI so khác (`--check`, job sbom của supply-chain.yml).
// Dùng: node scripts/third-party-notices.mjs [--check] [--out THIRD_PARTY_NOTICES.md]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const OUT_FILE = join(ROOT, "THIRD_PARTY_NOTICES.md");
/** Workspace không phân phối (chỉ test/công cụ). */
export const NOT_SHIPPED = new Set(["hotel-manager", "@hm/testkit"]);

/** Đầu ra `pnpm list -r --prod --json --depth Infinity` → [{name, version, path}] duy nhất, sắp theo tên rồi phiên bản. */
export function shippedPackages(workspaces) {
  // `pnpm list` rút gọn (`deduped: true`, không có `dependencies`) cây con đã in ở chỗ khác — kể cả dưới workspace không phân
  // phối. Lượt 1 lập chỉ mục cây con đầy đủ từ MỌI workspace; lượt 2 duyệt từ workspace phân phối, lấy cây con qua chỉ mục.
  const full = new Map();
  const index = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const key = `${name}@${d?.version}`;
      if (d?.dependencies && !full.has(key)) {
        full.set(key, d.dependencies);
        index(d.dependencies);
      }
    }
  };
  for (const ws of workspaces) index(ws.dependencies);
  const seen = new Map();
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (!d?.version || d.version.startsWith("link:")) continue;
      // Gói tuỳ chọn cho nền tảng khác (vd @swc/core-darwin-arm64) có trong lockfile nhưng không cài ⇒ không phân phối.
      if (d.path && !existsSync(join(d.path, "package.json"))) continue;
      const key = `${name}@${d.version}`;
      if (seen.has(key)) continue;
      seen.set(key, { name, version: d.version, path: d.path });
      walk(full.get(key));
    }
  };
  for (const ws of workspaces) if (!NOT_SHIPPED.has(ws.name)) walk(ws.dependencies);
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
}

/** `license` của package.json: chuỗi SPDX | {type} | mảng cũ `licenses` → chuỗi; không có → "UNKNOWN". */
export function licenseOf(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license?.type) return String(pkg.license.type);
  if (Array.isArray(pkg.licenses) && pkg.licenses.length)
    return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/** URL nguồn từ `repository` (chuỗi hoặc {url}); bỏ tiền tố git+ và đuôi .git. */
export function repoOf(pkg) {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) return pkg.homepage ?? "";
  return raw
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://");
}

const textFiles = (dir, re) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => re.test(f))
        .sort()
        .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim())
        .filter(Boolean)
    : [];

/** Đọc thông tin ghi công của một gói đã cài. */
export function describe(p) {
  const pkg = JSON.parse(readFileSync(join(p.path, "package.json"), "utf8"));
  return {
    name: p.name,
    version: p.version,
    license: licenseOf(pkg),
    repo: repoOf(pkg),
    notices: textFiles(p.path, /^NOTICE(\.(md|txt))?$/i),
    licenseTexts: textFiles(p.path, /^(LICEN[CS]E|COPYING)(\.(md|txt))?$|^LICEN[CS]E-/i),
  };
}

/** Markdown xác định (không ngày giờ) từ danh sách đã `describe`. */
export function render(entries) {
  const out = [
    "# THIRD_PARTY_NOTICES",
    "",
    "Hotel Manager (giấy phép: xem `LICENSE`) phân phối kèm các thành phần bên thứ ba dưới đây theo giấy phép riêng của chúng.",
    "Tệp này **sinh tự động** bởi `node scripts/third-party-notices.mjs` từ lockfile — không sửa tay; CI so khác (`--check`).",
    "",
    `## Danh sách (${entries.length} gói)`,
    "",
    "| Gói | Phiên bản | Giấy phép | Nguồn |",
    "|---|---|---|---|",
    ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.license} | ${e.repo} |`),
  ];
  const withNotice = entries.filter((e) => e.notices.length);
  if (withNotice.length) {
    out.push("", "## NOTICE của thành phần");
    for (const e of withNotice)
      out.push("", `### ${e.name}@${e.version}`, "", "```text", ...e.notices, "```");
  }
  // Gom văn bản giấy phép giống hệt nhau (nhiều gói MIT cùng tác giả) — giữ thứ tự xuất hiện đầu tiên.
  const groups = new Map();
  for (const e of entries)
    for (const t of e.licenseTexts) {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(`${e.name}@${e.version}`);
    }
  if (groups.size) {
    out.push("", "## Văn bản giấy phép");
    for (const [text, pkgs] of groups) out.push("", `### ${pkgs.join(", ")}`, "", "```text", text, "```");
  }
  return `${out.join("\n")}\n`;
}

export function generate() {
  const raw = execFileSync("pnpm", ["list", "-r", "--prod", "--json", "--depth", "Infinity"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return render(shippedPackages(JSON.parse(raw)).map(describe));
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : OUT_FILE;
  const text = generate();
  if (args.includes("--check")) {
    const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (cur !== text) {
      process.stderr.write(
        `[third-party-notices] ${out} lệch với lockfile — chạy \`node scripts/third-party-notices.mjs\` rồi commit.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`[third-party-notices] ${out} khớp lockfile.\n`);
  } else {
    writeFileSync(out, text);
    process.stdout.write(`[third-party-notices] đã ghi ${out}.\n`);
  }
}
