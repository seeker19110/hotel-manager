// Cluster PostgreSQL 17 tạm cho test khi không có TEST_DATABASE_URL (môi trường agent không Docker — PLAN T-001/T-005).
// Chỉ dùng cho test: xác thực `trust` trên 127.0.0.1, dữ liệu trong thư mục tạm, xoá khi dừng.
import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PG_BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin";

export interface PgCluster {
  adminUrl: string;
  stop(): void;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** initdb/pg_ctl không chạy dưới root: khi là root thì chạy qua user `postgres`. */
export function asPg(cmd: string, args: string[]): string {
  const isRoot = process.getuid?.() === 0;
  const [bin, argv] = isRoot ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
  const res = spawnSync(bin, argv, { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${cmd} lỗi (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

export async function startPgCluster(): Promise<PgCluster> {
  if (!existsSync(join(PG_BIN, "initdb"))) {
    throw new Error(
      `Không có PostgreSQL 17 ở ${PG_BIN}. Đặt TEST_DATABASE_URL hoặc chạy scripts/dev-env-setup.sh (PLAN T-001).`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "hm-pg-"));
  if (process.getuid?.() === 0) {
    const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
    chownSync(dir, uid, gid);
  }
  const data = join(dir, "data");
  const port = await freePort();
  asPg(join(PG_BIN, "initdb"), [
    "-D",
    data,
    "-U",
    "postgres",
    "--auth=trust",
    "-E",
    "UTF8",
    "--locale=C.UTF-8",
  ]);
  const opts = [
    `-p ${port}`,
    "-c listen_addresses=127.0.0.1",
    `-c unix_socket_directories=${dir}`,
    "-c fsync=off",
    "-c synchronous_commit=off",
    "-c full_page_writes=off",
    "-c max_connections=100", // bằng mặc định của Postgres service trong CI — lỗi cạn kết nối lộ ra ngay ở máy
  ].join(" ");
  asPg(join(PG_BIN, "pg_ctl"), ["-D", data, "-o", opts, "-w", "-l", join(dir, "log"), "start"]);
  return {
    adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        asPg(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
