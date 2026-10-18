// T-807: hook git cục bộ (XC-DX-006 tự cài, < 30 s trên commit 5 file; BASE-REPO-002 chặn file bị ignore, không artefact bị commit).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { installHooks, MARKER } from "./install-git-hooks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALLER_SRC = join(ROOT, "scripts/install-git-hooks.mjs");
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd, cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...opts.env },
  });

/** Repo tạm: git init + cấu hình dự án (hook, biome, .gitignore) + node_modules của repo thật (symlink). */
function sandbox({ install = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "hooks-"));
  dirs.push(d);
  sh(d, "git", ["init", "-q", "-b", "wip/test"]);
  sh(d, "git", ["config", "user.email", "dev@example.com"]);
  sh(d, "git", ["config", "user.name", "Dev"]);
  sh(d, "git", ["config", "commit.gpgsign", "false"]);
  cpSync(join(ROOT, ".githooks"), join(d, ".githooks"), { recursive: true });
  for (const f of [".gitignore", "biome.json"]) cpSync(join(ROOT, f), join(d, f));
  symlinkSync(join(ROOT, "node_modules"), join(d, "node_modules"));
  mkdirSync(join(d, "scripts"));
  cpSync(INSTALLER_SRC, join(d, "scripts/install-git-hooks.mjs"));
  if (install) expect(sh(d, "node", ["scripts/install-git-hooks.mjs"]).status).toBe(0);
  return d;
}

const GOOD = "export const value = 1;\n";
const BAD = "export  const   value=1 ;\n"; // sai format theo biome.json
const commit = (d, msg = "test: x") => sh(d, "git", ["commit", "-q", "-m", msg]);
const stage = (d, ...files) => expect(sh(d, "git", ["add", "-f", "--", ...files]).status).toBe(0);

describe("XC-DX-006 — hook tự cài", () => {
  it("sau khi chạy script cài: .git/hooks/pre-commit tồn tại, thực thi được, mang dấu nhận diện", () => {
    const d = sandbox();
    const p = join(d, ".git/hooks/pre-commit");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o111).not.toBe(0);
    expect(readFileSync(p, "utf8")).toContain("hm-managed-hook");
  });

  it("chạy lại an toàn: unchanged; stub cũ thì updated", () => {
    const d = sandbox();
    expect(installHooks(d).status).toBe("unchanged");
    writeFileSync(join(d, ".git/hooks/pre-commit"), `#!/bin/sh\n${MARKER}\nexit 0 # bản cũ\n`);
    expect(installHooks(d).status).toBe("updated");
    expect(installHooks(d).status).toBe("unchanged");
  });

  it("không đè hook của công cụ khác", () => {
    const d = sandbox({ install: false });
    mkdirSync(join(d, ".git/hooks"), { recursive: true });
    writeFileSync(join(d, ".git/hooks/pre-commit"), "#!/bin/sh\necho của-công-cụ-khác\n");
    expect(installHooks(d).status).toBe("foreign-hook");
    expect(readFileSync(join(d, ".git/hooks/pre-commit"), "utf8")).toContain("của-công-cụ-khác");
  });

  it("không phải repo git (Docker build, tarball) → không làm gì, exit 0, không tạo thư mục", () => {
    const d = mkdtempSync(join(tmpdir(), "nogit-"));
    dirs.push(d);
    mkdirSync(join(d, "scripts"));
    cpSync(INSTALLER_SRC, join(d, "scripts/install-git-hooks.mjs"));
    const env = { GIT_CEILING_DIRECTORIES: tmpdir() }; // không để git đi ngược lên repo khác
    expect(installHooks(d, env).status).toBe("no-git");
    const r = sh(d, "node", ["scripts/install-git-hooks.mjs"], { env });
    expect(r.status).toBe(0);
    expect(existsSync(join(d, ".git"))).toBe(false);
  });

  it("stub im lặng khi cây làm việc không có .githooks/pre-commit (nhánh cũ)", () => {
    const d = sandbox();
    rmSync(join(d, ".githooks"), { recursive: true });
    writeFileSync(join(d, "a.ts"), BAD);
    stage(d, "a.ts");
    expect(commit(d).status).toBe(0);
  });

  it("script prepare của package.json gọi bộ cài và không bao giờ làm hỏng install", () => {
    const prepare = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.prepare;
    expect(prepare).toContain("scripts/install-git-hooks.mjs");
    expect(prepare).toMatch(/test -f scripts\/install-git-hooks\.mjs/); // Dockerfile chỉ COPY package.json khi install
    expect(prepare).toMatch(/\|\| true$/);
    const d = mkdtempSync(join(tmpdir(), "docker-"));
    dirs.push(d);
    writeFileSync(join(d, "package.json"), "{}");
    expect(sh(d, "sh", ["-c", prepare]).status).toBe(0); // không có scripts/ trong ngữ cảnh build
  });
});

