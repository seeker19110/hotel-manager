import { exec, execFile, execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import pg from "pg";

declare const user: string;
declare const db: pg.Pool;

// ruleid: hm-sql-raw-dynamic
sql.raw("select * from t where name = '" + user + "'");
// ruleid: hm-sql-raw-template-interpolation
sql.raw(`select * from t where name = '${user}'`);
// ok: hm-sql-raw-dynamic
sql.raw("select 1");
// ok: hm-sql-raw-template-interpolation
sql.raw(`select 1`);
// ok: hm-sql-raw-dynamic
sql`select * from t where name = ${user}`;

// Một hằng mảng cùng phạm vi KHÔNG làm sql.raw(đầu vào) an toàn (không có ngoại lệ "allowlist" ngầm).
function rawAfterAllowlist(input: string) {
  const allowed = ["a", "b"];
  void allowed;
  // ruleid: hm-sql-raw-dynamic
  return sql.raw(input);
}

// ruleid: hm-pg-query-concat
db.query(`select * from t where name = '${user}'`);
// ruleid: hm-pg-query-concat
db.query(`select * from t where name = '` + user + "'");
// ok: hm-pg-query-concat
db.query("select * from t where name = $1", [user]);

// ruleid: hm-child-process-shell
exec(`ls ${user}`);
// ruleid: hm-child-process-shell
execSync(`ls ${user}`);
// ruleid: hm-child-process-shell
spawn("ls", [user], { shell: true });
// ok: hm-child-process-shell
execFile("ls", [user]);
// ok: hm-child-process-shell
spawn("ls", [user], { stdio: "ignore" });

// ruleid: hm-code-eval
eval(user);
// ruleid: hm-code-eval
new Function(user);

// ruleid: hm-path-traversal-dynamic
readFileSync(join("/srv/files", user));
// ruleid: hm-path-traversal-dynamic
writeFileSync(`/srv/files/${user}`, "x");
// ok: hm-path-traversal-dynamic
readFileSync("/etc/hm/config.json");
