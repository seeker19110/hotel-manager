// Lớp HTTP cho command/query (API-CONTRACT §1–2; PLAN đợt 2 T-103). Không phụ thuộc Next: nhận Request, trả Response.
// Thứ tự kiểm: phiên bản client (426) → phiên (401) → ngữ cảnh tổ chức (409 ORG_CONTEXT_REQUIRED kèm danh sách) → membership/MFA (resolveActor)
// → Idempotency-Key (400) → JSON (400) → schema (422 + errors[]) → command pipeline (idempotency, audit, outbox).
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { z } from "zod";
import {
  AccessError,
  type Actor,
  listMyOrganizations,
  ORG_CONTEXT_HEADER,
  ORG_HEADER,
  orgCookieName,
  recordSupportAccess,
  requestedOrgId,
  resolveActor,
  type UserCommandRequest,
} from "../access/index.ts";
import { t } from "../i18n.ts";
import {
  type ActorRef,
  emitSecurity,
  requestClient,
  type SecurityEventName,
  securityEventForProblem,
  withRequestTrace,
} from "../logging/index.ts";
import { observeHttp } from "../observability/index.ts";
import type { CommandResult } from "../pipeline/index.ts";
import {
  type CommandContext,
  executeCommand,
  getCommandResult,
  type Problem,
  settle,
  supportWriteDenied,
  toProblem,
  unwrap,
} from "../pipeline/index.ts";
import type { AppServices } from "../server/index.ts";
import { CLIENT_VERSION_HEADER, isClientOutdated } from "./client-version.ts";
import { nfcDeep } from "./normalize.ts";
import { retryAfterSeconds } from "./retry-after.ts";

export interface HttpSession {
  user: { id: string; twoFactorEnabled?: boolean | null | undefined };
  /** Thời điểm đăng nhập (xác thực lại = đăng nhập lại ⇒ phiên mới). */
  session?: { createdAt?: Date | string | null | undefined };
}

export interface HttpDeps {
  db: Kysely<unknown>;
  getSession(headers: Headers): Promise<HttpSession | null>;
  /**
   * Gọi khi `getSession` trả null: request mang cookie của một phiên ĐÃ BỊ THU HỒI (`session.revokeAll`, đặt lại MFA)? ⇒ 401
   * `SESSION_REVOKED` thay vì `UNAUTHENTICATED` (SPEC-access S-010). Bỏ trống = không phân biệt.
   */
  isSessionRevoked?(headers: Headers): Promise<boolean>;
  /** APP_BASE_URL là https → cookie `__Host-`. */
  secureCookies: boolean;
  services: AppServices;
  onUnexpectedError?(err: unknown, correlationId: string): void;
  /**
   * Phiên bản client web tối thiểu (SPEC-pwa S-009): command có `X-App-Version` thấp hơn ⇒ 426 CLIENT_OUTDATED, không ghi gì.
   * Bỏ trống = không bắt buộc. Lấy từ `apps/web/package.json` (`hm.minClientVersion`), không phải biến môi trường.
   */
  minClientVersion?: string;
  /** Hạn mức lệnh mới/phút/tổ chức (T-401); bỏ trống = `COMMAND_QUOTA_PER_MINUTE`. Chỉ test đặt khác. */
  commandQuotaPerMinute?: number;
  /** Hạn mức lệnh mới/phút/thành viên; bỏ trống = `COMMAND_MEMBER_QUOTA_PER_MINUTE`. Chỉ test đặt khác. */
  commandMemberQuotaPerMinute?: number;
  /** Ghi đè hạn mức tải file/nhập liệu mỗi phút (thành viên/tổ chức) — chỉ test đặt khác; bỏ trống = hằng ở `rate-limit.ts`. */
  uploadRateLimit?: { perMember?: number; perOrg?: number };
}

