// Trợ giúp cho test: repo git tạm (không đụng repo thật) để thử các rào so với nhánh gốc. Chỉ dùng trong *.test.mjs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git-history.mjs";

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hm-git-fixture-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "ci@example.test"], dir);
  git(["config", "user.name", "Kiểm thử"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  return {
    dir,
    write(rel, text) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    remove(rel) {
      rmSync(join(dir, rel), { force: true });
    },
    commit(message) {
      git(["add", "-A"], dir);
      git(["commit", "-q", "--no-verify", "-m", message], dir);
    },
    branch(name) {
      git(["checkout", "-q", "-b", name], dir);
    },
    destroy() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
