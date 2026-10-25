// Đồng ý theo MỤC ĐÍCH (T-2310; CMP-RIGHTS-001, CMP-VN-001, CMP-RIGHTS-004; D-119). Bảng `consent_records` chỉ-thêm (migration 0068):
// mỗi lần cấp/rút là MỘT hàng mới; trạng thái hiện tại = hàng mới nhất theo (người dùng, mục đích). Không bao giờ sửa hàng cũ.
//
// - Danh mục ĐÓNG (`CONSENT_PURPOSES`, khớp CHECK của CSDL): `service_core` bắt buộc để dùng dịch vụ (thu ở đăng ký, nhận lời mời,
//   đăng nhập portal lần đầu); `product_analytics` tuỳ chọn, mặc định KHÔNG (opt-in) — `track()` bỏ qua người chưa đồng ý.
// - Bằng chứng: `policy_version` + `ui_snapshot_hash` = SHA-256 của đúng văn bản đã hiển thị (catalog i18n `privacy.consent.<mục đích>`),
//   tính Ở SERVER — client không gửi văn bản/băm. Đổi câu chữ ⇒ tăng `CONSENT_POLICY_VERSION`.
// - Chủ thể = id người dùng của PHIÊN đã xác minh ở server; mọi đọc/ghi chạy trong transaction có `SET LOCAL app.auth_user_id` nên RLS
//   (0068) chỉ cho thấy/ghi hàng của chính người đó — sai chủ thể ở app cũng không đọc/ghi được của người khác.
// - Đồng thời: khoá tư vấn theo (người, mục đích) trong transaction ghi ⇒ hai lần bật/tắt song song được xếp hàng; ghi chỉ khi trạng thái
//   ĐỔI (bấm hai lần không sinh hàng thừa), nên thứ tự `id` = thứ tự quyết định của người dùng.
import { createHash } from "node:crypto";
import { type Kysely, sql, type Transaction } from "kysely";
import { t } from "../i18n.ts";

