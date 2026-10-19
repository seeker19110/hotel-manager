#!/usr/bin/env node
// Lệnh "Kiểm:" của các mục blueprint cần trạng thái THẬT trên GitHub (không phải lời khai trong repo): ruleset nhánh mặc
// định khớp `.github/rulesets/main.json`, lịch sử nhánh chính chỉ gồm squash PR, tag SemVer, Release mới nhất có SBOM đủ
// license + SHA256SUMS khớp. Đọc qua `gh api` (REST; GraphQL bị chặn ở phiên agent). Hàm thuần export để test.
// Dùng: node scripts/check-github-live.mjs ruleset | squash-history | tags | release [<tag>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = process.env.GH_REPO || "seeker19110/hotel-manager";

const contextsOf = (rules) =>
  rules
    .filter((r) => r.type === "required_status_checks")
    .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));

/**
 * Rule đang áp cho nhánh mặc định (`GET rules/branches/<nhánh>`) so với ruleset dạng code. Lỗi khi thiếu loại rule, khi
 * `pull_request` lỏng hơn bản code (không bắt resolve thread / cho kiểu merge khác squash), hoặc tập required check khác
 * bản code (thiếu = cổng hở; thừa = context không job nào tạo ⇒ PR kẹt "Expected").
 */
export function rulesetProblems(liveRules, codeRuleset) {
  const out = [];
  const types = new Set(liveRules.map((r) => r.type));
  for (const t of ["deletion", "non_fast_forward", "pull_request", "required_status_checks"])
    if (!types.has(t)) out.push(`thiếu rule ${t}`);
  const prs = liveRules.filter((r) => r.type === "pull_request");
  if (prs.length && !prs.some((r) => r.parameters?.required_review_thread_resolution === true))
    out.push("pull_request không bắt resolve thread (required_review_thread_resolution)");
  if (prs.length && !prs.every((r) => (r.parameters?.allowed_merge_methods ?? []).join() === "squash"))
    out.push("pull_request cho kiểu merge khác squash");
  const live = new Set(contextsOf(liveRules));
  const code = new Set(contextsOf(codeRuleset.rules ?? []));
  for (const c of code) if (!live.has(c)) out.push(`thiếu required check "${c}" so với main.json`);
  for (const c of live) if (!code.has(c)) out.push(`required check "${c}" không có trong main.json`);
  const strictCode = (codeRuleset.rules ?? []).some(
    (r) => r.type === "required_status_checks" && r.parameters?.strict_required_status_checks_policy === true,
  );
  const strictLive = liveRules.some(
    (r) => r.type === "required_status_checks" && r.parameters?.strict_required_status_checks_policy === true,
  );
  if (strictCode && !strictLive)
    out.push("required_status_checks không bật strict (nhánh phải cập nhật trước merge)");
  return out;
}

/**
 * Ruleset nhánh (target=branch, đang active) có ai được bypass không. GitHub chỉ trả `bypass_actors` cho token có quyền
 * quản trị: thiếu trường ⇒ không kiểm được ⇒ lỗi (không coi là rỗng).
 */
export function bypassProblems(rulesets) {
  return rulesets
    .filter((r) => r.target === "branch" && r.enforcement === "active")
    .flatMap((r) =>
      !Array.isArray(r.bypass_actors)
        ? [`ruleset "${r.name}": không đọc được bypass_actors (token thiếu quyền quản trị?)`]
        : r.bypass_actors.length > 0
          ? [`ruleset "${r.name}" có bypass_actors (${r.bypass_actors.length})`]
          : [],
    );
}

/**
 * Dòng `git log --first-parent --format=%s` không phải squash PR "… (#N)". Chỉ nhìn tiêu đề: commit đẩy thẳng mang hậu tố
 * giả vẫn lọt — lớp chặn thật là rule `pull_request` của ruleset (kiểm bằng `ruleset`).
 */
