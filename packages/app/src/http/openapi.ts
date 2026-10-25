// OpenAPI 3.1 sinh từ nguồn sự thật `http/registry.ts` (STD-API-001, BE-API-001/009, QA-INT-007, BASE-DOC-007).
// - Mỗi command (POST) và query (GET) trong COMMANDS/QUERIES là một path `/api/v1/<module>/<name>` đúng như route động
//   `app/api/v1/[module]/[command]` phục vụ; đầu vào = schema Zod (`z.toJSONSchema`, phía đầu vào).
// - Route riêng (không đi qua registry) khai ở `EXTRA_PATHS`; route không đưa vào spec phải có lý do ở `ROUTE_COVERAGE`.
// - `pnpm openapi` ghi `apps/web/openapi.json`; `openapi.test.ts` đòi file đã commit == sinh lại và mọi route có mặt.
// `info.version` là phiên bản HỢP ĐỒNG API (`/v1`), không phải phiên bản sản phẩm — đổi khi hợp đồng đổi (breaking → /v2).
import { z } from "zod";
import { ERROR_CODES } from "../errors.ts";
import { IMPORT_KINDS } from "../import/index.ts";
import { CONSENT_CHANNELS, CONSENT_PURPOSES } from "../privacy/index.ts";
import { COMMANDS, QUERIES, USER_COMMANDS } from "./registry.ts";
import { simPayload } from "./webhook-route.ts";

export const API_CONTRACT_VERSION = "1.0.0";

type Json = Record<string, unknown>;

const PROBLEM = "#/components/schemas/Problem";
const problemContent = { "application/problem+json": { schema: { $ref: PROBLEM } } };
const errorResponse = (description: string) => ({ description, content: problemContent });

/** Mã HTTP lỗi chuẩn cho mọi thao tác (body luôn là problem+json, RFC 9457). */
const ERROR_RESPONSES: Record<string, Json> = {
  "400": errorResponse("MALFORMED_REQUEST — thân không phải JSON hợp lệ hoặc thiếu/sai Idempotency-Key"),
  "401": errorResponse("UNAUTHENTICATED (cần đăng nhập) hoặc REAUTH_REQUIRED (cần xác thực lại)"),
  "403": errorResponse("FORBIDDEN — có membership nhưng không đủ quyền/hạn mức"),
  "404": errorResponse("NOT_FOUND — không tồn tại hoặc thuộc tổ chức/cơ sở khác (không phân biệt)"),
  "409": {
    description:
      "Xung đột trạng thái/ngữ cảnh (ORG_CONTEXT_REQUIRED, CONTEXT_CHANGED…); hoặc IDEMPOTENCY_IN_PROGRESS (cùng Idempotency-Key, lần đầu còn đang xử lý chưa commit, D-043) kèm `Retry-After` — đợi rồi tra GET /api/v1/commands/{id}, không gửi payload mới",
    headers: {
      "Retry-After": {
        schema: { type: "integer", minimum: 1 },
        description: "Giây nên đợi — chỉ có với IDEMPOTENCY_IN_PROGRESS",
      },
    },
    content: problemContent,
  },
  "422": errorResponse(
    "VALIDATION_FAILED — kèm `errors[]` theo trường; hoặc IDEMPOTENCY_CONFLICT (cùng Idempotency-Key khác payload, D-034)",
  ),
  "426": errorResponse(
    "CLIENT_OUTDATED — `X-App-Version` thấp hơn mức tối thiểu; không ghi gì, client cần cập nhật (SPEC-pwa S-009)",
  ),
  "429": {
    description: "RATE_LIMITED — vượt giới hạn tần suất",
    headers: { "Retry-After": { schema: { type: "integer", minimum: 0 }, description: "Giây nên đợi" } },
    content: problemContent,
  },
  "500": errorResponse("INTERNAL — chỉ trả correlation_id, không trả chi tiết"),
};
/** Tham chiếu tới `components.responses` (tránh lặp lại hàng trăm lần). */
const pick = (...codes: string[]) =>
  Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/responses/Error${c}` }]));

const ref = (name: string) => ({ $ref: `#/components/parameters/${name}` });

