// Khoá cấu hình quét bảo mật + CSDL qua TLS (BASE-SEC-007, SEC-WEB-001, SEC-WEB-004, DB-SEC-003): phần chạy thật nằm ở CI
// (.github/workflows/security-scan.yml: job `sast`, `dast` → scripts/dast.sh), file này giữ để không ai nới cấu hình âm thầm.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");

/** Khối một job (từ `  <tên>:` tới job kế/hết file) của workflow. */
function job(text, name) {
  const body = text.split(/^jobs:\n/m)[1] ?? "";
  const m = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\n)*)`, "m").exec(body);
  return m ? m[1] : null;
}

describe("security-scan.yml", () => {
  const wf = read(".github/workflows/security-scan.yml");

  it("chạy trên PR, push main, lịch và chạy tay", () => {
    expect(wf).toMatch(/^on:\n {2}pull_request:/m);
    expect(wf).toMatch(/push:\n {4}branches: \[main\]/);
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/workflow_dispatch:/);
  });

  it("chạy trên MỌI PR vào main: không lọc paths/branches ở cấp workflow (job đỏ phải chặn được merge)", () => {
    const on = wf.split(/^permissions:/m)[0];
    expect(on).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    expect(on).toMatch(/^ {2}pull_request:\s*$/m);
    expect(on).not.toMatch(/pull_request:\n {4}(?:branches|paths)/);
  });

  it("mọi actions/checkout của mọi workflow đặt persist-credentials: false", () => {
    const dir = `${ROOT}.github/workflows/`;
    let total = 0;
    for (const n of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(`${dir}${n}`, "utf8");
      const parts = text.split(/^ {6}- uses: actions\/checkout@/m).slice(1);
      for (const part of parts) {
        total += 1;
        const step = part.split(/^ {6}- /m)[0];
        expect(step, `${n}: checkout thiếu persist-credentials: false`).toMatch(/persist-credentials: false/);
      }
    }
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it("quyền tối thiểu cấp workflow, không continue-on-error, không `|| true` nuốt lỗi quét", () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(wf).not.toMatch(/continue-on-error/);
    expect(wf).not.toMatch(/(?:semgrep|zap)[^\n]*\|\|\s*true/);
  });

  it("job sast: Semgrep bản ghim, tự kiểm luật (--test) rồi quét với --error trên luật của repo (không registry)", () => {
    const sast = job(wf, "sast");
    expect(sast).not.toBeNull();
    expect(sast).toMatch(/semgrep --test security\/semgrep/);
    expect(sast).toMatch(/semgrep scan --config security\/semgrep\/hm-injection\.yml [^\n]*--error/);
    expect(sast).not.toMatch(/--config (auto|p\/|r\/|https?:)/);
    expect(sast).toMatch(/--metrics=off/);
    expect(sast).toMatch(/timeout-minutes: \d+/);
  });

  it("requirements của Semgrep: semgrep ghim bản cụ thể (==), MỌI gói có hash, job cài với --require-hashes", () => {
    const text = read("security/semgrep/requirements.txt");
    // gộp dòng nối `\` thành từng mục gói
    const entries = text
      .replace(/^\s*#.*$/gm, "")
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(entries.some((l) => /^semgrep==\d+\.\d+\.\d+\s/.test(l))).toBe(true);
    expect(entries.length).toBeGreaterThan(10);
    for (const l of entries) {
      expect(l).toMatch(/^[A-Za-z0-9._-]+==[\w.!+-]+\s+(--hash=sha256:[0-9a-f]{64} ?)+/);
    }
    expect(job(wf, "sast")).toMatch(
      /pip" install [^\n]*--require-hashes -r security\/semgrep\/requirements\.txt/,
    );
  });

  // Các bước DAST nằm ở scripts/dast.sh (một nhà, cũng là khoá `attack` của xt.yaml cho release-check); job chỉ gọi script.
  const dastSh = read("scripts/dast.sh");
  // phần mã, bỏ dòng chú thích (đầu file mô tả các bước) — để so thứ tự bước
  const dastCode = dastSh
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const lib = read("scripts/lib-e2e-app.sh");

  it("job dast: gọi scripts/dast.sh (kết quả vào zap-out/ để lưu artifact), Postgres service ghim digest, có timeout", () => {
    const dast = job(wf, "dast");
    expect(dast).not.toBeNull();
    expect(dast).toMatch(/image: postgres:17\.\d+@sha256:[0-9a-f]{64}/);
    expect(dast).toMatch(/env:\n\s+DAST_OUT: zap-out\n\s+run: bash scripts\/dast\.sh\n/);
    expect(dast).toMatch(/path: zap-out\/\n/);
    expect(dast).toMatch(/timeout-minutes: (?:[1-9]|[1-5]\d)\n/);
    // job không tự đặt ZAP_IMAGE (bản ghim một nhà ở script)
    expect(dast).not.toMatch(/ZAP_IMAGE:/);
  });

  it("dast.sh: app production chạy thật + ZAP baseline + quét chủ động, image ghim digest, cổng zap-gate, dừng app khi thoát", () => {
    expect(dastSh).toMatch(/^set -euo pipefail$/m);
    expect(lib).toMatch(/setsid node e2e\/server\.ts/);
    expect(lib).toMatch(/api\/health/);
    expect(dastSh).toMatch(/hm_build "\$\{DAST_SKIP_BUILD:-\}"/);
    expect(lib).toMatch(/pnpm --filter web build/);
    expect(dastSh).toMatch(/zap-baseline\.py -t "\$HM_BASE_URL" -m 2 -I -J baseline\.json/);
    expect(dastSh).toMatch(/zap-full-scan\.py -t "\$HM_BASE_URL" -m 2 -T 12 -I -J active\.json/);
    expect(dastSh).toMatch(
      /node "\$HM_ROOT\/scripts\/zap-gate\.mjs" "\$OUT\/baseline\.json" "\$OUT\/active\.json"\n/,
    );
    expect(dastSh).toMatch(
      /^ZAP_IMAGE="\$\{ZAP_IMAGE:-ghcr\.io\/zaproxy\/zaproxy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\}"$/m,
    );
    // dừng app kể cả khi đỏ để xoá DB tạm
    expect(dastSh).toMatch(/^trap hm_stop_app EXIT$/m);
    expect(lib).toMatch(/kill -TERM "\$pid"/);
  });

  it("dast.sh không nới cổng: -I chỉ để zap không tự quyết, quyết định ở zap-gate (không bỏ bước gate, không nuốt lỗi)", () => {
    const gate = dastCode.indexOf("zap-gate.mjs");
    expect(dastCode.indexOf("zap-full-scan.py")).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(dastCode.indexOf("zap-full-scan.py"));
    expect(dastSh).not.toMatch(/zap-gate[^\n]*(\|\||;)/);
    expect(dastSh).not.toMatch(/(?:zap|docker)[^\n]*\|\|\s*true/);
    expect(dastSh).not.toMatch(/continue-on-error|set \+e/);
  });
});

describe("luật SAST ↔ fixture", () => {
  const rules = read("security/semgrep/hm-injection.yml");
  const ids = [...rules.matchAll(/^ {2}- id: (hm-[a-z0-9-]+)$/gm)].map((m) => m[1]);
  const fixtures = readdirSync(`${ROOT}security/semgrep`)
    .filter((n) => /^hm-injection\.tsx?$/.test(n))
    .map((n) => read(`security/semgrep/${n}`))
    .join("\n");

  it("có luật cho SQL, lệnh hệ thống, đường dẫn, XSS", () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        "hm-sql-raw-dynamic",
        "hm-sql-raw-template-interpolation",
        "hm-pg-query-concat",
        "hm-child-process-shell",
        "hm-path-traversal-dynamic",
        "hm-xss-html-sink",
      ]),
    );
  });

  it.each(ids)("luật %s có mẫu xấu (ruleid) trong fixture", (id) => {
    expect(fixtures).toMatch(new RegExp(`// ruleid: ${id}\\b`));
  });

  it("luật có mẫu tốt (ok) cho các luật nhạy cảm với dương tính giả", () => {
    for (const id of [
      "hm-sql-raw-dynamic",
      "hm-pg-query-concat",
      "hm-child-process-shell",
      "hm-path-traversal-dynamic",
      "hm-xss-html-sink",
    ])
      expect(fixtures).toMatch(new RegExp(`// ok: ${id}\\b`));
  });

  it("allowlist (paths.exclude) chỉ gồm migration, test, e2e, testkit, scripts — không nới thêm", () => {
    const excl = [...rules.matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]);
    const allowed = new Set([
      "**/packages/db/src/migrations/",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test.mjs",
      "**/*.spec.ts",
      "**/e2e/",
      "**/packages/testkit/",
      "**/scripts/",
    ]);
    expect(excl.filter((p) => !allowed.has(p))).toEqual([]);
  });

  it("không có nosemgrep nào ngoài điểm đã rà soát (kèm lý do)", () => {
    const hits = [];
    const walk = (dir) => {
      for (const n of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
        if (["node_modules", ".next", ".git"].includes(n.name)) continue;
        const rel = `${dir}${n.name}`;
        if (n.isDirectory()) walk(`${rel}/`);
        else if (/\.(ts|tsx|mjs)$/.test(n.name) && !/security-scan\.test\.mjs$/.test(n.name)) {
          for (const line of read(rel).split("\n"))
            if (line.includes("nosemgrep"))
              hits.push(`${rel}: ${/nosemgrep: [\w-]+ -- .{20,}/.test(line) ? "ok" : "thiếu lý do"}`);
        }
      }
    };
    walk("apps/");
    walk("packages/");
    expect(hits).toEqual(["packages/app/src/logging/logger.ts: ok"]);
  });
});

