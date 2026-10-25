// Test THIRD_PARTY_NOTICES (CMP-LIC-001) và LICENSE/license manifest (BASE-REPO-004, D-111).
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  describe as describePkg,
  generate,
  licenseOf,
  render,
  repoOf,
  shippedPackages,
} from "./third-party-notices.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("shippedPackages", () => {
  const tmp = mkdtempSync(join(tmpdir(), "tpn-"));
  const pkgDir = (n) => {
    const d = join(tmp, n.replace("/", "+"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: n }));
    return d;
  };
  const a = pkgDir("a");
  const b = pkgDir("b");
  const c = pkgDir("c");

  it("bỏ workspace không phân phối, link: và gói tuỳ chọn không cài; lấy cây con đầy đủ kể cả khi bản đầy đủ nằm dưới workspace bị loại", () => {
    const workspaces = [
      // Bản rút gọn của a (deduped) xuất hiện ở workspace phân phối…
      {
        name: "@hm/web",
        dependencies: {
          a: { version: "1.0.0", path: a, deduped: true },
          "@hm/app": { version: "link:../x" },
        },
      },
      // …bản đầy đủ chỉ nằm dưới @hm/testkit (không phân phối).
      {
        name: "@hm/testkit",
        dependencies: {
          a: { version: "1.0.0", path: a, dependencies: { b: { version: "2.0.0", path: b } } },
          c: { version: "3.0.0", path: c },
        },
      },
      { name: "@hm/worker", dependencies: { gone: { version: "9.9.9", path: join(tmp, "khong-cai") } } },
    ];
    expect(shippedPackages(workspaces).map((p) => `${p.name}@${p.version}`)).toEqual(["a@1.0.0", "b@2.0.0"]);
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});

describe("licenseOf / repoOf", () => {
  it("license chuỗi, {type}, mảng cũ, thiếu → UNKNOWN", () => {
    expect(licenseOf({ license: " MIT " })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("MIT OR Apache-2.0");
    expect(licenseOf({})).toBe("UNKNOWN");
  });
  it("repository chuỗi/{url}, bỏ git+ và .git, git:// → https://; thiếu → homepage", () => {
    expect(repoOf({ repository: { url: "git+https://github.com/a/b.git" } })).toBe("https://github.com/a/b");
    expect(repoOf({ repository: "git://github.com/a/b.git" })).toBe("https://github.com/a/b");
    expect(repoOf({ homepage: "https://x.dev" })).toBe("https://x.dev");
  });
});

describe("describe + render", () => {
  it("đọc NOTICE và LICENSE; văn bản giống hệt gom một mục; xác định (không phụ thuộc thời gian)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tpn-r-"));
    try {
      const mk = (n, files) => {
        const d = join(tmp, n);
        mkdirSync(d);
        writeFileSync(
          join(d, "package.json"),
          JSON.stringify({ name: n, license: "MIT", repository: `https://e/${n}` }),
        );
        for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
        return { name: n, version: "1.0.0", path: d };
      };
      const entries = [
        describePkg(mk("x", { LICENSE: "MIT text\r\n", NOTICE: "Copyright X" })),
        describePkg(mk("y", { "LICENSE.md": "MIT text" })),
      ];
      const md = render(entries);
      expect(md).toContain("| x | 1.0.0 | MIT | https://e/x |");
      expect(md).toContain("### x@1.0.0\n\n```text\nCopyright X\n```");
      expect(md).toContain("### x@1.0.0, y@1.0.0\n\n```text\nMIT text\n```");
      expect(md.match(/MIT text/g)).toHaveLength(1);
      expect(render(entries)).toBe(md);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("repo thật (D-111)", () => {
  it("LICENSE ở gốc ghi Proprietary + chủ sở hữu; mọi package.json có license UNLICENSED khớp", () => {
    const lic = readFileSync(join(ROOT, "LICENSE"), "utf8");
    expect(lic).toMatch(/Proprietary/);
    expect(lic).toMatch(/Copyright \(c\) \d{4} seeker19110/);
    const manifests = [
      "package.json",
      ...globSync("apps/*/package.json", { cwd: ROOT }),
      ...globSync("packages/*/package.json", { cwd: ROOT }),
    ];
    expect(manifests.length).toBeGreaterThan(5);
    for (const m of manifests)
      expect(JSON.parse(readFileSync(join(ROOT, m), "utf8")).license, m).toBe("UNLICENSED");
  });

  it("THIRD_PARTY_NOTICES.md khớp lockfile, có gói phân phối chính, không giấy phép UNKNOWN", () => {
    const md = generate();
    expect(readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe(md);
    for (const p of ["next", "react", "pg", "kysely", "better-auth", "sharp"])
      expect(md).toMatch(new RegExp(`^\\| ${p} \\|`, "m"));
    expect(md).not.toMatch(/\| UNKNOWN \|/);
    expect(md).not.toMatch(/^\| vitest \|/m);
  }, 60_000);
});
