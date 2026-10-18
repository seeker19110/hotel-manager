// T-807: rào cấu hình phát hành (WF-REL-001 SemVer tự sinh bằng release-please; WF-REL-003 tag bất biến, Release có artefact + checksum).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const release = parse(read(".github/workflows/release.yml"));
const ci = parse(read(".github/workflows/ci.yml"));
const waitRun = release.jobs.assets.steps.find((s) => String(s.name).startsWith("Đợi check quality")).run;
const WAIT_LOOPS = Number(/seq 1 (\d+)/.exec(waitRun)?.[1]);
const WAIT_SLEEP_S = Number(/sleep (\d+)/.exec(waitRun)?.[1]);
const WAIT_MARGIN_MIN = 15; // hàng đợi runner + quality chạy lại
const stepText = (job) => job.steps.map((s) => `${s.name ?? ""}\n${s.run ?? ""}`).join("\n----\n");

/**
 * Chủ đề commit đã sửa dòng `"version"` của package.json sau `bootstrap-sha` (mốc bắt đầu tự động hoá; trước đó người đặt 0.1.0).
 * Clone nông không có mốc thì xét mọi commit có sẵn.
 */
function versionEditSubjects() {
  const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const base = json("release-please-config.json")["bootstrap-sha"];
  const range = git("cat-file", "-e", `${base}^{commit}`).status === 0 ? [`${base}..HEAD`] : [];
  const r = git(
    "log",
    "--diff-filter=M",
    "--format=%s",
    "-G",
    '^\\s*"version":',
    ...range,
    "--",
    "package.json",
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\n").filter(Boolean);
}

/** Commit sửa phiên bản chỉ hợp lệ khi là Release PR của release-please (`chore(main): release 0.2.0`). */
const isReleasePr = (subject) => /^chore(\([\w./-]+\))?: release \d+\.\d+\.\d+/.test(subject);

describe("WF-REL-001 — phiên bản SemVer sinh tự động từ Conventional Commits", () => {
  const rp = release.jobs["release-please"];

  it("workflow release dùng release-please ghim SHA 40 ký tự, chạy trên push main", () => {
    expect(rp).toBeTruthy();
    const uses = rp.steps
      .map((s) => String(s.uses ?? ""))
      .find((u) => u.startsWith("googleapis/release-please-action@"));
    expect(uses).toMatch(/@[0-9a-f]{40}$/);
    expect(release.on.push.branches).toEqual(["main"]);
  });

  it("release-please đọc token riêng nếu có, rơi về github.token (không ép secret, không tạo secret mới)", () => {
    const step = rp.steps.find((s) => s.id === "rp");
    expect(step.with.token).toMatch(/^\$\{\{ secrets\.RELEASE_PLEASE_TOKEN \|\| github\.token \}\}$/);
    expect(release.on.pull_request).toBeUndefined(); // secret chỉ đọc ở sự kiện push/dispatch (WF-CI-023)
    expect(release.on.pull_request_target).toBeUndefined();
    const readme = read("README.md");
    const section = /^## Phát hành[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(readme)?.[1] ?? "";
    expect(section).toContain("RELEASE_PLEASE_TOKEN");
    expect(section).toMatch(/đóng rồi mở lại Release PR/);
    expect(read("docs/autopilot/BLUEPRINT-GAPS.md")).toContain("RELEASE_PLEASE_TOKEN");
  });

  it("quyền tối thiểu: mặc định rỗng; chỉ job release-please được ghi contents + pull-requests", () => {
    expect(release.permissions).toEqual({});
    expect(rp.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    for (const job of Object.values(release.jobs)) expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("cấu hình: kiểu node, bản manifest = version của package.json, tag dạng vX.Y.Z", () => {
    const cfg = json("release-please-config.json");
    const manifest = json(".release-please-manifest.json");
    const pkg = json("package.json");
    expect(cfg["release-type"]).toBe("node");
    expect(cfg["include-v-in-tag"]).toBe(true);
    expect(cfg["include-component-in-tag"]).toBe(false);
    expect(cfg["bootstrap-sha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest["."]).toBe(pkg.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(cfg.packages)).toEqual(["."]);
  });

  it("không có commit tay sửa version của package.json ngoài Release PR", () => {
    const bad = versionEditSubjects().filter((s) => !isReleasePr(s));
    expect(bad).toEqual([]);
  });

  it("nhận đúng: Release PR hợp lệ, commit tay 'bump version' thì không", () => {
    expect(isReleasePr("chore(main): release 0.2.0")).toBe(true);
    expect(isReleasePr("chore: release 1.0.0")).toBe(true);
    expect(isReleasePr("chore: bump version to 0.2.0")).toBe(false);
    expect(isReleasePr("feat: thêm xuất báo cáo")).toBe(false);
    expect(isReleasePr("")).toBe(false);
  });
});

describe("WF-REL-003 — tag bất biến, Release kèm artefact + checksum", () => {
  const tags = json(".github/rulesets/tags.json");

  it("ruleset tag v* cấm xoá và cập nhật (và đẩy không-fast-forward), không bypass", () => {
    expect(tags.target).toBe("tag");
    expect(tags.enforcement).toBe("active");
    expect(tags.bypass_actors).toEqual([]);
    expect(tags.conditions.ref_name.include).toEqual(["refs/tags/v*"]);
    const types = tags.rules.map((r) => r.type);
    for (const t of ["deletion", "update", "non_fast_forward"]) expect(types).toContain(t);
    expect(types).not.toContain("creation");
  });

  it("release-please tạo Release NHÁP; tag chỉ công khai sau khi quality xanh", () => {
    expect(json("release-please-config.json").draft).toBe(true);
    const assets = release.jobs.assets;
    expect(assets.needs).toBe("release-please");
    expect(String(assets.if)).toContain("release_created == 'true'");
    const text = stepText(assets);
    const at = (s) => text.indexOf(s);
    expect(at("check_name=quality")).toBeGreaterThan(-1);
    expect(at("gh release upload")).toBeGreaterThan(at("check_name=quality"));
    expect(at("--draft=false")).toBeGreaterThan(at("gh release upload"));
  });

  it("artefact là tarball của đúng commit phát hành + SHA256SUMS được kiểm lại", () => {
    const text = stepText(release.jobs.assets);
    expect(text).toMatch(/git archive .*"\$RELEASE_SHA"/);
    expect(text).toContain("sha256sum");
    expect(text).toContain("SHA256SUMS");
    expect(text).toContain("sha256sum -c SHA256SUMS");
    expect(release.jobs.assets.env.RELEASE_SHA).toContain("needs.release-please.outputs.sha");
  });

  describe("cửa sổ đợi quality đủ dài cho job con chậm nhất", () => {
    it("loops × sleep > timeout lớn nhất của job con + timeout của quality + biên; timeout job assets > cửa sổ", () => {
      const needs = [ci.jobs.quality.needs].flat();
      expect(needs).toContain("onboarding-smoke");
      const slowestChild = Math.max(...needs.map((n) => ci.jobs[n]["timeout-minutes"]));
      const windowMin = (WAIT_LOOPS * WAIT_SLEEP_S) / 60;
      expect(windowMin).toBeGreaterThanOrEqual(
        slowestChild + ci.jobs.quality["timeout-minutes"] + WAIT_MARGIN_MIN,
      );
      expect(release.jobs.assets["timeout-minutes"]).toBeGreaterThan(windowMin);
    });
  });

  describe("bước đợi quality chạy thật với gh giả", () => {
    const fakeGh = (states) => {
      const d = mkdtempSync(join(tmpdir(), "rel-"));
      dirs.push(d);
      writeFileSync(join(d, "states"), `${states.join("\n")}\n`);
      writeFileSync(join(d, "n"), "0");
      // gh giả: trả lần lượt từng trạng thái trong `states` (dòng cuối lặp lại mãi); sleep giả: không đợi.
      writeFileSync(
        join(d, "gh"),
        `#!/bin/sh\nn=$(cat "${d}/n"); n=$((n+1)); echo $n > "${d}/n"\nl=$(wc -l < "${d}/states")\n[ "$n" -gt "$l" ] && n=$l\nawk -v n="$n" 'NR==n' "${d}/states"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(d, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return d;
    };
    const exec = (states) => {
      const d = fakeGh(states);
      const r = spawnSync("bash", ["-c", waitRun], {
        env: { ...process.env, PATH: `${d}:${process.env.PATH}`, REPO: "o/r", RELEASE_SHA: "abc" },
        encoding: "utf8",
      });
      return { ...r, calls: Number(readFileSync(join(d, "n"), "utf8")) };
    };

    it("success ngay → exit 0", () => {
      expect(exec(["completed:success"]).status).toBe(0);
    });
    it("đang chạy rồi success → đợi và exit 0", () => {
      const r = exec(["none:", "in_progress:", "completed:success"]);
      expect(r.status).toBe(0);
      expect(r.calls).toBe(3);
    });
    it.each(["completed:failure", "completed:cancelled", "completed:skipped"])(
      "%s → exit 1, không đợi tiếp",
      (state) => {
        const r = exec([state]);
        expect(r.status).toBe(1);
        expect(r.calls).toBe(1);
      },
    );
    // WAIT_LOOPS vòng × 2 tiến trình giả (gh, sleep) — vượt 5 s mặc định khi máy tải nặng; timeout riêng, không đổi logic.
    it("quality không bao giờ xuất hiện → hết giờ, exit 1", { timeout: 30_000 }, () => {
      const r = exec(["none:"]);
      expect(r.status).toBe(1);
      expect(r.calls).toBe(WAIT_LOOPS);
    });
  });
});

describe("CMP-LIC-003 — SBOM CycloneDX lưu cùng Release", () => {
  const assets = release.jobs.assets;
  const text = stepText(assets);
  const supply = parse(read(".github/workflows/supply-chain.yml"));
  const matrix = supply.jobs["image-scan"].strategy.matrix.include;
  const imageRun = assets.steps.find((s) => String(s.name).startsWith("SBOM CycloneDX của image")).run;
  // Danh sách image là thân heredoc `<<'IMAGES'` … `IMAGES` (dòng "tên ref").
  const heredoc = /<<'IMAGES'\n([\s\S]*?)\nIMAGES/.exec(imageRun)?.[1] ?? "";
  const listed = Object.fromEntries(heredoc.split("\n").map((l) => l.trim().split(/\s+/)));

  it("sinh SBOM npm toàn workspace vào dist/ và kiểm giấy phép theo license-policy.json", () => {
    expect(text).toContain("node scripts/sbom.mjs --out dist/sbom.cdx.json");
    expect(text).toContain("node scripts/sbom-check.mjs --policy license-policy.json dist/sbom.cdx.json");
    expect(text).toContain("pnpm install --frozen-lockfile --ignore-scripts");
  });

  it("SBOM image cho đúng danh sách image của supply-chain.yml (build tại chỗ với image tự build)", () => {
    expect(Object.keys(listed).sort()).toEqual(matrix.map((m) => m.name).sort());
    for (const m of matrix) {
      if (m.build) {
        expect(imageRun).toContain(`docker build --tag ${listed[m.name]} ${m.build}`);
      } else {
        expect(listed[m.name]).toBe(m.ref);
        expect(m.ref).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    }
    expect(imageRun).toContain('-o "cyclonedx-json=dist/sbom-image-$name.cdx.json"');
    expect(imageRun).toContain('node scripts/sbom-check.mjs "dist/sbom-image-$name.cdx.json"');
  });

  it("SBOM nằm trong SHA256SUMS và được đính lên Release trước khi công khai", () => {
    const at = (s) => text.indexOf(s);
    expect(text).toMatch(/sha256sum [^\n]*\.\/\*\.cdx\.json[^\n]*> SHA256SUMS/);
    expect(at("dist/sbom.cdx.json")).toBeLessThan(at("> SHA256SUMS"));
    expect(at("sbom-image-")).toBeLessThan(at("> SHA256SUMS"));
    expect(text).toContain('gh release upload "$TAG" dist/*');
  });

  it("syft tải bằng action ghim cùng SHA với supply-chain.yml", () => {
    const sha = (yml) => /anchore\/sbom-action[^@]*@([0-9a-f]{40})/.exec(yml)?.[1];
    expect(sha(read(".github/workflows/release.yml"))).toBe(sha(read(".github/workflows/supply-chain.yml")));
  });
});
