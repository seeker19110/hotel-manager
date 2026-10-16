// Lớp HTTP cho command/query (API-CONTRACT §1–2; PLAN đợt 2 T-103). Không phụ thuộc Next: nhận Request, trả Response.
// Thứ tự kiểm: phiên (401) → ngữ cảnh tổ chức (409 ORG_CONTEXT_REQUIRED kèm danh sách) → membership/MFA (resolveActor)
// → Idempotency-Key (400) → JSON (400) → schema (422 + errors[]) → command pipeline (idempotency, audit, outbox).
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { AccessError, type Actor, listMyOrganizations, resolveActor } from "../access/actor.ts";
import { ORG_CONTEXT_HEADER, ORG_HEADER, orgCookieName, requestedOrgId } from "../access/org-context.ts";
import { settle, unwrap } from "../files/staging.ts";
import { type CommandContext, executeCommand, getCommandResult } from "../pipeline/command.ts";
import { type Problem, toProblem } from "../pipeline/problem.ts";
import type { AppServices } from "../server/services.ts";

export interface HttpSession {
  user: { id: string; twoFactorEnabled?: boolean | null | undefined };
  /** Thời điểm đăng nhập (xác thực lại = đăng nhập lại ⇒ phiên mới). */
  session?: { createdAt?: Date | string | null | undefined };
}

export interface HttpDeps {
  db: Kysely<unknown>;
  getSession(headers: Headers): Promise<HttpSession | null>;
  /** APP_BASE_URL là https → cookie `__Host-`. */
  secureCookies: boolean;
  services: AppServices;
  onUnexpectedError?(err: unknown, correlationId: string): void;
}

export interface CommandDef<I, O, P = undefined> {
  command: string;
  input: z.ZodType<I>;
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

export interface QueryDef<I, O> {
  query: string;
  input: z.ZodType<I>;
  run(
    db: Kysely<unknown>,
    actor: Actor,
    input: I,
    services: AppServices,
    meta: { correlationId: string },
  ): Promise<O>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORRELATION = /^[A-Za-z0-9._-]{8,64}$/;
const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status: number, correlationId: string, problem = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": problem ? "application/problem+json" : "application/json",
      "x-correlation-id": correlationId,
      ...NO_STORE,
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

/** Actor của request hoặc Response lỗi (401/409/404/403) đã sẵn để trả. */
export async function actorFromRequest(
  req: Request,
  deps: HttpDeps,
  correlationId: string,
): Promise<Actor | Response> {
  const session = await deps.getSession(req.headers);
  if (!session) return simpleProblem("UNAUTHENTICATED", 401, "Cần đăng nhập", correlationId);
  const orgId = requestedOrgId(
    req.headers.get(ORG_HEADER),
    readCookie(req.headers.get("cookie"), orgCookieName(deps.secureCookies)),
  );
  // SPEC-portal S-013: trang web gửi kèm ngữ cảnh nó đang hiển thị (`X-Org-Context`); phiên đã chuyển sang tổ chức khác ở
  // tab khác ⇒ 409, không ghi gì — UI tải lại. (`X-Org-Id` vẫn là cách API client CHỌN tổ chức, ưu tiên hơn cookie.)
  const shown = req.headers.get(ORG_CONTEXT_HEADER)?.trim();
  if (shown && orgId && shown !== orgId)
    return simpleProblem(
      "CONTEXT_CHANGED",
      409,
      "Bạn vừa chuyển sang cơ sở khác. Tải lại để tiếp tục.",
      correlationId,
    );
  if (!orgId) {
    const organizations = await listMyOrganizations(deps.db, session.user.id);
    return simpleProblem("ORG_CONTEXT_REQUIRED", 409, "Hãy chọn tổ chức bạn đang làm việc.", correlationId, {
      organizations: organizations.map((o) => ({
        id: o.organizationId,
        name: o.organizationName,
        role: o.role,
      })),
    });
  }
  try {
    return await resolveActor(deps.db, {
      authUserId: session.user.id,
      orgId,
      twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
      authenticatedAt: session.session?.createdAt ? new Date(session.session.createdAt) : undefined,
    });
  } catch (err) {
    if (err instanceof AccessError) return problemResponse(toProblem(err), correlationId);
    throw err;
  }
}

export function validationProblem(error: z.ZodError, correlationId: string): Response {
  return simpleProblem("VALIDATION_FAILED", 422, "Dữ liệu không hợp lệ", correlationId, {
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

/** POST command: trả `{ command_id, status: "committed", data }` hoặc problem+json. */
export async function handleCommand<I, O, P = undefined>(
  def: CommandDef<I, O, P>,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const actor = await actorFromRequest(req, deps, correlationId);
    if (actor instanceof Response) return actor;
    const key = req.headers.get("idempotency-key") ?? "";
    if (!UUID.test(key)) {
      return simpleProblem("MALFORMED_REQUEST", 400, "Thiếu hoặc sai Idempotency-Key (UUID)", correlationId);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return simpleProblem("MALFORMED_REQUEST", 400, "Thân yêu cầu không phải JSON hợp lệ", correlationId);
    }
    const parsed = def.input.safeParse(body);
    if (!parsed.success) return validationProblem(parsed.error, correlationId);
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
      { command: def.command, idempotencyKey: key, payload: body, correlationId },
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

/** GET query: tham số từ query string; trả `{ data }` hoặc problem+json. */
export async function handleQuery<I, O>(
  def: QueryDef<I, O>,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const actor = await actorFromRequest(req, deps, correlationId);
    if (actor instanceof Response) return actor;
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const parsed = def.input.safeParse(params);
    if (!parsed.success) return validationProblem(parsed.error, correlationId);
    return json(
      { data: await def.run(deps.db, actor, parsed.data, deps.services, { correlationId }) },
      200,
      correlationId,
    );
  } catch (err) {
    const p = toProblem(err, correlationId);
    if (p.status < 500) return problemResponse(p, correlationId);
    return unexpected(err, deps, correlationId);
  }
}

/** GET /api/v1/commands/{id} (API-CONTRACT §1, SPEC-pwa S-010…S-012, S-019). */
export async function handleCommandStatus(
  commandId: string,
  req: Request,
  deps: HttpDeps,
): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const actor = await actorFromRequest(req, deps, correlationId);
    if (actor instanceof Response) return actor;
    const r = await getCommandResult(deps.db, actor, commandId);
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
