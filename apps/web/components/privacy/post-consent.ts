// Gửi lựa chọn đồng ý của CHÍNH người đang đăng nhập (POST /api/v1/me/consents — T-2310, D-122). Server lấy người dùng từ phiên,
// tự tính băm văn bản; client chỉ gửi mục đích, có/không, nơi chọn và phiên bản văn bản đã hiển thị.
import { timedFetch } from "../../lib/fetch-timeout.ts";

export type ConsentChannel = "signup" | "invite" | "portal" | "settings";

export interface ConsentChoice {
  purpose: string;
  granted: boolean;
  channel: ConsentChannel;
  /** Phiên bản văn bản đang hiển thị — server trả 409 nếu đã có bản mới hơn. */
  version: string;
}

export async function postConsent(
  c: ConsentChoice,
): Promise<{ ok: boolean; status: number; result: "recorded" | "unchanged" | null }> {
  const res = await timedFetch("/api/v1/me/consents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      purpose: c.purpose,
      granted: c.granted,
      channel: c.channel,
      policy_version: c.version,
    }),
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { status?: "recorded" | "unchanged" } };
  return { ok: res.ok, status: res.status, result: body.data?.status ?? null };
}
