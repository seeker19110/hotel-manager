// POST /api/v1/session/switchOrganization — `session.switchOrganization` (SPEC-access-and-property S-020, API-CONTRACT §1).
// Đầu vào { organization_id, property_id? } + `Idempotency-Key`. Chỉ đặt cookie chọn ngữ cảnh sau khi đối chiếu membership
// (cookie không phải quyền: mọi request vẫn resolveActor). Idempotency như mọi command: cùng key + cùng payload → kết
// quả cũ; khác payload → 409 IDEMPOTENCY_CONFLICT; kết quả lưu ở idempotency_keys của tổ chức đích.
import { randomUUID } from "node:crypto";
import { orgCookieName, serverContext, switchOrganization, withHttpMetrics } from "@hm/app";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(status: number, code: string, title: string) {
  return NextResponse.json(
    { type: `https://hotel-manager.invalid/errors/${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } },
  );
}

export const POST = withHttpMetrics("/api/v1/session/switchOrganization", handle);

async function handle(req: Request): Promise<Response> {
  const { auth, db, config } = serverContext();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return problem(401, "UNAUTHENTICATED", "Cần đăng nhập");

  const key = req.headers.get("idempotency-key") ?? "";
  if (!UUID.test(key)) return problem(400, "MALFORMED_REQUEST", "Thiếu hoặc sai Idempotency-Key (UUID)");
  let body: { organization_id?: unknown; property_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return problem(400, "MALFORMED_REQUEST", "Thân yêu cầu không phải JSON hợp lệ");
  }
  const orgId = typeof body.organization_id === "string" ? body.organization_id : "";
  const propertyId =
    body.property_id == null ? null : typeof body.property_id === "string" ? body.property_id : "";
  if (!UUID.test(orgId) || (propertyId !== null && !UUID.test(propertyId))) {
    return problem(422, "VALIDATION_FAILED", "organization_id/property_id phải là UUID");
  }
  const result = await switchOrganization(db, session.user.id, {
    key,
    organizationId: orgId,
    propertyId,
    correlationId: req.headers.get("x-correlation-id") ?? randomUUID(),
  });
  if (result.kind === "conflict")
    return problem(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key đã dùng cho yêu cầu khác");
  if (result.kind === "not_found") return problem(404, "NOT_FOUND", "Không tìm thấy tổ chức");
  const { context } = result;

  const secure = config.APP_BASE_URL.startsWith("https://");
  const res = NextResponse.json(
    { command_id: key.toLowerCase(), status: "committed", data: { context } },
    { headers: { "cache-control": "no-store" } },
  );
  res.cookies.set(orgCookieName(secure), context.organization.id, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
  });
  return res;
}
