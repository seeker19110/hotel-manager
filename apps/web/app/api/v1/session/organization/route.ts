// session.switchOrganization (SPEC-access-and-property S-020): đặt cookie chọn tổ chức sau khi đối chiếu membership.
// Form HTML → 303 về /phong; JSON → 200 kèm ngữ cảnh. Cookie không phải quyền: mọi request vẫn resolveActor.
import { ORG_COOKIE, selectOrganization, serverContext } from "@hm/app";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

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

  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  let orgId = "";
  try {
    orgId = isForm
      ? String((await req.formData()).get("organizationId") ?? "")
      : String(((await req.json()) as { organizationId?: unknown }).organizationId ?? "");
  } catch {
    return problem(400, "MALFORMED_REQUEST", "Yêu cầu không đọc được");
  }
  const org = /^[0-9a-f-]{36}$/i.test(orgId) ? await selectOrganization(db, session.user.id, orgId) : null;
  if (!org) return problem(404, "NOT_FOUND", "Không tìm thấy tổ chức");

  const res = isForm
    ? NextResponse.redirect(new URL("/phong", config.APP_BASE_URL), 303)
    : NextResponse.json({ context: org }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(ORG_COOKIE, org.organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.APP_BASE_URL.startsWith("https://"),
    path: "/",
  });
  return res;
}