export interface CommandDef<I, O, P = undefined> {
  command: string;
  input: z.ZodType<I>;
  /** Vẫn chạy khi tổ chức `pending_deletion` (chỉ xuất dữ liệu — T-2312, D-125). Mặc định: 423 ORG_PENDING_DELETION. */
  allowPendingDeletion?: boolean;
  /**
   * Bước chuẩn bị NGOÀI transaction lệnh (T-303; quét mã độc, ghi object — xem files/staging.ts). Chạy trước `executeCommand`;
   * kết quả đi vào `run`. Lỗi của bước này được ném lại TRONG `run` để pipeline vẫn ghi kết quả `failed` + audit `denied`.
   */
  prepare?(
    db: Kysely<unknown>,
    actor: Actor,
    input: I,
    services: AppServices,
    meta: { idempotencyKey: string },
  ): Promise<P>;
  run(
    ctx: CommandContext,
    input: I,
    services: AppServices,
    prepared: P,
  ): Promise<{ data: O; httpStatus?: number }>;
}

/**
 * Lệnh "cấp người dùng" (SPEC-access S-001 `org.create`, S-007/S-008 `member.acceptInvitation`): cần phiên đăng nhập nhưng KHÔNG cần
 * (cũng không nhận) ngữ cảnh tổ chức — người gọi chưa là thành viên. `X-Org-Id` bị bỏ qua. Quyền là điều kiện của chính lệnh
 * (vd. đúng email được mời), kiểm trong `run`; idempotency/audit/outbox vẫn đi qua pipeline (xem `access/provision.ts`).
 */
export interface UserCommandDef<I, O> {
  command: string;
  input: z.ZodType<I>;
  run(req: UserCommandRequest, input: I, services: AppServices): Promise<CommandResult<O>>;
}

export interface QueryDef<I, O> {
  query: string;
  input: z.ZodType<I>;
  /** Như `CommandDef.allowPendingDeletion`. */
  allowPendingDeletion?: boolean;
  run(
    db: Kysely<unknown>,
    actor: Actor,
    input: I,
    services: AppServices,
    meta: { correlationId: string },
  ): Promise<O>;
}

/**
 * Lỗi của lệnh cấp người dùng KHÔNG được route ghi thêm sự kiện bảo mật `denied`: lỗi idempotency là hành vi bình thường của
 * client retry (không phải bị từ chối quyền) và lỗi đã tự phát sự kiện riêng, mã ngắn, ở nơi sinh lỗi (`invitation.rejected` với
 * lý do thật trong `accept-invitation.ts`) — ghi thêm sẽ nhân đôi/gây nhiễu. 429 do hạn mức của bootstrap thì KHÔNG nằm đây
 * (không ai khác phát ⇒ route phát `rate_limit.exceeded` đúng một lần).
 */
const NO_ROUTE_DENIED_EVENT = new Set([
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_CONFLICT",
  "INVITATION_INVALID",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION = /^[A-Za-z0-9._-]{8,64}$/;
const NO_STORE = { "cache-control": "no-store" };
/** Tiêu đề 401 chung (command, query, /api/v1/me — AUD-XFEAT-004). */
export const UNAUTHENTICATED_TITLE = t("http.unauthenticated");

export function json(body: unknown, status: number, correlationId: string, problem = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": problem ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8",
      "x-correlation-id": correlationId,
      ...NO_STORE,
      // Mọi 429 đều có Retry-After (BE-REL-006): lấy từ `retry_after` của problem, thiếu ⇒ mặc định 60 giây.
      ...(status === 429
        ? {
            "retry-after": String(retryAfterSeconds((body as { retry_after?: unknown } | null)?.retry_after)),
          }
        : {}),
      // 409 IDEMPOTENCY_IN_PROGRESS (D-043): `retry_after` của problem → header, để client đợi rồi tra kết quả.
      ...(status === 409 && (body as { code?: unknown } | null)?.code === "IDEMPOTENCY_IN_PROGRESS"
        ? {
            "retry-after": String(retryAfterSeconds((body as { retry_after?: unknown } | null)?.retry_after)),
          }
        : {}),
    },
  });
}

