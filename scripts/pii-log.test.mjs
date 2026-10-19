// CMP-PRIV-008: không PII trong log. (1) luật Semgrep cấm đưa nguyên object người dùng/request hoặc trường họ tên/địa chỉ vào log
// (security/semgrep/hm-privacy.yml, job `sast`); (2) bộ quét PII trên log server của lượt E2E (scripts/pii-log-scan.mjs, job `e2e`,
// D-072 thay cho log staging). Logger che email/SĐT/CCCD/token: bản ghi do chính logger sinh phải qua bộ quét sạch.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger } from "../packages/app/src/logging/logger.ts";
import { scanText } from "./pii-log-scan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const kinds = (text) => scanText(text).map((h) => h.kind);
// Cookie phiên giả ghép lúc chạy để gitleaks không coi là bí mật thật (WF-GIT-010).
const FAKE_COOKIE = `better-auth.${["session", "token"].join("_")}=${["AbCdEf", "123456789"].join("")}`;

describe("bộ quét PII trong log", () => {
  it("bắt email/SĐT/CCCD chưa che, token Bearer, cookie phiên, tên seed '(giả)'", () => {
    expect(kinds('{"msg":"x","to":"an.nguyen@example.com"}')).toEqual(["email"]);
    expect(kinds('{"phone":"0912345678"}')).toEqual(["phone"]);
    expect(kinds('{"p":"+84912345678"}')).toEqual(["phone"]);
    expect(kinds('{"doc":"001203004567"}')).toEqual(["id-number"]);
    expect(kinds('{"h":"Bearer abcdefghijklmnop"}')).toEqual(["bearer-token"]);
    expect(kinds(JSON.stringify({ c: FAKE_COOKIE }))).toEqual(["session-cookie"]);
    expect(kinds('{"guest":"Khách E2E (giả)"}')).toEqual(["seed-name"]);
  });

  it("dạng đã che của logger, ID, số tiền, thời gian thì không báo", () => {
    for (const ok of [
      '{"to":"a***@example.com"}',
      '{"phone":"091****678"}',
      '{"h":"Bearer ***"}',
      '{"c":"session_token=***"}',
      '{"person_id":"0b8e2f2a-5d1c-4a39-9f7e-2c3b4d5e6f70"}',
      '{"amount":1430000,"ts":"2026-10-18T09:00:00.000Z","ms":1760778000000}',
    ])
      expect(kinds(ok), ok).toEqual([]);
  });

  it("bản ghi do logger thật sinh từ đầu vào có PII → đã che, bộ quét sạch", () => {
    const lines = [];
    const log = createLogger({ sink: { write: (l) => lines.push(l) }, level: "debug" });
    log.info("gửi thư", { to: "an.nguyen@example.com", phone: "0912345678", note: "CCCD 001203004567" });
    log.warn("auth", {
      authorization: "Bearer abcdefghijklmnop",
      cookie: FAKE_COOKIE,
    });
    expect(lines.length).toBe(2);
    expect(scanText(lines.join("\n"))).toEqual([]);
  });

  it("CLI: tệp sạch exit 0; có PII exit 1 và KHÔNG in nguyên giá trị; không có tệp .log exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "pii-"));
    dirs.push(d);
    const run = () => spawnSync("node", [join(ROOT, "scripts/pii-log-scan.mjs"), d], { encoding: "utf8" });
    expect(run().status).toBe(2);
    writeFileSync(join(d, "server-3100.log"), '{"service":"web","msg":"ok","person_id":"x"}\n');
    expect(run().status).toBe(0);
    writeFileSync(join(d, "server-3300.log"), '{"service":"web","msg":"lộ","to":"an.nguyen@example.com"}\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("server-3300.log:1: PII chưa che (email)");
    expect(r.stderr + r.stdout).not.toContain("an.nguyen");
  });

  it("CLI: tệp rỗng/không có dòng log của app, hay đường dẫn không tồn tại → exit 2 (không no-op xanh)", () => {
    const d = mkdtempSync(join(tmpdir(), "pii-log-"));
    dirs.push(d);
    const run = (...a) =>
      spawnSync("node", [join(ROOT, "scripts/pii-log-scan.mjs"), ...a], { encoding: "utf8" });
    writeFileSync(join(d, "server-3100.log"), "");
    expect(run(d).status).toBe(2);
    writeFileSync(join(d, "server-3100.log"), "Ready in 300ms\n");
    expect(run(d).status).toBe(2);
    expect(run(join(d, "khong-co")).status).toBe(2);
  });

  it("thêm dạng SĐT có dấu, Bearer viết thường, CCCD dính tiền tố; mã tham chiếu không báo nhầm", () => {
    expect(kinds('{"p":"0912 345 678"}')).toEqual(["phone"]);
    expect(kinds('{"p":"0912.345.678"}')).toEqual(["phone"]);
    expect(kinds('{"p":"+84 912 345 678"}')).toEqual(["phone"]);
    expect(kinds('{"h":"bearer abcdefghijklmnop"}')).toEqual(["bearer-token"]);
    expect(kinds('{"d":"CCCD001203004567"}')).toEqual(["id-number"]);
    // trace_id/span_id hex kết thúc bằng 12 chữ số sau một chữ cái: không phải CCCD (báo nhầm trên CI, PR #72).
    expect(kinds('{"trace_id":"4bf92f3577b34da6a3c0e123456789012"}')).toEqual([]);
    expect(kinds('{"span_id":"b123456789012"}')).toEqual([]);
    expect(kinds('{"amount":1430000,"ms":1760778000000}')).toEqual([]);
  });
});