const FORMATS_WITH_PATTERN = new Set(["uuid", "email", "date", "date-time"]);

/** Zod kèm regex dài cho các `format` chuẩn (uuid, email, date…): bỏ `pattern` thừa — `format` đã đủ nghĩa, file nhỏ đi nhiều. */
function dropRedundantPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropRedundantPatterns);
  if (node === null || typeof node !== "object") return node;
  const o = node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "pattern" && typeof o.format === "string" && FORMATS_WITH_PATTERN.has(o.format)) continue;
    out[k] = dropRedundantPatterns(v);
  }
  return out;
}

/** Schema Zod → JSON Schema 2020-12 (OpenAPI 3.1 dùng cùng dialect), bỏ `$schema`. */
function schemaOf(input: z.ZodType): Json {
  const { $schema: _omit, ...rest } = z.toJSONSchema(input, { io: "input", target: "draft-2020-12" }) as Json;
  return dropRedundantPatterns(rest) as Json;
}

const commandSuccess = (data: Json | true = true) => ({
  description:
    "Đã commit (HTTP 200, hoặc 201/202 tuỳ lệnh); gửi lại cùng Idempotency-Key trả đúng kết quả này",
  headers: correlationHeader(),
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["command_id", "status", "data"],
        properties: {
          command_id: { type: "string", format: "uuid" },
          status: { const: "committed" },
          data,
        },
      },
    },
  },
});

function correlationHeader(): Json {
  return {
    "X-Correlation-Id": { schema: { type: "string" }, description: "Mã tra cứu xuyên log/audit" },
  };
}

/** Phản hồi riêng của từng lệnh ngoài bộ chung (vd. chấp nhận lời mời: mọi lý do không hợp lệ đều trả cùng 410, không lộ trạng thái). */
const COMMAND_EXTRA_RESPONSES: Record<string, Json> = {
  "member.acceptInvitation": {
    "410": errorResponse("INVITATION_INVALID — lời mời không còn hiệu lực (không phân biệt lý do)"),
  },
};

/** `userScope` = lệnh cấp người dùng (cần phiên, KHÔNG nhận ngữ cảnh tổ chức — `USER_COMMANDS`). */
function commandOperation(name: string, input: z.ZodType, userScope = false): Json {
  const module = name.split(".")[0] as string;
  return {
    operationId: name,
    tags: [module],
    summary: userScope ? `${name} (cấp người dùng — không cần ngữ cảnh tổ chức)` : name,
    security: [{ sessionCookie: [] }],
    parameters: userScope
      ? [ref("IdempotencyKey"), ref("AppVersion")]
      : [ref("IdempotencyKey"), ref("OrgId"), ref("OrgContext"), ref("AppVersion")],
    requestBody: { required: true, content: { "application/json": { schema: schemaOf(input) } } },
    responses: {
      "2XX": commandSuccess(),
      ...pick("400", "401", "403", "404", "409", "422", "426", "429", "500"),
      ...(COMMAND_EXTRA_RESPONSES[name] ?? {}),
    },
  };
}

function queryOperation(name: string, input: z.ZodType): Json {
  const module = name.split(".")[0] as string;
  const schema = schemaOf(input) as { properties?: Record<string, Json>; required?: string[] };
  const required = new Set(schema.required ?? []);
  const params = Object.entries(schema.properties ?? {}).map(([p, s]) => ({
    name: p,
    in: "query",
    required: required.has(p),
    schema: s,
  }));
  return {
    operationId: name,
    tags: [module],
    summary: name,
    security: [{ sessionCookie: [] }],
    parameters: [...params, ref("OrgId"), ref("OrgContext")],
    responses: {
      "200": {
        description: "Kết quả truy vấn",
        headers: correlationHeader(),
        content: {
          "application/json": {
            schema: { type: "object", required: ["data"], properties: { data: {} } },
          },
        },
      },
      ...pick("401", "403", "404", "409", "422", "429", "500"),
    },
  };
}

