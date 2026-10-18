// Test cho scripts/new-deps-check.mjs (BASE-DEP-006; T-802).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allNames,
  checkDeclarations,
  declaredLine,
  dependencySection,
  directNames,
  newPackages,
} from "./new-deps-check.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Lockfile giả dạng pnpm: document môi trường + document chính. */
function lock({ direct = {}, packages = [], workspace = {} } = {}) {
  const imp = Object.entries(direct)
    .map(([n, v]) => `      '${n}':\n        specifier: ${v}\n        version: ${v}`)
    .join("\n");
  const link = Object.keys(workspace)
    .map((n) => `      '${n}':\n        specifier: workspace:*\n        version: link:../${n}`)
    .join("\n");
  const pk = packages.map((k) => `  '${k}':\n    resolution: {integrity: sha512-AAAA}`).join("\n");
  return `lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  env-only@9.9.9:\n    resolution: {integrity: sha512-BBBB}\n---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n${imp || "      {}"}\n${link}\npackages:\n${pk || "  {}"}\n`;
}

const BASE = lock({ direct: { vitest: "5.0.4" }, packages: ["vitest@5.0.4", "tinyspy@4.0.0"] });
const BODY = (line) => `## Mục tiêu\nx\n\n## Phụ thuộc mới\n<!-- mẫu -->\n${line}\n\n## Rủi ro\ny\n`;

describe("directNames / allNames", () => {
  it("lấy tên trực tiếp từ importers, bỏ link: nội bộ và document môi trường", () => {
    const l = lock({
      direct: { yaml: "2.9.1", "@hm/domain": "1.0.0" },
      workspace: { "@hm/app": 1 },
      packages: ["yaml@2.9.1", "@scope/p@1.0.0(peer@2.0.0)"],
    });
    expect([...directNames(l)].sort()).toEqual(["@hm/domain", "yaml"]);
    expect([...allNames(l)].sort()).toEqual(["@scope/p", "yaml"]);
  });
  it("lockfile rỗng → tập rỗng", () => {
    expect(directNames("").size).toBe(0);
    expect(allNames("").size).toBe(0);
  });
});

describe("newPackages", () => {
  it("không đổi → rỗng; chỉ nâng bản gói đã có → rỗng", () => {
    expect(newPackages(BASE, BASE)).toEqual({ direct: [], transitive: [] });
    const bumped = lock({ direct: { vitest: "5.0.5" }, packages: ["vitest@5.0.5", "tinyspy@4.0.0"] });
    expect(newPackages(BASE, bumped)).toEqual({ direct: [], transitive: [] });
  });
  it("thêm trực tiếp + kéo theo gián tiếp mới", () => {
    const head = lock({
      direct: { vitest: "5.0.4", yaml: "2.9.1" },
      packages: ["vitest@5.0.4", "tinyspy@4.0.0", "yaml@2.9.1", "dep-of-yaml@1.0.0"],
    });
    expect(newPackages(BASE, head)).toEqual({ direct: ["yaml"], transitive: ["dep-of-yaml"] });
  });
  it("gói đã có gián tiếp rồi được nâng lên trực tiếp → không tính là mới", () => {
    const head = lock({
      direct: { vitest: "5.0.4", tinyspy: "4.0.0" },
      packages: ["vitest@5.0.4", "tinyspy@4.0.0"],
    });
    expect(newPackages(BASE, head).direct).toEqual([]);
  });
  it("gói bị gỡ không gây lỗi", () => {
    expect(newPackages(BASE, lock()).direct).toEqual([]);
  });
});