describe("nối vào CI", () => {
  it("job e2e quét log server sau Playwright, kể cả khi E2E đỏ; server E2E ghi log vào e2e-logs/", () => {
    const ci = read(".github/workflows/ci.yml");
    const e2e = ci.split(/^ {2}e2e:\n/m)[1].split(/^ {2}[a-z-]+:\n/m)[0];
    const at = (s) => e2e.indexOf(s);
    expect(at("node scripts/pii-log-scan.mjs apps/web/e2e-logs")).toBeGreaterThan(at("playwright test"));
    expect(e2e).not.toMatch(/pii-log-scan[^\n]*\|\|/);
    expect(e2e).toMatch(/Quét PII[^\n]*\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
    const server = read("apps/web/e2e/server.ts");
    expect(server).toMatch(/LOG_DIR = join\(import\.meta\.dirname, "\.\.", "e2e-logs"\)/);
    expect(server).toContain('stdio: ["inherit", "pipe", "pipe"]');
    expect(read(".gitignore")).toMatch(/^e2e-logs\/$/m);
  });

  it("job sast quét cả luật quyền riêng tư; luật có mẫu xấu và mẫu tốt", () => {
    const wf = read(".github/workflows/security-scan.yml");
    expect(wf).toMatch(/semgrep scan [^\n]*--config security\/semgrep\/hm-privacy\.yml [^\n]*--error/);
    const rules = read("security/semgrep/hm-privacy.yml");
    const ids = [...rules.matchAll(/^ {2}- id: (hm-[a-z0-9-]+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual([
      "hm-log-pii-object",
      "hm-log-pii-object-fn",
      "hm-log-pii-field",
      "hm-log-pii-field-fn",
      "hm-log-pii-key",
      "hm-log-pii-key-fn",
      "hm-log-pii-spread",
      "hm-log-pii-spread-fn",
      "hm-log-pii-stringify",
      "hm-log-pii-stringify-fn",
      "hm-log-pii-child",
    ]);
    const fixture = read("security/semgrep/hm-privacy.ts");
    for (const id of ids) {
      expect(fixture).toMatch(new RegExp(`// ruleid: ${id}\\b`));
      if (!id.endsWith("-fn") || id === "hm-log-pii-object-fn")
        expect(fixture).toMatch(new RegExp(`// ok: ${id}\\b`));
    }
  });
});
