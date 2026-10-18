// T-806: rào máy cho hợp đồng API và vận hành — ruleset Spectral (BE-API-001), test rule Prometheus + truy vấn SLO (OPS-SLO-001),
// cấu hình Collector + kịch bản chạy thật (OPS-OBS-001), test N−1 trên schema N (OPS-DEPLOY-003), và workflow `api-ops.yml` khoá
// các bước đó trên CI. Phần chạy công cụ nhị phân (promtool/otelcol-contrib) nằm ở CI; ở đây kiểm cấu trúc + logic thuần.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildRulesYaml, extractQueries } from "./check-slo-promql.mjs";
import { flattenRecords, queryByService, sampleDockerLog, verify } from "./otel-collector-e2e.mjs";
import {
  appliedMigrationProblems,
  BASELINE_FILES,
  MIGRATIONS_REL,
  overlay,
  registryKeys,
  registryProblems,
} from "./schema-compat.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const scratch = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hm-apiops-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

// ───────────────────────── Spectral (BE-API-001) ─────────────────────────
function spectral(file) {
  const outFile = join(tmp(), "spectral.json");
  const r = spawnSync(
    join(ROOT, "node_modules/.bin/spectral"),
    [
      "lint",
      file,
      "--ruleset",
      join(ROOT, ".spectral.yaml"),
      "--fail-severity=warn",
      "--format",
      "json",
      "--output",
      outFile,
    ],
    { encoding: "utf8" },
  );
  const out = existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "";
  return { status: r.status, codes: out ? JSON.parse(out).map((x) => x.code) : [] };
}

