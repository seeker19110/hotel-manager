// POST /api/v1/notifications/unsubscribe — huỷ đăng ký email bằng token ký trong email (SPEC-notifications S-010). Không phiên.
import { handleUnsubscribe, serverContext } from "@hm/app";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { db, config } = serverContext();
  return handleUnsubscribe(req, { db, secret: config.BETTER_AUTH_SECRET });
}