export function problemResponse(
  p: Problem | (Record<string, unknown> & { status: number }),
  correlationId: string,
): Response {
  return json({ ...p, correlation_id: correlationId }, p.status, correlationId, true);
}

export function simpleProblem(
  code: string,
  status: number,
  title: string,
  correlationId: string,
  extra = {},
): Response {
  return problemResponse(
    { type: `https://hotel-manager.invalid/errors/${code}`, title, status, code, ...extra },
    correlationId,
  );
}

/**
 * Client quá cũ (S-009): 426 CLIENT_OUTDATED hoặc null. Dùng chung cho command và hai route tải file (upload ảnh, nhập liệu) để
 * mọi đường ghi dữ liệu từ trình duyệt kiểm phiên bản như nhau — gọi TRƯỚC phiên/CSDL/đọc thân.
 */
export function outdatedClientProblem(req: Request, deps: HttpDeps, correlationId: string): Response | null {
  return isClientOutdated(req.headers.get(CLIENT_VERSION_HEADER), deps.minClientVersion)
    ? simpleProblem("CLIENT_OUTDATED", 426, t("http.client_outdated"), correlationId)
    : null;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function correlationOf(req: Request): string {
  const c = req.headers.get("x-correlation-id");
  return c && CORRELATION.test(c) ? c : randomUUID();
}

/** Từ chối (401/403/429, hoặc 404 vì không thuộc tổ chức) → sự kiện bảo mật chuẩn hoá (SEC-LOG-001). */
function denied(
  req: Request,
  correlationId: string,
  p: { status: number; code: string },
  actor: ActorRef | null,
  target: { type: string; id: string },
  event?: SecurityEventName | null,
): void {
  const name = event ?? securityEventForProblem(p);
  if (!name) return;
  emitSecurity({
    event: name,
    outcome: "denied",
    actor,
    target,
    reason: p.code,
    client: requestClient(req.headers),
    correlationId,
  });
}

/**
 * Đầu vào bị từ chối ở biên HTTP (SEC-LOG-001): `input.validation_failed` (sai schema/quy tắc) hoặc `input.deserialize_failed`
 * (thân không phải JSON/multipart hợp lệ). Chỉ ghi MÃ lý do cố định — không ghi giá trị người dùng gửi.
 */
export function rejectInput(
  req: Request,
  correlationId: string,
  event: "input.validation_failed" | "input.deserialize_failed" | "file.upload_rejected",
  actor: ActorRef | null,
  target: { type: string; id: string },
  reason: string,
): void {
  emitSecurity({
    event,
    outcome: "denied",
    actor,
    target,
    reason,
    client: requestClient(req.headers),
    correlationId,
  });
}

/** 401 khi không có phiên hợp lệ: `SESSION_REVOKED` nếu cookie là của phiên đã bị thu hồi, ngược lại `UNAUTHENTICATED`. */
async function noSession(
  req: Request,
  deps: HttpDeps,
  correlationId: string,
  endpoint: { type: string; id: string },
): Promise<Response> {
  const revoked = deps.isSessionRevoked ? await deps.isSessionRevoked(req.headers) : false;
  const code = revoked ? "SESSION_REVOKED" : "UNAUTHENTICATED";
  denied(req, correlationId, { status: 401, code }, null, endpoint);
  return simpleProblem(code, 401, revoked ? t("http.session_revoked") : UNAUTHENTICATED_TITLE, correlationId);
}

/** Actor của request hoặc Response lỗi (401/409/404/403) đã sẵn để trả. */
export async function actorFromRequest(
  req: Request,
  deps: HttpDeps,
  correlationId: string,
  /** `allowPendingDeletion`: đường được phép khi tổ chức chờ xoá (xuất dữ liệu, trạng thái/huỷ — T-2312, D-125). */
  opts: {
    allowPendingDeletion?: boolean;
    /**
     * Đường GHI (tên lệnh/endpoint): tài khoản hỗ trợ chỉ đọc (D-128) ⇒ 403 + audit `command.denied` + sự kiện bảo mật, trước khi
     * đọc thân request hay chạy bất cứ gì.
     */
    write?: string;
  } = {},
): Promise<Actor | Response> {
  const session = await deps.getSession(req.headers);
  const endpoint = { type: "endpoint", id: new URL(req.url).pathname };
  if (!session) return noSession(req, deps, correlationId, endpoint);
  const orgId = requestedOrgId(
    req.headers.get(ORG_HEADER),
    readCookie(req.headers.get("cookie"), orgCookieName(deps.secureCookies)),
  );
  // SPEC-portal S-013: trang web gửi kèm ngữ cảnh nó đang hiển thị (`X-Org-Context`); phiên đã chuyển sang tổ chức khác ở
  // tab khác ⇒ 409, không ghi gì — UI tải lại. (`X-Org-Id` vẫn là cách API client CHỌN tổ chức, ưu tiên hơn cookie.)
  const shown = req.headers.get(ORG_CONTEXT_HEADER)?.trim();
  if (shown && orgId && shown !== orgId)
    return simpleProblem("CONTEXT_CHANGED", 409, t("http.context_changed"), correlationId);
  if (!orgId) {
    const organizations = await listMyOrganizations(deps.db, session.user.id);
    return simpleProblem("ORG_CONTEXT_REQUIRED", 409, t("http.org_context_required"), correlationId, {
      organizations: organizations.map((o) => ({
        id: o.organizationId,
        name: o.organizationName,
        role: o.role,
      })),
    });
  }
  let actor: Actor;
  try {
    actor = await resolveActor(deps.db, {
      authUserId: session.user.id,
      orgId,
      twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
      authenticatedAt: session.session?.createdAt ? new Date(session.session.createdAt) : undefined,
      ...(opts.allowPendingDeletion ? { allowPendingDeletion: true } : {}),
    });
  } catch (err) {
    if (err instanceof AccessError) {
      const p = toProblem(err);
      // 404 ở đây = không phải thành viên tổ chức được yêu cầu (dò tổ chức khác): vẫn ghi để phát hiện dò quét.
      denied(
        req,
        correlationId,
        p,
        { authUserId: session.user.id, orgId },
        endpoint,
        p.status === 404 ? "authz.org_not_found" : null,
      );
      return problemResponse(p, correlationId);
    }
    throw err;
  }
  if (opts.write !== undefined && actor.role === "platform_support")
    return problemResponse(
      await supportWriteDenied(deps.db, actor, {
        command: opts.write,
        correlationId,
        client: requestClient(req.headers),
      }),
      correlationId,
    );
  return actor;
}

export function validationProblem(error: z.ZodError, correlationId: string): Response {
  return simpleProblem("VALIDATION_FAILED", 422, t("http.validation_failed"), correlationId, {
    errors: error.issues.map((i) => {
      const path = i.path.join(".");
      return { path, field: path, code: i.code };
    }),
  });
}

function unexpected(err: unknown, deps: HttpDeps, correlationId: string): Response {
  deps.onUnexpectedError?.(err, correlationId);
  return problemResponse(toProblem(err, correlationId), correlationId);
}

/**
 * Mẫu route của lệnh/truy vấn trong metric HTTP: `module.name` (do danh mục đăng ký, không phải đầu vào của request) →
 * `/api/v1/module/name`. Không có id nào trong nhãn (OPS-OBS-003).
 */
const routeOf = (name: string) => `/api/v1/${name.replace(".", "/")}`;

/** POST command: trả `{ command_id, status: "committed", data }` hoặc problem+json. Đo `hm_http_*` (T-406). */
export function handleCommand<I, O, P = undefined>(
  def: CommandDef<I, O, P>,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  return observeHttp(routeOf(def.command), req.method, () =>
    withRequestTrace(req, () => runCommand(def, req, deps)),
  );
}

async function runCommand<I, O, P>(
  def: CommandDef<I, O, P>,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    // Client quá cũ: trả 426 TRƯỚC mọi việc khác (không cần phiên, không đụng CSDL) để UI hiện nút "Cập nhật" (S-009).
    const outdated = outdatedClientProblem(req, deps, correlationId);
    if (outdated) return outdated;
    const actor = await actorFromRequest(req, deps, correlationId, {
      allowPendingDeletion: def.allowPendingDeletion === true,
      write: def.command,
    });
    if (actor instanceof Response) return actor;
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key)) {
      return simpleProblem("MALFORMED_REQUEST", 400, t("http.idempotency_key_invalid"), correlationId);
    }
    let body: unknown;
    try {
      body = nfcDeep(await req.json());
    } catch {
      rejectInput(
        req,
        correlationId,
        "input.deserialize_failed",
        actor,
        { type: "command", id: def.command },
        "MALFORMED_REQUEST",
      );
      return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
    }
    const parsed = def.input.safeParse(body);
    if (!parsed.success) {
      rejectInput(
        req,
        correlationId,
        "input.validation_failed",
        actor,
        { type: "command", id: def.command },
        "VALIDATION_FAILED",
      );
      return validationProblem(parsed.error, correlationId);
    }
    const input = parsed.data;
    const prep = def.prepare
      ? await settle(() =>
          (def.prepare as NonNullable<typeof def.prepare>)(deps.db, actor, input, deps.services, {
            idempotencyKey: key,
          }),
        )
      : undefined;
    const result = await executeCommand<O>(
      deps.db,
      actor,
      {
        command: def.command,
        idempotencyKey: key,
        payload: body,
        correlationId,
        client: requestClient(req.headers),
        ...(deps.commandQuotaPerMinute ? { quotaPerMinute: deps.commandQuotaPerMinute } : {}),
        ...(deps.commandMemberQuotaPerMinute
          ? { memberQuotaPerMinute: deps.commandMemberQuotaPerMinute }
          : {}),
      },
      (ctx) => def.run(ctx, input, deps.services, (prep ? unwrap(prep) : undefined) as P),
    );
    if (result.status === "committed") {
      return json(
        { command_id: result.commandId, status: "committed", data: result.data },
        result.httpStatus,
        correlationId,
      );
    }
    return problemResponse(result.problem, correlationId);
  } catch (err) {
    return unexpected(err, deps, correlationId);
  }
}