describe("DB-SEC-003 — pg_hba.conf và compose", () => {
  it("job quality cài binary PG 17 để test TLS CSDL chạy thật (không bị bỏ qua)", () => {
    expect(read(".github/workflows/ci.yml")).toMatch(/scripts\/dev-env-setup\.sh --only postgres/);
  });

  const entries = read("deploy/postgres/pg_hba.conf")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/));

  it("chỉ hostssl (scram-sha-256) và local peer cho role postgres; không host/hostnossl/trust/password/md5", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [type, , user, ...rest] of entries) {
      const method = rest[rest.length - 1];
      if (type === "hostssl") expect(method).toBe("scram-sha-256");
      else if (type === "local") {
        expect(method).toBe("peer");
        expect(user).toBe("postgres");
      } else expect.unreachable(`loại dòng không được phép: ${type}`);
    }
    expect(entries.some(([t]) => t === "hostssl")).toBe(true);
    expect(read("deploy/postgres/pg_hba.conf").replace(/^\s*#.*$/gm, "")).not.toMatch(
      /\b(trust|password|md5|ident|host|hostnossl)\b\s/,
    );
  });

  it("không dòng hostssl nào mở cho mọi địa chỉ (0.0.0.0/0, ::/0, all)", () => {
    for (const [type, , , addr] of entries)
      if (type === "hostssl") expect(["0.0.0.0/0", "::/0", "all"]).not.toContain(addr);
  });

  it("compose: postgres nạp hba_file, bật ssl, TLS ≥ 1.2, mật khẩu SCRAM; không publish cổng", () => {
    const compose = read("deploy/compose.yaml");
    const pg = /^ {2}postgres:\n((?: {4}.*\n|\n)*)/m.exec(compose.split(/^services:\n/m)[1] ?? "")?.[1] ?? "";
    expect(pg).toMatch(/hba_file=\/etc\/postgresql\/pg_hba\.conf/);
    expect(pg).toMatch(/- ssl=on/);
    expect(pg).toMatch(/ssl_min_protocol_version=TLSv1\.[23]/);
    expect(pg).toMatch(/password_encryption=scram-sha-256/);
    expect(pg).toMatch(/\.\/postgres\/pg_hba\.conf:\/etc\/postgresql\/pg_hba\.conf:ro/);
    expect(pg).not.toMatch(/^ {4}ports:/m);
  });

  it("compose: web và worker mount CA để verify-full", () => {
    const compose = read("deploy/compose.yaml");
    expect((compose.match(/pg-ca\.crt:\/run\/secrets\/pg-ca\.crt:ro/g) ?? []).length).toBe(2);
  });
});