describe("BE-API-001 — Spectral lint hợp đồng OpenAPI", { timeout: 90_000 }, () => {
  const spec = JSON.parse(read("apps/web/openapi.json"));
  const withSpec = (mutate) => {
    const doc = structuredClone(spec);
    mutate(doc);
    const f = join(tmp(), "openapi.json");
    writeFileSync(f, JSON.stringify(doc));
    return spectral(f);
  };

  it("spec thật sạch (không lỗi, không cảnh báo) và `pnpm lint:openapi` trỏ đúng file + ruleset", () => {
    expect(spectral(join(ROOT, "apps/web/openapi.json"))).toEqual({ status: 0, codes: [] });
    const script = JSON.parse(read("package.json")).scripts["lint:openapi"];
    expect(script).toContain("apps/web/openapi.json");
    expect(script).toContain(".spectral.yaml");
    expect(script).toContain("--fail-severity=warn");
    expect(read("xt.yaml")).toMatch(/^lint: ".*pnpm lint:openapi/m);
  });

  it("mỗi lỗi hợp đồng bị đúng rule bắt: thiếu 4xx, thiếu operationId, thiếu tag, operationId trùng", () => {
    const posts = Object.entries(spec.paths).filter(([, p]) => p.post);
    const [no4xx, noId, noTags, dupA, dupB] = posts.map(([path]) => path);
    const r = withSpec((d) => {
      const op = d.paths[no4xx].post;
      op.responses = { 200: op.responses["200"] ?? { description: "ok" }, 500: { description: "lỗi" } };
      delete d.paths[noId].post.operationId;
      d.paths[noTags].post.tags = [];
      d.paths[dupB].post.operationId = d.paths[dupA].post.operationId;
    });
    expect(r.status).toBe(1);
    expect(r.codes).toEqual(
      expect.arrayContaining([
        "hm-operation-has-error-response",
        "operation-operationId",
        "operation-tags",
        "operation-operationId-unique",
      ]),
    );
  });

  it("biên: chỉ có `default` hoặc chỉ `4XX` vẫn đạt rule phản hồi lỗi", () => {
    const [a, b] = Object.entries(spec.paths)
      .filter(([, p]) => p.post)
      .map(([path]) => path);
    const r = withSpec((d) => {
      d.paths[a].post.responses = { 200: { description: "ok" }, default: { description: "lỗi" } };
      d.paths[b].post.responses = { 200: { description: "ok" }, "4XX": { description: "lỗi" } };
    });
    expect(r.codes).not.toContain("hm-operation-has-error-response");
  });

  it("biên: khoá mở rộng `x-*` không được tính là phản hồi 4xx (chỉ 2xx + x-note vẫn đỏ; thêm 4xx thì xanh)", () => {
    const [a, b] = Object.entries(spec.paths)
      .filter(([, p]) => p.post)
      .map(([path]) => path);
    const r = withSpec((d) => {
      d.paths[a].post.responses = { 200: { description: "ok" }, "x-note": { description: "không phải mã" } };
      d.paths[b].post.responses = {
        200: { description: "ok" },
        "x-note": { description: "không phải mã" },
        422: { description: "lỗi" },
      };
    });
    expect(r.codes.filter((c) => c === "hm-operation-has-error-response")).toHaveLength(1);
  });

  it("không phải OpenAPI hợp lệ (thiếu info) → đỏ", () => {
    const r = withSpec((d) => {
      delete d.info;
    });
    expect(r.status).toBe(1);
  });
});

// ───────────────────────── Prometheus (OPS-SLO-001) ─────────────────────────
describe("OPS-SLO-001 — test rule Prometheus + truy vấn SLO", () => {
  const alerts = read("deploy/prometheus/alerts.yml");
  const tests = read("deploy/prometheus/alerts.test.yml");
  const pageAlerts = [...alerts.matchAll(/- alert: (\w+)\n(?:(?!\n\s*- alert:)[\s\S])*?severity: page/g)].map(
    (m) => m[1],
  );

  it("tìm được các cảnh báo page (không rỗng) gồm burn rate nhanh", () => {
    expect(pageAlerts).toEqual(
      expect.arrayContaining(["HmAvailabilityBurnFast", "HmLatencyBurnFast", "HmMetricsDown"]),
    );
  });

  it("test nạp đúng alerts.yml và mỗi cảnh báo page có ca BÁO lẫn ca KHÔNG BÁO", () => {
    expect(tests).toMatch(/^rule_files:\n {2}- alerts\.yml$/m);
    for (const name of pageAlerts) {
      const blocks = tests
        .split(/\n {6}- eval_time:/)
        .filter((b) => new RegExp(`alertname: ${name}\\b`).test(b));
      expect(blocks.length, `${name} chưa có test`).toBeGreaterThanOrEqual(1);
      const total = [...tests.matchAll(new RegExp(`alertname: ${name}\\b\\n\\s+exp_alerts:( \\[\\])?`, "g"))];
      expect(
        total.some((m) => m[1]),
        `${name} thiếu ca không báo`,
      ).toBe(true);
      expect(
        total.some((m) => !m[1]),
        `${name} thiếu ca báo`,
      ).toBe(true);
    }
  });

  it("workflow chạy `promtool check rules`, `promtool test rules` và kiểm PromQL của SLO.md", () => {
    const wf = read(".github/workflows/api-ops.yml");
    expect(wf).toContain("promtool check rules deploy/prometheus/alerts.yml");
    expect(wf).toContain("promtool test rules deploy/prometheus/alerts.test.yml");
    expect(wf).toContain("node scripts/check-slo-promql.mjs");
  });

  it("extractQueries: bỏ chú thích/dòng trống, thay [W], bỏ qua khối không phải promql, rỗng → []", () => {
    const md = "text\n```promql\n# chú thích\n\nsum(rate(a[W]))\n  b / c  \n```\n```sh\nnot a query\n```\n";
    expect(extractQueries(md)).toEqual(["sum(rate(a[5m]))", "b / c"]);
    expect(extractQueries("không có khối nào")).toEqual([]);
    expect(extractQueries("```promql\n# chỉ chú thích\n```")).toEqual([]);
  });

  it("buildRulesYaml: mỗi truy vấn thành một recording rule, thoát đúng nháy/Unicode", () => {
    const y = buildRulesYaml(['sum(a{x="1"})', "vi_du_ký_tự"]);
    expect(y).toContain('expr: "sum(a{x=\\"1\\"})"');
    expect(y).toContain("record: hm:slo_check:q2");
    expect(y).toContain('expr: "vi_du_ký_tự"');
  });

  it("SLO.md có SLI khả dụng và độ trễ dạng truy vấn PromQL cụ thể", () => {
    const qs = extractQueries(read("docs/ops/SLO.md"));
    expect(qs.some((q) => q.includes("hm_http_requests_total") && q.includes('status=~"5.."'))).toBe(true);
    expect(
      qs.some((q) => q.includes("hm_http_request_duration_seconds_bucket") && q.includes('le="0.8"')),
    ).toBe(true);
    expect(qs.every((q) => !q.includes("[W]"))).toBe(true);
  });
});

// ───────────────────────── Collector (OPS-OBS-001) ─────────────────────────
describe("OPS-OBS-001 — cấu hình OTel Collector", () => {
  const cfg = read("deploy/otel/collector.yaml");

  it("receiver file log + otlp, processor resource gắn 3 khoá, KHÔNG có processor lọc/loại dòng", () => {
    expect(cfg).toMatch(/^ {2}file_log\/app:/m);
    expect(cfg).toMatch(/^ {2}otlp:/m);
    for (const key of ["service.name", "service.version", "deployment.environment"]) {
      expect(cfg, `thiếu resource ${key}`).toMatch(
        new RegExp(`key: ${key.replace(".", "\\.")}\\n\\s+value: .+\\n\\s+action: insert`),
      );
    }
    expect(cfg).toMatch(/processors: \[[^\]]*resource\/app[^\]]*\]/);
    expect(cfg).not.toMatch(/^ {2}(filter|transform)\b/m);
    expect(cfg).not.toMatch(/type: (filter|remove)\b/);
  });

  it("dòng không parse được vẫn đi tiếp (on_error: send) và được gắn `unparsed`", () => {
    expect(cfg).toMatch(/id: parse_json[\s\S]*?on_error: send/);
    expect(cfg).toMatch(/id: mark_unparsed[\s\S]*?attributes\["unparsed"\][\s\S]*?value: "true"/);
  });

  it("không đọc biến môi trường của ứng dụng (chỉ biến HM_LOG_*/HM_OTEL_*/HM_DEPLOYMENT_ENV của Collector, có mặc định)", () => {
    const vars = [...cfg.matchAll(/\$\{env:(\w+)(:-[^}]*)?\}/g)];
    expect(vars.length).toBeGreaterThan(0);
    for (const [, name, dflt] of vars) {
      expect(name).toMatch(/^HM_(LOG_|OTEL_|DEPLOYMENT_ENV)/);
      expect(dflt, `${name} phải có mặc định`).toBeTruthy();
    }
    expect(read(".env.example")).not.toMatch(/HM_OTEL|HM_LOG_INCLUDE/);
  });

  it("workflow: validate + chạy thật kịch bản e2e", () => {
    const wf = read(".github/workflows/api-ops.yml");
    expect(wf).toContain("otelcol-contrib validate --config deploy/otel/collector.yaml");
    expect(wf).toContain("node scripts/otel-collector-e2e.mjs");
  });
});

