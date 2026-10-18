// T-308: rào máy cho tài liệu an ninh + vận hành — rule cảnh báo (severity/owner/runbook_url, metric có thật), runbook có
// đủ mục, threat model (trạng thái, bằng chứng trỏ file + tên test thật, OWASP Top 10:2025), SLO, ASVS
// (BASE-SEC-011, SEC-TM-001/003/005/006, STD-SEC-001/003, OPS-IR-001/004/006/010, CMP-INTL-006, CMP-VN-006, SEC-SECRET-011,
// OPS-DR-008, WF-DOC-008, BASE-DOC-004, OPS-SLO-001/004/005). Không phụ thuộc thư viện YAML: parser tối thiểu bên dưới.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ---------- YAML tối thiểu (map lồng nhau, list of map, scalar có/không nháy; không anchor, không block scalar) ----------
function scalar(v) {
  const t = v.trim();
  if (t.startsWith('"')) return JSON.parse(t);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replaceAll("''", "'");
  return t;
}

function parseYaml(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (raw.includes("\t")) throw new Error(`tab trong YAML: ${raw}`);
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() });
  }
  function block(i, indent) {
    if (lines[i].text.startsWith("- ")) {
      const arr = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
        lines[i] = { indent: indent + 2, text: lines[i].text.slice(2).trim() };
        const [v, next] = block(i, indent + 2);
        arr.push(v);
        i = next;
      }
      return [arr, i];
    }
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(lines[i].text);
      if (!m) throw new Error(`dòng YAML không hiểu được: ${lines[i].text}`);
      const [, key, val] = m;
      if (val === undefined || val === "") {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.indent > indent) {
          const [v, next] = block(i + 1, nextLine.indent);
          obj[key] = v;
          i = next;
        } else {
          obj[key] = "";
          i += 1;
        }
      } else {
        obj[key] = scalar(val);
        i += 1;
      }
    }
    return [obj, i];
  }
  if (lines.length === 0) return {};
  const [root] = block(0, lines[0].indent);
  return root;
}

describe("parseYaml (tối thiểu)", () => {
  it("map lồng, list of map, nháy kép/đơn, giá trị có dấu hai chấm trong nháy", () => {
    const y = parseYaml(
      [
        "# chú thích",
        "groups:",
        "  - name: g1",
        "    rules:",
        "      - alert: A",
        "        expr: 'x{status=\"failed\"} > 0'",
        "        labels:",
        "          severity: page",
        "        annotations:",
        '          summary: "có: dấu hai chấm"',
        "      - alert: B",
        "        expr: y > 1",
      ].join("\n"),
    );
    expect(y.groups[0].name).toBe("g1");
    const [a, b] = y.groups[0].rules;
    expect(a.expr).toBe('x{status="failed"} > 0');
    expect(a.labels.severity).toBe("page");
    expect(a.annotations.summary).toBe("có: dấu hai chấm");
    expect(b).toEqual({ alert: "B", expr: "y > 1" });
  });
  it("rỗng → {}; tab → lỗi; dòng sai → lỗi", () => {
    expect(parseYaml("")).toEqual({});
    expect(() => parseYaml("a:\n\tb: 1")).toThrow(/tab/);
    expect(() => parseYaml("không phải yaml")).toThrow();
  });
});

// ---------- metric trong biểu thức PromQL ----------
const PROMQL_WORDS = new Set([
  "and",
  "or",
  "unless",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  "inf",
  "nan",
  "sum",
  "min",
  "max",
  "avg",
  "count",
  "group",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "quantile",
  "count_values",
]);

function metricsInExpr(expr) {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\[[^\]]*\]/g, "");
  const out = new Set();
  for (const m of stripped.matchAll(/(?<![\w:])[A-Za-z_:][A-Za-z0-9_:]*(?![\w:])(?!\s*\()/g)) {
    if (!PROMQL_WORDS.has(m[0])) out.add(m[0]);
  }
  return [...out];
}

