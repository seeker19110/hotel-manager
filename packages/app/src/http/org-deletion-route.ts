// /api/v1/privacy/org-deletion-certificates — chứng nhận xoá tổ chức (T-2312; IND-SAAS-006; D-121) cho CHÍNH người đã yêu cầu xoá.
// Chủ thể luôn là người dùng của PHIÊN (không nhận id người từ request); tổ chức đã purge không còn thành viên nên không dùng ngữ cảnh tổ chức.
//  - GET: danh sách (id, tổ chức, mốc thời gian, sha256).
//  - GET `?id=<uuid>`: tải tệp JSON NGUYÊN VĂN như đã băm (người nhận tự `sha256sum` để đối chiếu `content_sha256`); không phải của mình ⇒ 404.
import { t } from "../i18n.ts";
import { toProblem } from "../pipeline/index.ts";
import { myOrgDeletionCertificates } from "../tenancy/index.ts";
import {
  correlationOf,
  type HttpDeps,
  json,
  problemResponse,
  simpleProblem,
  UNAUTHENTICATED_TITLE,
} from "./command-route.ts";

type Deps = Pick<HttpDeps, "db" | "getSession" | "onUnexpectedError">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleOrgDeletionCertificatesGet(req: Request, deps: Deps): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const session = await deps.getSession(req.headers);
    if (!session) return simpleProblem("UNAUTHENTICATED", 401, UNAUTHENTICATED_TITLE, correlationId);
    const certs = await myOrgDeletionCertificates(deps.db, session.user.id);
    const id = new URL(req.url).searchParams.get("id");
    if (id !== null) {
      const c = UUID.test(id) ? certs.find((x) => x.id === id) : undefined;
      if (!c) return simpleProblem("NOT_FOUND", 404, t("common.not_found"), correlationId);
      return new Response(c.content, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="chung-nhan-xoa-to-chuc-${c.organizationId}.json"`,
          "cache-control": "no-store",
          "x-content-sha256": c.contentSha256,
          "x-correlation-id": correlationId,
        },
      });
    }
    return json(
      {
        certificates: certs.map((c) => ({
          id: c.id,
          organization_id: c.organizationId,
          requested_at: c.requestedAt.toISOString(),
          due_at: c.dueAt.toISOString(),
          purged_at: c.purgedAt.toISOString(),
          content_sha256: c.contentSha256,
        })),
      },
      200,
      correlationId,
    );
  } catch (err) {
    deps.onUnexpectedError?.(err, correlationId);
    return problemResponse(toProblem(err, correlationId), correlationId);
  }
}
