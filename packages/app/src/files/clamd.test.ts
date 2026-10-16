// T-203 (D-003) — contract test adapter clamd với clamd giả chạy giao thức INSTREAM thật trên TCP cục bộ:
// khung `zINSTREAM\0` + khúc độ dài 4 byte big-endian + khúc 0; trả `stream: OK` / `… FOUND` / `… ERROR`.
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { clamdScanner, parseClamdReply, ScannerUnavailableError } from "./clamd.ts";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

type Mode = "real" | "error" | "hang" | "close" | "garbage" | "size-limit";

/** clamd giả: đọc đúng khung INSTREAM, ghi lại dữ liệu nhận được; `streamMax` mô phỏng StreamMaxLength. */
async function fakeClamd(mode: Mode, streamMax = 1024 * 1024) {
  const received: Buffer[] = [];
  const commands: string[] = [];
  const server: Server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let gotCommand = false;
    let total = 0;
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!gotCommand) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        commands.push(buf.subarray(0, z).toString());
        buf = buf.subarray(z + 1);
        gotCommand = true;
        if (mode === "close") return sock.destroy();
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const all = Buffer.concat(received);
          if (mode === "hang") return;
          if (mode === "error") return sock.end("Something went wrong ERROR\0");
          if (mode === "garbage") return sock.end("xin chào\0");
          return sock.end(
            all.toString("latin1").includes(EICAR) ? "stream: Eicar-Signature FOUND\0" : "stream: OK\0",
          );
        }
        if (mode === "size-limit" && total + len > streamMax) {
          return sock.end("INSTREAM size limit exceeded. ERROR\0");
        }
        if (buf.length < 4 + len) return;
        received.push(Buffer.from(buf.subarray(4, 4 + len)));
        total += len;
        buf = buf.subarray(4 + len);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  servers.push(server);
  return { port, received, commands };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

describe("clamdScanner — giao thức INSTREAM", () => {
  it("file sạch → clean; gửi đúng lệnh zINSTREAM và đủ dữ liệu qua nhiều khúc", async () => {
    const c = await fakeClamd("real");
    const data = Buffer.alloc(200_000, 7);
    const r = await clamdScanner({ host: "127.0.0.1", port: c.port, chunkBytes: 65_536 }).scan(data);
    expect(r).toEqual({ clean: true });
    expect(c.commands).toEqual(["zINSTREAM"]);
    expect(c.received.length).toBe(4);
    expect(Buffer.concat(c.received).equals(data)).toBe(true);
  });

  it("EICAR → nhiễm, giữ tên chữ ký", async () => {
    const c = await fakeClamd("real");
    const r = await clamdScanner({ host: "127.0.0.1", port: c.port }).scan(Buffer.from(EICAR, "latin1"));
    expect(r).toEqual({ clean: false, reason: "Eicar-Signature" });
  });

  it.each([
    ["clamd báo ERROR", "error"],
    ["vượt StreamMaxLength", "size-limit"],
    ["đóng kết nối giữa chừng", "close"],
    ["trả lời lạ", "garbage"],
  ] as const)("%s → ScannerUnavailableError (không bao giờ coi là sạch)", async (_n, mode) => {
    const c = await fakeClamd(mode, 1000);
    await expect(
      clamdScanner({ host: "127.0.0.1", port: c.port }).scan(Buffer.alloc(5000, 1)),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it("clamd không trả lời → quá hạn → ScannerUnavailableError", async () => {
    const c = await fakeClamd("hang");
    await expect(
      clamdScanner({ host: "127.0.0.1", port: c.port, timeoutMs: 200 }).scan(Buffer.from("abc")),
    ).rejects.toThrow(/quá hạn/);
  });

  it("không kết nối được (cổng đóng) → ScannerUnavailableError", async () => {
    const c = await fakeClamd("real");
    await new Promise((r) => (servers.pop() as Server).close(r));
    await expect(
      clamdScanner({ host: "127.0.0.1", port: c.port }).scan(Buffer.from("abc")),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it("file vượt maxBytes → từ chối trước khi gửi", async () => {
    await expect(
      clamdScanner({ host: "127.0.0.1", port: 1, maxBytes: 10 }).scan(Buffer.alloc(11)),
    ).rejects.toThrow(/giới hạn/);
  });
});

describe("parseClamdReply", () => {
  it("tên chữ ký lạ (ký tự không an toàn) → thay bằng MALWARE trước khi ghi CSDL", () => {
    expect(parseClamdReply("stream: <script>alert(1)</script> FOUND")).toEqual({
      clean: false,
      reason: "MALWARE",
    });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      clean: false,
      reason: "Win.Test.EICAR_HDB-1",
    });
  });
});
