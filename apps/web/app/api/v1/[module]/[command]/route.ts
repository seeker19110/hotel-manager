// POST /api/v1/<module>/<command> — mọi command công khai đi qua một chỗ (API-CONTRACT §1; danh mục ở @hm/app COMMANDS).
import { findCommand, handleCommand } from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ module: string; command: string }> },
) {
  const { module, command } = await params;
  const def = findCommand(module, command);
  if (!def) {
    return Response.json(
      {
        type: "https://hotel-manager.invalid/errors/NOT_FOUND",
        title: "Không có command này",
        status: 404,
        code: "NOT_FOUND",
      },
      { status: 404, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } },
    );
  }
  return handleCommand(def, req, httpDeps());
}