// Metric có thật = khóa trong HELP của metrics.ts; histogram `x` còn có `x_bucket`/`x_sum`/`x_count` (dùng trong PromQL).
function knownMetrics() {
  const src = read("packages/app/src/observability/metrics.ts");
  const help = /const HELP[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  const out = [];
  for (const m of help.matchAll(/^\s{2}([a-zA-Z_:][a-zA-Z0-9_:]*):\s*\[\s*"(gauge|counter|histogram)"/gm)) {
    out.push(m[1]);
    if (m[2] === "histogram") out.push(`${m[1]}_bucket`, `${m[1]}_sum`, `${m[1]}_count`);
  }
  return out;
}

describe("metricsInExpr", () => {
  it.each([
    ["absent(hm_up)", ["hm_up"]],
    ['delta(hm_export_jobs{status="failed"}[1h]) > 0', ["hm_export_jobs"]],
    ["hm_a > 2 * (avg_over_time(hm_a[1d] offset 1d) + 10)", ["hm_a"]],
    ["a > 1 or absent(b)", ["a", "b"]],
    ["sum by (worker) (rate(x_total[5m])) / on (worker) y", ["x_total", "y"]],
    ["", []],
  ])("%s", (expr, expected) => {
    expect(metricsInExpr(expr).sort()).toEqual(expected.sort());
  });
  it("knownMetrics đọc được HELP của metrics.ts", () => {
    const k = knownMetrics();
    expect(k).toContain("hm_up");
    expect(k).toContain("notification_dead_total");
    expect(k).toContain("hm_worker_heartbeat_age_seconds");
    expect(k.length).toBeGreaterThanOrEqual(11);
  });
  it("knownMetrics gồm metric HTTP (counter + histogram và hậu tố _bucket/_sum/_count)", () => {
    const k = knownMetrics();
    for (const m of [
      "hm_http_requests_total",
      "hm_http_request_duration_seconds",
      "hm_http_request_duration_seconds_bucket",
      "hm_http_request_duration_seconds_sum",
      "hm_http_request_duration_seconds_count",
      "hm_reconciliation_breaks_open",
    ])
      expect(k, m).toContain(m);
  });
});

// ---------- alerts.yml ----------
function runbookTarget(url) {
  const noAnchor = url.split("#")[0];
  const m = /\/blob\/[^/]+\/(.+)$/.exec(noAnchor);
  return m ? m[1] : noAnchor;
}

describe("deploy/prometheus/alerts.yml", () => {
  const doc = parseYaml(read("deploy/prometheus/alerts.yml"));
  const rules = (doc.groups ?? []).flatMap((g) => g.rules ?? []);
  const known = new Set(knownMetrics());

  it("có rule, tên duy nhất", () => {
    expect(rules.length).toBeGreaterThanOrEqual(7);
    const names = rules.map((r) => r.alert);
    expect(new Set(names).size).toBe(names.length);
  });
  it.each(rules.map((r) => [r.alert, r]))(
    "%s: severity, owner, runbook_url, summary, expr, metric có thật",
    (_n, r) => {
      expect(["page", "ticket"]).toContain(r.labels?.severity);
      expect(r.labels?.owner, "thiếu owner").toMatch(/^[a-z0-9-]+$/);
      expect(r.annotations?.summary, "thiếu summary").toBeTruthy();
      expect(r.annotations?.description, "thiếu description").toBeTruthy();
      const url = r.annotations?.runbook_url;
      expect(url, "thiếu runbook_url").toBeTruthy();
      const file = resolve(ROOT, runbookTarget(url));
      expect(file.startsWith(ROOT) && existsSync(file), `runbook_url không trỏ file có thật: ${url}`).toBe(
        true,
      );
      expect(r.expr, "thiếu expr").toBeTruthy();
      const used = metricsInExpr(r.expr);
      expect(used.length).toBeGreaterThan(0);
      const unknown = used.filter((m) => !known.has(m));
      expect(unknown, `metric không có ở metrics.ts: ${unknown.join(", ")}`).toEqual([]);
    },
  );
  it("metric thực chất là gauge (notification_dead_total = số hàng dead) không dùng increase()/rate(): retry làm giảm ⇒ báo giả", () => {
    for (const r of rules)
      expect(r.expr, `${r.alert}: gauge không dùng increase/rate`).not.toMatch(
        /\b(increase|rate|irate)\(\s*(notification_dead_total|hm_jobs_failed|hm_holds_active|hm_outbox_\w+)/,
      );
    const dead = rules.find((r) => r.alert === "HmNotificationDead");
    expect(dead?.expr).toMatch(/^delta\(notification_dead_total\[1h\]\) > 0$/);
  });
  it("cảnh báo page không dùng ngưỡng tài nguyên máy (OPS-SLO-004: không page kiểu cpu > 80%)", () => {
    for (const r of rules.filter((x) => x.labels.severity === "page"))
      expect(r.expr).not.toMatch(/cpu|memory|node_/i);
  });
  it("runbook_url trong thư mục runbook có thật cũng được chấp nhận; URL tuyệt đối được quy về đường dẫn repo", () => {
    expect(runbookTarget("https://github.com/o/r/blob/main/docs/RUNBOOK.md#muc")).toBe("docs/RUNBOOK.md");
    expect(runbookTarget("docs/ops/runbooks/restore.md#a")).toBe("docs/ops/runbooks/restore.md");
  });
});

// ---------- frontmatter + mục bắt buộc của runbook ----------
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  return parseYaml(m[1]);
}
const hasHeading = (text, h) =>
  new RegExp(`^#{2,3} (?:\\d+(?:\\.\\d+)*\\.? )?${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(text);

const COMMON_RUNBOOK_SECTIONS = ["Khi nào dùng", "Các bước", "Xác minh", "Liên hệ và leo thang"];
const RUNBOOKS = {
  "docs/ops/runbooks/data-breach.md": ["Bảng thời hạn thông báo", "Mẫu thông báo", "Điều kiện trước"],
  "docs/ops/runbooks/secret-leak.md": ["Từng loại bí mật"],
  "docs/ops/runbooks/restore.md": ["Điều kiện trước", "Hoàn tác / đường lùi"],
  "docs/ops/runbooks/deploy-rollback.md": ["Điều kiện trước", "Backup trước migrate", "Rollback", "Hoàn tác"],
  "docs/ops/runbooks/db-password-rotation.md": ["Điều kiện trước", "Hoàn tác / đường lùi"],
};

describe("runbook có đủ mục bắt buộc", () => {
  it.each(Object.entries(RUNBOOKS))("%s", (file, extra) => {
    const text = read(file);
    const fm = frontmatter(text);
    expect(fm, "thiếu frontmatter").not.toBeNull();
    expect(fm.title).toBeTruthy();
    expect(fm.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fm.last_drilled, "thiếu last_drilled (WF-DOC-008)").toBeTruthy();
    for (const h of [...COMMON_RUNBOOK_SECTIONS, ...extra.filter((e) => e !== "Hoàn tác")])
      expect(hasHeading(text, h), `thiếu mục "${h}"`).toBe(true);
  });

  it("vi phạm dữ liệu: không bịa — mọi dữ kiện pháp lý đánh dấu chưa xác minh, không có số điều tự đặt", () => {
    const text = read("docs/ops/runbooks/data-breach.md");
    expect(text).toMatch(/\(chưa xác minh — cần pháp lý\)/);
    expect(text).toMatch(/72 giờ/);
    expect(text).toMatch(/chủ thể/);
    expect(text).toMatch(/Bộ Công an/);
    // số điều chỉ được nhắc khi kèm đánh dấu chưa xác minh trong cùng dòng
    for (const line of text.split("\n").filter((l) => /\bĐiều \d+|\bĐ\.\d+/.test(l)))
      expect(line, `số điều thiếu đánh dấu chưa xác minh: ${line}`).toMatch(
        /chưa xác minh|lệch giữa các bản chép/,
      );
  });

  it("lộ bí mật: có dòng cho từng biến bí mật trong SECRET_KEYS và .env.example", () => {
    const text = read("docs/ops/runbooks/secret-leak.md");
    const schema = read("packages/app/src/config/schema.ts");
    const keys = [
      ...(/SECRET_KEYS = \[([\s\S]*?)\] as const/.exec(schema)?.[1] ?? "").matchAll(/"([A-Z0-9_]+)"/g),
    ].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(9);
    for (const k of keys) expect(text, `secret-leak.md thiếu ${k}`).toContain(k);
    for (const k of ["HM_PII_KEY_ID", "CLAMD_HOST"]) expect(text).toContain(k);
    const envKeys = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const secretish = envKeys.filter(
      (k) => /SECRET|PASS|KEY|TOKEN|URL/.test(k) && !/^(APP_BASE_URL|S3_ENDPOINT)$/.test(k),
    );
    for (const k of secretish) expect(text, `secret-leak.md thiếu ${k}`).toContain(k);
  });

  it("khôi phục: lệnh pgBackRest thật như scripts/db-backup-restore-check.sh và bucket file", () => {
    const text = read("docs/ops/runbooks/restore.md");
    const script = read("scripts/db-backup-restore-check.sh");
    expect(script).toContain("--delta --type=name");
    for (const frag of [
      "run --rm --no-deps -u postgres postgres",
      "--type=name --target=truoc_migrate_",
      "--type=time",
      "--target-action=promote",
      "pgbackrest --stanza=hm info",
      "bash scripts/db-backup-restore-check.sh",
      "pg_create_restore_point",
      "hm-files",
      "bootstrap-roles.sql",
    ])
      expect(text, `restore.md thiếu: ${frag}`).toContain(frag);
    expect(script).toContain('STANZA="hm"');
  });

  it("khôi phục: mặc định vào volume mới; --delta chỉ ở phương án cuối; không lấy truoc_khoi_phuc làm đích", () => {
    const text = read("docs/ops/runbooks/restore.md");
    const overlay = read("deploy/compose.restore.yaml");
    expect(overlay).toMatch(/pgdata:\s*\n\s+external: true/);
    expect(text).toContain("-f deploy/compose.restore.yaml");
    const finalOption = text.indexOf("Phương án cuối");
    expect(finalOption).toBeGreaterThan(0);
    // --delta chỉ xuất hiện (trong lệnh) sau mục phương án cuối, kèm cảnh báo không đảo ngược
    const firstDelta = text.indexOf("--delta ");
    expect(firstDelta).toBeGreaterThan(finalOption);
    expect(text.slice(finalOption, finalOption + 200)).toMatch(/KHÔNG đảo ngược/);
    // không `exec` vào container postgres đã dừng để restore
    expect(text).not.toMatch(/exec postgres pgbackrest[^\n]*restore/);
    // đích khôi phục không phải điểm tạo sau sự cố
    expect(text).not.toMatch(/--target=truoc_khoi_phuc/);
  });

  it("deploy/rollback: backup trước migrate, lệnh theo compose, migration down", () => {
    const text = read("docs/ops/runbooks/deploy-rollback.md");
    for (const frag of [
      "deploy/compose.yaml",
      "pgbackrest --stanza=hm --type=incr backup",
      "pg_create_restore_point",
      "migrateToLatest",
      "migrateDown",
      "res.error",
      "process.exit(code)",
      "/api/ready",
    ])
      expect(text, `deploy-rollback.md thiếu: ${frag}`).toContain(frag);
    expect(read("deploy/compose.yaml")).toContain("archive-push");
  });
});

describe("docs/ops/INCIDENT-RESPONSE.md", () => {
  const text = read("docs/ops/INCIDENT-RESPONSE.md");
  it("SEV1–4: mỗi mức có tiêu chí, ≥ 2 ví dụ của dự án, thời gian phản hồi, người tuyên bố", () => {
    for (const sev of ["SEV1", "SEV2", "SEV3", "SEV4"]) {
      const row = text.split("\n").find((l) => l.startsWith(`| ${sev} |`));
      expect(row, `thiếu hàng ${sev}`).toBeTruthy();
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      expect(cells).toHaveLength(5);
      expect(cells[1].length).toBeGreaterThan(10);
      expect(
        cells[2].split(";").filter((x) => x.trim()).length,
        `${sev} cần ≥ 2 ví dụ`,
      ).toBeGreaterThanOrEqual(2);
      expect(cells[3].length).toBeGreaterThan(3);
      expect(cells[4].length).toBeGreaterThan(3);
    }
  });
  it("thứ tự cố định: phát hiện → phân mức → khoanh vùng/giảm thiệt hại → liên lạc → khắc phục → hậu kiểm", () => {
    const order = [
      "Phát hiện",
      "Phân mức",
      "Khoanh vùng và giảm thiệt hại",
      "Liên lạc",
      "Khắc phục",
      "Đóng và hậu kiểm",
    ];
    const idx = order.map((h) => text.search(new RegExp(`^### 3\\.\\d ${h}`, "m")));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it("có: trước khi chạy lệnh lên dữ liệu, thao tác cần người duyệt, nhánh sự cố bảo mật, mẫu timeline, ai làm gì", () => {
    for (const h of [
      "Ai làm gì",
      "Trước khi chạy lệnh lên dữ liệu",
      "Thao tác không đảo ngược — phải có người duyệt trước",
      "Sự cố bảo mật = SEV1",
      "Mẫu dòng thời gian",
    ])
      expect(hasHeading(text, h), `thiếu mục "${h}"`).toBe(true);
    expect(text).toMatch(/Hai người xác nhận/);
    expect(text).toMatch(/Bảo toàn chứng cứ/);
  });
  it("trỏ tới các runbook và RUNBOOK.md tổng trỏ ngược tới tài liệu mới", () => {
    for (const f of ["data-breach", "secret-leak", "restore", "deploy-rollback"])
      expect(text).toContain(`runbooks/${f}.md`);
    const rb = read("docs/RUNBOOK.md");
    for (const f of [
      "ops/INCIDENT-RESPONSE.md",
      "ops/runbooks/data-breach.md",
      "ops/runbooks/secret-leak.md",
      "ops/runbooks/restore.md",
      "ops/runbooks/deploy-rollback.md",
      "ops/SLO.md",
      "prometheus/alerts.yml",
    ])
      expect(rb, `RUNBOOK.md thiếu liên kết ${f}`).toContain(f);
  });
});

