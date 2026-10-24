// POST /api/v1/session/switchOrganization — `session.switchOrganization` (SPEC-access-and-property S-020, API-CONTRACT §1).
// Đầu vào { organization_id, property_id? } + `Idempotency-Key`; schema strict (trường lạ → 422, khớp OpenAPI
// `additionalProperties: false`). Chỉ đặt cookie chọn ngữ cảnh sau khi đối chiếu membership (cookie không phải quyền: mọi
// request vẫn resolveActor). Idempotency như mọi command: cùng key + cùng payload → kết quả cũ; khác payload → 422
// IDEMPOTENCY_CONFLICT; kết quả lưu ở idempotency_keys của tổ chức đích. Tách khỏi route Next để test được (BASE-SEC-001).
import { z } from "zod";
import { orgCookieName, switchOrganization } from "../access/index.ts";
import { t } from "../i18n.ts";
import { correlationOf, type HttpDeps, json, simpleProblem, validationProblem } from "./command-route.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID);

export const switchOrganizationInput = z.strictObject({
  organization_id: uuid,
  property_id: uuid.nullish(),
});

export async function handleSwitchOrganization(
  req: Request,
  deps: Pick<HttpDeps, "db" | "getSession" | "secureCookies">,
): Promise<Response> {
  const correlationId = correlationOf(req);
  const session = await deps.getSession(req.headers);
  if (!session) return simpleProblem("UNAUTHENTICATED", 401, t("http.unauthenticated"), correlationId);

  const key = req.headers.get("idempotency-key") ?? "";
  if (!UUID.test(key))
    return simpleProblem("MALFORMED_REQUEST", 400, t("http.idempotency_key_invalid"), correlationId);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return simpleProblem("MALFORMED_REQUEST", 400, t("http.body_not_json"), correlationId);
  }
  const parsed = switchOrganizationInput.safeParse(raw);
  if (!parsed.success) return validationProblem(parsed.error, correlationId);

  const result = await switchOrganization(deps.db, session.user.id, {
    key,
    organizationId: parsed.data.organization_id,
    propertyId: parsed.data.property_id ?? null,
    correlationId,
  });
  if (result.kind === "conflict")
    return simpleProblem("IDEMPOTENCY_CONFLICT", 422, t("http.idempotency_conflict"), correlationId);
  if (result.kind === "not_found")
    return simpleProblem("NOT_FOUND", 404, t("http.organization_not_found"), correlationId);
  const { context } = result;

  const res = json(
    { command_id: key.toLowerCase(), status: "committed", data: { context } },
    200,
    correlationId,
  );
  // Cookie `__Host-` (HTTPS) buộc Secure + Path=/ + không Domain; giá trị là UUID đã đối chiếu nên không cần mã hoá.
  res.headers.append(
    "set-cookie",
    `${orgCookieName(deps.secureCookies)}=${context.organization.id}; Path=/; HttpOnly; SameSite=Lax${deps.secureCookies ? "; Secure" : ""}`,
  );
  return res;
}
