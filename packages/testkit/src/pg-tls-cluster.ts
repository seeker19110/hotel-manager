// Cluster PostgreSQL 17 tạm cho test DB-SEC-003: TLS bật, pg_hba.conf là CHÍNH `deploy/postgres/pg_hba.conf` (hostssl + scram-sha-256),
// chứng chỉ do CA tạm ký bằng openssl (SAN localhost + 127.0.0.1). Chỉ dùng cho test; xoá khi dừng.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { asPg, freePort, PG_BIN } from "./pg-cluster.ts";

const HBA_SOURCE = new URL("../../../deploy/postgres/pg_hba.conf", import.meta.url).pathname;
/** Mật khẩu role thăm dò trong cluster dùng một lần này (không phải bí mật). */
const PROBE_PASSWORD = "tls-probe-not-a-secret";

export interface PgTlsCluster {
  /** Đường dẫn CA tạm đã ký chứng chỉ máy chủ — dùng cho `sslrootcert`. */
  caFile: string;
  /** URL role thăm dò (đăng nhập bằng mật khẩu SCRAM) với tham số `sslmode` và tuỳ chọn `sslrootcert`. */
  url(opts: { sslmode: string; rootCert?: boolean; password?: string }): string;
  /** Đường dẫn bản sao pg_hba.conf mà cluster đang nạp (copy nguyên văn của deploy/postgres/pg_hba.conf). */
  hbaFile: string;
  /**
   * Các dòng pg_hba mà MÁY CHỦ đang áp dụng (hỏi `pg_hba_file_rules` qua hostssl + SCRAM, `verify-full` với CA tạm): loại + phương thức.
   * Không dùng socket Unix: dòng `local … peer` của deploy/ chỉ khớp khi người dùng hệ điều hành tên `postgres` (CI chạy bằng user khác).
   */
  hbaRules(): Promise<{ type: string; method: string }[]>;
  stop(): void;
}

const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });

export async function startPgTlsCluster(): Promise<PgTlsCluster> {
  if (!existsSync(join(PG_BIN, "initdb"))) {
    throw new Error(`Không có PostgreSQL 17 ở ${PG_BIN}. Chạy scripts/dev-env-setup.sh --only postgres.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "hm-pgtls-"));
  const data = join(dir, "data");
  const ca = join(dir, "ca.crt");
  const caKey = join(dir, "ca.key");
  const crt = join(dir, "server.crt");
  const key = join(dir, "server.key");
  const csr = join(dir, "server.csr");
  const ext = join(dir, "san.cnf");
  const hba = join(dir, "pg_hba.conf");
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl("req", "-x509", ...ec, "-keyout", caKey, "-out", ca, "-subj", "/CN=hm-test-ca", "-days", "1");
  openssl("req", ...ec, "-keyout", key, "-out", csr, "-subj", "/CN=localhost");
  writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  openssl(
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    crt,
    "-days",
    "1",
    "-extfile",
    ext,
  );
  copyFileSync(HBA_SOURCE, hba);
  chmodSync(key, 0o600);
  if (process.getuid?.() === 0) {
    const id = (flag: string) => Number(execFileSync("id", [flag, "postgres"], { encoding: "utf8" }).trim());
    for (const f of [dir, ca, crt, key, hba]) chownSync(f, id("-u"), id("-g"));
  }

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
  const base = [
    `-p ${port}`,
    "-c listen_addresses=127.0.0.1",
    `-c unix_socket_directories=${dir}`,
    "-c fsync=off",
  ];
  const ctl = (action: string[], opts: string[]) =>
    asPg(join(PG_BIN, "pg_ctl"), [
      "-D",
      data,
      ...(opts.length ? ["-o", opts.join(" ")] : []),
      "-w",
      "-l",
      join(dir, "log"),
      ...action,
    ]);
  // Bước 1 (hba mặc định của initdb = trust trên socket): tạo role đăng nhập bằng mật khẩu SCRAM.
  ctl(["start"], base);
  asPg(join(PG_BIN, "psql"), [
    "-h",
    dir,
    "-p",
    String(port),
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `SET password_encryption = 'scram-sha-256'; CREATE ROLE tls_probe LOGIN PASSWORD '${PROBE_PASSWORD}'`,
  ]);
  asPg(join(PG_BIN, "psql"), [
    "-h",
    dir,
    "-p",
    String(port),
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    // Chỉ đọc cấu hình hba (mặc định chỉ superuser): cấp đúng hai quyền cho role thăm dò thay vì nâng lên superuser.
    "GRANT EXECUTE ON FUNCTION pg_hba_file_rules() TO tls_probe; GRANT SELECT ON pg_hba_file_rules TO tls_probe",
  ]);
  ctl(["stop"], []);
  // Bước 2: cấu hình như production — TLS ≥ 1.2, hba_file của deploy/, SCRAM.
  ctl(
    ["start"],
    [
      ...base,
      "-c ssl=on",
      `-c ssl_cert_file=${crt}`,
      `-c ssl_key_file=${key}`,
      "-c ssl_min_protocol_version=TLSv1.2",
      `-c hba_file=${hba}`,
      "-c password_encryption=scram-sha-256",
    ],
  );
  return {
    caFile: ca,
    hbaFile: hba,
    async hbaRules() {
      const client = new pg.Client({
        host: "127.0.0.1",
        port,
        user: "tls_probe",
        password: PROBE_PASSWORD,
        database: "postgres",
        ssl: { ca: readFileSync(ca, "utf8"), servername: "localhost" },
        connectionTimeoutMillis: 10_000,
      });
      await client.connect();
      try {
        const r = await client.query<{ type: string; method: string }>(
          "select type, auth_method as method from pg_hba_file_rules where error is null order by rule_number",
        );
        return r.rows.map(({ type, method }) => ({ type, method }));
      } finally {
        await client.end();
      }
    },
    url({ sslmode, rootCert = true, password = PROBE_PASSWORD }) {
      const q = new URLSearchParams({ sslmode });
      if (rootCert) q.set("sslrootcert", ca);
      return `postgres://tls_probe:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres?${q}`;
    },
    stop() {
      try {
        asPg(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