describe("docs/ops/SLO.md", () => {
  const text = read("docs/ops/SLO.md");
  it("SLI/SLO từ PROJECT §5: khả dụng 99,9%, p95 800 ms, giữ phòng 1,5 s, RPO/RTO", () => {
    expect(text).toContain("99,9%");
    expect(text).toMatch(/800 ms/);
    expect(text).toMatch(/1,5 s/);
    expect(text).toMatch(/RPO CSDL ≤ 15 phút/);
    expect(read("PROJECT.md")).toMatch(/SLO 99,9%/);
  });
  it("có ngân sách lỗi, chính sách khi cạn, truy vấn PromQL", () => {
    expect(hasHeading(text, "Ngân sách lỗi")).toBe(true);
    expect(hasHeading(text, "Chính sách khi cạn ngân sách")).toBe(true);
    expect(text).toMatch(/43 phút/);
    expect(text).toMatch(/```promql/);
  });
  it("metric HTTP có thật: SLO.md nêu đúng tên metric/bucket và không còn nói 'chưa có'; metrics.ts khai HELP cho chúng", () => {
    expect(text).not.toMatch(/Chưa có metric HTTP/);
    for (const m of ["hm_http_requests_total", "hm_http_request_duration_seconds", 'le="0.8"'])
      expect(text, `SLO.md thiếu ${m}`).toContain(m);
    const known = knownMetrics();
    expect(known).toContain("hm_http_requests_total");
    expect(known).toContain("hm_http_request_duration_seconds");
  });
  it("mọi metric mà mã phát ra (name: \"hm_…\" trong metrics.ts và http-metrics.ts) đều khai HELP (không metric 'mồ côi')", () => {
    const known = new Set(knownMetrics());
    const emitted = new Set();
    for (const f of [
      "packages/app/src/observability/metrics.ts",
      "packages/app/src/observability/http-metrics.ts",
    ])
      for (const m of read(f).matchAll(/name:\s*"((?:hm_|notification_)[a-z0-9_]+)"/g)) emitted.add(m[1]);
    expect(emitted.size).toBeGreaterThanOrEqual(5);
    expect([...emitted].filter((n) => !known.has(n)).sort()).toEqual([]);
    // metric nghiệp vụ do hàm SQL trả về cũng phải có HELP: 0046 (metrics_snapshot) + 0050 (reconciliation_metrics)
    for (const f of [
      "packages/db/src/migrations/0046_observability.ts",
      "packages/db/src/migrations/0050_reconciliation_daily.ts",
    ])
      for (const m of read(f).matchAll(/'((?:hm_|notification_)[a-z0-9_]+)'::text/g))
        expect(known.has(m[1]), `${f}: metric ${m[1]} thiếu HELP`).toBe(true);
  });
  it("histogram độ trễ có bucket 0,8 (SLO-LAT) và 1,5 (SLO-HOLD)", () => {
    const src = read("packages/app/src/observability/http-metrics.ts");
    const buckets =
      /HTTP_DURATION_BUCKETS = \[([^\]]+)\]/
        .exec(src)?.[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map(Number) ?? [];
    expect(buckets).toContain(0.8);
    expect(buckets).toContain(1.5);
    expect([...buckets].sort((a, b) => a - b)).toEqual(buckets);
  });
  it("mọi rule nêu trong bảng burn rate của SLO.md có thật ở alerts.yml, và ngược lại cho nhóm hotel-manager.slo", () => {
    const doc = parseYaml(read("deploy/prometheus/alerts.yml"));
    const slo = (doc.groups ?? []).find((g) => g.name === "hotel-manager.slo");
    expect(slo, "thiếu nhóm hotel-manager.slo").toBeTruthy();
    for (const r of slo.rules) expect(text, `SLO.md không nhắc ${r.alert}`).toContain(r.alert);
  });
});

describe("cảnh báo sức khoẻ CSDL (T-503)", () => {
  it("nhóm CSDL (DB-PERF-004/008): kết nối > 80%, tuổi XID ticket < page < 2^31 trừ ngưỡng từ chối, hàng chết — trên metric có thật", () => {
    const rules = (parseYaml(read("deploy/prometheus/alerts.yml")).groups ?? []).flatMap(
      (g) => g.rules ?? [],
    );
    const byName = Object.fromEntries(rules.map((r) => [r.alert, r]));
    const conn = byName.HmDbConnectionsHigh;
    expect(conn.expr).toMatch(/hm_db_connections\s*\/\s*hm_db_max_connections\s*>\s*0\.8\b/);
    expect(conn.labels.severity).toBe("ticket");
    const limit = (r) => Number(/>\s*(\d+)/.exec(r.expr)?.[1]);
    const high = byName.HmDbXidAgeHigh;
    const crit = byName.HmDbXidAgeCritical;
    for (const r of [high, crit]) {
      expect(r.expr).toContain("hm_db_xid_age");
      expect(r.expr).toContain("hm_db_multixact_age");
    }
    expect(high.labels.severity).toBe("ticket");
    expect(crit.labels.severity).toBe("page");
    // PostgreSQL từ chối ghi khi còn 3 triệu giao dịch tới 2^31; cảnh báo ở 40 triệu còn lại (PostgreSQL 18 §24.1.5).
    expect(limit(high)).toBeLessThan(limit(crit));
    expect(limit(crit)).toBeLessThan(2 ** 31 - 40_000_000);
    expect(limit(high)).toBeGreaterThan(200_000_000); // trên autovacuum_freeze_max_age mặc định
    const dead = byName.HmDbDeadTuplesHigh;
    expect(dead.expr).toContain("hm_db_dead_tuples");
    expect(dead.expr).toContain("hm_db_dead_tuple_ratio");
    for (const r of [conn, high, crit, dead]) {
      const sec = r.annotations.runbook_section;
      expect(read("docs/RUNBOOK.md"), `RUNBOOK thiếu mục "${sec}"`).toContain(`### ${sec}`);
    }
  });
});