/** POST lệnh cấp người dùng: phiên (401) → Idempotency-Key (400) → JSON (400) → schema (422) → `run`. Đo `hm_http_*`. */
export function handleUserCommand<I, O>(
  def: UserCommandDef<I, O>,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  return observeHttp(routeOf(def.command), req.method, () =>
    withRequestTrace(req, () => runUserCommand(def, req, deps)),
  );
}

async function runUserCommand<I, O>(
  def: UserCommandDef<I, O>,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  const correlationId = correlationOf(req);
  // S-009: lệnh cấp người dùng cũng là đường ghi từ trình duyệt — client quá cũ thì 426 trước phiên/CSDL, như command thường.
  const outdated = outdatedClientProblem(req, deps, correlationId);
  if (outdated) return outdated;
  const endpoint = { type: "endpoint", id: new URL(req.url).pathname };
  let userId: string | null = null;
  try {
    const session = await deps.getSession(req.headers);
    if (!session) return await noSession(req, deps, correlationId, endpoint);
    userId = session.user.id;
    const actorRef: ActorRef = { authUserId: userId };
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key)) {
      return simpleProblem("MALFORMED_REQUEST", 400, t("http.idempotency_key_invalid"), correlationId);
    }
    let body: unknown;
    try {
      body = nfcDeep(await req.json());
    } catch {
      rejectInput(
        req,
        correlationId,
        "input.deserialize_failed",
        actorRef,
        { type: "command", id: def.command },
        "MALFORMED_REQUEST",
      );
      return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
    }
    const parsed = def.input.safeParse(body);
    if (!parsed.success) {
      rejectInput(
        req,
        correlationId,
        "input.validation_failed",
        actorRef,
        { type: "command", id: def.command },
        "VALIDATION_FAILED",
      );
      return validationProblem(parsed.error, correlationId);
    }
    const result = await def.run(
      { db: deps.db, userId, key, payload: body, correlationId, client: requestClient(req.headers) },
      parsed.data,
      deps.services,
    );
    if (result.status === "committed") {
      return json(
        { command_id: result.commandId, status: "committed", data: result.data },
        result.httpStatus,
        correlationId,
      );
    }
    return problemResponse(result.problem, correlationId);
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status < 500) {
      if (!NO_ROUTE_DENIED_EVENT.has(p.code))
        denied(req, correlationId, p, userId ? { authUserId: userId } : null, {
          type: "command",
          id: def.command,
        });
      return problemResponse(p, correlationId);
    }
    return unexpected(err, deps, correlationId);
  }
}

