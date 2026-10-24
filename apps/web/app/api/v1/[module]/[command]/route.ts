// POST /api/v1/<module>/<command> — mọi command công khai đi qua một chỗ (API-CONTRACT §1; danh mục ở @hm/app COMMANDS);
// GET /api/v1/<module>/<query> — query chỉ đọc (danh mục QUERIES).
import {
  findCommand,
  findQuery,
  findUserCommand,
  handleCommand,
  handleQuery,
  handleUserCommand,
} from "@hm/app";
import { httpDeps } from "../../../../../lib/http-deps.ts";
import { t } from "../../../../../lib/i18n.ts";

export const dynamic = "force-dynamic";

const notFound = () =>
  Response.json(
    {
      type: "https://hotel-manager.invalid/errors/NOT_FOUND",
      title: t("api.command_not_found.title"),
      status: 404,
      code: "NOT_FOUND",
    },
    {
      status: 404,
      headers: { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store" },
    },
  );

export async function GET(
  req: Request,
  { params }: { params: Promise<{ module: string; command: string }> },
) {
  const { module, command } = await params;
  const def = findQuery(module, command);
  return def ? handleQuery(def, req, httpDeps()) : notFound();
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ module: string; command: string }> },
) {
  const { module, command } = await params;
  const def = findCommand(module, command);
  if (def) return handleCommand(def, req, httpDeps());
  const userDef = findUserCommand(module, command);
  return userDef ? handleUserCommand(userDef, req, httpDeps()) : notFound();
}