describe("burn rate nhiều cửa sổ (OPS-SLO-004)", () => {
  const doc = parseYaml(read("deploy/prometheus/alerts.yml"));
  const slo = (doc.groups ?? []).find((g) => g.name === "hotel-manager.slo")?.rules ?? [];
  const byName = Object.fromEntries(slo.map((r) => [r.alert, r]));
  const windows = (expr) => [...new Set([...expr.matchAll(/\[(\d+[smhd])\]/g)].map((m) => m[1]))];

  it("khả dụng 99,9% và độ trễ 800 ms: mỗi SLI đủ ba cặp cửa sổ 1h/5m (page), 6h/30m (ticket), 3d/6h (ticket)", () => {
    const want = {
      Fast: { severity: "page", w: ["1h", "5m"] },
      Medium: { severity: "ticket", w: ["6h", "30m"] },
      Slow: { severity: "ticket", w: ["3d", "6h"] },
    };
    for (const sli of ["Availability", "Latency"])
      for (const [speed, { severity, w }] of Object.entries(want)) {
        const r = byName[`Hm${sli}Burn${speed}`];
        expect(r, `thiếu Hm${sli}Burn${speed}`).toBeTruthy();
        expect(r.labels.severity).toBe(severity);
        expect(windows(r.expr).sort()).toEqual([...w].sort());
        // hai cửa sổ nối bằng `and` (cả dài lẫn ngắn phải vượt)
        expect(r.expr).toMatch(/\) and \(/);
        expect(r.expr).not.toMatch(/\bor\b/);
      }
  });
  it("ngưỡng = hệ số đốt × ngân sách lỗi: 14,4/6/1 × 0,001 (khả dụng) và × 0,05 (độ trễ)", () => {
    for (const [speed, f] of [
      ["Fast", "14.4"],
      ["Medium", "6"],
      ["Slow", "1"],
    ]) {
      expect(byName[`HmAvailabilityBurn${speed}`].expr).toContain(`> ${f} * 0.001`);
      expect(byName[`HmLatencyBurn${speed}`].expr).toContain(`> ${f} * 0.05`);
    }
  });
  it("SLI khả dụng: 5xx / tổng của luồng lõi; SLI độ trễ: bucket le=0.8 / count — không dùng trung bình; có sàn số request", () => {
    for (const speed of ["Fast", "Medium", "Slow"]) {
      const a = byName[`HmAvailabilityBurn${speed}`].expr;
      expect(a).toContain('status=~"5.."');
      expect(a).toContain("hm_http_requests_total");
      expect(a).toMatch(/increase\(hm_http_requests_total\{[^}]*\}\[\w+\]\)\) > 30/);
      const l = byName[`HmLatencyBurn${speed}`].expr;
      expect(l).toContain('le="0.8"');
      expect(l).toContain("hm_http_request_duration_seconds_bucket");
      expect(l).toContain("hm_http_request_duration_seconds_count");
      expect(l).not.toMatch(/_sum|avg/);
    }
  });
  it("có rule ticket đối soát (IND-FIN-006) trên metric hm_reconciliation_*", () => {
    const rules = (doc.groups ?? []).flatMap((g) => g.rules ?? []);
    const r = rules.find((x) => x.alert === "HmReconciliationBreaksOverSla");
    expect(r?.labels.severity).toBe("ticket");
    expect(r?.expr).toContain("hm_reconciliation_breaks_oldest_open_age_seconds");
  });
});