describe("otel-collector-e2e — phân tích đầu ra", () => {
  const rec = (resource, attributes, body, extra = {}) => ({
    resource,
    attributes,
    body,
    severityNumber: 9,
    traceId: "",
    spanId: "",
    time: 0n,
    ...extra,
  });
  const attr = (o) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
  const jsonl = (docs) => `${docs.map((d) => JSON.stringify(d)).join("\n")}\n`;

  it("flattenRecords đọc OTLP/JSON: resource, attributes, body, severity, trace; bỏ dòng trống; rỗng → []", () => {
    const text = jsonl([
      {
        resourceLogs: [
          {
            resource: { attributes: attr({ "service.name": "hm-web" }) },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1792285323123000000",
                    severityNumber: 9,
                    body: { stringValue: "chào" },
                    attributes: attr({ k: "v" }),
                    traceId: "ab",
                    spanId: "cd",
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const [r] = flattenRecords(`\n${text}\n`);
    expect(r).toMatchObject({
      resource: { "service.name": "hm-web" },
      attributes: { k: "v" },
      body: "chào",
      severityNumber: 9,
      traceId: "ab",
      spanId: "cd",
      time: 1792285323123000000n,
    });
    expect(flattenRecords("")).toEqual([]);
    expect(flattenRecords("\n\n")).toEqual([]);
  });

  it("queryByService lọc đúng theo service.name", () => {
    const rs = [
      rec({ "service.name": "a" }, {}, "1"),
      rec({ "service.name": "b" }, {}, "2"),
      rec({}, {}, "3"),
    ];
    expect(queryByService(rs, "a").map((r) => r.body)).toEqual(["1"]);
    expect(queryByService(rs, "zzz")).toEqual([]);
  });

  it("mẫu docker log có 4 dòng hợp lệ + 3 dòng không parse được, đều là một dòng JSON bọc Docker", () => {
    const lines = sampleDockerLog().trim().split("\n");
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ stream: "stdout" });
  });

  it("verify: rỗng (Collector không xuất gì) → lỗi; thiếu dòng rác → lỗi", () => {
    expect(verify([]).length).toBeGreaterThan(0);
    const dropped = verify([rec({ "service.name": "hm-web" }, {}, "x")]);
    expect(dropped.join("\n")).toMatch(/đủ 7 bản ghi/);
  });
});

// ───────────────────────── N−1 trên schema N (OPS-DEPLOY-003) ─────────────────────────
describe("OPS-DEPLOY-003 — schema-compat (bản N−1 trên schema N)", () => {
  const fixture = (files) => {
    const root = tmp();
    mkdirSync(join(root, MIGRATIONS_REL), { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(root, MIGRATIONS_REL, name), content);
    return root;
  };

  /** index.ts giả với sổ `migrations` chứa các khoá cho trước. */
  const idx = (...keys) =>
    `export const migrations = {\n${keys.map((k, i) => `  "${k}": m${i},`).join("\n")}\n};\n`;

  it("appliedMigrationProblems: giống nhau/thêm mới → sạch; sửa, xoá, đổi tên → báo", () => {
    const base = new Map([
      ["0001_a.ts", "A"],
      ["0002_b.ts", "B"],
    ]);
    expect(appliedMigrationProblems(base, new Map([...base, ["0003_c.ts", "C"]]))).toEqual([]);
    expect(
      appliedMigrationProblems(
        base,
        new Map([
          ["0001_a.ts", "A"],
          ["0002_b.ts", "B2"],
        ]),
      )[0],
    ).toMatch(/0002_b\.ts.*sửa/);
    expect(appliedMigrationProblems(base, new Map([["0001_a.ts", "A"]]))[0]).toMatch(/0002_b\.ts.*xoá/);
    expect(
      appliedMigrationProblems(
        base,
        new Map([
          ["0001_a.ts", "A"],
          ["0002_renamed.ts", "B"],
        ]),
      )[0],
    ).toMatch(/0002_b\.ts/);
    expect(appliedMigrationProblems(new Map(), new Map())).toEqual([]);
  });

  it("overlay: chép migration mới + index.ts của PR đè lên nền; giữ nguyên phần còn lại của nền", () => {
    const base = fixture({ "0001_a.ts": "A", "index.ts": idx("0001_a") });
    const head = fixture({ "0001_a.ts": "A", "0002_b.ts": "B", "index.ts": idx("0001_a", "0002_b") });
    writeFileSync(join(base, "marker.txt"), "giữ");
    expect(overlay(base, head)).toBe(0);
    expect(readFileSync(join(base, MIGRATIONS_REL, "0002_b.ts"), "utf8")).toBe("B");
    expect(readFileSync(join(base, MIGRATIONS_REL, "index.ts"), "utf8")).toBe(idx("0001_a", "0002_b"));
    expect(existsSync(join(base, "marker.txt"))).toBe(true);
  });

  it("overlay: PR sửa/xoá migration đã áp → exit 1 và KHÔNG chép gì", () => {
    const base = fixture({ "0001_a.ts": "A", "index.ts": idx("0001_a") });
    const edited = fixture({ "0001_a.ts": "A'", "index.ts": idx("0001_a") });
    expect(overlay(base, edited)).toBe(1);
    expect(readFileSync(join(base, MIGRATIONS_REL, "index.ts"), "utf8")).toBe(idx("0001_a"));
    const removed = fixture({ "index.ts": idx("0001_a") });
    expect(overlay(base, removed)).toBe(1);
  });

  it("registryKeys/registryProblems: đọc khoá sổ; PR thiếu khoá của nền (file còn nhưng bị gỡ khỏi sổ) → báo; không có sổ → báo", () => {
    expect(registryKeys(idx("0001_a", "0002_b"))).toEqual(["0001_a", "0002_b"]);
    expect(registryKeys("// không có sổ")).toEqual([]);
    expect(registryProblems(idx("0001_a", "0002_b"), idx("0001_a", "0002_b", "0003_c"))).toEqual([]);
    expect(registryProblems(idx("0001_a", "0002_b"), idx("0001_a"))[0]).toMatch(/thiếu khoá 0002_b/);
    expect(registryProblems(idx("0001_a"), "")[0]).toMatch(/thiếu khoá 0001_a/);
    expect(registryProblems("", idx("0001_a"))[0]).toMatch(/không tìm thấy sổ/);
    expect(registryKeys(read("packages/db/src/migrations/index.ts")).length).toBeGreaterThan(50);
  });

  it("overlay: index.ts của PR bỏ khoá của nền (dù file migration còn) → exit 1, không chép", () => {
    const base = fixture({ "0001_a.ts": "A", "0002_b.ts": "B", "index.ts": idx("0001_a", "0002_b") });
    const head = fixture({ "0001_a.ts": "A", "0002_b.ts": "B", "index.ts": idx("0001_a") });
    expect(overlay(base, head)).toBe(1);
    expect(readFileSync(join(base, MIGRATIONS_REL, "index.ts"), "utf8")).toBe(idx("0001_a", "0002_b"));
  });

  it("overlay: chép file nền ratchet/sổ dữ liệu của PR đè nền; PR xoá file nền → exit 1; nền không có file → bỏ qua", () => {
    const put = (root, f, v) => {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), v);
    };
    expect(BASELINE_FILES).toEqual(
      expect.arrayContaining([
        "packages/testkit/src/schema-guards.baseline.json",
        "docs/privacy/data-map.yaml",
      ]),
    );
    for (const f of BASELINE_FILES) {
      expect(existsSync(join(ROOT, f)), `${f} phải tồn tại trong repo`).toBe(true);
    }
    const files = { "0001_a.ts": "A", "index.ts": idx("0001_a") };
    const base = fixture(files);
    const head = fixture({ ...files, "0002_b.ts": "B", "index.ts": idx("0001_a", "0002_b") });
    for (const f of BASELINE_FILES) {
      put(base, f, "nền-cũ");
      put(head, f, "nền-mới");
    }
    expect(overlay(base, head)).toBe(0);
    for (const f of BASELINE_FILES) expect(readFileSync(join(base, f), "utf8")).toBe("nền-mới");
    // PR xoá file nền mà nền có ⇒ lỗi (không im lặng chạy với nền cũ).
    const noBaseline = fixture({ ...files, "0002_b.ts": "B", "index.ts": idx("0001_a", "0002_b") });
    expect(overlay(base, noBaseline)).toBe(1);
    // Nền chưa có file (nhánh nền cũ hơn) ⇒ chép của PR nếu PR có, không lỗi.
    const oldBase = fixture(files);
    expect(overlay(oldBase, head)).toBe(0);
    expect(existsSync(join(oldBase, BASELINE_FILES[0]))).toBe(true);
  });

  it("overlay: thiếu thư mục migration ở một phía → exit 1", () => {
    const base = fixture({ "0001_a.ts": "A" });
    expect(overlay(base, tmp())).toBe(1);
    expect(overlay(undefined, base)).toBe(1);
  });

  it("CLI: dòng lệnh overlay chạy được và lệnh lạ → exit 2", () => {
    const base = fixture({ "0001_a.ts": "A", "index.ts": idx("0001_a") });
    const head = fixture({ "0001_a.ts": "A", "0002_b.ts": "B", "index.ts": idx("0001_a", "0002_b") });
    const run = (...a) =>
      spawnSync("node", [join(ROOT, "scripts/schema-compat.mjs"), ...a], { encoding: "utf8" });
    const ok = run("overlay", base, head);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/mới trong PR: 1/);
    expect(run("khong-co").status).toBe(2);
  });

  it("migration thật của repo: nền = chính nó → overlay sạch (không phải tự sửa)", () => {
    const copy = tmp();
    mkdirSync(join(copy, MIGRATIONS_REL), { recursive: true });
    cpSync(join(ROOT, MIGRATIONS_REL), join(copy, MIGRATIONS_REL), { recursive: true });
    expect(overlay(copy, ROOT)).toBe(0);
  });

  it("workflow: chỉ chạy trên PR, checkout nền theo base.sha, overlay trước, chạy project db và loại đúng schema-drift", () => {
    const wf = read(".github/workflows/api-ops.yml");
    const job = wf.slice(wf.indexOf("  schema-compat:"));
    expect(job).toContain("if: github.event_name == 'pull_request'");
    expect(job).toContain(`ref: ${["$", "{{ github.event.pull_request.base.sha }}"].join("")}`);
    expect(job.indexOf("schema-compat.mjs overlay .n-1 .")).toBeGreaterThan(0);
    expect(job.indexOf("overlay")).toBeLessThan(job.indexOf("pnpm install --frozen-lockfile"));
    expect(job).toContain(
      'pnpm vitest run --project db --exclude "**/schema-drift.db.test.ts" --exclude "**/migration-*.db.test.ts"',
    );
    expect(job).toContain("postgres:17.11");
  });

  it("workflow: cài binary PG 17 (DB-SEC-003) trước khi chạy project db — connection-tls.db.test.ts của nhánh nền cần initdb", () => {
    const wf = read(".github/workflows/api-ops.yml");
    const job = wf.slice(wf.indexOf("  schema-compat:"));
    const setup = job.indexOf("bash scripts/dev-env-setup.sh --only postgres");
    expect(setup).toBeGreaterThan(0);
    expect(setup).toBeLessThan(job.indexOf("pnpm vitest run --project db"));
    // Chạy từ checkout của PR (gốc), không từ .n-1: script dev-env-setup của PR là bản được kiểm.
    expect(job.slice(job.lastIndexOf("- name:", setup), setup)).not.toContain("working-directory");
  });
});

// ───────────────────────── workflow + công cụ ghim ─────────────────────────
describe("api-ops.yml và scripts/ops-tools.sh", () => {
  const wf = read(".github/workflows/api-ops.yml");
  const tools = read("scripts/ops-tools.sh");

  it("đủ 4 job, không continue-on-error, quyền tối thiểu, mọi job có timeout", () => {
    for (const j of ["openapi", "prometheus-rules", "otel-collector", "schema-compat"]) {
      expect(wf, `thiếu job ${j}`).toMatch(new RegExp(`^ {2}${j}:\\n {4}name: ${j}\\n`, "m"));
    }
    expect(wf).not.toContain("continue-on-error");
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
    expect((wf.match(/timeout-minutes:/g) ?? []).length).toBe(4);
  });

  it("chạy trên MỌI PR vào main (không lọc paths cấp workflow) và mọi checkout không giữ token", () => {
    const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    expect(on).toMatch(/pull_request:\n {4}branches: \[main\]/);
    expect(on).not.toMatch(/\bpaths(-ignore)?:/);
    const checkouts = wf
      .split("\n")
      .flatMap((l, i, a) => (/uses: actions\/checkout@/.test(l) ? [a.slice(i, i + 6).join("\n")] : []));
    expect(checkouts).toHaveLength(5);
    for (const c of checkouts)
      expect(c.split("\n").slice(1, 4).join("\n"), c).toContain("persist-credentials: false");
  });

  it("ops-tools.sh ghim phiên bản + SHA-256 64 hex cho từng công cụ, và kiểm SHA trước khi giải nén", () => {
    for (const v of ["PROMETHEUS", "OTELCOL"]) {
      expect(tools).toMatch(new RegExp(`^${v}_VERSION="\\d+\\.\\d+\\.\\d+"$`, "m"));
      expect(tools).toMatch(new RegExp(`^${v}_SHA256="[0-9a-f]{64}"$`, "m"));
    }
    expect(tools).toContain("sha256sum -c");
    expect(tools).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });

  it("ops-tools.sh: lệnh sai → exit 2; công cụ lạ → exit 2 (không tải gì)", () => {
    const run = (...a) =>
      spawnSync("bash", [join(ROOT, "scripts/ops-tools.sh"), ...a], {
        encoding: "utf8",
        env: { ...process.env, HM_TOOLS_DIR: tmp() },
      });
    expect(run().status).toBe(2);
    expect(run("install").status).toBe(2);
    expect(run("install", "khong-co").status).toBe(2);
    expect(run("path").stdout.trim()).toMatch(/\/bin$/);
  });

  describe("cache binary kiểm SHA đã lưu; thư mục tạm được dọn cả khi lỗi", () => {
    const field = (name, what) => tools.match(new RegExp(`^${name}_${what}="([^"]+)"`, "m"))[1];
    const pin = (name) => `${field(name, "VERSION")}-${field(name, "SHA256")}`;
    const fakeBin = `#!/bin/sh\necho "promtool, version ${field("PROMETHEUS", "VERSION")}"\n`;
    const sha = createHash("sha256").update(fakeBin).digest("hex");
    /** Cài giả một promtool vào thư mục công cụ; `stamp` = nội dung file dấu (undefined → không tạo). */
    const setup = (stamp) => {
      const dir = tmp();
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "bin", "promtool"), fakeBin);
      chmodSync(join(dir, "bin", "promtool"), 0o755);
      if (stamp) writeFileSync(join(dir, "bin", "promtool.sha256"), `${stamp}\n`);
      return dir;
    };
    // Proxy chết ⇒ mọi lần tải đều lỗi nhanh, không chạm mạng thật.
    const install = (toolsDir, tmpDir) =>
      spawnSync("bash", [join(ROOT, "scripts/ops-tools.sh"), "install", "promtool"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HM_TOOLS_DIR: toolsDir,
          TMPDIR: tmpDir,
          HTTPS_PROXY: "http://127.0.0.1:9",
          https_proxy: "http://127.0.0.1:9",
          NO_PROXY: "",
          no_proxy: "",
        },
        timeout: 60_000,
      });

    it("dấu SHA khớp (binary + ghim) → dùng cache, không tải, không để rác", () => {
      const t = tmp();
      expect(install(setup(`${sha}-${pin("PROMETHEUS")}`), t).status).toBe(0);
      expect(readdirSync(t)).toEqual([]);
    });

    it("binary bị thay nhưng vẫn in đúng version (dấu không khớp) → không tin cache, đi tải (lỗi mạng ⇒ exit ≠ 0) và dọn thư mục tạm", () => {
      const t = tmp();
      expect(install(setup(`${"0".repeat(64)}-${pin("PROMETHEUS")}`), t).status).not.toBe(0);
      expect(readdirSync(t), "thư mục tạm còn sót sau exit ≠ 0").toEqual([]);
    });

    it("không có file dấu, hoặc ghim (version/SHA) đã đổi → không tin cache", () => {
      expect(install(setup(), tmp()).status).not.toBe(0);
      expect(
        install(setup(`${sha}-${pin("PROMETHEUS").replace(/.$/, (c) => (c === "0" ? "1" : "0"))}`), tmp())
          .status,
      ).not.toBe(0);
    });
  });
});
