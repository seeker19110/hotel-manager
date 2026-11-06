// Điều kiện "Không áp dụng" của SEC-AI-002 (D-160): sản phẩm không có agent/LLM — Won't V1 (PROJECT.md). Rào này đỏ khi
// có SDK LLM/agent trong manifest hoặc cấu hình quyền agent (`bypassPermissions`, `allowed_tools`) trong mã sản phẩm —
// khi đó bỏ [~] SEC-AI-002, cài allowlist tool deny-by-default (từ chối allowlist rỗng) và tick bằng bằng chứng thật.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Gói SDK gọi LLM hoặc dựng agent/tool (khớp nguyên tên hoặc tiền tố scope). */
const AI_PACKAGES = [
  /^@anthropic-ai\//,
  /^@ai-sdk\//,
  /^@langchain\//,
  /^@modelcontextprotocol\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^@mistralai\//,
  /^openai$/,
  /^langchain$/,
  /^ai$/,
  /^ollama$/,
  /^cohere-ai$/,
  /^llamaindex$/,
];

function manifests() {
  const out = ["package.json"];
  for (const dir of ["apps", "packages"])
    for (const name of readdirSync(join(ROOT, dir))) out.push(`${dir}/${name}/package.json`);
  return out;
}

function sourceFiles(rel, acc = []) {
  for (const name of readdirSync(join(ROOT, rel))) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const r = `${rel}/${name}`;
    if (statSync(join(ROOT, r)).isDirectory()) sourceFiles(r, acc);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) acc.push(r);
  }
  return acc;
}

describe("SEC-AI-002 — điều kiện Không áp dụng: sản phẩm không có agent/LLM", () => {
  it("không manifest nào phụ thuộc SDK LLM/agent", () => {
    const hits = [];
    for (const m of manifests()) {
      const pkg = JSON.parse(read(m));
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
        for (const dep of Object.keys(pkg[field] ?? {}))
          if (AI_PACKAGES.some((re) => re.test(dep))) hits.push(`${m}: ${dep}`);
    }
    expect(hits, "có SDK LLM/agent: bỏ [~] SEC-AI-002 và làm allowlist tool").toEqual([]);
  });

  it("mã sản phẩm không cấu hình quyền agent (bypassPermissions / allowed_tools / allowedTools)", () => {
    const hits = [];
    for (const dir of ["apps", "packages"])
      for (const f of sourceFiles(dir))
        if (/bypassPermissions|allowed_tools|allowedTools/.test(read(f))) hits.push(f);
    expect(hits).toEqual([]);
  });

  it("bộ dò bắt được SDK thật (không rỗng nghĩa)", () => {
    for (const dep of [
      "@anthropic-ai/sdk",
      "@anthropic-ai/claude-agent-sdk",
      "openai",
      "ai",
      "@ai-sdk/openai",
    ])
      expect(
        AI_PACKAGES.some((re) => re.test(dep)),
        dep,
      ).toBe(true);
    for (const dep of ["aion", "kysely", "zod"])
      expect(
        AI_PACKAGES.some((re) => re.test(dep)),
        dep,
      ).toBe(false);
  });

  it("BLUEPRINT ghi SEC-AI-002 là [~] Không áp dụng, dẫn tới rào này", () => {
    expect(read("BLUEPRINT.md")).toMatch(
      /^- \[~\] `SEC-AI-002` .*— Không áp dụng: .*scripts\/no-ai-agent\.test\.mjs/m,
    );
  });
});
