// POST /api/v1/session/switchOrganization — `session.switchOrganization` (SPEC-access-and-property S-020, API-CONTRACT §1).
// Đầu vào { organization_id, property_id? } + `Idempotency-Key`. Chỉ đặt cookie chọn ngữ cảnh sau khi đối chiếu membership
// (cookie không phải quyền: mọi request vẫn resolveActor). Lệnh tự idempotent (không ghi CSDL) nên không lưu
// idempotency_keys: gửi lại cùng key trả cùng ngữ cảnh; `GET /commands/{id}` trả 404 → client được gửi lại cùng key.
import { organizationContext, orgCookieName, serverContext } from "@hm/app";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(status: number, code: string, title: string) {
  return NextResponse.json(
    { type: `https://hotel-manager.invalid/errors/${code}`, title, status, code },
    { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } },
  );
}

export async function POST(req: Request): Promise<Response> {
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
  const context = await organizationContext(db, session.user.id, orgId, propertyId);
  if (!context) return problem(404, "NOT_FOUND", "Không tìm thấy tổ chức");

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
