// Yêu cầu của chủ thể dữ liệu (DSAR — T-2311; STD-PRIV-004, CMP-RIGHTS-007, CMP-INTL-007, CMP-PRIV-005, CMP-VN-007; D-120, D-124).
// Ba quyền tự phục vụ của CHÍNH người đăng nhập (chủ thể = id người dùng của PHIÊN đã xác minh, không bao giờ từ thân request):
//  - TRUY CẬP (`access`): xuất JSON dữ liệu cá nhân, đồng bộ, sau khi xác thực lại ≤ 5 phút. Ghi một `dsar_requests` đã hoàn tất.
//  - XOÁ TÀI KHOẢN (`delete`): xác thực lại + gõ lại email; chặn nếu là owner active duy nhất của tổ chức. Hai pha:
//      1. NGAY trong request (app_runtime, một transaction): ghi yêu cầu, thu hồi MỌI phiên (để lại dấu vết → 401 SESSION_REVOKED), xoá
//         phương thức đăng nhập (mật khẩu)/2FA/mã xác minh, ẩn danh auth user (tên, email → giá trị không định danh) ⇒ không đăng nhập lại
//         được kể cả bằng OTP email cũ.
//      2. Worker (`processDsarErasures`, app_worker): xoá sự kiện phân tích của actor (hàm `app.forget_analytics_actor` — callback do
//         nơi lắp ráp truyền vào để module này không phụ thuộc `analytics`), rồi `app.dsar_complete_erasure`: kết thúc mọi membership
//         (audit từng tổ chức), ẩn danh hồ sơ người không gắn chứng từ, dọn phần auth còn sót, đóng yêu cầu với `result` (kho đã xoá +
//         kho GIỮ kèm lý do: consent_records — bằng chứng đồng ý D-124; chứng từ tiền — nghĩa vụ kế toán; audit_events).
//  - HẠN CHẾ XỬ LÝ (`restrict`): bật/tắt một bước; khi bật `track()` bỏ qua actor (mục đích tuỳ chọn duy nhất hiện có là phân tích).
// Module lá (ARC-MOD-004): chỉ dùng SQL + `consent.ts`; không import module app khác.
import { MS_PER_MINUTE, secondsToMs } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import { t } from "../i18n.ts";
import { setConsentSubject } from "./consent.ts";
import { DSAR_DEFAULT_REGION, type DsarKind, dsarDueAt } from "./dsar-policy.ts";

/** Xác thực lại: phiên phải được tạo (đăng nhập lại) trong 5 phút gần nhất — cùng ngưỡng với xuất dữ liệu tổ chức (exports). */
export const DSAR_REAUTH_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_MS = MS_PER_MINUTE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DsarErrorCode = "REAUTH_REQUIRED" | "SOLE_OWNER" | "CONFIRMATION_MISMATCH" | "DSAR_INVALID";

export class DsarError extends Error {
  readonly code: DsarErrorCode;
  readonly status: number;
  readonly soleOwnerOrgs: number;
  constructor(code: DsarErrorCode, status: number, message: string, soleOwnerOrgs = 0) {
    super(message);
    this.name = "DsarError";
    this.code = code;
    this.status = status;
    this.soleOwnerOrgs = soleOwnerOrgs;
  }
}

/** Phiên đã xác minh của người gọi. */
export interface DsarSubject {
  userId: string;
  /** Lúc tạo phiên (đăng nhập/xác thực lại). Thiếu ⇒ coi như chưa xác thực lại. */
  authenticatedAt?: Date | undefined;
}

export function assertDsarRecentAuth(authenticatedAt: Date | undefined, now: Date): void {
  const at = authenticatedAt?.getTime();
  if (
    at === undefined ||
    Number.isNaN(at) ||
    now.getTime() - at > secondsToMs(DSAR_REAUTH_MAX_AGE_SECONDS) ||
    at > now.getTime() + CLOCK_SKEW_MS
  )
    throw new DsarError("REAUTH_REQUIRED", 401, t("privacy.dsar.reauth_required"));
}

function assertUser(userId: string): void {
  if (!UUID.test(userId)) throw new DsarError("DSAR_INVALID", 400, "dsar: userId is not a UUID");
}

const inSubjectTx = <T>(
  db: Kysely<unknown>,
  userId: string,
  fn: (trx: Transaction<unknown>) => Promise<T>,
) => {
  assertUser(userId);
  return db.transaction().execute(async (trx) => {
    await setConsentSubject(trx, userId);
    return fn(trx);
  });
};