// ---------- THREAT-MODEL ----------
const THREAT = read("docs/design/THREAT-MODEL.md");
const TM_STATUS = ["mitigate", "accept", "transfer"];
const OWASP_2025 = {
  "A01:2025": "Broken Access Control",
  "A02:2025": "Security Misconfiguration",
  "A03:2025": "Software Supply Chain Failures",
  "A04:2025": "Cryptographic Failures",
  "A05:2025": "Injection",
  "A06:2025": "Insecure Design",
  "A07:2025": "Authentication Failures",
  "A08:2025": "Software or Data Integrity Failures",
  "A09:2025": "Security Logging and Alerting Failures",
  "A10:2025": "Mishandling of Exceptional Conditions",
};

const tableRows = (text, prefix) =>
  text
    .split("\n")
    .filter((l) => l.startsWith(`| ${prefix}`))
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );

/**
 * Tiêu đề (chuỗi literal) của `it(`/`test(`/`describe(` (kể cả `.each(...)(`, `.skip` không tính là bằng chứng nhưng vẫn lộ ra ở đây).
 * Tên bằng chứng phải nằm trong một tiêu đề thật — khớp chuỗi con trong thân file (comment, dữ liệu, chuỗi khác) không đủ.
 */
function testTitles(file) {
  const src = read(file);
  const re = /(?:\b(?:it|test|describe)(?:\.[A-Za-z]+)*|[)\]])\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return [...src.matchAll(re)].map((m) => m[2]);
}

