// DB-PERF-004 — `docs/db/connections.md` khớp mã: trần pool từng tiến trình và tổng theo bản sao.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

const maxOf = (src: string, re: RegExp): number => {
  const m = re.exec(src);
  if (!m) throw new Error(`không thấy ${re}`);
  return Number(m[1]);
};

describe("connections-doc — bảng kết nối khớp mã", () => {
  const doc = read("docs/db/connections.md");
  const web = maxOf(
    read("packages/app/src/server/context.ts"),
    /createPool\(config\.DATABASE_URL, \{ max: (\d+) \}\)/,
  );
  const auth = maxOf(read("packages/app/src/auth/auth.ts"), /search_path=auth", max: (\d+) \}/);
  const runtime = read("apps/worker/src/runtime.ts");
  const workerPool = maxOf(runtime, /createPool\(cfg\.workerDatabaseUrl, \{ max: (\d+)/);
  const workerRuntime = maxOf(runtime, /createPool\(config\.DATABASE_URL, \{ max: (\d+)/);
  const boss = maxOf(runtime, /application_name: "hm-worker-boss",\s*max: (\d+)/);

  it("mỗi trần pool trong mã có đúng hàng trong bảng", () => {
    expect(doc).toMatch(new RegExp(`\\| web \\| dữ liệu ứng dụng \\|[^|]*\\| ${web} \\|`));
    expect(doc).toMatch(new RegExp(`\\| web \\| xác thực[^|]*\\|[^|]*\\| ${auth} \\|`));
    expect(doc).toMatch(new RegExp(`\\| worker \\| job nền/relay outbox \\|[^|]*\\| ${workerPool} \\|`));
    expect(doc).toMatch(
      new RegExp(`\\| worker \\| lệnh theo ngữ cảnh tổ chức \\|[^|]*\\| ${workerRuntime} \\|`),
    );
    expect(doc).toMatch(new RegExp(`\\| worker \\| pg-boss[^|]*\\|[^|]*\\| ${boss} \\|`));
  });

  it("tổng theo bản sao và ngân sách ≤ max_connections", () => {
    const webTotal = web + auth;
    const workerTotal = workerPool + workerRuntime + boss;
    expect(doc).toContain(`web = ${web} + ${auth} = **${webTotal}**`);
    expect(doc).toContain(`worker = ${workerPool} + ${workerRuntime} + ${boss} = **${workerTotal}**`);
    const available = 100 - 3 - 10;
    expect(doc).toContain(`\`${webTotal} × W + ${workerTotal} × K ≤ ${available}\``);
    // Pilot một web + một worker phải nằm trong ngân sách.
    expect(webTotal + workerTotal).toBeLessThanOrEqual(available);
  });

  it("tài liệu nêu max_connections = 100 như RUNBOOK", () => {
    expect(doc).toContain("`max_connections = 100`");
    expect(read("docs/RUNBOOK.md")).toContain("max_connections=100");
  });
});
