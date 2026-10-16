// Adapter quét mã độc ClamAV tự host qua clamd (D-003; SPEC-housekeeping-maintenance Q-10, S-015).
// Giao thức (docs.clamav.net, xác minh 2026-10-16): TCP (mặc định 3310, không xác thực — chỉ cho mạng nội bộ). Gửi lệnh
// `zINSTREAM\0`, rồi các chunk `<độ dài 4 byte big-endian><dữ liệu>`, kết thúc bằng chunk độ dài 0. Phản hồi kết thúc bằng NUL:
// `stream: OK` (sạch) · `stream: <tên> FOUND` (nhiễm) · `INSTREAM size limit exceeded. ERROR` (quá StreamMaxLength, mặc định
// 100M) · `... ERROR` (lỗi khác). `zPING\0` → `PONG`.
// Fail-closed: mọi trường hợp KHÔNG có kết luận "sạch"/"nhiễm" rõ ràng (không kết nối, quá hạn, đứt kết nối giữa chừng,
// ERROR, size limit, phản hồi lạ) → ném `ScanUnavailableError`; file không bao giờ sang `ready`.
import { connect, type Socket } from "node:net";
import { type MalwareScanner, ScanUnavailableError } from "./inspect.ts";

export const DEFAULT_CLAMD_PORT = 3310;
export const DEFAULT_CLAMD_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_CLAMD_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_CLAMD_TIMEOUT_MS = 30_000;
/** Phản hồi hợp lệ của clamd rất ngắn; vượt mức này coi là lạ (chống nhồi bộ nhớ). */
const MAX_REPLY_BYTES = 4096;

export interface ClamdOptions {
  host: string;
  port?: number;
  /** Cỡ chunk khi gửi (byte), 1…2^31-1; mặc định 64 KiB. */
  chunkBytes?: number;
  /** Hạn để kết nối TCP (ms). */
  connectTimeoutMs?: number;
  /** Hạn TỔNG cho cả lượt quét, tính từ lúc bắt đầu (ms). */
  timeoutMs?: number;
  /** Chỗ nối socket — chỉ để test (vd. socket không bao giờ nối được). */
  connect?: (opts: { host: string; port: number }) => Socket;
}

function positive(name: string, v: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`${name} phải là số nguyên 1…${max}`);
  return v;
}

/** Khung chunk INSTREAM: độ dài 4 byte big-endian + dữ liệu. */
export function instreamFrame(data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.byteLength, 0);
  return Buffer.concat([head, data]);
}

/** Phân tích phản hồi `zINSTREAM` đã bỏ NUL. */
export function parseInstreamReply(reply: string): { clean: true } | { clean: false; reason: string } {
  const text = reply.replace(/\0+$/, "").trim();
  if (/size limit exceeded/i.test(text))
    throw new ScanUnavailableError(`clamd: file vượt giới hạn quét của máy quét (${text})`);
  if (/ERROR$/.test(text)) throw new ScanUnavailableError(`clamd báo lỗi: ${text}`);
  if (text === "stream: OK") return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { clean: false, reason: found[1] as string };
  throw new ScanUnavailableError(`clamd trả phản hồi không hiểu: ${text.slice(0, 200)}`);
}

export class ClamdScanner implements MalwareScanner {
  readonly #host: string;
  readonly #port: number;
  readonly #chunk: number;
  readonly #connectTimeout: number;
  readonly #timeout: number;
  readonly #connect: (opts: { host: string; port: number }) => Socket;

  constructor(opts: ClamdOptions) {
    if (!opts.host) throw new RangeError("ClamdScanner cần host");
    this.#host = opts.host;
    this.#port = positive("port", opts.port ?? DEFAULT_CLAMD_PORT, 65535);
    this.#chunk = positive("chunkBytes", opts.chunkBytes ?? DEFAULT_CLAMD_CHUNK_BYTES, 2 ** 31 - 1);
    this.#connectTimeout = positive(
      "connectTimeoutMs",
      opts.connectTimeoutMs ?? DEFAULT_CLAMD_CONNECT_TIMEOUT_MS,
    );
    this.#timeout = positive("timeoutMs", opts.timeoutMs ?? DEFAULT_CLAMD_TIMEOUT_MS);
    this.#connect = opts.connect ?? ((o) => connect(o));
  }

  /** Gửi một lệnh và chờ phản hồi kết thúc NUL; `writer` ghi phần thân sau lệnh (nếu có). */
  #exchange(
    command: string,
    body: (write: (b: Buffer) => Promise<void>, alive: () => boolean) => Promise<void>,
  ) {
    return new Promise<string>((resolve, reject) => {
      const socket = this.#connect({ host: this.#host, port: this.#port });
      let settled = false;
      const received: Buffer[] = [];
      let receivedBytes = 0;

      const done = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as string);
      };
      const connectTimer = setTimeout(
        () => done(new ScanUnavailableError(`clamd: quá ${this.#connectTimeout} ms chưa kết nối được`)),
        this.#connectTimeout,
      );
      const totalTimer = setTimeout(
        () => done(new ScanUnavailableError(`clamd: quá ${this.#timeout} ms chưa có kết quả`)),
        this.#timeout,
      );

      const write = (b: Buffer): Promise<void> =>
        new Promise((res, rej) => {
          if (settled) return res();
          socket.write(b, (e) => (e ? rej(e) : res()));
        });

      socket.on("error", (e) =>
        done(new ScanUnavailableError(`clamd: lỗi kết nối (${e.message})`, { cause: e })),
      );
      socket.on("close", () => done(new ScanUnavailableError("clamd: kết nối đóng trước khi có kết quả")));
      socket.on("data", (d: Buffer) => {
        received.push(d);
        receivedBytes += d.byteLength;
        const all = Buffer.concat(received);
        const nul = all.indexOf(0);
        if (nul >= 0) return done(null, all.subarray(0, nul).toString("utf8"));
        if (receivedBytes > MAX_REPLY_BYTES) done(new ScanUnavailableError("clamd: phản hồi quá dài"));
      });
      socket.on("connect", () => {
        clearTimeout(connectTimer);
        (async () => {
          await write(Buffer.from(`${command}\0`, "latin1"));
          await body(write, () => !settled);
        })().catch((e: Error) => {
          // Server có thể đã trả lời rồi đóng (vd. size limit) khi ta còn đang ghi: để `data`/`close` quyết định kết quả.
          if (!settled) done(new ScanUnavailableError(`clamd: ghi dữ liệu lỗi (${e.message})`, { cause: e }));
        });
      });
    });
  }

  async scan(bytes: Uint8Array): Promise<{ clean: true } | { clean: false; reason: string }> {
    const reply = await this.#exchange("zINSTREAM", async (write, alive) => {
      for (let i = 0; i < bytes.byteLength && alive(); i += this.#chunk) {
        await write(instreamFrame(bytes.subarray(i, Math.min(i + this.#chunk, bytes.byteLength))));
      }
      if (alive()) await write(Buffer.alloc(4)); // chunk độ dài 0 = hết luồng
    });
    return parseInstreamReply(reply);
  }

  /** Kiểm tra clamd còn sống (`zPING` → `PONG`) cho health check. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.#exchange("zPING", async () => {});
      return reply.trim() === "PONG";
    } catch {
      return false;
    }
  }
}
