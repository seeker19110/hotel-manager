// /api/v1/organization/deletion — vòng đời xoá tổ chức đang chọn (PLAN T-2312; IND-SAAS-006, UX-CONTENT-005; D-125).
// - Ngữ cảnh tổ chức như command (X-Org-Id/cookie, membership tra lại mỗi lần) nhưng ĐƯỢC chạy khi tổ chức `pending_deletion`
//   (`allowPendingDeletion`) — mọi đường khác bị 423 ORG_PENDING_DELETION ở `resolveActor`.
// - GET: trạng thái (mọi thành viên — để hiện biểu ngữ). POST `{ password? }` (schema strict): chỉ owner; xác thực lại như DSAR
//   (phiên ≤ 5 phút HOẶC `password` đúng; thử ≤ 5 lần/15 phút/tài khoản) ⇒ 202 (mới) / 200 (đã chờ xoá). DELETE: owner huỷ — một
//   bước, 200 `{ cancelled }` (idempotent: không chờ xoá ⇒ `cancelled: false`). CSRF: kiểm Origin ở proxy.ts (mọi /api/ ghi).
import { minutesToSeconds, SECONDS_PER_MINUTE } from "@hm/domain";
import { z } from "zod";
import type { Actor } from "../actor-core/index.ts";
import { t } from "../i18n.ts";
import { emitSecurity, requestClient } from "../logging/index.ts";
import { rateLimitHit } from "../pipeline/index.ts";
import { DSAR_PASSWORD_ATTEMPTS_PER_15_MIN } from "../privacy/index.ts";
import {
  cancelOrgDeletion,
  OrgDeletionError,
  type OrgDeletionStatus,
  orgDeletionStatus,
  requestOrgDeletion,
} from "../tenancy/index.ts";
import {
  actorFromRequest,
  correlationOf,
  type HttpDeps,
  json,
  simpleProblem,
  validationProblem,
} from "./command-route.ts";
import type { VerifyPassword } from "./data-requests.ts";

export const requestOrgDeletionInput = z.strictObject({
  password: z.string().min(1).max(256).optional(),
});

export type OrgDeletionDeps = HttpDeps & { verifyPassword?: VerifyPassword; now?: () => Date };

const statusJson = (s: OrgDeletionStatus) => ({
  organization_id: s.organizationId,
  organization_name: s.organizationName,
  status: s.status,
  requested_at: s.requestedAt?.toISOString() ?? null,
  due_at: s.dueAt?.toISOString() ?? null,
  requested_by_me: s.requestedByMe,
});

function problemOf(err: OrgDeletionError, correlationId: string): Response {
  return err.code === "REAUTH_REQUIRED"
    ? simpleProblem("REAUTH_REQUIRED", 401, t("tenancy.deletion.reauth_required"), correlationId, {
        reason: "reauth_required",
      })
    : simpleProblem("FORBIDDEN", 403, t("tenancy.deletion.forbidden"), correlationId);
}

const actorOf = (req: Request, deps: OrgDeletionDeps, correlationId: string) =>
  actorFromRequest(req, deps, correlationId, { allowPendingDeletion: true });

export async function handleGetOrgDeletion(req: Request, deps: OrgDeletionDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const actor = await actorOf(req, deps, correlationId);
  if (actor instanceof Response) return actor;
  return json({ data: statusJson(await orgDeletionStatus(deps.db, actor)) }, 200, correlationId);
}

async function reauthAt(
  req: Request,
  deps: OrgDeletionDeps,
  actor: Actor,
  password: string | undefined,
  correlationId: string,
): Promise<Date | null | Response> {
  if (password === undefined) return actor.authenticatedAt ?? null;
  const security = {
    actor: { authUserId: actor.authUserId },
    client: requestClient(req.headers),
    correlationId,
  };
  const rate = await rateLimitHit(deps.db, {
    scope: "org_deletion.reauth",
    subject: actor.authUserId,
    limit: DSAR_PASSWORD_ATTEMPTS_PER_15_MIN,
    windowSeconds: minutesToSeconds(15),
  });
  if (!rate.allowed) {
    emitSecurity({
      ...security,
      event: "rate_limit.exceeded",
      outcome: "denied",
      target: { type: "route", id: "org_deletion.reauth" },
      reason: "RATE_LIMITED",
    });
    return simpleProblem("RATE_LIMITED", 429, t("tenancy.deletion.rate_limited"), correlationId, {
      retry_after: rate.retryAfter ?? SECONDS_PER_MINUTE,
    });
  }
  const ok = deps.verifyPassword ? await deps.verifyPassword(req.headers, password) : false;
  if (!ok) {
    emitSecurity({
      ...security,
      event: "auth.reauth_required",
      outcome: "denied",
      target: { type: "organization", id: actor.orgId },
      reason: "invalid_password",
    });
    return simpleProblem("REAUTH_REQUIRED", 401, t("tenancy.deletion.password_invalid"), correlationId, {
      reason: "invalid_password",
    });
  }
  return deps.now?.() ?? new Date();
}

export async function handleRequestOrgDeletion(req: Request, deps: OrgDeletionDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const actor = await actorOf(req, deps, correlationId);
  if (actor instanceof Response) return actor;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
  }
  const parsed = requestOrgDeletionInput.safeParse(raw);
  if (!parsed.success) return validationProblem(parsed.error, correlationId);
  if (actor.role !== "owner") return problemOf(new OrgDeletionError("FORBIDDEN"), correlationId);
  const at = await reauthAt(req, deps, actor, parsed.data.password, correlationId);
  if (at instanceof Response) return at;
  try {
    const r = await requestOrgDeletion(deps.db, actor, {
      reauthenticatedAt: at,
      correlationId,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    const status = await orgDeletionStatus(deps.db, actor);
    return json(
      { data: { result: r.status, ...statusJson(status) } },
      r.status === "created" ? 202 : 200,
      correlationId,
    );
  } catch (err) {
    if (err instanceof OrgDeletionError) return problemOf(err, correlationId);
    throw err;
  }
}

export async function handleCancelOrgDeletion(req: Request, deps: OrgDeletionDeps): Promise<Response> {
  const correlationId = correlationOf(req);
  const actor = await actorOf(req, deps, correlationId);
  if (actor instanceof Response) return actor;
  try {
    const cancelled = await cancelOrgDeletion(deps.db, actor, { correlationId });
    const status = await orgDeletionStatus(deps.db, actor);
    return json({ data: { cancelled, ...statusJson(status) } }, 200, correlationId);
  } catch (err) {
    if (err instanceof OrgDeletionError) return problemOf(err, correlationId);
    throw err;
  }
}
