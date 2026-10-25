// Thu/rút đồng ý theo mục đích (PLAN T-2310; CMP-RIGHTS-001/004, CMP-VN-001; D-122) trên `consent_records` (migration 0068,
// append-only, RLS theo ngữ cảnh NGƯỜI DÙNG `app.user_id`).
// - Mô hình: mỗi lần cho/rút là MỘT hàng mới; trạng thái hiện tại = hàng mới nhất theo (recorded_at, seq) của (người, mục đích).
// - Idempotent theo TRẠNG THÁI (chọn: không ghi thêm khi không đổi): cho khi đang cho CÙNG phiên bản văn bản, hoặc rút khi chưa
//   từng cho/đã rút ⇒ `unchanged`, không thêm hàng — lịch sử chỉ chứa thay đổi thật, bấm đúp/gửi lại không làm phình bằng chứng.
//   Cho lại theo phiên bản văn bản MỚI ⇒ ghi hàng mới (đồng ý gắn với văn bản đã thấy). Đọc-rồi-ghi được tuần tự hoá bằng khoá
//   advisory theo (người, mục đích) trong transaction nên hai yêu cầu đồng thời không cùng ghi một trạng thái.
// - Không ghi `audit_events`: bảng đó theo tổ chức (organization_id NOT NULL, người thao tác là `persons` của tổ chức) còn đồng ý
//   là của tài khoản, có từ trước khi thuộc tổ chức nào; chính `consent_records` append-only là nhật ký bằng chứng (ai, mục đích,
//   hành động, phiên bản + băm văn bản, kênh, thời điểm do CSDL đặt).
import { randomUUID } from "node:crypto";
import { setUserContext, withUserContext } from "@hm/db";
import { type Kysely, sql, type Transaction } from "kysely";
import type { AnalyticsDb, ConsentCheck } from "../analytics/index.ts";
import {
  type ConsentPurpose,
  isConsentPurpose,
  PURPOSES,
  type PurposeView,
  purposeDef,
  purposeView,
  uiSnapshotHash,
} from "./purposes.ts";