describe("XC-DX-006 — hook nhanh, chỉ file thay đổi", () => {
  it("commit 5 file sạch: xanh và < 30 s", () => {
    const d = sandbox();
    const files = [1, 2, 3, 4, 5].map((i) => `m${i}.ts`);
    for (const f of files) writeFileSync(join(d, f), GOOD);
    stage(d, ...files);
    const t0 = Date.now();
    const r = commit(d);
    const ms = Date.now() - t0;
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(ms).toBeLessThan(30_000);
  });

  it("file sai format đã stage → commit bị chặn, nêu lỗi biome; sửa xong thì qua", () => {
    const d = sandbox();
    writeFileSync(join(d, "bad.ts"), BAD);
    stage(d, "bad.ts");
    const r = commit(d);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/format|biome/i);
    writeFileSync(join(d, "bad.ts"), GOOD);
    stage(d, "bad.ts");
    expect(commit(d).status).toBe(0);
  });

  it("chỉ xét file đã stage: file sai format chưa stage không cản commit", () => {
    const d = sandbox();
    writeFileSync(join(d, "ok.ts"), GOOD);
    writeFileSync(join(d, "draft.ts"), BAD);
    stage(d, "ok.ts");
    expect(commit(d).status).toBe(0);
  });

  it("commit rỗng (không file stage) → qua", () => {
    const d = sandbox();
    expect(sh(d, "git", ["commit", "-q", "--allow-empty", "-m", "chore: rỗng"]).status).toBe(0);
  });
});

describe("BASE-REPO-002 — hook chặn file bị ignore", () => {
  it.each([
    ["dist/out.js"],
    ["build/out.js"],
    [".venv/lib/x.py"],
    ["node_modules_x/../.env"],
    [".env.local"],
    ["deploy/secrets/pg.txt"],
  ])("git add -f %s → commit bị chặn", (rel) => {
    const d = sandbox();
    const abs = join(d, rel.replace("node_modules_x/../", ""));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "x\n");
    stage(d, rel.replace("node_modules_x/../", ""));
    const r = commit(d);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(".gitignore");
  });

  it(".env.example (được phủ định trong .gitignore) vẫn commit được", () => {
    const d = sandbox();
    writeFileSync(join(d, ".env.example"), "FOO=\n");
    stage(d, ".env.example");
    expect(commit(d).status).toBe(0);
  });

  it("tên file có dấu cách và Unicode: file thường qua, file bị ignore bị chặn", () => {
    const d = sandbox();
    writeFileSync(join(d, "phòng 101.ts"), GOOD);
    stage(d, "phòng 101.ts");
    expect(commit(d).status).toBe(0);
    mkdirSync(join(d, "dist"), { recursive: true });
    writeFileSync(join(d, "dist", "báo cáo.js"), "x\n");
    stage(d, "dist/báo cáo.js");
    const r = commit(d);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("báo cáo.js");
  });
});

describe("BASE-REPO-002 — repo thật không chứa artefact/bí mật bị ignore", () => {
  const ls = (...args) => {
    const r = sh(ROOT, "git", ["ls-files", ...args]);
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split("\n").filter(Boolean);
  };
  it("git ls-files không có node_modules/dist/build/.venv/.env* (trừ .env.example)", () => {
    const bad = ls().filter(
      (f) =>
        /(^|\/)(node_modules|dist|build|\.venv)\//.test(f) ||
        (/(^|\/)\.env($|\.)/.test(f) && !/(^|\/)\.env\.example$/.test(f)),
    );
    expect(bad).toEqual([]);
  });
  it("không file nào đang được theo dõi mà khớp .gitignore", () => {
    expect(ls("-ci", "--exclude-standard")).toEqual([]);
  });
  it(".gitignore phủ node_modules, dist, build, .venv, .env*", () => {
    const g = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");
    for (const rule of ["node_modules/", "dist/", "build/", ".venv/", ".env", ".env.*", "!.env.example"])
      expect(g).toContain(rule);
  });
});
