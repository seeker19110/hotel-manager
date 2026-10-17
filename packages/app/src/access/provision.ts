// Lệnh "cấp người dùng": người gọi CHƯA là thành viên của tổ chức đích nên không đi qua `resolveActor` (SPEC-access S-001, S-007).
// Actor dựng sẵn với id TẤT ĐỊNH theo (người dùng, Idempotency-Key): gửi lại cùng key ⇒ cùng id ⇒ cùng khoá idempotency ⇒ replay;
// hàng tổ chức/person/membership được ghi trong `bootstrap` của pipeline (cùng transaction với audit + outbox — INV-G6).
import { createHash } from "node:crypto";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../actor-core/index.ts";
import type { SecurityClient } from "../logging/index.ts";
import { type CommandResult, executeCommand } from "../pipeline/index.ts";

export interface UserCommandRequest {
  db: Kysely<unknown>;
  userId: string;
  /** Idempotency-Key (UUID). */
  key: string;
  /** Thân yêu cầu gốc (đã NFC) — băm để phát hiện cùng key khác nội dung. */
  payload: unknown;
  correlationId: string;
  client?: SecurityClient;
}

/** UUID (dạng v4) suy ra từ nhãn + người dùng + key: cùng đầu vào ⇒ cùng id. Người khác dùng cùng key ⇒ id khác. */
export function deriveUuid(label: string, userId: string, key: string): string {
  const h = createHash("sha256").update(`${label}\0${userId}\0${key.toLowerCase()}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x40;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Hai request cùng key chạy song song: bên thua đụng khoá chính của bản dựng sẵn ⇒ chạy lại để replay kết quả bên thắng. */
export function isDerivedRowCollision(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return (
    e?.code === "23505" &&
    ["organizations_pkey", "persons_pkey", "memberships_pkey"].includes(e.constraint ?? "")
  );
}

export async function runUserCommand<T>(
  req: UserCommandRequest,
  spec: {
    command: string;
    actor: Actor;
    bootstrap: Parameters<typeof executeCommand>[2]["bootstrap"];
    handler: Parameters<typeof executeCommand<T>>[3];
  },
): Promise<CommandResult<T>> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await executeCommand<T>(
        req.db,
        spec.actor,
        {
          command: spec.command,
          idempotencyKey: req.key,
          payload: req.payload,
          correlationId: req.correlationId,
          ...(req.client ? { client: req.client } : {}),
          ...(spec.bootstrap ? { bootstrap: spec.bootstrap } : {}),
        },
        spec.handler,
      );
    } catch (err) {
      if (!isDerivedRowCollision(err)) throw err;
      last = err;
    }
  }
  throw last;
}

/** Tên hiển thị + email chuẩn hoá của người dùng đăng nhập (đọc từ CSDL, không tin dữ liệu client). */
export async function readAuthUser(
  trx: Transaction<unknown> | Kysely<unknown>,
  userId: string,
): Promise<{ name: string; email: string } | null> {
  const r = await sql<{ name: string; email: string }>`
    select name, lower(btrim(email)) as email from auth."user" where id = ${userId}`.execute(trx);
  return r.rows[0] ?? null;
}