/** GET query: tham số từ query string; trả `{ data }` hoặc problem+json. Đo `hm_http_*` (T-406). */
export function handleQuery<I, O>(def: QueryDef<I, O>, req: Request, deps: HttpDeps): Promise<Response> {
  return observeHttp(routeOf(def.query), req.method, () =>
    withRequestTrace(req, () => runQuery(def, req, deps)),
  );
}

async function runQuery<I, O>(def: QueryDef<I, O>, req: Request, deps: HttpDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  let actorOf: Actor | null = null;
  try {
    const actor = await actorFromRequest(req, deps, correlationId, {
      allowPendingDeletion: def.allowPendingDeletion === true,
    });
    if (actor instanceof Response) return actor;
    actorOf = actor;
    // D-128: mỗi query của tài khoản hỗ trợ để lại một `support.accessed` (lý do của lời cấp, nguồn) TRƯỚC khi đọc dữ liệu.
    await recordSupportAccess(deps.db, actor, {
      kind: "query",
      name: def.query,
      client: requestClient(req.headers),
      correlationId,
    });
    const params = nfcDeep(Object.fromEntries(new URL(req.url).searchParams));
    const parsed = def.input.safeParse(params);
    if (!parsed.success) {
      rejectInput(
        req,
        correlationId,
        "input.validation_failed",
        actor,
        { type: "query", id: def.query },
        "VALIDATION_FAILED",
      );
      return validationProblem(parsed.error, correlationId);
    }
    return json(
      { data: await def.run(deps.db, actor, parsed.data, deps.services, { correlationId }) },
      200,
      correlationId,
    );
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status < 500) {
      denied(req, correlationId, p, actorOf, { type: "query", id: def.query });
      return problemResponse(p, correlationId);
    }
    return unexpected(err, deps, correlationId);
  }
}

