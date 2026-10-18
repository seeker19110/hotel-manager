// SeaweedFS tạm cho test (ADR-0002, PLAN T-011): binary `weed` từ scripts/dev-env-setup.sh; cổng ngẫu nhiên,
// khoá truy cập chỉ cho test; xoá dữ liệu khi dừng.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Cổng trống do hệ điều hành cấp, giữ mở đồng thời để `n` cổng khác nhau. weed mặc định đặt cổng gRPC = cổng HTTP +
 * 10000 mà không ai kiểm cổng đó còn trống — nó hay rơi vào dải cổng tạm của kết nối ra (32768–60999) và đã làm
 * `weed` thoát ngay ("master failed to listen on grpc port … address already in use") — nên mọi cổng gRPC cũng
 * khai tường minh từ đây.
 */
export async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => createServer());
  try {
    return await Promise.all(
      servers.map(
        (s) =>
          new Promise<number>((resolve, reject) => {
            s.once("error", reject);
            s.listen(0, "127.0.0.1", () => {
              const a = s.address();
              resolve(typeof a === "object" && a ? a.port : 0);
            });
          }),
      ),
    );
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
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
  const [master, volume, filer, s3, masterGrpc, volumeGrpc, filerGrpc, s3Grpc] = await freePorts(8);
  const logFile = join(dir, "weed.log");
  const log = openSync(logFile, "w");
  let proc: ChildProcess;
  try {
    proc = spawn(
      process.env.WEED_BIN || "weed",
      [
        // glog mặc định ghi tệp vào /tmp — để trong `dir` (xoá khi dừng).
        `-logdir=${dir}`,
        "server",
        "-ip=127.0.0.1",
        "-ip.bind=127.0.0.1",
        `-dir=${dir}`,
        `-master.port=${master}`,
        `-master.port.grpc=${masterGrpc}`,
        `-volume.port=${volume}`,
        `-volume.port.grpc=${volumeGrpc}`,
        "-filer",
        `-filer.port=${filer}`,
        `-filer.port.grpc=${filerGrpc}`,
        "-s3",
        `-s3.port=${s3}`,
        `-s3.port.grpc=${s3Grpc}`,
        `-s3.config=${join(dir, "s3.json")}`,
        // Tắt dịch vụ phụ có cổng mặc định CỐ ĐỊNH (Iceberg 8181, Lance 9101 từ SeaweedFS 4.x): hai lượt test song song
        // (hoặc một `weed` mồ côi) giữ cổng đó làm `weed` mới thoát ngay ⇒ "SeaweedFS không khởi động được".
        "-s3.port.iceberg=0",
        "-s3.port.lance=0",
        // Socket Unix HTTP của filer/s3 mặc định là /tmp/seaweedfs-<dịch vụ>-<cổng>.sock, sót lại mỗi lần `weed` bị kill —
        // để trong `dir`. Socket gRPC (/tmp/seaweedfs-*-grpc-<cổng>.sock) viết cứng trong binary, không dời được (vô hại).
        `-filer.localSocket=${join(dir, "filer.sock")}`,
        `-s3.localSocket=${join(dir, "s3.sock")}`,
        // Test không gửi thống kê ra ngoài (mặc định bật, gửi tới telemetry.seaweedfs.com).
        "-master.telemetry=false",
      ],
      { stdio: ["ignore", log, log] },
    );
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    closeSync(log);
  }
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
  if (exited) {
    // Ưu tiên dòng lỗi của glog (F…/E…) và lỗi parse cờ (in đầu bảng usage); không có thì lấy đuôi log.
    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    const errs = lines.filter((l) => /^[FE]\d{4} |invalid value|flag provided but not defined/.test(l));
    const tail = (errs.length > 0 ? errs : lines).slice(-15).join("\n");
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `SeaweedFS không khởi động được — chạy \`bash scripts/dev-env-setup.sh --only weed\` (PLAN T-001). Log weed:\n${tail}`,
    );
  }
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
