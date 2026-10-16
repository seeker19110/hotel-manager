// Màn "Hôm nay" (PLAN đợt 3 T-216; SPEC-audit-reporting S-006, S-007, S-008, §5 `today.getSummary`; INV-G1, INV-G2).
// Chỉ đọc. Mỗi cơ sở có NGÀY KINH DOANH riêng (múi giờ + giờ chốt: `app.business_date`, S-008) nên mọi mốc "hôm nay/quá hạn" tính theo
// ngày của từng cơ sở, không theo ngày UTC. Nội dung theo vai trò dựa trên MA TRẬN QUYỀN (không viết lại bảng vai trò ở đây):
// - khách (đến/đi/đang ở, có tên): `calendar.read_guests` ≠ no — chủ/quản lý/lễ tân/kế toán (chỉ xem);
// - tiền (nợ đến hạn/quá hạn, kỳ thu cần duyệt): `money.read` / `billing.prepare`;
// - phòng cần dọn: `calendar.read_status` — buồng phòng chỉ thấy MỤC NÀY (không khoá `debts`, `guests`… trong kết quả: S-007);
// - thông báo lưu trú: `residence_notice.manage`; hợp đồng sắp hết hạn: `lease.manage`.
// Phần không được xem thì KHÔNG có khoá trong kết quả (không trả null/0 để khỏi lộ tồn tại). Danh sách có trần `itemLimit`; số đếm luôn chính xác.
// "Việc dọn" hiện tính từ `units.housekeeping_status` (dirty/assigned/cleaning, phòng đang khai thác) vì bảng `tasks` (T-209) và phiếu sự cố
// chưa có — `pending_sources` nêu rõ để nối sau. RLS vẫn là lớp thứ hai (buồng phòng không đọc `stays`/`persons`/`invoices`).
import { withTenant } from "@hm/db";
import { type Action, authorize, grantFor, type MatrixRole } from "@hm/domain";
import { type Kysely, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import { CommandError } from "../pipeline/problem.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TODAY_DEFAULT_ITEM_LIMIT = 50;
export const TODAY_MAX_ITEM_LIMIT = 200;
export const TODAY_DEFAULT_DEBT_TOP = 5;
export const TODAY_MAX_DEBT_TOP = 50;
export const TODAY_DEFAULT_LEASE_HORIZON_DAYS = 30;
export const TODAY_MAX_LEASE_HORIZON_DAYS = 90;
/** Nguồn dữ liệu chưa có khi viết: nối vào đây khi T-209 (tasks) và phiếu sự cố có bảng. */
export const TODAY_PENDING_SOURCES = ["tasks", "incidents"] as const;

/** Vai trò có được một hành động trong ma trận (không xét phạm vi cơ sở; `own`/`no` → không). */
function can(actor: Actor, action: Action): boolean {
  const g = grantFor(action, actor.role as MatrixRole);
  return g === "yes" || g === "limit" || g === "read" || g === "request";
}

export interface TodayInput {
  /** Bỏ trống = mọi cơ sở trong phạm vi của người xem. Ngoài phạm vi/không tồn tại → 404. */
  propertyId?: string;
  itemLimit?: number;
  debtTop?: number;
  leaseHorizonDays?: number;
  now?: Date;
}

export interface TodayGuestItem {
  property_id: string;
  stay_id: string;
  unit_code: string;
  guest_name: string | null;
  guests: number;
  arrival_date: string;
  departure_date: string;
  /** `expected` (chưa nhận phòng), `in_house`, `checked_out`. */
  stay_status: string;
}

export interface TodayDebtItem {
  property_id: string;
  invoice_id: string;
  number: string;
  payer_name: string | null;
  open_amount: number;
  due_on: string;
  days_overdue: number;
}

export interface TodaySummary {
  role: string;
  generated_at: string;
  /** Ngày kinh doanh chung nếu mọi cơ sở trùng ngày; khác nhau (múi giờ/giờ chốt) → null, xem `properties[]`. */
  business_date: string | null;
  properties: { property_id: string; name: string; business_date: string; timezone: string }[];
  cards: Record<string, number>;
  guests?: {
    arrivals: TodayGuestItem[];
    departures: TodayGuestItem[];
    in_house: TodayGuestItem[];
    overstays: TodayGuestItem[];
  };
  debts?: {
    due_today_count: number;
    due_today_amount: number;
    overdue_count: number;
    overdue_amount: number;
    total_count: number;
    total_amount: number;
    top: TodayDebtItem[];
  };
  billing_review?: {
    count: number;
    items: { property_id: string; billing_period_id: string; period_start: string; period_end: string }[];
  };
  cleaning?: {
    count: number;
    source: "units.housekeeping_status";
    items: {
      property_id: string;
      unit_id: string;
      unit_code: string;
      floor_name: string;
      housekeeping_status: string;
    }[];
  };
  residence_notices?: {
    overdue_count: number;
    due_today_count: number;
    items: {
      property_id: string;
      notice_id: string;
      stay_id: string;
      unit_code: string;
      status: string;
      is_foreign: boolean;
      due_at: string;
      overdue: boolean;
    }[];
  };
  leases_expiring?: {
    count: number;
    horizon_days: number;
    items: {
      property_id: string;
      lease_id: string;
      number: string;
      unit_code: string;
      representative_name: string | null;
      status: string;
      effective_to: string;
      days_left: number;
    }[];
  };
  pending_sources: readonly string[];
}

const num = (s: string | null | undefined): number => (s === null || s === undefined ? 0 : Number(s));

/**
 * `today.getSummary` (SPEC §5). 403 `FORBIDDEN` cho vai trò không có mục nào (người thuê, hỗ trợ nền tảng); 404 cho cơ sở ngoài phạm vi.
 */
export async function getTodaySummary(
  db: Kysely<unknown>,
  actor: Actor,
  input: TodayInput = {},
): Promise<TodaySummary> {
  const sees = {
    guests: can(actor, "calendar.read_guests"),
    money: can(actor, "money.read"),
    billing: can(actor, "billing.prepare"),
    cleaning: can(actor, "calendar.read_status"),
    notices: can(actor, "residence_notice.manage"),
    leases: can(actor, "lease.manage"),
  };
  if (!Object.values(sees).some(Boolean)) {
    throw new CommandError("FORBIDDEN", 403, "Bạn không có quyền thực hiện thao tác này");
  }
  if (input.propertyId !== undefined) {
    if (!UUID_RE.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
    // Ngoài phạm vi → NOT_FOUND (không lộ cơ sở khác tồn tại); hành động nào cũng được vì đã chặn vai trò không có mục nào.
    authorize(actor, sees.cleaning ? "calendar.read_status" : "calendar.read_guests", {
      propertyId: input.propertyId,
    });
  }
  const now = input.now ?? new Date();
  const itemLimit = Math.min(
    Math.max(Math.trunc(input.itemLimit ?? TODAY_DEFAULT_ITEM_LIMIT), 1),
    TODAY_MAX_ITEM_LIMIT,
  );
  const debtTop = Math.min(
    Math.max(Math.trunc(input.debtTop ?? TODAY_DEFAULT_DEBT_TOP), 1),
    TODAY_MAX_DEBT_TOP,
  );
  const horizon = Math.min(
    Math.max(Math.trunc(input.leaseHorizonDays ?? TODAY_DEFAULT_LEASE_HORIZON_DAYS), 1),
    TODAY_MAX_LEASE_HORIZON_DAYS,
  );
  const orgId = actor.orgId;

  return withTenant(db, { orgId, actorId: actor.membershipId }, async (trx) => {
    const scope: string[] | null = actor.allProperties ? null : [...actor.propertyIds];
    const props = await sql<{ id: string; name: string; timezone: string; bd: string }>`
      select p.id, p.name, p.timezone, app.business_date(p.organization_id, p.id, ${now}::timestamptz)::text as bd
      from properties p
      where p.organization_id = ${orgId} and p.archived_at is null
        and (${scope}::uuid[] is null or p.id = any(${scope}::uuid[]))
        and (${input.propertyId ?? null}::uuid is null or p.id = ${input.propertyId ?? null}::uuid)
      order by p.name, p.id`.execute(trx);
    if (input.propertyId !== undefined && props.rows.length === 0)
      throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
    const ids = props.rows.map((p) => p.id);
    const dates = new Set(props.rows.map((p) => p.bd));
    const out: TodaySummary = {
      role: actor.role,
      generated_at: now.toISOString(),
      business_date: dates.size === 1 ? (props.rows[0]?.bd ?? null) : null,
      properties: props.rows.map((p) => ({
        property_id: p.id,
        name: p.name,
        business_date: p.bd,
        timezone: p.timezone,
      })),
      cards: {},
      pending_sources: TODAY_PENDING_SOURCES,
    };
    if (ids.length === 0) return emptyFor(out, sees, horizon);

    // CTE ngày kinh doanh theo từng cơ sở dùng chung cho các truy vấn dưới.
    const bd = sql`select p.id as property_id, app.business_date(p.organization_id, p.id, ${now}::timestamptz) as d
                   from properties p where p.organization_id = ${orgId} and p.id = any(${ids}::uuid[])`;

    if (sees.guests) {
      const r = await sql<{
        stay_id: string;
        property_id: string;
        stay_status: string;
        unit_code: string;
        guest_name: string | null;
        guests: number;
        arrival_date: string;
        departure_date: string;
        arriving: boolean;
        departing: boolean;
        overstay: boolean;
      }>`
        with bd as (${bd})
        select s.id as stay_id, s.property_id, s.status as stay_status, u.code as unit_code, per.full_name as guest_name,
               i.guests::int as guests, i.arrival_date::text, i.departure_date::text,
               (i.arrival_date = bd.d and s.status in ('expected','in_house')) as arriving,
               (i.departure_date = bd.d and s.status in ('in_house','checked_out')) as departing,
               (s.status = 'in_house' and i.departure_date < bd.d) as overstay
        from stays s
        join reservation_items i on i.organization_id = s.organization_id and i.id = s.reservation_item_id
        join units u on u.organization_id = s.organization_id and u.id = s.unit_id
        join bd on bd.property_id = s.property_id
        left join persons per on per.organization_id = s.organization_id and per.id = s.primary_guest_person_id
        where s.organization_id = ${orgId} and s.property_id = any(${ids}::uuid[])
          and ((i.arrival_date = bd.d and s.status in ('expected','in_house'))
            or (i.departure_date = bd.d and s.status in ('in_house','checked_out'))
            or s.status = 'in_house')
        order by u.code, s.id`.execute(trx);
      const item = (x: (typeof r.rows)[number]): TodayGuestItem => ({
        property_id: x.property_id,
        stay_id: x.stay_id,
        unit_code: x.unit_code,
        guest_name: x.guest_name,
        guests: x.guests,
        arrival_date: x.arrival_date,
        departure_date: x.departure_date,
        stay_status: x.stay_status,
      });
      const arrivals = r.rows.filter((x) => x.arriving);
      const departures = r.rows.filter((x) => x.departing);
      const inHouse = r.rows.filter((x) => x.stay_status === "in_house");
      const overstays = r.rows.filter((x) => x.overstay);
      out.cards.arrivals = arrivals.length;
      out.cards.departures = departures.length;
      out.cards.in_house = inHouse.length;
      out.cards.overstays = overstays.length;
      out.guests = {
        arrivals: arrivals.slice(0, itemLimit).map(item),
        departures: departures.slice(0, itemLimit).map(item),
        in_house: inHouse.slice(0, itemLimit).map(item),
        overstays: overstays.slice(0, itemLimit).map(item),
      };
    }

    if (sees.money) {
      const due = sql`select i.id, i.property_id, i.number, i.due_on, i.open_amount, i.payer_person_id, bd.d
                      from invoices i join bd on bd.property_id = i.property_id
                      where i.organization_id = ${orgId} and i.property_id = any(${ids}::uuid[])
                        and i.open_amount > 0 and i.due_on is not null and i.due_on <= bd.d and i.kind <> 'adjustment'`;
      const agg = await sql<{
        due_c: string;
        due_a: string | null;
        over_c: string;
        over_a: string | null;
      }>`
        with bd as (${bd}), due as (${due})
        select count(*) filter (where due_on = d)::text as due_c, sum(open_amount) filter (where due_on = d)::text as due_a,
               count(*) filter (where due_on < d)::text as over_c, sum(open_amount) filter (where due_on < d)::text as over_a
        from due`.execute(trx);
      const top = await sql<{
        id: string;
        property_id: string;
        number: string;
        payer: string | null;
        open_amount: string;
        due_on: string;
        days_overdue: number;
      }>`
        with bd as (${bd}), due as (${due})
        select due.id, due.property_id, due.number, per.full_name as payer, due.open_amount::text, due.due_on::text,
               (due.d - due.due_on)::int as days_overdue
        from due left join persons per on per.organization_id = ${orgId} and per.id = due.payer_person_id
        order by due.open_amount desc, due.due_on, due.id
        limit ${debtTop}`.execute(trx);
      const a = agg.rows[0];
      const dueC = num(a?.due_c);
      const overC = num(a?.over_c);
      const dueA = num(a?.due_a);
      const overA = num(a?.over_a);
      out.cards.debt_due_or_overdue = dueC + overC;
      out.debts = {
        due_today_count: dueC,
        due_today_amount: dueA,
        overdue_count: overC,
        overdue_amount: overA,
        total_count: dueC + overC,
        total_amount: dueA + overA,
        top: top.rows.map((x) => ({
          property_id: x.property_id,
          invoice_id: x.id,
          number: x.number,
          payer_name: x.payer,
          open_amount: num(x.open_amount),
          due_on: x.due_on,
          days_overdue: x.days_overdue,
        })),
      };
    }

    if (sees.billing) {
      const r = await sql<{
        id: string;
        property_id: string;
        period_start: string;
        period_end: string;
      }>`
        select b.id, b.property_id, b.period_start::text, b.period_end::text
        from billing_periods b
        where b.organization_id = ${orgId} and b.property_id = any(${ids}::uuid[]) and b.status = 'reviewing'
        order by b.period_start, b.id limit ${itemLimit}`.execute(trx);
      const c = await sql<{ n: string }>`
        select count(*)::text as n from billing_periods
        where organization_id = ${orgId} and property_id = any(${ids}::uuid[]) and status = 'reviewing'`.execute(
        trx,
      );
      out.cards.billing_review = num(c.rows[0]?.n);
      out.billing_review = {
        count: num(c.rows[0]?.n),
        items: r.rows.map((x) => ({
          property_id: x.property_id,
          billing_period_id: x.id,
          period_start: x.period_start,
          period_end: x.period_end,
        })),
      };
    }

    if (sees.cleaning) {
      const r = await sql<{
        id: string;
        property_id: string;
        code: string;
        floor_name: string;
        housekeeping_status: string;
      }>`
        select u.id, u.property_id, u.code, f.name as floor_name, u.housekeeping_status
        from units u
        join floors f on f.organization_id = u.organization_id and f.property_id = u.property_id and f.id = u.floor_id
        where u.organization_id = ${orgId} and u.property_id = any(${ids}::uuid[]) and u.archived_at is null
          and u.availability = 'active' and u.housekeeping_status in ('dirty','assigned','cleaning')
        order by u.property_id, f.name, u.code, u.id
        limit ${itemLimit}`.execute(trx);
      const c = await sql<{ n: string }>`
        select count(*)::text as n from units
        where organization_id = ${orgId} and property_id = any(${ids}::uuid[]) and archived_at is null
          and availability = 'active' and housekeeping_status in ('dirty','assigned','cleaning')`.execute(
        trx,
      );
      out.cards.cleaning = num(c.rows[0]?.n);
      out.cleaning = {
        count: num(c.rows[0]?.n),
        source: "units.housekeeping_status",
        items: r.rows.map((x) => ({
          property_id: x.property_id,
          unit_id: x.id,
          unit_code: x.code,
          floor_name: x.floor_name,
          housekeeping_status: x.housekeeping_status,
        })),
      };
    }

    if (sees.notices) {
      // Quá hạn: `due_at` đã qua (theo thời điểm hiện tại). Đến hạn hôm nay: còn trong ngày kinh doanh của cơ sở và chưa tới giờ.
      const where = sql`n.organization_id = ${orgId} and n.property_id = any(${ids}::uuid[]) and n.status in ('pending','exported')
          and n.due_at is not null
          and (n.due_at <= ${now}::timestamptz or app.business_date(n.organization_id, n.property_id, n.due_at) = bd.d)`;
      const r = await sql<{
        id: string;
        property_id: string;
        stay_id: string;
        code: string;
        status: string;
        is_foreign: boolean;
        due_at: Date;
        overdue: boolean;
      }>`
        with bd as (${bd})
        select n.id, n.property_id, n.stay_id, u.code, n.status, n.is_foreign, n.due_at, (n.due_at <= ${now}::timestamptz) as overdue
        from residence_notices n
        join bd on bd.property_id = n.property_id
        join stays s on s.organization_id = n.organization_id and s.id = n.stay_id
        join units u on u.organization_id = s.organization_id and u.id = s.unit_id
        where ${where}
        order by (n.due_at <= ${now}::timestamptz) desc, n.due_at, n.id
        limit ${itemLimit}`.execute(trx);
      const c = await sql<{ over_c: string; due_c: string }>`
        with bd as (${bd})
        select count(*) filter (where n.due_at <= ${now}::timestamptz)::text as over_c,
               count(*) filter (where n.due_at > ${now}::timestamptz)::text as due_c
        from residence_notices n join bd on bd.property_id = n.property_id
        where ${where}`.execute(trx);
      out.cards.residence_notices = num(c.rows[0]?.over_c) + num(c.rows[0]?.due_c);
      out.residence_notices = {
        overdue_count: num(c.rows[0]?.over_c),
        due_today_count: num(c.rows[0]?.due_c),
        items: r.rows.map((x) => ({
          property_id: x.property_id,
          notice_id: x.id,
          stay_id: x.stay_id,
          unit_code: x.code,
          status: x.status,
          is_foreign: x.is_foreign,
          due_at: new Date(x.due_at).toISOString(),
          overdue: x.overdue,
        })),
      };
    }

    if (sees.leases) {
      const base = sql`
        from leases l
        join bd on bd.property_id = l.property_id
        join units u on u.organization_id = l.organization_id and u.id = l.unit_id
        left join persons per on per.organization_id = l.organization_id and per.id = l.representative_person_id
        join lateral (select lv.effective_to from lease_versions lv
                      where lv.organization_id = l.organization_id and lv.lease_id = l.id and lv.signed_at is not null
                      order by lv.version_no desc limit 1) v on true
        where l.organization_id = ${orgId} and l.property_id = any(${ids}::uuid[]) and l.status in ('active','notice_given')
          and v.effective_to is not null and v.effective_to <= bd.d + ${horizon}::int`;
      const r = await sql<{
        id: string;
        property_id: string;
        number: string;
        code: string;
        name: string | null;
        status: string;
        effective_to: string;
        days_left: number;
      }>`
        with bd as (${bd})
        select l.id, l.property_id, l.number, u.code, per.full_name as name, l.status, v.effective_to::text,
               (v.effective_to - bd.d)::int as days_left
        ${base}
        order by v.effective_to, l.id
        limit ${itemLimit}`.execute(trx);
      const c = await sql<{ n: string }>`with bd as (${bd}) select count(*)::text as n ${base}`.execute(trx);
      out.cards.leases_expiring = num(c.rows[0]?.n);
      out.leases_expiring = {
        count: num(c.rows[0]?.n),
        horizon_days: horizon,
        items: r.rows.map((x) => ({
          property_id: x.property_id,
          lease_id: x.id,
          number: x.number,
          unit_code: x.code,
          representative_name: x.name,
          status: x.status,
          effective_to: x.effective_to,
          days_left: x.days_left,
        })),
      };
    }
    return out;
  });
}

/** Không có cơ sở nào trong phạm vi: trả đủ các phần được phép với số 0 (thẻ hiện "0 — Không có việc"). */
function emptyFor(
  out: TodaySummary,
  sees: {
    guests: boolean;
    money: boolean;
    billing: boolean;
    cleaning: boolean;
    notices: boolean;
    leases: boolean;
  },
  horizon: number,
): TodaySummary {
  if (sees.guests) {
    Object.assign(out.cards, { arrivals: 0, departures: 0, in_house: 0, overstays: 0 });
    out.guests = { arrivals: [], departures: [], in_house: [], overstays: [] };
  }
  if (sees.money) {
    out.cards.debt_due_or_overdue = 0;
    out.debts = {
      due_today_count: 0,
      due_today_amount: 0,
      overdue_count: 0,
      overdue_amount: 0,
      total_count: 0,
      total_amount: 0,
      top: [],
    };
  }
  if (sees.billing) {
    out.cards.billing_review = 0;
    out.billing_review = { count: 0, items: [] };
  }
  if (sees.cleaning) {
    out.cards.cleaning = 0;
    out.cleaning = { count: 0, source: "units.housekeeping_status", items: [] };
  }
  if (sees.notices) {
    out.cards.residence_notices = 0;
    out.residence_notices = { overdue_count: 0, due_today_count: 0, items: [] };
  }
  if (sees.leases) {
    out.cards.leases_expiring = 0;
    out.leases_expiring = { count: 0, horizon_days: horizon, items: [] };
  }
  return out;
}