describe("DB-SEC-003 — runbook chạy được với pg_hba `local … peer`", () => {
  /** Dòng `docker compose … exec postgres …` thiếu `-u postgres`: root trong container bị "Peer authentication failed". */
  const execWithoutUser = (text) =>
    text.split("\n").filter((line) => {
      if (!/\bcompose\b/.test(line) || !/\bexec\b/.test(line)) return false;
      const afterExec = line.split(/\bexec\b/)[1] ?? "";
      // Có token dịch vụ `postgres` (ngoài giá trị của -u/--user) mà không đặt người dùng postgres.
      const hasService = /(?:^|\s)postgres(?:\s|$)/.test(afterExec.replace(/(?:-u|--user)[ =]postgres/g, ""));
      return hasService && !/(?:-u|--user)[ =]postgres\b/.test(afterExec);
    });

  it("bộ kiểm tự đỏ khi thiếu -u postgres và xanh khi đủ", () => {
    expect(
      execWithoutUser("docker compose -f deploy/compose.yaml exec postgres psql -U postgres"),
    ).toHaveLength(1);
    expect(execWithoutUser("docker compose exec -T postgres pgbackrest info")).toHaveLength(1);
    expect(execWithoutUser("docker compose exec -u postgres postgres pgbackrest info")).toEqual([]);
    expect(execWithoutUser("docker compose exec --user=postgres postgres psql")).toEqual([]);
    expect(execWithoutUser("docker compose exec caddy sh")).toEqual([]);
  });

  it("mọi `compose exec postgres` trong docs/ops và deploy/README.md có -u postgres", () => {
    const files = [];
    const walk = (dir) => {
      for (const n of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
        if (n.isDirectory()) walk(`${dir}${n.name}/`);
        else if (n.name.endsWith(".md")) files.push(`${dir}${n.name}`);
      }
    };
    walk("docs/ops/");
    files.push("deploy/README.md");
    expect(files.length).toBeGreaterThan(3);
    const bad = files.flatMap((f) => execWithoutUser(read(f)).map((l) => `${f}: ${l.trim()}`));
    expect(bad).toEqual([]);
  });
});
