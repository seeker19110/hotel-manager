// T-802: khoá cấu hình chuỗi cung ứng bằng test cấu trúc — dependabot ↔ manifest thật, workflow SBOM/quét lỗ hổng/EOL/new-deps/
// commit-lint/quét log CI, hook commit-msg, tài liệu chính sách (BASE-DEP-003/006/007/008/009, OPS-MAINT-001/003/004,
// SEC-SECRET-007, CMP-LIC-003/004, BASE-REPO-005). Phần chạy thật nằm ở job CI tương ứng (xem Bằng chứng trong BLUEPRINT.md).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deployFiles, findUnpinned } from "./check-image-pins.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const yml = (rel) => parse(read(rel));
const steps = (wf, job) => wf.jobs[job].steps;
const runs = (wf, job) =>
  steps(wf, job)
    .map((s) => s.run ?? "")
    .join("\n");

/** Mọi file dưới `dir` thoả `pred(tên)`, trả đường dẫn tương đối ROOT (bỏ node_modules/.git/.next/.pnpm-store). */
function find(dir, pred, out = []) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    if (["node_modules", ".git", ".next", ".claude", ".xtemplates"].includes(name)) continue;
    const rel = dir === "." ? name : `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) find(rel, pred, out);
    else if (pred(name)) out.push(rel);
  }
  return out;
}

const dirOf = (rel) => (rel.includes("/") ? `/${rel.slice(0, rel.lastIndexOf("/"))}` : "/");

// ---------------------------------------------------------------- dependabot
describe("dependabot.yml ↔ manifest thật (BASE-DEP-007, OPS-MAINT-001)", () => {
  const cfg = yml(".github/dependabot.yml");
  const byEco = (eco) => cfg.updates.filter((u) => u["package-ecosystem"] === eco);
  const dirsOf = (eco) => byEco(eco).flatMap((u) => u.directories ?? [u.directory]);

  it("version 2 và mỗi hệ sinh thái chỉ khai một lần", () => {
    expect(cfg.version).toBe(2);
    const ecos = cfg.updates.map((u) => u["package-ecosystem"]);
    expect(new Set(ecos).size).toBe(ecos.length);
  });

  it("đủ hệ sinh thái cho manifest có trong repo", () => {
    const need = new Set();
    if (existsSync(join(ROOT, "package.json"))) need.add("npm");
    if (find(".github/workflows", (n) => /\.ya?ml$/.test(n)).length > 0) need.add("github-actions");
    if (find("deploy", (n) => /^Dockerfile|\.Dockerfile$/.test(n)).length > 0) need.add("docker");
    if (find("deploy", (n) => /^(docker-)?compose.*\.ya?ml$/.test(n)).length > 0) need.add("docker-compose");
    expect(need.size).toBeGreaterThanOrEqual(4);
    for (const eco of need) expect(byEco(eco), `thiếu ${eco}`).toHaveLength(1);
  });

  it("không khai hệ sinh thái không có manifest (pip, gomod…)", () => {
    const known = new Set(["npm", "github-actions", "docker", "docker-compose"]);
    for (const u of cfg.updates) expect(known.has(u["package-ecosystem"]), u["package-ecosystem"]).toBe(true);
    expect(
      find(".", (n) => ["requirements.txt", "requirements-dev.txt", "pyproject.toml", "go.mod"].includes(n)),
    ).toEqual([]);
  });

  it("thư mục khai báo phủ mọi Dockerfile và compose", () => {
    for (const f of find("deploy", (n) => /^Dockerfile|\.Dockerfile$/.test(n)))
      expect(dirsOf("docker")).toContain(dirOf(f));
    for (const f of find("deploy", (n) => /^(docker-)?compose.*\.ya?ml$/.test(n)))
      expect(dirsOf("docker-compose")).toContain(dirOf(f));
    expect(dirsOf("npm")).toContain("/");
    expect(dirsOf("github-actions")).toContain("/");
    for (const d of cfg.updates.flatMap((u) => u.directories ?? [u.directory]).filter((d) => d !== "/"))
      expect(existsSync(join(ROOT, d)), d).toBe(true);
  });

  it("mỗi mục: lịch tuần, nhóm, trần PR mở, cooldown ≥ 14 ngày, prefix commit Conventional", () => {
    for (const u of cfg.updates) {
      const eco = u["package-ecosystem"];
      expect(u.schedule.interval, eco).toBe("weekly");
      expect(Object.keys(u.groups ?? {}).length, `${eco} groups`).toBeGreaterThan(0);
      expect(u["open-pull-requests-limit"], eco).toBeGreaterThan(0);
      expect(u["open-pull-requests-limit"], eco).toBeLessThanOrEqual(5);
      expect(u.cooldown["default-days"], eco).toBeGreaterThanOrEqual(14);
      expect(u["commit-message"].prefix, eco).toMatch(/^(chore|ci|build)\(deps/);
    }
  });

  it("npm: nhóm gom minor+patch, không gom major", () => {
    const g = Object.values(byEco("npm")[0].groups)[0];
    expect(g["update-types"]).toEqual(["minor", "patch"]);
  });
});

// ---------------------------------------------------------------- new-deps + commit-lint + hook
describe("pr-deps.yml (BASE-DEP-006)", () => {
  const wf = yml(".github/workflows/pr-deps.yml");
  it("chạy trên pull_request kể cả khi sửa mô tả (edited), job new-deps", () => {
    expect(wf.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "edited", "synchronize"]));
    expect(wf.jobs["new-deps"]).toBeDefined();
  });
  it("so lockfile nhánh gốc với PR; mô tả PR đi qua biến môi trường (không nội suy vào lệnh)", () => {
    const text = runs(wf, "new-deps");
    expect(text).toMatch(/git show FETCH_HEAD:pnpm-lock\.yaml/);
    expect(text).toMatch(/node scripts\/new-deps-check\.mjs --base-lock/);
    expect(text).not.toMatch(/\$\{\{/);
    const bodyStep = steps(wf, "new-deps").find((s) => (s.run ?? "").includes("new-deps-check"));
    expect(bodyStep.env.PR_BODY).toBe("${{ github.event.pull_request.body }}");
  });
  it("mẫu PR có mục '## Phụ thuộc mới' với định dạng 4 trường", () => {
    const t = read(".github/pull_request_template.md");
    expect(t).toMatch(/^## Phụ thuộc mới$/m);
    expect(t).toMatch(/tên · giấy phép · lý do · phương án thay thế đã xét/);
  });
});

describe("commit-lint (BASE-REPO-005)", () => {
  const wf = yml(".github/workflows/commit-lint.yml");
  it("CI kiểm mọi commit của PR: fetch-depth 0 và --range base..head", () => {
    expect(steps(wf, "commit-lint")[0].with["fetch-depth"]).toBe(0);
    expect(runs(wf, "commit-lint")).toMatch(/commit-lint\.mjs --range "\$BASE_SHA\.\.\$HEAD_SHA"/);
  });
  it("hook local commit-msg tồn tại, có quyền thực thi, gọi cùng script; commit-gated.sh cũng kiểm", () => {
    const hook = join(ROOT, ".githooks/commit-msg");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(read(".githooks/commit-msg")).toMatch(/scripts\/commit-lint\.mjs" --file/);
    expect(read("scripts/commit-gated.sh")).toMatch(/commit-lint\.mjs" --message/);
  });
});

// ---------------------------------------------------------------- EOL
describe("eol-check.yml (BASE-DEP-003, OPS-MAINT-003)", () => {
  const wf = yml(".github/workflows/eol-check.yml");
  it("chạy theo lịch tuần + chạy tay, gọi scripts/eol-check.mjs", () => {
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ [0-6]$/);
    expect(wf.on.workflow_dispatch).toBeDefined();
    expect(runs(wf, "eol-check")).toMatch(/node scripts\/eol-check\.mjs/);
  });
});

// ---------------------------------------------------------------- SBOM + quét lỗ hổng
describe("supply-chain.yml (BASE-DEP-009, OPS-MAINT-004, CMP-LIC-003/004)", () => {
  const wf = yml(".github/workflows/supply-chain.yml");
  const matrix = wf.jobs["image-scan"].strategy.matrix.include;

  it("chạy mỗi PR, push main, hằng tuần và chạy tay; quyền chỉ đọc", () => {
    expect(wf.on.pull_request).toBeDefined();
    expect(wf.on.push.branches).toContain("main");
    expect(wf.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ [0-6]$/);
    expect(wf.on.workflow_dispatch).toBeDefined();
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("mọi bước quét: fail-build true, ngưỡng high, only-fixed (SLA ở VULN-SLA.md); không continue-on-error", () => {
    const scans = [...steps(wf, "sbom"), ...steps(wf, "image-scan")].filter((s) =>
      s.uses?.startsWith("anchore/scan-action@"),
    );
    expect(scans).toHaveLength(2);
    for (const s of scans) {
      expect(s.with["fail-build"]).toBe("true");
      expect(s.with["severity-cutoff"]).toBe("high");
      expect(s.with["only-fixed"]).toBe("true");
      expect(s["continue-on-error"]).toBeUndefined();
    }
    expect(read(".github/workflows/supply-chain.yml")).not.toMatch(/continue-on-error/);
  });

  it("SBOM npm: sinh → kiểm giấy phép → quét SBOM → lưu artifact (luôn lưu)", () => {
    const s = steps(wf, "sbom");
    const idx = (re) => s.findIndex((x) => re.test(x.run ?? x.uses ?? ""));
    expect(idx(/scripts\/sbom\.mjs/)).toBeGreaterThan(-1);
    expect(idx(/scripts\/sbom-check\.mjs/)).toBeGreaterThan(idx(/scripts\/sbom\.mjs/));
    expect(idx(/anchore\/scan-action/)).toBeGreaterThan(idx(/sbom-check/));
    // Giấy phép của MỌI thành phần npm (cả gián tiếp/workspace) đối chiếu allow của chính sách — licenses:check chỉ quét gốc.
    expect(s[idx(/scripts\/sbom-check\.mjs/)].run).toMatch(
      /sbom-check\.mjs .*--policy license-policy\.json .*sbom\/npm\.cdx\.json/,
    );
    const up = s.find((x) => x.uses?.startsWith("actions/upload-artifact@"));
    expect(up.if).toBe("always()");
    expect(up.with["retention-days"]).toBeGreaterThanOrEqual(30);
    expect(s.find((x) => x.uses?.startsWith("anchore/scan-action@")).with.sbom).toBe("sbom/npm.cdx.json");
  });

  it("SBOM image: syft cyclonedx-json → sbom-check → quét image → lưu artifact; tra giấy phép module Go", () => {
    const s = steps(wf, "image-scan");
    const sbomStep = s.find((x) => x.uses?.startsWith("anchore/sbom-action@"));
    expect(sbomStep.with.format).toBe("cyclonedx-json");
    expect(sbomStep.env.SYFT_GOLANG_SEARCH_REMOTE_LICENSES).toBe("true");
    const order = s.map((x) => x.uses?.split("@")[0] ?? x.run?.split(" ").slice(0, 2).join(" "));
    expect(order.indexOf("anchore/sbom-action")).toBeLessThan(order.indexOf("node scripts/sbom-check.mjs"));
    expect(order.indexOf("node scripts/sbom-check.mjs")).toBeLessThan(order.indexOf("anchore/scan-action"));
    expect(s.find((x) => x.uses?.startsWith("actions/upload-artifact@")).if).toBe("always()");
  });

  it("matrix image khớp deploy/: mọi image ngoài đều được quét, không quét image không dùng", () => {
    const deployRefs = new Set();
    let builtDirs = 0;
    for (const f of deployFiles(join(ROOT, "deploy"))) {
      const stages = new Set();
      for (const raw of readFileSync(f, "utf8").split("\n")) {
        const line = raw.replace(/\s+#.*$/, "").trim();
        const st = /^FROM\s+.+\s+AS\s+(\S+)\s*$/i.exec(line);
        const m =
          /^(?:-\s*)?image:\s*["']?([^"'\s]+)["']?$/.exec(line) ??
          /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
        if (m && !stages.has(m[1].toLowerCase())) deployRefs.add(m[1]);
        if (st) stages.add(st[1].toLowerCase());
      }
    }
    const pulled = matrix.filter((m) => !m.build);
    for (const m of matrix.filter((x) => x.build)) {
      builtDirs++;
      expect(existsSync(join(ROOT, m.build, "Dockerfile")), m.build).toBe(true);
    }
    expect(builtDirs).toBeGreaterThan(0);
    // Dockerfile build tại chỗ: base của nó được quét thông qua chính image đã build.
    const builtBases = new Set(
      matrix
        .filter((x) => x.build)
        .flatMap((m) => readFileSync(join(ROOT, m.build, "Dockerfile"), "utf8").split("\n"))
        .map((l) => /^FROM\s+(\S+)/i.exec(l)?.[1])
        .filter(Boolean),
    );
    for (const ref of deployRefs)
      expect(pulled.some((m) => m.ref === ref) || builtBases.has(ref), `image ${ref} chưa được quét`).toBe(
        true,
      );
    for (const m of pulled)
      expect(deployRefs.has(m.ref), `matrix ${m.name} không có trong deploy/`).toBe(true);
    // Image trong matrix ghim digest (tag trôi → quét không tái lập được).
    for (const m of pulled) expect(findUnpinned(`image: ${m.ref}`), m.name).toEqual([]);
    expect(new Set(matrix.map((m) => m.name)).size).toBe(matrix.length);
  });
});

// ---------------------------------------------------------------- quét log CI + lịch sử
describe("quét bí mật (SEC-SECRET-007)", () => {
  const ci = yml(".github/workflows/ci.yml");
  // Bước chạy cổng nằm ở job `gate` (job `quality` chỉ gom kết quả các job cổng — WF-CI-001).
  const q = steps(ci, "gate");
  const at = (pred) => q.findIndex(pred);

  it("cổng ghi log ra file (pipefail), gitleaks quét log, chỉ lưu artifact khi quét sạch", () => {
    const gate = q[at((s) => (s.run ?? "").includes("dev-task.sh gate"))];
    expect(gate.shell).toBe("bash");
    expect(gate.run).toMatch(/dev-task\.sh gate 2>&1 \| tee "\$RUNNER_TEMP\/ci-logs\/gate\.log"/);
    const scan = q[at((s) => s.id === "log-scan")];
    expect(scan.run).toMatch(/^gitleaks dir "\$RUNNER_TEMP\/ci-logs"/);
    expect(scan.if).toBe("always()");
    const up =
      q[at((s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name === "ci-logs-gate")];
    expect(up.if).toContain("steps.log-scan.outcome == 'success'");
    expect(at((s) => s.id === "log-scan")).toBeGreaterThan(
      at((s) => (s.run ?? "").includes("dev-task.sh gate")),
    );
    expect(q.indexOf(up)).toBeGreaterThan(q.indexOf(scan));
  });

  it("trace Playwright: gitleaks quét (cả trong zip) trước khi lưu artifact; chỉ lưu khi quét sạch", () => {
    const e = steps(ci, "e2e");
    const iScan = e.findIndex((s) => s.id === "trace-scan");
    const iUp = e.findIndex((s) => s.with?.name === "playwright-traces");
    expect(iScan).toBeGreaterThan(-1);
    expect(e.some((s) => (s.run ?? "").includes("dev-env-setup.sh --only gitleaks"))).toBe(true);
    expect(e[iScan].run).toMatch(/^gitleaks dir apps\/web\/test-results .*--max-archive-depth \d/);
    expect(e[iScan].if).toBe("failure()");
    expect(e[iUp].if).toContain("steps.trace-scan.outcome == 'success'");
    expect(e[iUp].with.path).toBe("apps/web/test-results/");
    expect(iUp).toBeGreaterThan(iScan);
  });

  it("gitleaks cài từ binary ghim phiên bản + SHA-256 (khớp checksums của release)", () => {
    expect(q.some((s) => (s.run ?? "").includes("dev-env-setup.sh --only gitleaks"))).toBe(true);
    const sh = read("scripts/dev-env-setup.sh");
    expect(sh).toMatch(/GITLEAKS_VERSION="\d+\.\d+\.\d+"/);
    expect(sh).toMatch(/GITLEAKS_SHA256="[0-9a-f]{64}"/);
    expect(sh).toMatch(/echo "\$\{GITLEAKS_SHA256\}\s+\$tmp\/gitleaks\.tgz" \| sha256sum -c/);
  });

  it("secret-scan.yml quét toàn lịch sử (fetch-depth 0) và chạy cả theo lịch tuần", () => {
    const wf = yml(".github/workflows/secret-scan.yml");
    expect(wf.jobs.gitleaks.steps[0].with["fetch-depth"]).toBe(0);
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.workflow_dispatch).toBeDefined();
  });
});

// ---------------------------------------------------------------- tài liệu chính sách
describe("tài liệu chính sách", () => {
  const sla = read("docs/ops/VULN-SLA.md");
  it("VULN-SLA.md: SLA theo mức critical/high/medium và bảng review tháng có số quá SLA = 0 ở dòng mới nhất", () => {
    for (const lv of ["Critical", "High", "Medium"]) expect(sla).toMatch(new RegExp(`^\\| ${lv} \\|`, "m"));
    const rows = sla.split("\n").filter((l) => /^\| \d{4}-\d{2} \|/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    const cells = rows
      .at(-1)
      .split("|")
      .map((c) => c.trim());
    expect(cells[6]).toBe("0"); // cột "Quá SLA"
    expect(sla).toMatch(/supply-chain\.yml/);
  });
  it("DEPENDENCY-POLICY.md nêu nhịp Dependabot, ghim, phụ thuộc mới, EOL, SBOM và trỏ tới công cụ thật", () => {
    const p = read("docs/ops/DEPENDENCY-POLICY.md");
    for (const kw of [
      "Dependabot",
      "cooldown",
      "major",
      "## Ghim",
      "## Thêm phụ thuộc mới",
      "## Hết hạn hỗ trợ",
      "## SBOM và giấy phép",
    ])
      expect(p, kw).toContain(kw);
    for (const f of [
      "scripts/eol-check.mjs",
      "scripts/new-deps-check.mjs",
      "scripts/check-image-pins.mjs",
      "license-policy.json",
      ".github/dependabot.yml",
    ])
      expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
});

// ---------------------------------------------------------------- .grype.yaml: ngoại lệ có hạn (VULN-SLA.md)
describe(".grype.yaml: bỏ qua lỗ hổng chỉ khi có hạn, có theo dõi, đúng gói/phiên bản", () => {
  const cfg = yml(".grype.yaml");
  const rules = cfg.ignore;
  const sla = read("docs/ops/VULN-SLA.md");
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 30); // VULN-SLA: ngoại lệ ≤ 30 ngày
  const dueOf = (r) => /hạn rà lại: (\d{4}-\d{2}-\d{2})/.exec(r.reason ?? "")?.[1];

  it("mỗi luật: đúng một mã, gói + phiên bản + loại cụ thể, không bỏ qua cả gói", () => {
    expect(Array.isArray(rules) && rules.length > 0).toBe(true);
    for (const r of rules) {
      expect(r.vulnerability, JSON.stringify(r)).toMatch(
        /^(GO-\d{4}-\d+|CVE-\d{4}-\d+|GHSA(-[a-z0-9]{4}){3})$/,
      );
      for (const f of ["name", "version", "type"])
        expect(r.package?.[f], `${r.vulnerability}.${f}`).toBeTruthy();
      expect(Object.keys(r).sort(), r.vulnerability).toEqual(["package", "reason", "vulnerability"]);
    }
    const keys = rules.map(
      (r) => `${r.vulnerability}|${r.package.name}|${r.package.version}|${r.package.location ?? ""}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("mỗi luật có 'hạn rà lại' hợp lệ, chưa quá hạn, ≤ 30 ngày kể từ hôm nay", () => {
    for (const r of rules) {
      const due = dueOf(r);
      expect(due, `${r.vulnerability} thiếu "hạn rà lại: YYYY-MM-DD"`).toBeTruthy();
      expect(new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10), r.vulnerability).toBe(due);
      expect(due >= today, `${r.vulnerability} đã quá hạn ${due} — nâng image hoặc quyết định lại`).toBe(
        true,
      );
      expect(due <= horizon.toISOString().slice(0, 10), `${r.vulnerability} hạn ${due} quá 30 ngày`).toBe(
        true,
      );
    }
  });
  it("mọi mã được bỏ qua đều nằm ở bảng Theo dõi của VULN-SLA.md", () => {
    const tracked = sla.slice(sla.indexOf("## Theo dõi"));
    for (const r of rules) {
      const id = r.vulnerability;
      // Bảng viết gọn "GO-2026-6603, 6605, …": chấp nhận mã đầy đủ hoặc số cuối của mã GO-.
      const short = /^GO-\d{4}-(\d+)$/.exec(id)?.[1];
      const found =
        tracked.includes(id) || (short !== undefined && new RegExp(`\\b${short}\\b`).test(tracked));
      expect(found, `${id} chưa có trong bảng Theo dõi`).toBe(true);
    }
  });
  it("workflow không nới: cutoff high, only-fixed, fail-build; không có grype-config/continue-on-error", () => {
    const wf = read(".github/workflows/supply-chain.yml");
    expect(wf).not.toMatch(/continue-on-error/);
    expect(wf).not.toMatch(/^\s*config:/m);
    const scans = Object.values(parse(wf).jobs)
      .flatMap((j) => j.steps)
      .filter((s) => String(s.uses ?? "").startsWith("anchore/scan-action@"));
    expect(scans).toHaveLength(2);
    for (const s of scans) {
      expect(s.with["severity-cutoff"]).toBe("high");
      expect(s.with["only-fixed"]).toBe("true");
      expect(s.with["fail-build"]).toBe("true");
    }
  });
  it("luật npm (location /usr/local/lib/node_modules/npm) có điều kiện: runtime web/worker xoá npm trước USER node", () => {
    expect(rules.some((r) => r.package.location?.startsWith("/usr/local/lib/node_modules/npm"))).toBe(true);
    for (const f of ["deploy/web.Dockerfile", "deploy/worker.Dockerfile"]) {
      const runtime = read(f).split(/^FROM .* AS runtime$/m)[1];
      expect(runtime, f).toBeTruthy();
      const rm = runtime.indexOf("rm -rf /usr/local/lib/node_modules/npm");
      expect(rm, `${f}: runtime phải xoá npm`).toBeGreaterThanOrEqual(0);
      expect(runtime, f).toContain("/usr/local/bin/npm");
      expect(rm, `${f}: xoá npm phải trước USER node`).toBeLessThan(runtime.indexOf("USER node"));
    }
  });
});
