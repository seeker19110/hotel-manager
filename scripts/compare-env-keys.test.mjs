import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function run(a, b) {
  const dir = mkdtempSync(join(tmpdir(), "env-keys-"));
  dirs.push(dir);
  const first = join(dir, "staging.json");
  const second = join(dir, "production.json");
  writeFileSync(first, typeof a === "string" ? a : JSON.stringify(a));
  writeFileSync(second, typeof b === "string" ? b : JSON.stringify(b));
  return spawnSync(process.execPath, ["scripts/compare-env-keys.mjs", first, second], { encoding: "utf8" });
}

describe("compare environment key manifests", () => {
  it("matches services and keys irrespective of ordering", () => {
    const r = run(
      [
        ["web", ["B", "A"]],
        ["worker", []],
      ],
      [
        ["worker", []],
        ["web", ["A", "B"]],
      ],
    );
    expect(r.status).toBe(0);
  });
  it("reports missing keys and services on both sides", () => {
    const r = run(
      [
        ["web", ["ST_ONLY"]],
        ["stage", []],
      ],
      [
        ["web", ["PROD_ONLY"]],
        ["prod", []],
      ],
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("web: staging thiếu PROD_ONLY");
    expect(r.stderr).toContain("web: production thiếu ST_ONLY");
    expect(r.stderr).toContain("prod: thiếu dịch vụ ở staging");
    expect(r.stderr).toContain("stage: thiếu dịch vụ ở production");
  });
  it.each([
    "not-json secret-value",
    "{}",
    "[]",
    '[["web",["A"]],["web",["B"]]]',
    '[["web",["A","A"]]]',
    '[["web",["A=secret-value"]]]',
    '[["web",{"A":"secret-value"}]]',
    '[["BAD SERVICE",[]]]',
    '[["web"]]',
    '[["web",[1]]]',
  ])("rejects malformed, duplicate or value-bearing input without echoing it: %s", (bad) => {
    const r = run(bad, [["web", ["A"]]]);
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toContain("secret-value");
  });
  it("rejects protected paths and resolves JSON symlinks without creating protected files", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-keys-"));
    dirs.push(dir);
    const protectedPath = join(dir, ".env.json"); // Deliberately never created.
    const valid = join(dir, "keys.json");
    const target = join(dir, "keys.txt");
    const link = join(dir, "linked.json");
    writeFileSync(valid, '[["web",[]]]');
    writeFileSync(target, '[["web",[]]]');
    symlinkSync(target, link);
    for (const path of [protectedPath, link]) {
      const r = spawnSync(process.execPath, ["scripts/compare-env-keys.mjs", path, valid], {
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
    }
    const validLink = join(dir, "valid-link.json");
    symlinkSync(valid, validLink);
    const ok = spawnSync(process.execPath, ["scripts/compare-env-keys.mjs", validLink, valid], {
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
  });
  it("rejects a FIFO without blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-keys-"));
    dirs.push(dir);
    const fifo = join(dir, "pipe.json");
    const valid = join(dir, "keys.json");
    writeFileSync(valid, '[["web",[]]]');
    const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(created.status).toBe(0);
    const result = spawnSync(process.execPath, ["scripts/compare-env-keys.mjs", fifo, valid], {
      encoding: "utf8",
      timeout: 2000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
  });
});