async function insertRequest(
  trx: Transaction<unknown>,
  r: { userId: string; kind: DsarKind; now: Date; completed: boolean; result: Record<string, unknown> },
): Promise<{ id: string; receivedAt: Date; dueAt: Date; region: string }> {
  const region = DSAR_DEFAULT_REGION;
  const dueAt = dsarDueAt(r.kind, r.now, region);
  const row = await sql<{ id: string }>`
    insert into dsar_requests (subject_user_id, kind, region, received_at, due_at, completed_at, status, result)
    values (${r.userId}, ${r.kind}, ${region}, ${r.now}, ${dueAt}, ${r.completed ? r.now : null},
            ${r.completed ? "completed" : "received"}, ${JSON.stringify(r.result)}::jsonb)
    returning id`.execute(trx);
  return { id: (row.rows[0] as { id: string }).id, receivedAt: r.now, dueAt, region };
}

// ───────────────────────────── Hạn chế xử lý ─────────────────────────────

/** Người dùng đang hạn chế xử lý? Trong transaction của người gọi (đặt ngữ cảnh chủ thể). Id không phải UUID ⇒ false. */
export async function isProcessingRestrictedInTx(
  trx: Transaction<unknown>,
  userId: string,
): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  await setConsentSubject(trx, userId);
  const r = await sql<{ one: number }>`
    select 1 as one from processing_restrictions where subject_user_id = ${userId}`.execute(trx);
  return r.rows.length > 0;
}

