// PLAN đợt 4 T-305 — OpenAPI 3.1 sinh từ registry: file đã commit khớp nguồn; mọi route có trong spec hoặc có lý do ngoại lệ.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApi, ROUTE_COVERAGE, renderOpenApi } from "./openapi.ts";
import { COMMANDS, findCommand, findQuery, QUERIES } from "./registry.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const API_DIR = join(ROOT, "apps/web/app/api");

type Op = {
  operationId: string;
  security?: unknown[];
  parameters?: { name?: string; $ref?: string }[];
  responses: Record<string, unknown>;
};
const spec = buildOpenApi() as {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, Op>>;
  components: { responses: Record<string, unknown>; schemas: Record<string, unknown> };
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [relative(API_DIR, p)] : [];
  });
}

describe("openapi — file sinh ra khớp nguồn (STD-API-001)", () => {
  it("apps/web/openapi.json đã commit == sinh lại từ registry (so theo nội dung JSON; chạy `pnpm openapi` nếu đỏ)", () => {
    const committed = JSON.parse(readFileSync(join(ROOT, "apps/web/openapi.json"), "utf8"));
    // Không toEqual trực tiếp trên cây 150 path: đỏ thì in ra đường dẫn đầu tiên lệch thay vì hàng nghìn dòng diff.
    const fresh = JSON.parse(renderOpenApi());
    const drift = Object.keys({ ...committed.paths, ...fresh.paths }).filter(
      (p) => JSON.stringify(committed.paths[p]) !== JSON.stringify(fresh.paths[p]),
    );
    expect(drift).toEqual([]);
    expect(JSON.stringify(committed) === JSON.stringify(fresh)).toBe(true);
  });

  it("là OpenAPI 3.1, JSON hợp lệ, sinh lại hai lần ra cùng một chuỗi (xác định)", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(renderOpenApi()).toBe(renderOpenApi());
    expect(JSON.parse(renderOpenApi())).toEqual(JSON.parse(JSON.stringify(spec)));
  });
});

