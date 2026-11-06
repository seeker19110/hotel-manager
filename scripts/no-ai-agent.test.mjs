// Điều kiện "Không áp dụng" của SEC-AI-002 (D-160): sản phẩm không có agent/LLM — Won't V1 (PROJECT.md; kể cả ngoại lệ
// "thử OCR công tơ có người duyệt" chưa làm). Rào này ĐỎ (không tự đổi trạng thái) khi có SDK LLM/agent/suy luận mô hình
// trong manifest, mã gọi thẳng host API LLM, hoặc cấu hình quyền agent trong mã sản phẩm — khi đó (kể cả thử OCR) bỏ [~]
// SEC-AI-002, cài allowlist tool deny-by-default (từ chối allowlist rỗng) và tick bằng bằng chứng thật.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Gói SDK gọi LLM, dựng agent/tool hoặc chạy suy luận mô hình (khớp nguyên tên hoặc tiền tố scope). */
const AI_PACKAGES = [
  /^@anthropic-ai\//,
  /^@openai\//,
  /^@ai-sdk\//,
  /^@langchain\//,
  /^@llamaindex\//,
  /^@mastra\//,
  /^@modelcontextprotocol\//,
  /^@google\/(generative-ai|genai)$/,
  /^@google-cloud\/(vertexai|aiplatform)$/,
  /^@genkit-ai\//,
  /^@aws-sdk\/client-bedrock/,
  /^@azure\/openai$/,
  /^@azure(-rest)?\/ai-/,
  /^@mistralai\//,
  /^@huggingface\//,
  /^@xenova\/transformers$/,
  /^@cloudflare\/ai$/,
  /^(openai|langchain|llamaindex|ai|ollama|cohere-ai|groq-sdk|genkit|replicate|together-ai)$/,
  /^(workers-ai-provider|node-llama-cpp)$/,
];

/** Host API LLM gọi thẳng bằng fetch (không qua SDK). */
const LLM_HOSTS =
  /api\.(openai|anthropic|mistral|cohere|groq|together)\.(com|ai|xyz)|generativelanguage\.googleapis\.com|bedrock-runtime\.|openai\.azure\.com|api-inference\.huggingface\.co|api\.replicate\.com/;

function manifests() {
  const out = ["package.json"];
  for (const dir of ["apps", "packages"])
    for (const name of readdirSync(join(ROOT, dir)))
      if (statSync(join(ROOT, dir, name)).isDirectory()) out.push(`${dir}/${name}/package.json`);
  return out;
}

function sourceFiles(rel, acc = []) {
  for (const name of readdirSync(join(ROOT, rel))) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const r = `${rel}/${name}`;
    if (statSync(join(ROOT, r)).isDirectory()) sourceFiles(r, acc);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)) acc.push(r);
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

  it("mã sản phẩm không cấu hình quyền agent và không gọi thẳng host API LLM", () => {
    const hits = [];
    for (const dir of ["apps", "packages"])
      for (const f of sourceFiles(dir)) {
        const src = read(f);
        if (/bypassPermissions|dangerously-skip-permissions|allowed_tools|allowedTools/.test(src))
          hits.push(`${f}: quyền agent`);
        if (LLM_HOSTS.test(src)) hits.push(`${f}: host API LLM`);
      }
    expect(hits).toEqual([]);
  });

  it("bộ dò bắt được SDK và host thật (không rỗng nghĩa)", () => {
    for (const host of [
      "https://api.openai.com/v1/chat",
      "https://api.anthropic.com/v1/messages",
      "https://x.openai.azure.com/",
    ])
      expect(LLM_HOSTS.test(host), host).toBe(true);
    for (const dep of [
      "@anthropic-ai/sdk",
      "@anthropic-ai/claude-agent-sdk",
      "openai",
      "@openai/agents",
      "ai",
      "@ai-sdk/openai",
      "@aws-sdk/client-bedrock-runtime",
      "@aws-sdk/client-bedrock-agent-runtime",
      "@google-cloud/vertexai",
      "@azure/openai",
      "@azure-rest/ai-inference",
      "@azure/ai-projects",
      "groq-sdk",
      "@huggingface/inference",
      "@mastra/core",
      "@llamaindex/core",
      "genkit",
      "@genkit-ai/googleai",
      "replicate",
      "together-ai",
      "@cloudflare/ai",
      "workers-ai-provider",
      "node-llama-cpp",
      "@xenova/transformers",
    ])
      expect(
        AI_PACKAGES.some((re) => re.test(dep)),
        dep,
      ).toBe(true);
    for (const dep of ["aion", "kysely", "zod", "@aws-sdk/client-s3", "@azure/storage-blob", "ai-utils"])
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