/** Bật/tắt hạn chế xử lý. Chỉ ghi khi trạng thái ĐỔI (bấm hai lần không sinh yêu cầu thừa). Khoá tư vấn theo người: hai lần song song xếp hàng. */
export async function setProcessingRestriction(
  db: Kysely<unknown>,
  input: { userId: string; active: boolean; now?: Date },
): Promise<{ active: boolean; changed: boolean; requestId: string | null }> {
  const now = input.now ?? new Date();
  return inSubjectTx(db, input.userId, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`dsar-restrict:${input.userId}`}, 0))`.execute(
      trx,
    );
    const cur = await isProcessingRestrictedInTx(trx, input.userId);
    if (cur === input.active) return { active: cur, changed: false, requestId: null };
    if (input.active)
      await sql`insert into processing_restrictions (subject_user_id, restricted_at) values (${input.userId}, ${now})`.execute(
        trx,
      );
    else await sql`delete from processing_restrictions where subject_user_id = ${input.userId}`.execute(trx);
    const req = await insertRequest(trx, {
      userId: input.userId,
      kind: "restrict",
      now,
      completed: true,
      result: { active: input.active },
    });
    return { active: input.active, changed: true, requestId: req.id };
  });
}

// ───────────────────────────── Trạng thái ─────────────────────────────

export interface DsarRequestView {
  id: string;
  kind: DsarKind;
  status: "received" | "completed" | "rejected";
  region: string;
  receivedAt: Date;
  dueAt: Date;
  completedAt: Date | null;
}

interface RequestRow {
  id: string;
  kind: DsarKind;
  status: DsarRequestView["status"];
  region: string;
  received_at: Date;
  due_at: Date;
  completed_at: Date | null;
  result: Record<string, unknown>;
}

const toView = (r: RequestRow): DsarRequestView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  region: r.region,
  receivedAt: r.received_at,
  dueAt: r.due_at,
  completedAt: r.completed_at,
});

async function requestsOf(trx: Transaction<unknown>, userId: string): Promise<RequestRow[]> {
  const r = await sql<RequestRow>`
    select id, kind, status, region, received_at, due_at, completed_at, result from dsar_requests
    where subject_user_id = ${userId} order by received_at desc, id desc limit 100`.execute(trx);
  return r.rows;
}

/** Trạng thái cho trang Bảo mật: đang hạn chế? owner duy nhất ở bao nhiêu tổ chức (xoá bị chặn)? lịch sử yêu cầu. */
export async function dsarStatus(
  db: Kysely<unknown>,
  userId: string,
): Promise<{ restricted: boolean; soleOwnerOrgs: number; requests: DsarRequestView[] }> {
  return inSubjectTx(db, userId, async (trx) => {
    const restricted = await isProcessingRestrictedInTx(trx, userId);
    const sole = await sql<{ n: number }>`select app.dsar_sole_owner_orgs() as n`.execute(trx);
    return {
      restricted,
      soleOwnerOrgs: sole.rows[0]?.n ?? 0,
      requests: (await requestsOf(trx, userId)).map(toView),
    };
  });
}

// ───────────────────────────── Truy cập (xuất) ─────────────────────────────

export const DSAR_EXPORT_FORMAT = "hm-dsar-access/1";

export interface DsarExport {
  format: typeof DSAR_EXPORT_FORMAT;
  generated_at: string;
  request: { id: string; received_at: string; due_at: string; region: string };
  account: {
    id: string;
    name: string;
    email: string;
    email_verified: boolean;
    two_factor_enabled: boolean;
    created_at: string;
  } | null;
  login_methods: { provider: string; created_at: string }[];
  sessions: {
    created_at: string;
    expires_at: string;
    ip_address: string | null;
    user_agent: string | null;
  }[];
  memberships: {
    organization_id: string;
    organization_name: string;
    role: string;
    status: string;
    valid_from: string;
    valid_to: string | null;
    revoked_at: string | null;
    person: {
      full_name: string;
      email: string | null;
      phone: string | null;
      address: string | null;
      nationality: string | null;
    };
  }[];
  consents: {
    purpose: string;
    action: string;
    policy_version: string;
    channel: string;
    recorded_at: string;
  }[];
  processing_restriction: { active: boolean; since: string | null };
  dsar_requests: {
    kind: string;
    status: string;
    region: string;
    received_at: string;
    due_at: string;
    completed_at: string | null;
  }[];
  analytics: {
    pseudonymous: true;
    total: number;
    by_event: { event: string; count: number; first_at: string; last_at: string }[];
  };
}

const iso = (d: Date | string | null): string | null =>
  d === null ? null : (d instanceof Date ? d : new Date(d)).toISOString();
const isoReq = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * Xuất dữ liệu cá nhân của CHÍNH người gọi (đồng bộ). `analyticsActor` = actor_key giả danh của người gọi (HMAC bằng bí mật server —
 * nơi gọi tính từ id của phiên); null ⇒ bỏ phần đếm sự kiện. Chưa xác thực lại ≤ 5 phút ⇒ `DsarError` REAUTH_REQUIRED (401), không ghi gì.
 */
export async function exportPersonalData(
  db: Kysely<unknown>,
  input: DsarSubject & { analyticsActor: Buffer | null; now?: Date },
): Promise<DsarExport> {
  const now = input.now ?? new Date();
  assertUser(input.userId);
  assertDsarRecentAuth(input.authenticatedAt, now);
  return inSubjectTx(db, input.userId, async (trx) => {
    const uid = input.userId;
    const user = await sql<{
      id: string;
      name: string;
      email: string;
      emailVerified: boolean;
      twoFactorEnabled: boolean | null;
      createdAt: Date;
    }>`select id, name, email, "emailVerified", "twoFactorEnabled", "createdAt" from auth."user" where id = ${uid}`.execute(
      trx,
    );
    const accounts = await sql<{ providerId: string; createdAt: Date }>`
      select "providerId", "createdAt" from auth.account where "userId" = ${uid} order by "createdAt"`.execute(
      trx,
    );
    const sessions = await sql<{
      createdAt: Date;
      expiresAt: Date;
      ipAddress: string | null;
      userAgent: string | null;
    }>`select "createdAt", "expiresAt", "ipAddress", "userAgent" from auth."session" where "userId" = ${uid}
       order by "createdAt"`.execute(trx);
    const memberships = await sql<{
      organization_id: string;
      organization_name: string;
      role: string;
      status: string;
      valid_from: Date;
      valid_to: Date | null;
      revoked_at: Date | null;
      person_full_name: string;
      person_email: string | null;
      person_phone: string | null;
      person_address: string | null;
      person_nationality: string | null;
    }>`select * from app.dsar_my_memberships()`.execute(trx);
    const consents = await sql<{
      purpose: string;
      action: string;
      policy_version: string;
      channel: string;
      recorded_at: Date;
    }>`select purpose, action, policy_version, channel, recorded_at from consent_records
       where subject_user_id = ${uid} order by id`.execute(trx);
    const restriction = await sql<{ restricted_at: Date }>`
      select restricted_at from processing_restrictions where subject_user_id = ${uid}`.execute(trx);
    const events = input.analyticsActor
      ? (
          await sql<{ event: string; n: number; first_at: Date; last_at: Date }>`
            select event, n, first_at, last_at from app.dsar_actor_event_summary(${input.analyticsActor})`.execute(
            trx,
          )
        ).rows
      : [];
    const prior = await requestsOf(trx, uid);
    const u = user.rows[0];
    const sections = {
      account: u ? 1 : 0,
      login_methods: accounts.rows.length,
      sessions: sessions.rows.length,
      memberships: memberships.rows.length,
      consents: consents.rows.length,
      analytics_events: events.reduce((s, e) => s + e.n, 0),
    };
    const req = await insertRequest(trx, {
      userId: uid,
      kind: "access",
      now,
      completed: true,
      result: { sections },
    });
    return {
      format: DSAR_EXPORT_FORMAT,
      generated_at: now.toISOString(),
      request: {
        id: req.id,
        received_at: req.receivedAt.toISOString(),
        due_at: req.dueAt.toISOString(),
        region: req.region,
      },
      account: u
        ? {
            id: u.id,
            name: u.name,
            email: u.email,
            email_verified: u.emailVerified,
            two_factor_enabled: u.twoFactorEnabled === true,
            created_at: isoReq(u.createdAt),
          }
        : null,
      login_methods: accounts.rows.map((a) => ({ provider: a.providerId, created_at: isoReq(a.createdAt) })),
      sessions: sessions.rows.map((s) => ({
        created_at: isoReq(s.createdAt),
        expires_at: isoReq(s.expiresAt),
        ip_address: s.ipAddress,
        user_agent: s.userAgent,
      })),
      memberships: memberships.rows.map((m) => ({
        organization_id: m.organization_id,
        organization_name: m.organization_name,
        role: m.role,
        status: m.status,
        valid_from: isoReq(m.valid_from),
        valid_to: iso(m.valid_to),
        revoked_at: iso(m.revoked_at),
        person: {
          full_name: m.person_full_name,
          email: m.person_email,
          phone: m.person_phone,
          address: m.person_address,
          nationality: m.person_nationality,
        },
      })),
      consents: consents.rows.map((c) => ({
        purpose: c.purpose,
        action: c.action,
        policy_version: c.policy_version,
        channel: c.channel,
        recorded_at: isoReq(c.recorded_at),
      })),
      processing_restriction: {
        active: restriction.rows.length > 0,
        since: iso(restriction.rows[0]?.restricted_at ?? null),
      },
      dsar_requests: [
        {
          kind: "access",
          status: "completed",
          region: req.region,
          received_at: req.receivedAt.toISOString(),
          due_at: req.dueAt.toISOString(),
          completed_at: now.toISOString(),
        },
        ...prior.map((p) => ({
          kind: p.kind,
          status: p.status,
          region: p.region,
          received_at: isoReq(p.received_at),
          due_at: isoReq(p.due_at),
          completed_at: iso(p.completed_at),
        })),
      ],
      analytics: {
        pseudonymous: true,
        total: sections.analytics_events,
        by_event: events.map((e) => ({
          event: e.event,
          count: e.n,
          first_at: isoReq(e.first_at),
          last_at: isoReq(e.last_at),
        })),
      },
    };
  });
}

// ───────────────────────────── Xoá tài khoản ─────────────────────────────

/** So khớp email gõ lại (không phân biệt hoa thường, bỏ khoảng trắng hai đầu, NFC). */
export function confirmationMatches(typed: string, email: string): boolean {
  const n = (s: string) => s.normalize("NFC").trim().toLowerCase();
  return n(typed).length > 0 && n(typed) === n(email);
}

/**
 * Pha 1 của xoá tài khoản (request của chính người dùng). Thứ tự kiểm: xác thực lại (401) → email gõ lại (422) → owner duy nhất (409).
 * Khoá tư vấn TOÀN CỤC cho mọi yêu cầu xoá (hiếm) ⇒ hai owner cùng tổ chức xoá song song: người sau thấy yêu cầu của người trước và bị
 * chặn (owner đang chờ xoá không tính là owner còn lại). Đã có yêu cầu xoá đang chờ ⇒ trả lại yêu cầu đó (idempotent).
 */
export async function requestAccountDeletion(
  db: Kysely<unknown>,
  input: DsarSubject & { confirmEmail: string; now?: Date },
): Promise<{ requestId: string; dueAt: Date; revokedSessions: number; created: boolean }> {
  const now = input.now ?? new Date();
  assertUser(input.userId);
  assertDsarRecentAuth(input.authenticatedAt, now);
  return inSubjectTx(db, input.userId, async (trx) => {
    const uid = input.userId;
    await sql`select pg_advisory_xact_lock(hashtextextended('dsar-delete', 0))`.execute(trx);
    const open = await sql<{ id: string; due_at: Date }>`
      select id, due_at from dsar_requests where subject_user_id = ${uid} and kind = 'delete' and status = 'received'
      limit 1`.execute(trx);
    const user = await sql<{ email: string }>`select email from auth."user" where id = ${uid}`.execute(trx);
    const email = user.rows[0]?.email;
    if (open.rows[0]) {
      const o = open.rows[0];
      return { requestId: o.id, dueAt: o.due_at, revokedSessions: 0, created: false };
    }
    if (email === undefined || !confirmationMatches(input.confirmEmail, email))
      throw new DsarError("CONFIRMATION_MISMATCH", 422, t("privacy.dsar.confirmation_mismatch"));
    const sole = await sql<{ n: number }>`select app.dsar_sole_owner_orgs() as n`.execute(trx);
    const soleOwnerOrgs = sole.rows[0]?.n ?? 0;
    if (soleOwnerOrgs > 0)
      throw new DsarError("SOLE_OWNER", 409, t("privacy.dsar.sole_owner"), soleOwnerOrgs);
    const req = await insertRequest(trx, { userId: uid, kind: "delete", now, completed: false, result: {} });
    // Thu hồi mọi phiên — cùng cách `access/sessions.ts` `revokeUserSessions` (dấu vết băm token ⇒ cookie cũ nhận 401 SESSION_REVOKED).
    await sql`
      insert into auth.revoked_session (token_hash, user_id, expires_at)
      select sha256(convert_to(token, 'UTF8')), "userId", "expiresAt" from auth."session" where "userId" = ${uid}::uuid
      on conflict (token_hash) do nothing`.execute(trx);
    const revoked = await sql`delete from auth."session" where "userId" = ${uid}::uuid`.execute(trx);
    await sql`delete from auth.account where "userId" = ${uid}::uuid`.execute(trx);
    await sql`delete from auth."twoFactor" where "userId" = ${uid}::uuid`.execute(trx);
    await sql`
      delete from auth.verification
      where position(${uid} in identifier) > 0 or position(lower(${email}) in lower(identifier)) > 0`.execute(
      trx,
    );
    await sql`
      update auth."user"
      set name = '—', email = ${`deleted-${uid}@deleted.invalid`}, "emailVerified" = false, image = null,
          "twoFactorEnabled" = false, "updatedAt" = now()
      where id = ${uid}::uuid`.execute(trx);
    return {
      requestId: req.id,
      dueAt: req.dueAt,
      revokedSessions: Number(revoked.numAffectedRows ?? 0),
      created: true,
    };
  });
}

export interface DsarErasureStats {
  completed: number;
  failed: number;
}

/**
 * Pha 2 (worker, kết nối app_worker): mọi yêu cầu xoá đang chờ → xoá sự kiện phân tích (callback) → `app.dsar_complete_erasure`.
 * Mỗi yêu cầu độc lập: một yêu cầu lỗi không chặn yêu cầu khác (lỗi ghi log chỉ id yêu cầu + tên lỗi, thử lại ở lượt sau). Idempotent:
 * chạy lại/hai worker song song chỉ đóng một lần (hàm khoá hàng yêu cầu; xoá phân tích lần hai = 0 dòng).
 */
export async function processDsarErasures(
  workerDb: Kysely<unknown>,
  opts: {
    forgetAnalytics: (userId: string) => Promise<number>;
    limit?: number;
    log?: (event: string, fields: Record<string, unknown>) => void;
  },
): Promise<DsarErasureStats> {
  const open = await sql<{ request_id: string; subject_user_id: string }>`
    select request_id, subject_user_id from app.dsar_open_erasures(${opts.limit ?? 20})`.execute(workerDb);
  const stats: DsarErasureStats = { completed: 0, failed: 0 };
  for (const r of open.rows) {
    try {
      const analytics = await opts.forgetAnalytics(r.subject_user_id);
      const done = await sql<{ result: unknown }>`
        select app.dsar_complete_erasure(${r.request_id}::uuid, ${analytics}::int) as result`.execute(
        workerDb,
      );
      if (done.rows[0]?.result) stats.completed++;
    } catch (err) {
      stats.failed++;
      opts.log?.("dsar.erasure_failed", {
        request_id: r.request_id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return stats;
}
