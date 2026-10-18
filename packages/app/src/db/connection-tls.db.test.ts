// DB-SEC-003 — kết nối CSDL qua TLS có xác minh chứng chỉ; máy chủ từ chối kết nối không mã hoá và mật khẩu sai.
// Cluster Postgres 17 thật nạp CHÍNH `deploy/postgres/pg_hba.conf` (hostssl + scram-sha-256) cùng chứng chỉ do CA tạm ký.
import { readFileSync } from "node:fs";
import { type PgTlsCluster, startPgTlsCluster } from "@hm/testkit/setup";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let cluster: PgTlsCluster;

beforeAll(async () => {
  cluster = await startPgTlsCluster();
});
afterAll(() => cluster?.stop());

async function connect(url: string): Promise<{ ssl: boolean; version: string | null }> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const r = await client.query<{ ssl: boolean; version: string | null }>(
      "select ssl, version from pg_stat_ssl where pid = pg_backend_pid()",
    );
    return r.rows[0] ?? { ssl: false, version: null };
  } finally {
    await client.end();
  }
}

describe("DB-SEC-003 — Postgres thật với deploy/postgres/pg_hba.conf", () => {
  it("sslmode=verify-full + CA đúng + mật khẩu đúng → vào được, phiên đã mã hoá TLS ≥ 1.2", async () => {
    const s = await connect(cluster.url({ sslmode: "verify-full" }));
    expect(s.ssl).toBe(true);
    expect(["TLSv1.2", "TLSv1.3"]).toContain(s.version);
  });

  it("kết nối không mã hoá → máy chủ từ chối: không có dòng pg_hba cho kết nối không mã hoá", async () => {
    const mode = "disable";
    await expect(connect(cluster.url({ sslmode: mode, rootCert: false }))).rejects.toThrow(
      /no pg_hba\.conf entry.*no encryption/i,
    );
  });

  it("verify-full nhưng không tin CA (thiếu sslrootcert) → client từ chối máy chủ", async () => {
    await expect(connect(cluster.url({ sslmode: "verify-full", rootCert: false }))).rejects.toThrow(
      /self.signed|unable to verify|certificate/i,
    );
  });

  it("mật khẩu sai qua TLS hợp lệ → xác thực SCRAM thất bại", async () => {
    await expect(connect(cluster.url({ sslmode: "verify-full", password: "sai-mat-khau" }))).rejects.toThrow(
      /password authentication failed/i,
    );
  });

  it("mật khẩu rỗng → bị từ chối ngay ở client (driver không có mật khẩu để trả lời SCRAM), không có đường vào không mật khẩu", async () => {
    await expect(connect(cluster.url({ sslmode: "verify-full", password: "" }))).rejects.toThrow(
      /SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a (?:non-empty )?string/,
    );
  });

  it("verify-full nhưng chứng chỉ không có SAN khớp tên máy → client từ chối (sai SAN)", async () => {
    const u = new URL(cluster.url({ sslmode: "verify-full" }));
    const client = new pg.Client({
      host: u.hostname,
      port: Number(u.port),
      user: u.username,
      password: decodeURIComponent(u.password),
      database: "postgres",
      // CA đúng nhưng tên cần xác minh không nằm trong SAN (localhost, 127.0.0.1) của chứng chỉ máy chủ.
      ssl: { ca: readFileSync(cluster.caFile, "utf8"), servername: "hm-sai-ten.example.test" },
      connectionTimeoutMillis: 10_000,
    });
    await expect(client.connect()).rejects.toThrow(/Hostname\/IP does not match certificate's altnames/i);
    await client.end().catch(() => undefined);
  });

  it("máy chủ từ chối TLS 1.1 (ssl_min_protocol_version=TLSv1.2)", async () => {
    const u = new URL(cluster.url({ sslmode: "verify-full" }));
    const client = new pg.Client({
      host: u.hostname,
      port: Number(u.port),
      user: u.username,
      password: decodeURIComponent(u.password),
      database: "postgres",
      // Ép client chỉ nói TLS ≤ 1.1 (hạ mức bảo mật phía client của OpenSSL để lỗi đến từ máy chủ, không phải từ client).
      ssl: {
        ca: readFileSync(cluster.caFile, "utf8"),
        minVersion: "TLSv1",
        maxVersion: "TLSv1.1",
        ciphers: "ALL:@SECLEVEL=0",
      },
      connectionTimeoutMillis: 10_000,
    });
    await expect(client.connect()).rejects.toThrow(/tlsv1 alert protocol version/i);
    await client.end().catch(() => undefined);
  });

  it("máy chủ báo đúng các dòng pg_hba của deploy/: chỉ local peer và hostssl scram-sha-256", async () => {
    const declared = readFileSync(new URL("../../../../deploy/postgres/pg_hba.conf", import.meta.url), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => {
        const cols = l.split(/\s+/);
        return { type: cols[0] ?? "", method: cols[cols.length - 1] ?? "" };
      });
    const live = await cluster.hbaRules();
    expect(live).toEqual(declared); // máy chủ thật nạp đúng nội dung (không phải so hai bản sao tệp)
    expect(live).toEqual([
      { type: "local", method: "peer" },
      { type: "hostssl", method: "scram-sha-256" },
    ]);
  });
});
