// GET /api/v1/portal/guest/stays/{id} (SPEC-portal S-016…S-020): khách không phiên — token qua header `X-Guest-Token`
// (không đặt trên URL để khỏi lọt vào log/referrer), bước hai `X-Guest-Verify` (4 số cuối SĐT người đặt).
import type { Kysely } from "kysely";
import { correlationOf, json, simpleProblem } from "../http/command-route.ts";
import { CommandError } from "../pipeline/problem.ts";
import { guestGetStay } from "./guest.ts";

export async function handleGuestStay(
  req: Request,
  stayId: string,
  deps: { db: Kysely<unknown>; clientIp: string },
): Promise<Response> {
  const correlationId = correlationOf(req);
  try {
    const phone = req.headers.get("x-guest-verify")?.trim();
    const data = await guestGetStay(deps.db, {
      token: req.headers.get("x-guest-token")?.trim() ?? "",
      stayId,
      ip: deps.clientIp,
      ...(phone ? { phoneLast4: phone } : {}),
    });
    return json({ data }, 200, correlationId);
  } catch (err) {
    if (err instanceof CommandError) return simpleProblem(err.code, err.status, err.message, correlationId);
    throw err;
  }
}