const uuidSchema = { type: "string", format: "uuid" };

/** Route riêng không đi qua registry — mô tả tay theo mã route thật (đọc `apps/web/app/api/**`). */
const EXTRA_PATHS: Record<string, Json> = {
  "/api/v1/commands/{id}": {
    get: {
      operationId: "commands.getStatus",
      tags: ["commands"],
      summary: "Tra kết quả command theo command_id (khi client hết thời gian chờ)",
      security: [{ sessionCookie: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: uuidSchema },
        ref("OrgId"),
        ref("OrgContext"),
      ],
      responses: {
        "200": {
          description: "committed (kèm data) · in_progress · failed (kèm problem)",
          headers: correlationHeader(),
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["command_id", "status"],
                properties: {
                  command_id: uuidSchema,
                  status: { enum: ["committed", "in_progress", "failed"] },
                  data: {},
                  problem: { $ref: PROBLEM },
                },
              },
            },
          },
        },
        ...pick("401", "404", "409", "500"),
      },
    },
  },
  "/api/version": {
    get: {
      operationId: "app.getVersion",
      tags: ["app"],
      summary: "Phiên bản bản build và phiên bản client tối thiểu (SPEC-pwa S-009)",
      security: [],
      responses: {
        "200": {
          description: "Phiên bản hiện hành",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version", "min_client_version"],
                properties: { version: { type: "string" }, min_client_version: { type: "string" } },
              },
            },
          },
        },
        ...pick("500"),
      },
    },
  },
  "/api/v1/me": {
    get: {
      operationId: "me.get",
      tags: ["session"],
      summary: "Người dùng hiện tại và các tổ chức của họ",
      security: [{ sessionCookie: [] }],
      responses: {
        "200": {
          description: "Người dùng + tổ chức",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["user", "organizations"],
                properties: {
                  user: {
                    type: "object",
                    required: ["id", "email", "name", "twoFactorEnabled"],
                    properties: {
                      id: uuidSchema,
                      email: { type: "string" },
                      name: { type: "string" },
                      twoFactorEnabled: { type: "boolean" },
                    },
                  },
                  organizations: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        ...pick("401"),
      },
    },
  },
  "/api/v1/me/consents": {
    get: {
      operationId: "me.getConsents",
      tags: ["privacy"],
      summary:
        "Trạng thái đồng ý theo mục đích + toàn bộ lịch sử của chính người đăng nhập (`?download=1` ⇒ tệp JSON tải về)",
      security: [{ sessionCookie: [] }],
      parameters: [
        { name: "download", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
      ],
      responses: {
        "200": {
          description: "Mục đích (cần/không cần đồng ý, trạng thái) và lịch sử cho/rút, cũ → mới",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["purposes", "history"],
                properties: {
                  purposes: { type: "array", items: { type: "object" } },
                  history: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        ...pick("401"),
      },
    },
    post: {
      operationId: "me.setConsent",
      tags: ["privacy"],
      summary:
        "Cho (granted=true) hoặc rút (granted=false) đồng ý một mục đích — idempotent theo trạng thái, không cần Idempotency-Key",
      security: [{ sessionCookie: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["purpose", "granted", "channel"],
              additionalProperties: false,
              properties: {
                purpose: { type: "string", enum: [...CONSENT_PURPOSES] },
                granted: { type: "boolean" },
                channel: { type: "string", enum: [...CONSENT_CHANNELS] },
                policy_version: { type: "string", maxLength: 20 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "`recorded` (thêm một hàng) hoặc `unchanged` (trạng thái đã đúng như yêu cầu)",
          content: { "application/json": { schema: { type: "object", required: ["data"] } } },
        },
        ...pick("400", "401", "409", "422"),
      },
    },
  },
  "/api/v1/session/switchOrganization": {
    post: {
      operationId: "session.switchOrganization",
      tags: ["session"],
      summary: "Chọn tổ chức/cơ sở đang làm việc (đặt cookie ngữ cảnh sau khi đối chiếu membership)",
      security: [{ sessionCookie: [] }],
      parameters: [ref("IdempotencyKey")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["organization_id"],
              additionalProperties: false,
              properties: {
                organization_id: uuidSchema,
                property_id: { ...uuidSchema, type: ["string", "null"] },
              },
            },
          },
        },
      },
      responses: { "200": commandSuccess({ type: "object" }), ...pick("400", "401", "404", "409", "422") },
    },
  },
  "/api/v1/notifications/unsubscribe": {
    post: {
      operationId: "notifications.unsubscribe",
      tags: ["notifications"],
      summary: "Huỷ đăng ký email bằng token ký có hạn (không phiên)",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string", minLength: 10, maxLength: 512 } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Đã cập nhật tuỳ chọn",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: {
                  data: {
                    type: "object",
                    properties: { type: { type: "string" }, message: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        "410": errorResponse("LINK_EXPIRED — token hết hạn"),
        ...pick("400", "404", "429", "500"),
      },
    },
  },
  "/api/v1/files/upload": {
    post: {
      operationId: "files.upload",
      tags: ["files"],
      summary: "Tải ảnh/PDF (thân là byte của file); quét mã độc, kiểm magic bytes",
      security: [{ sessionCookie: [] }],
      parameters: [
        ref("IdempotencyKey"),
        ref("OrgId"),
        ref("OrgContext"),
        {
          name: "owner_type",
          in: "query",
          required: true,
          schema: { enum: ["work_order", "payment_claim", "lease_settlement"] },
        },
        { name: "property_id", in: "query", required: true, schema: uuidSchema },
      ],
      requestBody: {
        required: true,
        content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } } },
      },
      responses: {
        "2XX": commandSuccess({ type: "object" }),
        "413": errorResponse("FILE_TOO_LARGE"),
        "415": errorResponse("FILE_TYPE_NOT_ALLOWED"),
        "503": errorResponse("SERVICE_UNAVAILABLE — kho file/máy quét tạm không dùng được"),
        ...pick("400", "401", "403", "404", "409", "422", "429", "500"),
      },
    },
  },
  "/api/v1/import/upload": {
    post: {
      operationId: "import.upload",
      tags: ["import"],
      summary: "Tải file nguồn của lô nhập (multipart; CSV/XLSX)",
      security: [{ sessionCookie: [] }],
      parameters: [ref("IdempotencyKey"), ref("OrgId"), ref("OrgContext")],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file", "property_id", "kind"],
              properties: {
                file: { type: "string", contentEncoding: "binary" },
                property_id: uuidSchema,
                kind: { enum: [...IMPORT_KINDS] },
                cutoff_on: { type: "string", format: "date" },
              },
            },
          },
        },
      },
      responses: {
        "2XX": commandSuccess({ type: "object" }),
        "413": errorResponse("FILE_TOO_LARGE"),
        "415": errorResponse("FILE_TYPE_NOT_ALLOWED"),
        "503": errorResponse("SERVICE_UNAVAILABLE"),
        ...pick("400", "401", "403", "404", "409", "422", "429", "500"),
      },
    },
  },
  "/api/v1/portal/guest/stays/{id}": {
    get: {
      operationId: "portal.guestGetStay",
      tags: ["portal"],
      summary: "Khách xem lượt ở + folio bằng liên kết (không phiên; token ở header, không ở URL)",
      security: [{ guestLink: [] }],
      parameters: [
        { name: "id", in: "path", required: true, schema: uuidSchema },
        {
          name: "X-Guest-Token",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 43, maxLength: 43 },
        },
        {
          name: "X-Guest-Verify",
          in: "header",
          required: false,
          description: "4 số cuối SĐT người đặt (bước hai, nếu cơ sở bật)",
          schema: { type: "string", pattern: "^[0-9]{4}$" },
        },
      ],
      responses: {
        "200": {
          description: "Lượt ở + folio",
          content: {
            "application/json": {
              schema: { type: "object", required: ["data"], properties: { data: { type: "object" } } },
            },
          },
        },
        "410": errorResponse("LINK_REVOKED / LINK_EXPIRED"),
        ...pick("404", "429"),
      },
    },
  },
  "/api/v1/webhooks/{provider}/{account}": {
    post: {
      operationId: "webhooks.receive",
      tags: ["webhooks"],
      summary: "Tiền vào từ nhà cung cấp (adapter mô phỏng `sim`); xác thực bằng chữ ký HMAC + timestamp",
      security: [{ webhookSignature: [] }],
      parameters: [
        { name: "provider", in: "path", required: true, schema: { enum: ["sim"] } },
        { name: "account", in: "path", required: true, schema: { type: "string" } },
        { name: "X-Hm-Timestamp", in: "header", required: true, schema: { type: "string" } },
        { name: "X-Hm-Signature", in: "header", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: schemaOf(simPayload) } },
      },
      responses: {
        "200": {
          description: "Đã nhận (idempotent theo event_id)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["received", "duplicate"],
                properties: { received: { const: true }, duplicate: { type: "boolean" } },
              },
            },
          },
        },
        ...pick("400", "401", "404", "422", "429", "500"),
      },
    },
  },
};