export const CONSENT_PURPOSES = ["service_core", "product_analytics"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
/** Mục đích bắt buộc để dùng dịch vụ — không rút được ở trang Bảo mật (rút = xoá tài khoản, T-2311). */
export const REQUIRED_PURPOSES: readonly ConsentPurpose[] = ["service_core"];
export const CONSENT_CHANNELS = ["register", "invitation", "portal", "settings"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type ConsentAction = "grant" | "withdraw";

/** Phiên bản văn bản chính sách/đồng ý hiện hành (YYYY-MM-DD[.n], khớp CHECK của CSDL). Đổi văn bản `privacy.consent.*` ⇒ tăng. */
export const CONSENT_POLICY_VERSION = "2026-10-25";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isConsentPurpose = (v: unknown): v is ConsentPurpose =>
  typeof v === "string" && (CONSENT_PURPOSES as readonly string[]).includes(v);
export const isRequiredPurpose = (p: ConsentPurpose): boolean => REQUIRED_PURPOSES.includes(p);

/** Văn bản đồng ý của mục đích (đúng chuỗi hiển thị cho người dùng). */
export function consentText(purpose: ConsentPurpose): string {
  return purpose === "service_core"
    ? t("privacy.consent.service_core")
    : t("privacy.consent.product_analytics");
}

/** SHA-256 hex của văn bản đã hiển thị, gắn phiên bản + mục đích (cùng câu chữ ở hai mục đích vẫn khác băm). */
export function consentSnapshotHash(purpose: ConsentPurpose, version = CONSENT_POLICY_VERSION): string {
  return createHash("sha256")
    .update(`${version}\n${purpose}\n${consentText(purpose)}`, "utf8")
    .digest("hex");
}

/** Văn bản để giao diện hiển thị (server truyền xuống client) — cùng nguồn với băm bằng chứng. */
export interface ConsentDisplay {
  purpose: ConsentPurpose;
  required: boolean;
  text: string;
  policyVersion: string;
}
export function consentDisplays(): ConsentDisplay[] {
  return CONSENT_PURPOSES.map((purpose) => ({
    purpose,
    required: isRequiredPurpose(purpose),
    text: consentText(purpose),
    policyVersion: CONSENT_POLICY_VERSION,
  }));
}

export class ConsentError extends Error {
  readonly code: "CONSENT_WITHDRAW_REQUIRES_DELETION" | "CONSENT_INVALID";
  constructor(code: ConsentError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ConsentError";
  }
}

export interface ConsentState {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
  channel: ConsentChannel;
  recordedAt: Date;
}

export interface ConsentInput {
  /** Id người dùng của PHIÊN đã xác minh (không lấy từ thân request). */
  subjectId: string;
  purpose: ConsentPurpose;
  channel: ConsentChannel;
}

type Db = Kysely<unknown> | Transaction<unknown>;

function assertSubject(subjectId: string): void {
  if (!UUID.test(subjectId)) throw new ConsentError("CONSENT_INVALID", "consent: subjectId is not a UUID");
}

/** Đặt ngữ cảnh chủ thể cho RLS của `consent_records` trong transaction hiện tại (SET LOCAL). */
export async function setConsentSubject(trx: Transaction<unknown>, subjectId: string): Promise<void> {
  assertSubject(subjectId);
  await sql`select set_config('app.auth_user_id', ${subjectId}, true)`.execute(trx);
}

interface Row {
  purpose: ConsentPurpose;
  action: ConsentAction;
  policy_version: string;
  channel: ConsentChannel;
  ui_snapshot_hash: string;
  recorded_at: Date;
}

const toState = (r: Row): ConsentState => ({
  purpose: r.purpose,
  granted: r.action === "grant",
  policyVersion: r.policy_version,
  channel: r.channel,
  recordedAt: r.recorded_at,
});

async function latest(trx: Db, subjectId: string, purpose?: ConsentPurpose): Promise<Row[]> {
  const r = await sql<Row>`
    select distinct on (purpose) purpose, action, policy_version, channel, ui_snapshot_hash, recorded_at
    from public.consent_records
    where subject_user_id = ${subjectId} ${purpose ? sql`and purpose = ${purpose}` : sql``}
    order by purpose, id desc`.execute(trx);
  return r.rows;
}

/**
 * Ghi một lần cấp/rút TRONG transaction của người gọi (vd. bootstrap của `member.acceptInvitation` — cùng transaction với membership).
 * Đặt ngữ cảnh chủ thể, khoá tư vấn (người, mục đích), chỉ thêm hàng khi trạng thái đổi. Trả `changed` + trạng thái sau cùng.
 */
export async function recordConsentInTx(
  trx: Transaction<unknown>,
  input: ConsentInput & { action: ConsentAction },
): Promise<{ changed: boolean; state: ConsentState | null }> {
  if (!isConsentPurpose(input.purpose)) throw new ConsentError("CONSENT_INVALID", "consent: unknown purpose");
  if (!(CONSENT_CHANNELS as readonly string[]).includes(input.channel))
    throw new ConsentError("CONSENT_INVALID", "consent: unknown channel");
  if (input.action === "withdraw" && isRequiredPurpose(input.purpose))
    throw new ConsentError("CONSENT_WITHDRAW_REQUIRES_DELETION", t("privacy.withdraw_requires_deletion"));
  await setConsentSubject(trx, input.subjectId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`consent:${input.subjectId}:${input.purpose}`}, 0))`.execute(
    trx,
  );
  const [cur] = await latest(trx, input.subjectId, input.purpose);
  const hash = consentSnapshotHash(input.purpose);
  const unchanged =
    input.action === "grant"
      ? cur?.action === "grant" &&
        cur.policy_version === CONSENT_POLICY_VERSION &&
        cur.ui_snapshot_hash === hash
      : cur === undefined || cur.action === "withdraw"; // chưa từng cấp = chưa đồng ý: rút không có gì để ghi
  if (unchanged) return { changed: false, state: cur ? toState(cur) : null };
  const r = await sql<Row>`
    insert into public.consent_records (subject_user_id, purpose, action, policy_version, channel, ui_snapshot_hash)
    values (${input.subjectId}, ${input.purpose}, ${input.action}, ${CONSENT_POLICY_VERSION}, ${input.channel}, ${hash})
    returning purpose, action, policy_version, channel, ui_snapshot_hash, recorded_at`.execute(trx);
  return { changed: true, state: toState(r.rows[0] as Row) };
}

const inSubjectTx = async <T>(
  db: Kysely<unknown>,
  subjectId: string,
  fn: (trx: Transaction<unknown>) => Promise<T>,
) => {
  assertSubject(subjectId);
  return db.transaction().execute(async (trx) => {
    await setConsentSubject(trx, subjectId);
    return fn(trx);
  });
};

/** Cấp đồng ý (một hàng `grant`, trừ khi đã đồng ý đúng phiên bản hiện hành). */
export function grantConsent(db: Kysely<unknown>, input: ConsentInput) {
  return inSubjectTx(db, input.subjectId, (trx) => recordConsentInTx(trx, { ...input, action: "grant" }));
}

/** Rút đồng ý (một hàng `withdraw`). Mục đích bắt buộc → `ConsentError` CONSENT_WITHDRAW_REQUIRES_DELETION (xoá tài khoản, T-2311). */
export function withdrawConsent(db: Kysely<unknown>, input: ConsentInput) {
  return inSubjectTx(db, input.subjectId, (trx) => recordConsentInTx(trx, { ...input, action: "withdraw" }));
}

/** Trạng thái hiện tại từng mục đích của người dùng (null = chưa từng cấp/rút). */
export async function currentConsents(
  db: Kysely<unknown>,
  subjectId: string,
): Promise<Record<ConsentPurpose, ConsentState | null>> {
  const rows = await inSubjectTx(db, subjectId, (trx) => latest(trx, subjectId));
  const out = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, null])) as Record<
    ConsentPurpose,
    ConsentState | null
  >;
  for (const r of rows) if (isConsentPurpose(r.purpose)) out[r.purpose] = toState(r);
  return out;
}

/** Người dùng đang đồng ý mục đích này? (hàng mới nhất là `grant`). Id không phải UUID ⇒ false. */
export async function hasConsent(
  db: Kysely<unknown>,
  subjectId: string,
  purpose: ConsentPurpose,
): Promise<boolean> {
  if (!UUID.test(subjectId)) return false;
  return (await currentConsents(db, subjectId))[purpose]?.granted === true;
}

/** Như `hasConsent` nhưng trong transaction của người gọi (đặt ngữ cảnh chủ thể; không mở transaction mới). */
export async function hasConsentInTx(
  trx: Transaction<unknown>,
  subjectId: string,
  purpose: ConsentPurpose,
): Promise<boolean> {
  if (!UUID.test(subjectId)) return false;
  await setConsentSubject(trx, subjectId);
  const [cur] = await latest(trx, subjectId, purpose);
  return cur?.action === "grant";
}
