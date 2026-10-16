// Healthcheck tối thiểu; kiểm DB + hàng đợi thêm ở T-005/T-008 (ARCHITECTURE "Quan sát tối thiểu").
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok" },
    { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}