/** GET /api/v1/commands/{id} (API-CONTRACT §1, SPEC-pwa S-010…S-012, S-019). Đo `hm_http_*` (T-406). */
export function handleCommandStatus(commandId: string, req: Request, deps: HttpDeps): Promise<Response> {
  return observeHttp("/api/v1/commands/{id}", req.method, () =>
    withRequestTrace(req, () => runCommandStatus(commandId, req, deps)),
  );
}

async function runCommandStatus(commandId: string, req: Request, deps: HttpDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    // Tổ chức chờ xoá: chỉ kết quả lệnh nhóm `exports.*` (xuất dữ liệu trong thời gian giữ — D-125); lệnh khác 423.
    const actor = await actorFromRequest(req, deps, correlationId, { allowPendingDeletion: true });
    if (actor instanceof Response) return actor;
    const r = await getCommandResult(deps.db, actor, commandId, {
      allowWhenPendingDeletion: (command) => command.startsWith("exports."),
    });
    const id = commandId.toLowerCase();
    if (r.status === "committed")
      return json({ command_id: id, status: "committed", data: r.data }, 200, correlationId);
    if (r.status === "in_progress")
      return json({ command_id: id, status: "in_progress" }, 200, correlationId);
    return json({ command_id: id, status: "failed", problem: r.problem }, 200, correlationId);
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status < 500) return problemResponse(p, correlationId);
    return unexpected(err, deps, correlationId);
  }
}