export function nonSquashSubjects(subjects) {
  return subjects.filter((s) => s.trim() && !/\(#\d+\)$/.test(s.trim()));
}

const SEMVER_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** Tag `v*` sai dạng SemVer `vX.Y.Z` (STD-PROC-002). */
export function badTags(tags) {
  return tags.filter((t) => t.startsWith("v") && !SEMVER_TAG.test(t));
}

// D-077: license là thuộc tính của gói; mục `file` (danh mục tệp trong image) và `operating-system` không tính.
const NOT_PACKAGE = new Set(["file", "operating-system"]);
/** Số component dạng gói có trường license / tổng gói của một SBOM CycloneDX. */
export function sbomCoverage(cdx) {
  const pkgs = (cdx.components ?? []).filter((c) => !NOT_PACKAGE.has(c.type));
  return { licensed: pkgs.filter((c) => (c.licenses ?? []).length > 0).length, total: pkgs.length };
}

/**
 * So `SHA256SUMS` ("<hex>  [*][./]<tên>", dạng `sha256sum`) với tệp đã tải: mỗi tệp tải về phải có dòng trong SHA256SUMS
 * và băm khớp. Tên chuẩn hoá bỏ `./` (release.yml ghi `./sbom.cdx.json`).
 */
export function checksumProblems(sums, files) {
  const listed = new Map();
  for (const line of sums.split("\n").filter((l) => l.trim())) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/i);
    if (m) listed.set(m[2], m[1].toLowerCase());
  }
  const out = [];
  for (const [name, buf] of Object.entries(files)) {
    if (!listed.has(name)) out.push(`${name}: không có trong SHA256SUMS`);
    else if (createHash("sha256").update(buf).digest("hex") !== listed.get(name))
      out.push(`${name}: SHA-256 không khớp SHA256SUMS`);
  }
  return out;
}

const gh = (path, accept) =>
  execFileSync("gh", ["api", ...(accept ? ["-H", `Accept: ${accept}`] : []), path], {
    encoding: accept ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const ghJson = (path) => JSON.parse(gh(path));

function checkRuleset() {
  const repo = ghJson(`repos/${REPO}`);
  const live = ghJson(`repos/${REPO}/rules/branches/${repo.default_branch}`);
  const code = JSON.parse(readFileSync(join(ROOT, ".github/rulesets/main.json"), "utf8"));
  const sets = ghJson(`repos/${REPO}/rulesets`).map((r) => ghJson(`repos/${REPO}/rulesets/${r.id}`));
  return [...rulesetProblems(live, code), ...bypassProblems(sets)];
}

function checkSquashHistory() {
  const repo = ghJson(`repos/${REPO}`);
  const log = execFileSync("git", ["log", "--first-parent", "--format=%s", `origin/${repo.default_branch}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return nonSquashSubjects(log.split("\n")).map((s) => `commit ngoài squash PR: ${s}`);
}

function checkTags() {
  const tags = ghJson(`repos/${REPO}/tags?per_page=100`).map((t) => t.name);
  if (!tags.some((t) => SEMVER_TAG.test(t))) return ["chưa có tag vX.Y.Z nào"];
  return badTags(tags).map((t) => `tag sai SemVer: ${t}`);
}

function checkRelease(tag) {
  const rel = ghJson(tag ? `repos/${REPO}/releases/tags/${tag}` : `repos/${REPO}/releases/latest`);
  const out = [];
  if (rel.draft) out.push(`${rel.tag_name} còn là nháp`);
  const assets = Object.fromEntries(rel.assets.map((a) => [a.name, a]));
  if (!assets["sbom.cdx.json"]) out.push(`${rel.tag_name} thiếu sbom.cdx.json`);
  if (!assets.SHA256SUMS) return [...out, `${rel.tag_name} thiếu SHA256SUMS`];
  const fetch = (name) => gh(`repos/${REPO}/releases/assets/${assets[name].id}`, "application/octet-stream");
  const sboms = Object.fromEntries(
    Object.keys(assets)
      .filter((n) => n.endsWith(".cdx.json"))
      .map((n) => [n, fetch(n)]),
  );
  out.push(...checksumProblems(fetch("SHA256SUMS").toString("utf8"), sboms));
  // Ngưỡng 99% xét TỪNG SBOM: cộng gộp có thể che một SBOM thấp.
  for (const [name, buf] of Object.entries(sboms)) {
    const { licensed, total } = sbomCoverage(JSON.parse(buf.toString("utf8")));
    console.log(`[check-github-live] ${rel.tag_name} ${name}: license ${licensed}/${total} gói`);
    if (total === 0 || licensed / total < 0.99)
      out.push(`${name}: license có ở ${licensed}/${total} gói (< 99%)`);
  }
  return out;
}

if (isMain(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const run = {
    ruleset: checkRuleset,
    "squash-history": checkSquashHistory,
    tags: checkTags,
    release: checkRelease,
  }[cmd];
  if (!run) {
    console.error(
      "Dùng: node scripts/check-github-live.mjs ruleset | squash-history | tags | release [<tag>]",
    );
    process.exit(2);
  }
  const errs = run(arg);
  for (const e of errs) console.error(`✗ ${e}`);
  console.log(`[check-github-live] ${cmd}: ${errs.length ? `${errs.length} lỗi` : "đạt"}`);
  process.exit(errs.length ? 1 : 0);
}
