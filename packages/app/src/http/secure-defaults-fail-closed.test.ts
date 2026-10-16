// BASE-ERR-010 — lỗi ở cổng bảo mật (xác thực, phân quyền, validate, chữ ký) thất bại ĐÓNG: từ chối, không bao giờ 2xx.
// Không cần CSDL: mọi nhánh dưới đây dừng trước khi chạm dữ liệu. Danh sách fail-open ở THREAT-MODEL §5b (hiện: không có).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REPO_ROOT } from "../testing/source-scan.ts";
import {
  type CommandDef,
  type HttpDeps,
  handleCommand,
  handleCommandStatus,
  handleQuery,
  type QueryDef,
} from "./command-route.ts";

// Chạm vào CSDL = ném đồng bộ (không tạo lời hứa bị từ chối mà không ai await).
const NEVER_DB = new Proxy(
  {},
  {
    get: () => {
      throw new Error("không được chạm CSDL");
    },
  },
) as never;

const base = (
  getSession: HttpDeps["getSession"],
  onUnexpectedError?: HttpDeps["onUnexpectedError"],
): HttpDeps => ({
  db: NEVER_DB,
  getSession,
  secureCookies: true,
  services: {} as never,
  ...(onUnexpectedError ? { onUnexpectedError } : {}),
});

const CMD: CommandDef<unknown, never> = {
  command: "test.cmd",
  input: z.unknown(),
  run: async () => {
    throw new Error("không được chạy");
  },
};
const QRY: QueryDef<unknown, never> = {
  query: "test.qry",
  input: z.unknown(),
  run: async () => {
    throw new Error("không được chạy");
  },
};
const post = () =>
  new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
const get = () => new Request("http://local.test/api/v1/x/y");

describe("backend xác thực (getSession) ném lỗi → không bao giờ 2xx", () => {
  const boom = async () => {
    throw new Error("Better Auth: kết nối CSDL phiên thất bại");
  };

  it.each([
    ["POST command", (d: HttpDeps) => handleCommand(CMD, post(), d)],
    ["GET query", (d: HttpDeps) => handleQuery(QRY, get(), d)],
    [
      "GET trạng thái command",
      (d: HttpDeps) => handleCommandStatus("0b0e5e6c-6a3f-4f7e-9a58-2f6d3b0b9a11", get(), d),
    ],
  ])("%s → 500 (đóng), không lộ chi tiết, onUnexpectedError được gọi", async (_n, call) => {
    const seen: string[] = [];
    const res = await call(base(boom, (_e, c) => seen.push(c)));
    expect(res.status).toBe(500);
    expect(res.status).not.toBeLessThan(400);
    const text = await res.text();
    expect(text).not.toContain("Better Auth");
    expect(JSON.parse(text)).toMatchObject({ code: "INTERNAL" });
    expect(seen).toHaveLength(1);
  });

  it("getSession trả null (không phiên) → 401 cho cả ba, không chạm CSDL", async () => {
    const none = base(async () => null);
    for (const res of [
      await handleCommand(CMD, post(), none),
      await handleQuery(QRY, get(), none),
      await handleCommandStatus("0b0e5e6c-6a3f-4f7e-9a58-2f6d3b0b9a11", get(), none),
    ]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("UNAUTHENTICATED");
    }
  });

  it("phiên trả về nhưng tra membership lỗi (CSDL hỏng) → 500, không cho qua như đã xác thực", async () => {
    const res = await handleQuery(
      QRY,
      new Request("http://local.test/x", { headers: { "x-org-id": "0b0e5e6c-6a3f-4f7e-9a58-2f6d3b0b9a11" } }),
      base(async () => ({ user: { id: "0b0e5e6c-6a3f-4f7e-9a58-2f6d3b0b9a12" } })),
    );
    expect(res.status).toBe(500);
  });
});

describe("điểm fail-open được khai báo", () => {
  it("THREAT-MODEL có mục «Điểm fail-open» và nêu test này", () => {
    const tm = readFileSync(`${REPO_ROOT}docs/design/THREAT-MODEL.md`, "utf8");
    expect(tm).toMatch(/^## 5b\. Điểm fail-open/m);
    expect(tm).toContain("secure-defaults-fail-closed.test.ts");
  });
});
