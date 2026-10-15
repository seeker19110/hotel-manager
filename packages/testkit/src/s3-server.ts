// SeaweedFS tạm cho test (ADR-0002, PLAN T-011): binary `weed` từ scripts/dev-env-setup.sh; cổng ngẫu nhiên,
// khoá truy cập chỉ cho test; xoá dữ liệu khi dừng.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface S3TestConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Server {
  config: S3TestConfig;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

/** weed dùng cổng gRPC = cổng HTTP + 10000 — chọn cổng sao cho cả hai còn trống. */
async function portPair(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    if (p + 10000 < 65535) return p;
  }
  throw new Error("không tìm được cổng trống cho SeaweedFS");
}

export async function startS3Server(): Promise<S3Server> {
  const dir = mkdtempSync(join(tmpdir(), "hm-weed-"));
  const config: S3TestConfig = {
    endpoint: "",
    region: "vn-local",
    bucket: "hm-test",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-only-secret-key-not-real",
  };
  writeFileSync(
    join(dir, "s3.json"),
    JSON.stringify({
      identities: [
        {
          name: "test",
          credentials: [{ accessKey: config.accessKeyId, secretKey: config.secretAccessKey }],
          actions: ["Admin", "Read", "Write", "List", "Tagging"],
        },
      ],
    }),
  );
  const [master, volume, filer, s3] = [
    await portPair(),
    await portPair(),
    await portPair(),
    await portPair(),
  ];
  const proc: ChildProcess = spawn(
    process.env.WEED_BIN ?? "weed",
    [
      "server",
      "-ip=127.0.0.1",
      "-ip.bind=127.0.0.1",
      `-dir=${dir}`,
      `-master.port=${master}`,
      `-volume.port=${volume}`,
      "-filer",
      `-filer.port=${filer}`,
      "-s3",
      `-s3.port=${s3}`,
      `-s3.config=${join(dir, "s3.json")}`,
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  proc.once("error", () => {
    exited = true;
  });
  config.endpoint = `http://127.0.0.1:${s3}`;
  // Chờ S3 trả lời (403 cho request không ký = đã sẵn sàng).
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const r = await fetch(`${config.endpoint}/`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 403 || r.ok) break;
    } catch {
      // chưa lên
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (exited)
    throw new Error(
      "SeaweedFS không khởi động được — chạy `bash scripts/dev-env-setup.sh --only weed` (PLAN T-001)",
    );
  return {
    config,
    async stop() {
      if (!exited) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 300));
        if (!exited) proc.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