describe("dependencySection / declaredLine", () => {
  it("đọc đúng mục, bỏ chú thích HTML; không có mục → rỗng", () => {
    expect(dependencySection(BODY("- yaml · ISC · đọc workflow · tự viết parser"))).toBe(
      "- yaml · ISC · đọc workflow · tự viết parser",
    );
    expect(dependencySection("## Mục tiêu\nx")).toBe("");
    expect(dependencySection("")).toBe("");
    expect(dependencySection(undefined)).toBe("");
  });
  it("mục là mục cuối của mô tả vẫn đọc được", () => {
    expect(dependencySection("## Phụ thuộc mới\n- a · MIT · r · t")).toBe("- a · MIT · r · t");
  });
  it("cần đủ 4 trường không rỗng và tên khớp chính xác (không khớp tiền tố)", () => {
    const s =
      "- yaml-extra · ISC · lý do · thay thế\n- `yaml@2.9.1` · ISC · lý do · tự viết\n- other · MIT · · x";
    expect(declaredLine(s, "yaml")).toBe("`yaml@2.9.1` · ISC · lý do · tự viết");
    expect(declaredLine(s, "other")).toBeNull();
    expect(declaredLine(s, "yaml-extra")).not.toBeNull();
    expect(declaredLine(s, "khong-co")).toBeNull();
  });
  it("tên scope và Unicode trong lý do", () => {
    expect(
      declaredLine("* [x] @scope/pkg · MIT · cần để đọc tệp tiếng Việt: đà nẵng · Intl", "@scope/pkg"),
    ).not.toBeNull();
  });
});

describe("checkDeclarations", () => {
  it("không có gói mới → luôn đạt (kể cả mô tả trống)", () => {
    expect(checkDeclarations([], "")).toEqual([]);
  });
  it("có gói mới mà mục trống/không có → đỏ", () => {
    expect(checkDeclarations(["yaml"], BODY("")).join()).toMatch(/trống/);
    expect(checkDeclarations(["yaml"], "## Mục tiêu\nx").join()).toMatch(/trống/);
    expect(checkDeclarations(["yaml"], "").join()).toMatch(/trống/);
  });
  it('mục chỉ ghi "không có" mà có gói mới → đỏ (đúng ca "khai sai")', () => {
    expect(checkDeclarations(["yaml"], BODY("không có")).join()).toMatch(/thiếu dòng khai/);
  });
  it("khai đủ → đạt; thiếu một trong hai gói → đỏ đúng gói đó", () => {
    const line = "- yaml · ISC · đọc workflow trong test · tự viết parser (đã xét, không đủ)";
    expect(checkDeclarations(["yaml"], BODY(line))).toEqual([]);
    const errs = checkDeclarations(["yaml", "zod"], BODY(line));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/"zod"/);
  });
});

describe("CLI", () => {
  const run = (args) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [join(ROOT, "scripts/new-deps-check.mjs"), ...args], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  it("thiếu --base-lock → 2; PR thêm gói không khai → 1; khai đủ → 0; không đổi → 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "newdeps-"));
    try {
      const base = join(dir, "base.yaml");
      const head = join(dir, "head.yaml");
      const body = join(dir, "body.md");
      writeFileSync(base, BASE);
      writeFileSync(
        head,
        lock({
          direct: { vitest: "5.0.4", yaml: "2.9.1" },
          packages: ["vitest@5.0.4", "tinyspy@4.0.0", "yaml@2.9.1"],
        }),
      );
      expect(run([]).code).toBe(2);
      writeFileSync(body, BODY(""));
      const red = run(["--base-lock", base, "--head-lock", head, "--body-file", body]);
      expect(red.code).toBe(1);
      expect(red.out).toMatch(/::error::/);
      writeFileSync(body, BODY("- yaml · ISC · đọc workflow · tự viết"));
      expect(run(["--base-lock", base, "--head-lock", head, "--body-file", body]).code).toBe(0);
      expect(run(["--base-lock", base, "--head-lock", base]).code).toBe(0);
      expect(run(["--base-lock", base, "--head-lock", head]).code).toBe(1); // không truyền mô tả
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("lockfile thật của repo so với chính nó → đạt", () => {
    const f = join(ROOT, "pnpm-lock.yaml");
    expect(readFileSync(f, "utf8").length).toBeGreaterThan(0);
    expect(run(["--base-lock", f]).code).toBe(0);
  });
});