/**
 * Độ phủ route: mọi `apps/web/app/api/**\/route.ts` (đường dẫn từ `apps/web/app/api/`) phải có ở đây —
 * `spec` (đã vào tài liệu) hoặc `exception` (ngoài hợp đồng công khai, kèm lý do). Test đối chiếu với cây thư mục thật.
 */
export type RouteCoverage = { spec: string } | { exception: string };
export const ROUTE_COVERAGE: Readonly<Record<string, RouteCoverage>> = {
  "v1/[module]/[command]/route.ts": { spec: "registry: mọi mục COMMANDS (POST) và QUERIES (GET)" },
  "v1/commands/[id]/route.ts": { spec: "/api/v1/commands/{id}" },
  "v1/me/route.ts": { spec: "/api/v1/me" },
  "v1/me/consents/route.ts": { spec: "/api/v1/me/consents" },
  "version/route.ts": { spec: "/api/version" },
  "v1/session/switchOrganization/route.ts": { spec: "/api/v1/session/switchOrganization" },
  "v1/notifications/unsubscribe/route.ts": { spec: "/api/v1/notifications/unsubscribe" },
  "v1/files/upload/route.ts": { spec: "/api/v1/files/upload" },
  "v1/import/upload/route.ts": { spec: "/api/v1/import/upload" },
  "v1/portal/guest/stays/[id]/route.ts": { spec: "/api/v1/portal/guest/stays/{id}" },
  "v1/webhooks/[provider]/[account]/route.ts": { spec: "/api/v1/webhooks/{provider}/{account}" },
  "auth/[...all]/route.ts": {
    exception:
      "Endpoint của Better Auth (đăng nhập, phiên, 2FA, OTP) — hợp đồng do thư viện công bố, không phải hợp đồng nghiệp vụ",
  },
  "health/route.ts": {
    exception: "Healthcheck tiến trình cho hạ tầng (liveness), không phải API cho client",
  },
  "ready/route.ts": { exception: "Readiness cho hạ tầng (CSDL/kho/máy quét), không phải API cho client" },
  "metrics/route.ts": { exception: "Prometheus text, chỉ nội bộ (token hoặc mạng nội bộ), không công bố" },
};

