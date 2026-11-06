// Điều kiện "Không áp dụng" của SEC-AI-002 (D-160): sản phẩm không có agent/LLM — Won't V1 (PROJECT.md). Rào này ĐỎ (không
// tự đổi trạng thái) khi manifest hoặc lockfile có SDK LLM/agent trong AI_PACKAGES, mã gọi thẳng API LLM (host hoặc đường
// dẫn API), hoặc mã sản phẩm cấu hình quyền agent — khi đó (kể cả thử OCR công tơ nếu làm QUA LLM/SDK trong danh sách) bỏ
// [~] SEC-AI-002, cài allowlist tool deny-by-default (từ chối allowlist rỗng) và tick bằng bằng chứng thật. OCR không qua
// LLM/agent (tesseract.js, Cloud Vision, Textract, Azure Form Recognizer) không gọi tool nên ngoài phạm vi SEC-AI-002 (T-2613).
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
  /^@azure(-rest)?\/ai-(inference|projects|agents)/,
  /^@mistralai\//,
  /^@huggingface\//,
  /^@xenova\/transformers$/,
  /^@cloudflare\/ai$/,
  /^(openai|langchain|llamaindex|ai|ollama|cohere-ai|groq-sdk|genkit|replicate|together-ai)$/,
  /^(workers-ai-provider|node-llama-cpp)$/,
];

/**
 * Gọi thẳng API LLM bằng fetch (không qua SDK): host nhà cung cấp đã biết, hoặc đường dẫn API đặc trưng — bắt cả base URL
 * lấy từ env/tự host (Ollama, vLLM, LiteLLM…), vì tự host là mặc định của dự án (AGENTS §5). T-2611, AUD-HAR-005.
 */
const LLM_HOSTS = new RegExp(
  [
    String.raw`api\.(openai|anthropic|mistral|cohere|groq|together|deepseek|perplexity|fireworks)\.(com|ai|xyz)`,
    String.raw`api\.x\.ai\b`,
    String.raw`generativelanguage\.googleapis\.com`,
    String.raw`aiplatform\.googleapis\.com`,
    String.raw`bedrock-runtime\.`,
    String.raw`openai\.azure\.com`,
    String.raw`cognitiveservices\.azure\.com/openai`,
    String.raw`services\.ai\.azure\.com`,
    String.raw`(api-inference|router)\.huggingface\.co`,
    String.raw`api\.replicate\.com`,
    String.raw`openrouter\.ai`,
    String.raw`models\.github\.ai`,
    "/ai/run/",
    String.raw`/chat/completions\b`,
    String.raw`:generateContent\b`,
    String.raw`/api/(chat|generate|embed|embeddings)\b(?![-/])`,
    String.raw`/v1/(messages|responses|completions)\b`,
  ].join("|"),
);

function manifests() {
  const out = ["package.json"];
  for (const dir of ["apps", "packages"])
    for (const name of readdirSync(join(ROOT, dir)))
      if (statSync(join(ROOT, dir, name)).isDirectory()) out.push(`${dir}/${name}/package.json`);
  return out;
}

/**
 * Tên mọi gói trong pnpm-lock.yaml (v9, có thể nhiều tài liệu YAML): khoá thụt 2 khoảng trong `packages:`/`snapshots:`
 * dạng `name@version` hoặc `'@scope/name@version(peer…)'`.
 */
function lockPackageNames(text) {
  const names = new Set();
  let inSection = false;
  for (const line of text.split("\n")) {
    if (/^(packages|snapshots):\s*$/.test(line)) inSection = true;
    else if (/^\S/.test(line)) inSection = false;
    else if (inSection && /^ {2}\S.*:\s*$/.test(line)) {
      const key = line.trim().replace(/:\s*$/, "").replace(/^'|'$/g, "");
      const at = key.indexOf("@", 1);
      if (at > 0) names.add(key.slice(0, at));
    }
  }
  return names;
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

describe("T-2612 (AUD-HAR-006) — phụ thuộc gián tiếp trong pnpm-lock.yaml", () => {
  it("lockPackageNames đọc tên gói (scope, peer suffix, nhiều tài liệu YAML)", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@google/adk@2.4.0':",
      "    resolution: {integrity: sha512-x}",
      "  '@google/genai@1.30.0':",
      "    resolution: {integrity: sha512-y}",
      "  zod@4.6.6:",
      "snapshots:",
      "  '@google/adk@2.4.0(zod@4.6.6)':",
      "    dependencies:",
      "      '@google/genai': 1.30.0",
      "---",
      "packages:",
      "  '@pnpm/exe@12.16.1':",
    ].join("\n");
    expect([...lockPackageNames(lock)].sort()).toEqual(["@google/adk", "@google/genai", "@pnpm/exe", "zod"]);
    expect([...lockPackageNames(lock)].filter((n) => AI_PACKAGES.some((re) => re.test(n)))).toEqual([
      "@google/genai",
    ]);
  });
  it("không gói nào trong pnpm-lock.yaml (kể cả gián tiếp) là SDK LLM/agent", () => {
    const names = lockPackageNames(read("pnpm-lock.yaml"));
    expect(names.size).toBeGreaterThan(100);
    expect([...names].filter((n) => AI_PACKAGES.some((re) => re.test(n)))).toEqual([]);
  });
});

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
      // T-2611 (AUD-HAR-005): host mới và base URL lấy từ env (bắt theo đường dẫn API).
      "https://router.huggingface.co/v1/chat/completions",
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m:generateContent",
      "https://x.cognitiveservices.azure.com/openai/deployments/d/chat/completions",
      "https://x.services.ai.azure.com/models",
      "https://models.github.ai/inference",
      "https://api.deepseek.com/chat",
      "https://api.x.ai/v1/messages",
      "https://openrouter.ai/api/v1/chat/completions",
      "https://api.perplexity.ai/chat",
      "https://api.fireworks.ai/inference/v1",
      "https://api.cloudflare.com/client/v4/accounts/a/ai/run/@cf/meta/llama",
      "http://localhost:11434/api/chat",
      "fetch(env.LLM_BASE_URL + '/v1/chat/completions')",
      "fetch(base + '/models/gemini:generateContent')",
      // Review #152 🟢2: API tương thích Anthropic/OpenAI tự host (base URL từ env).
      "fetch(base + '/v1/messages')",
      "fetch(base + '/v1/responses')",
      "fetch(base + '/v1/completions')",
      "http://localhost:11434/api/embed",
    ])
      expect(LLM_HOSTS.test(host), host).toBe(true);
    for (const s of [
      "https://api.github.com/repos",
      "https://s3.amazonaws.com/b",
      "https://api.stripe.com/v1",
      "/api/chat-room",
      // Review #152 🟢1: không bắt nhầm API của X/Twitter, OCR Azure (Document Intelligence), route con nội bộ.
      "https://api.x.com/2/tweets",
      "https://r.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read:analyze",
      "/api/chat/rooms",
    ])
      expect(LLM_HOSTS.test(s), s).toBe(false);
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
    // OCR không qua LLM/agent nằm ngoài phạm vi (T-2613) — nhất quán giữa các nhà cung cấp.
    for (const dep of [
      "aion",
      "kysely",
      "zod",
      "@aws-sdk/client-s3",
      "@azure/storage-blob",
      "ai-utils",
      "tesseract.js",
      "@google-cloud/vision",
      "@aws-sdk/client-textract",
      "@azure/ai-form-recognizer",
    ])
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
