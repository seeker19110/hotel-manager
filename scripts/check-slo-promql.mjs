// OPS-SLO-001: truy vấn SLI trong docs/ops/SLO.md phải là PromQL hợp lệ — trích mọi khối ```promql, mỗi dòng không phải
// chú thích là một truy vấn (cửa sổ `[W]` thay bằng `[5m]`), bọc thành recording rule tạm rồi chạy `promtool check rules`.
// Dùng: `node scripts/check-slo-promql.mjs` (cần promtool trong PATH hoặc PROMTOOL_BIN; cài: `bash scripts/ops-tools.sh install promtool`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FENCE = /```promql\n([\s\S]*?)```/g;

/** Mọi truy vấn PromQL trong khối ```promql của một tài liệu markdown (bỏ dòng trống và dòng chú thích `#`). */
export function extractQueries(markdown) {
  const out = [];
  for (const m of markdown.matchAll(FENCE)) {
    for (const raw of (m[1] ?? "").split("\n")) {
      const q = raw.trim();
      if (!q || q.startsWith("#")) continue;
      out.push(q.replaceAll("[W]", "[5m]"));
    }
  }
  return out;
}

/** File rules tạm: mỗi truy vấn là một recording rule (promtool kiểm cú pháp biểu thức). */
export function buildRulesYaml(queries) {
  const rules = queries.map(
    (q, i) => `      - record: hm:slo_check:q${i + 1}\n        expr: ${JSON.stringify(q)}`,
  );
  return `groups:\n  - name: slo-md-check\n    rules:\n${rules.join("\n")}\n`;
}

export function main(path = join(ROOT, "docs/ops/SLO.md")) {
  const queries = extractQueries(readFileSync(path, "utf8"));
  if (queries.length === 0) {
    process.stderr.write(`${path}: không có truy vấn PromQL nào trong khối \`\`\`promql\n`);
    return 1;
  }
  const work = mkdtempSync(join(tmpdir(), "hm-slo-"));
  try {
    const file = join(work, "slo-queries.rules.yml");
    writeFileSync(file, buildRulesYaml(queries));
    const r = spawnSync(process.env.PROMTOOL_BIN || "promtool", ["check", "rules", file], {
      stdio: "inherit",
    });
    if (r.error) {
      process.stderr.write(`không chạy được promtool: ${r.error.message}\n`);
      return 1;
    }
    process.stdout.write(`[slo-promql] ${queries.length} truy vấn · promtool exit ${r.status}\n`);
    return r.status ?? 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv[2]));