/** Kiểm các tham chiếu `đường dẫn` «tên test» trong một ô bằng chứng; trả danh sách lỗi. */
function checkEvidence(cell) {
  const errors = [];
  let current = null;
  let paths = 0;
  for (const m of cell.matchAll(/`([^`]+)`|«([^»]+)»/g)) {
    if (m[1] !== undefined) {
      if (!/^(apps|packages|scripts|deploy|docs|\.github)\/|^\.gitleaksignore$/.test(m[1])) continue;
      paths += 1;
      if (!existsSync(join(ROOT, m[1]))) {
        errors.push(`file không có: ${m[1]}`);
        current = null;
      } else current = m[1];
    } else if (current === null) {
      errors.push(`tên test không gắn với file: «${m[2]}»`);
    } else if (!testTitles(current).some((title) => title.includes(m[2]))) {
      errors.push(`${current}: «${m[2]}» không nằm trong tiêu đề it(/test(/describe( nào`);
    }
  }
  if (paths === 0) errors.push("không trỏ tới file nào");
  return errors;
}

describe("checkEvidence", () => {
  it("file + tên test có thật → không lỗi", () => {
    expect(checkEvidence("`packages/app/src/config/schema.test.ts` «env trống → ConfigError»")).toEqual([]);
  });
  it("file không có / tên test không có / không có file → lỗi", () => {
    expect(checkEvidence("`packages/khong/co.test.ts`")).toHaveLength(1);
    expect(checkEvidence("`packages/app/src/config/schema.test.ts` «tên không tồn tại xyz»")).toHaveLength(1);
    expect(checkEvidence("IND-SAAS-002")).toEqual(["không trỏ tới file nào"]);
    expect(checkEvidence("«mồ côi»").length).toBeGreaterThan(0);
  });
  it("tên test phải là (một phần của) tiêu đề it(/describe(, không chỉ là chuỗi có trong file", () => {
    // `const TM_STATUS` và tên biến có trong thân file nhưng không phải tiêu đề test
    expect(checkEvidence("`scripts/ops-docs.test.mjs` «const TM_STATUS»")).toHaveLength(1);
    expect(checkEvidence("`scripts/ops-docs.test.mjs` «testTitles»")).toHaveLength(1);
    // tiêu đề thật: it(...), describe(...), it.each(...)(...)
    expect(checkEvidence("`scripts/ops-docs.test.mjs` «mọi image ghim digest»")).toHaveLength(1); // ở file khác
    expect(checkEvidence("`scripts/check-image-pins.test.mjs` «mọi image ghim digest sha256»")).toEqual([]);
    expect(checkEvidence("`scripts/check-image-pins.test.mjs` «deploy/»")).toEqual([]);
    expect(checkEvidence("`packages/app/src/privacy/data-map.db.test.ts` «%s → %s»")).toEqual([]);
  });
});

describe("docs/design/THREAT-MODEL.md", () => {
  it("frontmatter: updated 2026-10-16 trở đi, version ≥ 2", () => {
    const fm = frontmatter(THREAT);
    expect(fm).not.toBeNull();
    expect(fm.updated >= "2026-10-16").toBe(true);
    expect(Number(fm.version)).toBeGreaterThanOrEqual(2);
  });
  it("DFD Mermaid có clamd, worker/pg-boss, kho sao lưu khác máy, Prometheus/metrics, portal và cổng khách", () => {
    const mermaid = /```mermaid\n([\s\S]*?)```/.exec(THREAT)?.[1] ?? "";
    for (const frag of [
      "clamd",
      "worker",
      "pg-boss",
      "pgBackRest",
      "máy khác",
      "Prometheus",
      "/api/metrics",
      "Portal",
      "Cổng khách",
      "SMTP",
    ])
      expect(mermaid, `DFD thiếu ${frag}`).toContain(frag);
  });
  it("đủ A01:2025…A10:2025 với tên đúng (xác minh 2026-10-16) và bằng chứng có thật", () => {
    for (const [id, name] of Object.entries(OWASP_2025)) {
      const rows = tableRows(THREAT, `${id} |`);
      expect(rows, `thiếu ${id}`).toHaveLength(1);
      const cells = rows[0];
      expect(cells[1]).toBe(name);
      expect(cells[2].length, `${id} thiếu biện pháp`).toBeGreaterThan(20);
      expect(cells[3], `${id} thiếu TM`).toMatch(/TM-\d\d/);
      const errors = checkEvidence(cells[4]);
      expect(errors, `${id}: ${errors.join("; ")}`).toEqual([]);
    }
    expect(THREAT).toContain("top10.owasp.org/2025");
  });
  const section4 = THREAT.slice(THREAT.indexOf("## 4. Mối đe doạ"), THREAT.indexOf("## 4b."));
  const rows = tableRows(section4, "TM-");
  it("có TM-01…TM-16 cũ và TM mới; ID duy nhất", () => {
    const ids = rows.map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i <= 16; i++) expect(ids).toContain(`TM-${String(i).padStart(2, "0")}`);
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });
  it.each(rows.map((r) => [r[0], r]))(
    "%s: có quyết định mitigate/accept/transfer, mức, bằng chứng trỏ file + tên test có thật",
    (_id, r) => {
      expect(r, "thiếu cột").toHaveLength(9);
      expect(["Cao", "TB"]).toContain(r[4]);
      expect(TM_STATUS, `trạng thái "${r[5]}" không hợp lệ (không được để mở/trống)`).toContain(r[5]);
      expect(r[6].length, "thiếu biện pháp").toBeGreaterThan(20);
      expect(r[8].length, "cột Còn lại không được trống (ghi — nếu không còn gì)").toBeGreaterThan(0);
      const errors = checkEvidence(r[7]);
      expect(errors, errors.join("; ")).toEqual([]);
    },
  );
  it("mối đe doạ Cao có trạng thái và ít nhất một test (không chỉ cấu hình) làm bằng chứng", () => {
    for (const r of rows.filter((x) => x[4] === "Cao")) {
      const hasTest = /`[^`]*(\.test\.(ts|mjs)|\.spec\.ts)`|db-backup-restore-check\.sh/.test(r[7]);
      expect(hasTest, `${r[0]} thiếu bằng chứng dạng test`).toBe(true);
    }
  });
  it("không còn trạng thái 'mở' trống; trạng thái accept có điều kiện ghi rõ", () => {
    expect(THREAT).not.toMatch(/\|\s*mở( \(V1\))?\s*\|/);
    for (const r of rows.filter((x) => x[5] === "accept")) expect(r[6]).toMatch(/[Cc]hấp nhận|điều kiện/);
  });
  it("mọi TM nêu ở bảng OWASP có thật", () => {
    const ids = new Set(rows.map((r) => r[0]));
    for (const m of THREAT.matchAll(/(?<![\w-])TM-\d\d(?!\d)/g))
      expect(ids.has(m[0]), `${m[0]} không có trong bảng §4`).toBe(true);
  });
});

describe("ASVS (STD-SEC-001)", () => {
  it("PROJECT.md ghi 'ASVS 5.0.0 L2' và không còn 'ASVS 5.0 L2'", () => {
    const p = read("PROJECT.md");
    expect(p).toMatch(/ASVS 5\.0\.0 L[123]/);
    expect(p).not.toMatch(/ASVS 5\.0 L/);
  });
});