describe("openapi — mỗi command/query một thao tác đúng URL route thật dùng", () => {
  it("mọi COMMANDS là POST, có Idempotency-Key bắt buộc, body = schema; URL tra lại được bằng findCommand", () => {
    for (const name of Object.keys(COMMANDS)) {
      const [m, c] = name.split(".") as [string, string];
      const op = spec.paths[`/api/v1/${m}/${c}`]?.post;
      expect(op, name).toBeDefined();
      expect(op?.operationId).toBe(name);
      expect(
        op?.parameters?.some((p) => p.$ref?.endsWith("/IdempotencyKey")),
        name,
      ).toBe(true);
      expect(op?.responses["2XX"], name).toBeDefined();
      expect(findCommand(m, c), `route động không phục vụ ${name}`).toBe(COMMANDS[name]);
    }
  });

  it("mọi QUERIES là GET, tham số lấy từ schema, không có thân; URL tra lại được bằng findQuery", () => {
    for (const name of Object.keys(QUERIES)) {
      const [m, q] = name.split(".") as [string, string];
      const op = spec.paths[`/api/v1/${m}/${q}`]?.get;
      expect(op, name).toBeDefined();
      expect(op).not.toHaveProperty("requestBody");
      expect(findQuery(m, q), `route động không phục vụ ${name}`).toBe(QUERIES[name]);
    }
  });

  it("operationId duy nhất; thao tác nào cũng khai security (rỗng = công khai có chủ ý) và có lỗi problem+json chuẩn", () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries(spec.paths))
      for (const [method, op] of Object.entries(item)) {
        ids.push(op.operationId);
        expect(Array.isArray(op.security), `${method} ${path}`).toBe(true);
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(1);
      }
    expect(new Set(ids).size).toBe(ids.length);
    // Mọi $ref response lỗi đều có định nghĩa; lỗi dùng schema Problem.
    const refs = JSON.stringify(spec.paths).match(/#\/components\/responses\/(\w+)/g) ?? [];
    for (const r of new Set(refs))
      expect(spec.components.responses[r.split("/").pop() as string], r).toBeDefined();
    expect(spec.components.schemas.Problem).toBeDefined();
    expect(JSON.stringify(spec.components.responses)).toContain("application/problem+json");
  });

  it("SPEC-access S-007: member.acceptInvitation khai 410 INVITATION_INVALID (và 429 của hạn mức); org.create khai 429 (hạn mức theo người dùng)", () => {
    const accept = spec.paths["/api/v1/member/acceptInvitation"]?.post;
    expect(JSON.stringify(accept?.responses["410"])).toContain("INVITATION_INVALID");
    expect(accept?.responses["429"]).toBeDefined();
    expect(spec.paths["/api/v1/org/create"]?.post?.responses["429"]).toBeDefined();
  });

  it("BE-API-008 (D-034, D-043): mọi thao tác có Idempotency-Key khai 409 (đang xử lý) và 422 (cùng key khác payload), mô tả khớp 422 và không còn hứa 409; upload/webhook khai 429", () => {
    const withKey: string[] = [];
    for (const [path, item] of Object.entries(spec.paths))
      for (const [method, op] of Object.entries(item))
        if (op.parameters?.some((p) => p.$ref?.endsWith("/IdempotencyKey"))) {
          withKey.push(`${method} ${path}`);
          expect(op.responses["422"], `${method} ${path} thiếu 422`).toBeDefined();
          expect(op.responses["409"], `${method} ${path} thiếu 409 (IDEMPOTENCY_IN_PROGRESS)`).toBeDefined();
        }
    expect(withKey.length).toBeGreaterThan(10);
    const text = JSON.stringify(spec);
    expect(text).toContain("khác payload → 422 IDEMPOTENCY_CONFLICT");
    expect(text).not.toMatch(/409 IDEMPOTENCY_CONFLICT/);
    expect(JSON.stringify(spec.components.responses.Error422)).toContain("IDEMPOTENCY_CONFLICT");
    // D-043: 409 IDEMPOTENCY_IN_PROGRESS (lần đầu còn đang xử lý) + Retry-After; vẫn không hứa 409 cho khác payload.
    expect(JSON.stringify(spec.components.responses.Error409)).toContain("IDEMPOTENCY_IN_PROGRESS");
    expect(JSON.stringify(spec.components.responses.Error409)).toContain("Retry-After");
    expect(JSON.stringify(spec.components.responses.Error409)).not.toContain("IDEMPOTENCY_CONFLICT");
    for (const [path, m] of [
      ["/api/v1/files/upload", "post"],
      ["/api/v1/import/upload", "post"],
      ["/api/v1/webhooks/{provider}/{account}", "post"],
    ] as const)
      expect(spec.paths[path]?.[m]?.responses["429"], path).toBeDefined();
  });

  it("ca biên: schema rỗng (strictObject({})) vẫn ra body object; tham số tuỳ chọn không bị đánh required", () => {
    const empty = spec.paths["/api/v1/exports/requestOrgExport"]?.post as unknown as {
      requestBody: { content: { "application/json": { schema: { type: string } } } };
    };
    expect(empty.requestBody.content["application/json"].schema.type).toBe("object");
    const q = spec.paths["/api/v1/payment/getTransferInfo"]?.get as unknown as {
      parameters: { name: string; required: boolean }[];
    };
    expect(q.parameters.find((p) => p.name === "invoice_id")?.required).toBe(true);
    expect(q.parameters.find((p) => p.name === "receiving_account_id")?.required).toBe(false);
  });
});

describe("openapi — mọi route.ts có trong spec hoặc trong danh sách ngoại lệ có lý do (BE-API-009)", () => {
  const files = routeFiles(API_DIR).sort();

  it("tìm thấy route (bảo đảm quét không rỗng)", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it("mọi app/api/**/route.ts có trong ROUTE_COVERAGE (route mới chưa khai → đỏ)", () => {
    expect(files.filter((f) => !(f in ROUTE_COVERAGE))).toEqual([]);
  });

  it("ROUTE_COVERAGE không có mục mồ côi (file đã xoá/đổi tên)", () => {
    expect(Object.keys(ROUTE_COVERAGE).filter((k) => !files.includes(k))).toEqual([]);
  });

  it("route khai `spec` thì path có thật trong tài liệu; ngoại lệ phải nêu lý do cụ thể", () => {
    for (const [file, c] of Object.entries(ROUTE_COVERAGE)) {
      if ("spec" in c) {
        if (c.spec.startsWith("/")) expect(spec.paths[c.spec], file).toBeDefined();
      } else expect(c.exception.trim().length, file).toBeGreaterThanOrEqual(20);
    }
  });

  it("route /api/v1/** (trừ ngoại lệ) đều thuộc hợp đồng công khai: không route v1 nào nằm trong danh sách ngoại lệ", () => {
    expect(
      Object.entries(ROUTE_COVERAGE).filter(([f, c]) => f.startsWith("v1/") && "exception" in c),
    ).toEqual([]);
  });
});
