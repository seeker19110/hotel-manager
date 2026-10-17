// Dịch vụ giả cho E2E portal (không cần Docker/SeaweedFS/ClamAV): S3 trong bộ nhớ (PUT/GET/DELETE, bỏ qua chữ ký) và clamd
// giả (giao thức INSTREAM, luôn trả sạch trừ chuỗi EICAR). Chỉ chạy trong tiến trình E2E, cổng ngẫu nhiên ở 127.0.0.1.
import { createServer as httpServer, type Server } from "node:http";
import { createServer as tcpServer } from "node:net";

export interface Fake {
  port: number;
  server: Server | ReturnType<typeof tcpServer>;
}

export async function startFakeS3(): Promise<Fake> {
  const store = new Map<string, Buffer>();
  const server = httpServer((req, res) => {
    const key = (req.url ?? "").split("?")[0] as string;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        // PUT bucket (không có khoá con) hoặc object.
        if (key.split("/").filter(Boolean).length > 1) store.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const v = store.get(key);
        if (!v) res.writeHead(404).end();
        else res.writeHead(200, { "content-type": "application/octet-stream" }).end(v);
      } else if (req.method === "DELETE") {
        store.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, server };
}

const EICAR = Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");

export async function startFakeClamd(): Promise<Fake> {
  const server = tcpServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const header = "zINSTREAM\0";
      if (buf.length < header.length) return;
      let at = header.length;
      const body: Buffer[] = [];
      for (;;) {
        if (buf.length < at + 4) return;
        const n = buf.readUInt32BE(at);
        at += 4;
        if (n === 0) break;
        if (buf.length < at + n) return;
        body.push(buf.subarray(at, at + n));
        at += n;
      }
      const dirty = Buffer.concat(body).includes(EICAR);
      socket.end(dirty ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, server };
}