export const CONSENT_CHANNELS = ["signup", "invite", "portal", "settings"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type ConsentAction = "grant" | "withdraw";

export interface ConsentRecord {
  id: string;
  purpose: ConsentPurpose;
  action: ConsentAction;
  policyVersion: string;
  channel: ConsentChannel;
  uiSnapshotHash: string;
  recordedAt: Date;
}

/** Lỗi nghiệp vụ của đồng ý: phiên bản văn bản client đã hiển thị khác bản hiện hành (client phải tải lại). */
export class ConsentError extends Error {
  readonly code = "POLICY_VERSION_STALE";
  readonly currentVersion: string;
  constructor(currentVersion: string) {
    super("POLICY_VERSION_STALE");
    this.name = "ConsentError";
    this.currentVersion = currentVersion;
  }
}

export interface SetConsentInput {
  purpose: ConsentPurpose;
  channel: ConsentChannel;
  /** Phiên bản văn bản client đã hiển thị; có thì phải bằng bản hiện hành (khác ⇒ ConsentError). */
  policyVersion?: string;
}

export interface SetConsentResult {
  status: "recorded" | "unchanged";
  granted: boolean;
  record: ConsentRecord | null;
}

interface Row {
  id: string;
  purpose: string;
  action: ConsentAction;
  policy_version: string;
  channel: ConsentChannel;
  ui_snapshot_hash: string;
  recorded_at: Date;
}

const toRecord = (r: Row): ConsentRecord => ({
  id: r.id,
  purpose: r.purpose as ConsentPurpose,
  action: r.action,
  policyVersion: r.policy_version,
  channel: r.channel,
  uiSnapshotHash: r.ui_snapshot_hash,
  recordedAt: r.recorded_at,
});

async function latest(trx: AnalyticsDb, userId: string, purpose: ConsentPurpose): Promise<Row | undefined> {
  const r = await sql<Row>`
    select id, purpose, action, policy_version, channel, ui_snapshot_hash, recorded_at from consent_records
    where subject_user_id = ${userId}::uuid and purpose = ${purpose}
    order by recorded_at desc, seq desc limit 1`.execute(trx);
  return r.rows[0];
}

/** Đồng ý còn hiệu lực = hàng mới nhất là `grant` THEO ĐÚNG phiên bản văn bản hiện hành. */
const isEffectiveGrant = (row: Row | undefined, purpose: ConsentPurpose): boolean =>
  row?.action === "grant" && row.policy_version === purposeDef(purpose).version;

async function setConsent(
  db: Kysely<unknown>,
  userId: string,
  action: ConsentAction,
  input: SetConsentInput,
): Promise<SetConsentResult> {
  if (!isConsentPurpose(input.purpose)) throw new Error(`unknown consent purpose "${input.purpose}"`);
  if (!(CONSENT_CHANNELS as readonly string[]).includes(input.channel))
    throw new Error(`unknown consent channel "${input.channel}"`);
  const def = purposeDef(input.purpose);
  if (input.policyVersion !== undefined && input.policyVersion !== def.version)
    throw new ConsentError(def.version);
  return withUserContext(db, userId, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`consent:${userId}:${input.purpose}`}, 0))`.execute(
      trx,
    );
    const cur = await latest(trx, userId, input.purpose);
    const unchanged =
      action === "grant"
        ? cur?.action === "grant" && cur.policy_version === def.version
        : cur === undefined || cur.action === "withdraw";
    if (unchanged)
      return {
        status: "unchanged",
        granted: isEffectiveGrant(cur, input.purpose),
        record: cur ? toRecord(cur) : null,
      };
    const r = await sql<Row>`
      insert into consent_records (id, subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
      values (${randomUUID()}, ${userId}::uuid, ${input.purpose}, ${action}, ${def.version}, ${input.channel},
              ${uiSnapshotHash(def)})
      returning id, purpose, action, policy_version, channel, ui_snapshot_hash, recorded_at`.execute(trx);
    const row = r.rows[0] as Row;
    return { status: "recorded", granted: action === "grant", record: toRecord(row) };
  });
}

/** Cho đồng ý một mục đích (idempotent theo trạng thái + phiên bản văn bản). `userId` lấy từ phiên đã xác minh ở server. */
export function grantConsent(
  db: Kysely<unknown>,
  userId: string,
  input: SetConsentInput,
): Promise<SetConsentResult> {
  return setConsent(db, userId, "grant", input);
}

/** Rút đồng ý (idempotent: chưa từng cho/đã rút ⇒ không ghi thêm). Rút KHÔNG cần khớp phiên bản văn bản. */
export function withdrawConsent(
  db: Kysely<unknown>,
  userId: string,
  input: Omit<SetConsentInput, "policyVersion">,
): Promise<SetConsentResult> {
  return setConsent(db, userId, "withdraw", input);
}

export interface PurposeStatus extends PurposeView {
  /** null = mục không cần đồng ý. */
  granted: boolean | null;
  /** Hàng mới nhất (cho hoặc rút) — null khi chưa từng chọn. */
  last: ConsentRecord | null;
  /** Đã từng đồng ý theo phiên bản văn bản cũ hơn ⇒ cần hỏi lại. */
  outdated: boolean;
}

/** Trạng thái hiện tại của MỌI mục đích trong danh mục cho người dùng (đọc qua RLS của chính họ). */
export async function consentOverview(db: Kysely<unknown>, userId: string): Promise<PurposeStatus[]> {
  return withUserContext(db, userId, async (trx) => {
    const out: PurposeStatus[] = [];
    for (const def of PURPOSES) {
      const view = purposeView(def);
      if (!def.requiresConsent || !isConsentPurpose(def.id)) {
        out.push({ ...view, granted: null, last: null, outdated: false });
        continue;
      }
      const row = await latest(trx, userId, def.id);
      out.push({
        ...view,
        granted: isEffectiveGrant(row, def.id),
        last: row ? toRecord(row) : null,
        outdated: row?.action === "grant" && row.policy_version !== def.version,
      });
    }
    return out;
  });
}

/** Toàn bộ lịch sử đồng ý của người dùng, cũ → mới (xuất được — quyền truy cập của chủ thể). */
export async function consentHistory(db: Kysely<unknown>, userId: string): Promise<ConsentRecord[]> {
  return withUserContext(db, userId, async (trx) => {
    const r = await sql<Row>`
      select id, purpose, action, policy_version, channel, ui_snapshot_hash, recorded_at from consent_records
      where subject_user_id = ${userId}::uuid
      order by recorded_at, seq`.execute(trx);
    return r.rows.map(toRecord);
  });
}

// ---------- bộ kiểm đồng ý cho analytics (nối `configureAnalytics({ consent })`) ----------

const isTransaction = (db: AnalyticsDb): db is Transaction<unknown> =>
  (db as { isTransaction?: boolean }).isTransaction === true;

/** Cache theo TRANSACTION: một lệnh phát nhiều sự kiện chỉ đọc đồng ý một lần; hết transaction thì đối tượng bị thu gom. */
const perTransaction = new WeakMap<object, Map<string, boolean>>();

/**
 * Người dùng có đồng ý còn hiệu lực cho mục đích không. Trong transaction của lệnh: đọc trong SAVEPOINT riêng, đặt `app.user_id`
 * cục bộ rồi LÙI savepoint (giá trị cũ của `app.user_id` được khôi phục, transaction của lệnh không bị đổi ngữ cảnh, lỗi đọc không
 * làm transaction "aborted"); kết quả cache theo transaction. Ngoài transaction: mở transaction ngắn có ngữ cảnh người dùng.
 */
export async function hasConsent(db: AnalyticsDb, userId: string, purpose: ConsentPurpose): Promise<boolean> {
  if (!isTransaction(db)) {
    return withUserContext(db as Kysely<unknown>, userId, async (trx) =>
      isEffectiveGrant(await latest(trx, userId, purpose), purpose),
    );
  }
  const key = `${userId}:${purpose}`;
  const cached = perTransaction.get(db)?.get(key);
  if (cached !== undefined) return cached;
  await sql`savepoint hm_consent`.execute(db);
  let ok = false;
  try {
    await setUserContext(db, userId);
    ok = isEffectiveGrant(await latest(db, userId, purpose), purpose);
  } finally {
    await sql`rollback to savepoint hm_consent`.execute(db);
  }
  let m = perTransaction.get(db);
  if (!m) {
    m = new Map();
    perTransaction.set(db, m);
  }
  m.set(key, ok);
  return ok;
}

/**
 * Bộ kiểm đồng ý thật cho `track()` (D-118 → D-122): không có người thao tác ⇒ từ chối; còn lại đọc `consent_records` trong CHÍNH
 * kết nối/transaction của sự kiện (`env.db`) — không mượn thêm kết nối từ pool khi lệnh đang giữ một. Thiếu `env.db` ⇒ dùng
 * `fallbackDb` (nếu có), không thì từ chối. Lỗi ⇒ `track()` coi như không đồng ý (fail closed).
 */
export function createAnalyticsConsentCheck(fallbackDb?: Kysely<unknown>): ConsentCheck {
  return async (q, env) => {
    if (!q.actorUserId || q.purpose !== "analytics") return false;
    const db = env?.db ?? fallbackDb;
    if (!db) return false;
    return hasConsent(db, q.actorUserId, q.purpose);
  };
}