export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const [name, def] of Object.entries(COMMANDS)) {
    const [module, command] = name.split(".") as [string, string];
    paths[`/api/v1/${module}/${command}`] = { post: commandOperation(name, def.input) };
  }
  for (const [name, def] of Object.entries(USER_COMMANDS)) {
    const [module, command] = name.split(".") as [string, string];
    paths[`/api/v1/${module}/${command}`] = { post: commandOperation(name, def.input, true) };
  }
  for (const [name, def] of Object.entries(QUERIES)) {
    const [module, query] = name.split(".") as [string, string];
    const p = `/api/v1/${module}/${query}`;
    paths[p] = { ...(paths[p] ?? {}), get: queryOperation(name, def.input) };
  }
  Object.assign(paths, EXTRA_PATHS);
  const sorted = Object.fromEntries(
    Object.keys(paths)
      .sort()
      .map((k) => [k, paths[k]]),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "Hotel Manager API",
      version: API_CONTRACT_VERSION,
      description:
        "Sinh tự động từ packages/app/src/http/registry.ts — KHÔNG sửa tay (`pnpm openapi`). Quy ước chung: docs/design/API-CONTRACT.md.",
    },
    servers: [{ url: "/", description: "Cùng origin với ứng dụng web" }],
    security: [{ sessionCookie: [] }],
    tags: [
      ...new Set(
        Object.values(sorted).flatMap((p) =>
          Object.values(p as Json).flatMap((o) => (o as { tags?: string[] }).tags ?? []),
        ),
      ),
    ]
      .sort()
      .map((name) => ({ name })),
    paths: sorted,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "session",
          description:
            "Cookie phiên HttpOnly do Better Auth cấp (tên cookie thực do thư viện đặt); ghi bằng cookie kiểm Origin + SameSite=Lax",
        },
        guestLink: {
          type: "apiKey",
          in: "header",
          name: "X-Guest-Token",
          description: "Token liên kết khách 256 bit (chỉ băm được lưu)",
        },
        webhookSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Hm-Signature",
          description: "HMAC-SHA256 trên timestamp + thân",
        },
      },
      responses: Object.fromEntries(Object.entries(ERROR_RESPONSES).map(([c, r]) => [`Error${c}`, r])),
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "UUID do client sinh; cùng key + cùng payload → kết quả cũ; khác payload → 422 IDEMPOTENCY_CONFLICT; lần đầu còn đang xử lý → 409 IDEMPOTENCY_IN_PROGRESS + Retry-After. Lưu 7 ngày.",
          schema: uuidSchema,
        },
        OrgId: {
          name: "X-Org-Id",
          in: "header",
          required: false,
          description:
            "CHỌN tổ chức trong số tổ chức người dùng có membership (không phải quyền; luôn đối chiếu membership)",
          schema: uuidSchema,
        },
        AppVersion: {
          name: "X-App-Version",
          in: "header",
          required: false,
          description:
            "Phiên bản (semver) của bản build mà client web đang chạy; thấp hơn mức tối thiểu của server (`GET /api/version`) → 426 CLIENT_OUTDATED. Không gửi = client không tự khai (script/API) → không kiểm.",
          schema: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+" },
        },
        OrgContext: {
          name: "X-Org-Context",
          in: "header",
          required: false,
          description: "Tổ chức trang đang hiển thị; khác tổ chức của request → 409 CONTEXT_CHANGED",
          schema: uuidSchema,
        },
      },
      schemas: {
        Problem: {
          type: "object",
          description: "application/problem+json (RFC 9457) kèm mở rộng của API",
          required: ["type", "title", "status", "code"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            code: {
              type: "string",
              description: "Mã lỗi (packages/app/src/errors.ts)",
              examples: Object.keys(ERROR_CODES).slice(0, 3),
            },
            detail: { type: "string" },
            correlation_id: { type: "string" },
            errors: {
              type: "array",
              items: {
                type: "object",
                required: ["path", "field", "code"],
                properties: { path: { type: "string" }, field: { type: "string" }, code: { type: "string" } },
              },
            },
          },
          additionalProperties: true,
        },
      },
    },
  };
}

/** Văn bản chuẩn của `apps/web/openapi.json` (khoá giữ thứ tự sinh, 2 dấu cách, xuống dòng cuối). */
export function renderOpenApi(): string {
  return `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
}
