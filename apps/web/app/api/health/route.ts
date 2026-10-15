// Healthcheck tối thiểu; kiểm DB + hàng đợi thêm ở T-005/T-008 (ARCHITECTURE "Quan sát tối thiểu").
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
