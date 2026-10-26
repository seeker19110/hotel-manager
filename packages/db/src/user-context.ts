import { type Kysely, sql, type Transaction } from "kysely";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Đặt ngữ cảnh người dùng (`SET LOCAL app.user_id`) trong transaction ĐANG mở — hết transaction (hoặc lùi savepoint) là hết. */
export async function setUserContext<DB>(trx: Transaction<DB>, userId: string): Promise<void> {
  if (!UUID.test(userId)) throw new Error("userId is not a UUID");
  await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
}

/**
 * Chạy `fn` trong một transaction có ngữ cảnh NGƯỜI DÙNG (`app.user_id`) — RLS của bảng theo tài khoản, không theo tổ chức
 * (`consent_records`, migration 0068; `app.current_user_id()`). `userId` phải là id `auth."user"` lấy từ phiên đã xác minh ở
 * server, không từ client. Không đặt `app.org_id`: bảng theo tổ chức trong transaction này vẫn bị RLS chặn (fail-closed).
 */
export async function withUserContext<DB, T>(
  db: Kysely<DB>,
  userId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) throw new Error("userId is not a UUID");
  return db.transaction().execute(async (trx) => {
    await setUserContext(trx, userId);
    return fn(trx);
  });
}
