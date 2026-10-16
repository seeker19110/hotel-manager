// Máy quét mã độc tự host qua clamd (ClamAV) — D-003. Giao thức INSTREAM (docs.clamav.net/manual/Usage/ClamdProtocol,
// xác minh 2026-10-16): gửi `zINSTREAM\0`, rồi từng khúc = độ dài 4 byte big-endian + dữ liệu, kết thúc bằng khúc độ dài 0;
// clamd trả `stream: OK\0` | `stream: <tên> FOUND\0` | `<lý do> ERROR\0`. Không xác thực/TLS → chỉ nối qua mạng nội bộ.
// Mọi lỗi (kết nối, quá hạn, ERROR, trả lời lạ) → ScannerUnavailableError: file KHÔNG bao giờ được coi là sạch.

import { connect, type Socket } from "node:net";
import { kibToBytes, mibToBytes } from "@hm/domain";
import type { MalwareScanner } from "./inspect.ts";

export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerUnavailableError";
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  /** Tổng thời gian một lần quét (kết nối + gửi + chờ kết quả). */
  timeoutMs?: number;
  /** Phải ≤ StreamMaxLength của clamd (mặc định clamd 100M); file app đã ≤ 10 MB. */
  maxBytes?: number;
  chunkBytes?: number;
}

const DEFAULTS = { timeoutMs: 30_000, maxBytes: mibToBytes(25), chunkBytes: kibToBytes(64) };
/** Tên chữ ký chỉ giữ ký tự an toàn trước khi ghi CSDL/audit. */
const SAFE_NAME = /^[A-Za-z0-9._:\-/]{1,120}$/;

export function parseClamdReply(raw: string): { clean: true } | { clean: false; reason: string } {
  const reply = raw.replace(/[\0\n]+$/, "").trim();
  if (reply === "stream: OK") return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) {
    const name = found[1] as string;
    return { clean: false, reason: SAFE_NAME.test(name) ? name : "MALWARE" };
  }
  throw new ScannerUnavailableError(
    reply.endsWith("ERROR") ? "clamd báo lỗi khi quét" : "clamd trả lời không nhận dạng được",
  );
}

export function clamdScanner(opts: ClamdOptions): MalwareScanner {
  const o = { ...DEFAULTS, ...opts };
  return {
    scan(bytes) {
      if (bytes.byteLength > o.maxBytes) {
        return Promise.reject(new ScannerUnavailableError("file vượt giới hạn quét"));
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        let reply = "";
        const finish = (err: Error | null, value?: { clean: true } | { clean: false; reason: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (err) reject(err);
          else resolve(value as { clean: true });
        };
        const socket: Socket = connect({ host: o.host, port: o.port });
        const timer = setTimeout(() => finish(new ScannerUnavailableError("clamd quá hạn")), o.timeoutMs);
        socket.on("error", () => finish(new ScannerUnavailableError("không kết nối được clamd")));
        socket.on("data", (d: Buffer) => {
          reply += d.toString("latin1");
          if (reply.length > 4096) finish(new ScannerUnavailableError("clamd trả lời quá dài"));
          else if (reply.includes("\0")) {
            try {
              finish(null, parseClamdReply(reply.slice(0, reply.indexOf("\0"))));
            } catch (e) {
              finish(e as Error);
            }
          }
        });
        socket.on("end", () => {
          if (settled) return;
          try {
            finish(null, parseClamdReply(reply));
          } catch (e) {
            finish(e as Error);
          }
        });
        socket.on("connect", () => {
          socket.write("zINSTREAM\0");
          const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let off = 0; off < buf.length; off += o.chunkBytes) {
            const chunk = buf.subarray(off, Math.min(off + o.chunkBytes, buf.length));
            const len = Buffer.alloc(4);
            len.writeUInt32BE(chunk.length, 0);
            socket.write(len);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4)); // khúc độ dài 0 = hết dữ liệu
        });
      });
    },
  };
}
