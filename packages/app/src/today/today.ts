// PLAN đợt 3 T-220 — màn "Hôm nay" (SPEC-audit-reporting S-006…S-008; INV-G2; D-017).
// - Mỗi cơ sở trong phạm vi tính theo NGÀY KINH DOANH của chính nó (`app.business_date`: múi giờ + giờ chốt ngày).
// - Thẻ theo vai trò: buồng phòng chỉ "Phòng cần dọn" + "Sự cố", kỹ thuật chỉ "Sự cố" — không có trường tiền nào trong
//   phản hồi; kế toán: công nợ + kỳ thu cần duyệt; lễ tân: việc trong ca (không kỳ thu); owner/manager: đủ.
// - Số trên thẻ = số dòng của `today.listItems` cùng thẻ (đếm trên CHÍNH truy vấn danh sách) — bấm thẻ ra đúng số dòng.
// - Khách đến/đi không đếm booking `cancelled`/`no_show`/`expired`/`draft`.
import { withTenant } from "@hm/db";
import { type Kysely, type RawBuilder, sql } from "kysely";
import type { Actor } from "../access/actor.ts";
import { CommandError } from "../pipeline/problem.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TODAY_CARDS = [
  "arrivals",
  "departures",
  "receivables",
  "periodsReviewing",
  "dirtyUnits",
  "workOrders",
  "residenceNotices",
] as const;
export type TodayCard = (typeof TODAY_CARDS)[number];

const LABEL: Readonly<Record<TodayCard, string>> = {
  arrivals: "Khách đến",
  departures: "Khách đi",
  receivables: "Nợ đến hạn/quá hạn",
  periodsReviewing: "Kỳ thu cần duyệt",
  dirtyUnits: "Phòng cần dọn",
  workOrders: "Sự cố",
  residenceNotices: "Thông báo lưu trú sắp/quá hạn",
};

/** Thẻ có số tiền (chỉ trả `amount` cho các thẻ này). */
const MONEY: ReadonlySet<TodayCard> = new Set(["receivables"]);

const CARDS_BY_ROLE: Readonly<Record<string, readonly TodayCard[]>> = {
  owner: TODAY_CARDS,
  manager: TODAY_CARDS,
  front_desk: ["arrivals", "departures", "receivables", "dirtyUnits", "workOrders", "residenceNotices"],
  accountant: ["receivables", "periodsReviewing"],
  housekeeping: ["dirtyUnits", "workOrders"],
  maintenance: ["workOrders"],
};

/** Thông báo lưu trú hiện trên thẻ khi chưa nộp và hạn còn ≤ 24 giờ (hoặc đã quá hạn). */
export const RESIDENCE_NOTICE_HORIZON_HOURS = 24;

export interface TodayItem {
  id: string;
  propertyId: string;
  title: string;
  subtitle: string | null;
  amount?: number;
  overdue?: boolean;
}

export interface TodaySummary {
  properties: { id: string; name: string; businessDate: string }[];
  cards: { key: TodayCard; label: string; count: number; amount?: number }[];
  asOf: Date;
}

const forbidden = () => new CommandError("FORBIDDEN", 403, "Bạn không có quyền xem mục này");
const notFound = () => new CommandError("NOT_FOUND", 404, "Không tìm thấy");

function cardsFor(actor: Actor): readonly TodayCard[] {
  const c = CARDS_BY_ROLE[actor.role];
  if (!c) throw forbidden();
  return c;
}

/** Cơ sở trong phạm vi + ngày kinh doanh lúc `now`. */
const props = (actor: Actor, now: Date, propertyId?: string) => sql`
  select p.id, p.name, p.timezone, app.business_date(p.organization_id, p.id, ${now}) as bd
  from properties p
  where p.organization_id = ${actor.orgId} and p.archived_at is null
    and (${actor.allProperties} or p.id = any(${[...actor.propertyIds]}::uuid[]))
    ${propertyId ? sql`and p.id = ${propertyId}` : sql``}`;

/** Truy vấn danh sách của từng thẻ: cột id, property_id, title, subtitle, amount (bigint|null), overdue, sort_key. */
function listSql(card: TodayCard, now: Date): RawBuilder<unknown> {
  switch (card) {
    case "arrivals":
      return sql`
        select r.id, pr.id as property_id, concat('Phòng ', coalesce(u.code, '—'), ' · ', r.number) as title,
               to_char(ri.arrival_date, 'DD/MM/YYYY') as subtitle, null::bigint as amount, false as overdue, r.number as sort_key
        from pr join reservation_items ri on ri.organization_id = pr.org and ri.property_id = pr.id and ri.arrival_date = pr.bd
        join reservations r on r.organization_id = ri.organization_id and r.id = ri.reservation_id
        left join units u on u.organization_id = ri.organization_id and u.id = ri.unit_id
        where r.status in ('held','confirmed','in_house','checked_out')`;
    case "departures":
      return sql`
        select s.id, pr.id as property_id, concat('Phòng ', u.code, ' · ', r.number) as title,
               case s.status when 'checked_out' then 'Đã trả phòng' else 'Đang ở' end as subtitle,
               null::bigint as amount, false as overdue, u.code as sort_key
        from pr join reservation_items ri on ri.organization_id = pr.org and ri.property_id = pr.id and ri.departure_date = pr.bd
        join stays s on s.organization_id = ri.organization_id and s.reservation_item_id = ri.id
        join reservations r on r.organization_id = ri.organization_id and r.id = ri.reservation_id
        join units u on u.organization_id = s.organization_id and u.id = s.unit_id
        where s.status in ('in_house','checked_out')`;
    case "receivables":
      return sql`
        select i.id, pr.id as property_id, concat('Phiếu ', i.number) as title,
               concat('Hạn ', to_char(i.due_on, 'DD/MM/YYYY')) as subtitle, (i.total - i.allocated_total)::bigint as amount,
               i.due_on < pr.bd as overdue, to_char(i.due_on, 'YYYY-MM-DD') || i.number as sort_key
        from pr join invoices i on i.organization_id = pr.org and i.property_id = pr.id
        where i.kind in ('periodic','fee','folio','opening_balance') and i.total > i.allocated_total
          and i.due_on is not null and i.due_on <= pr.bd
          and (i.billing_period_id is null or exists (
                 select 1 from billing_periods b where b.organization_id = i.organization_id and b.id = i.billing_period_id
                   and b.status in ('issued','locked')))`;
    case "periodsReviewing":
      return sql`
        select b.id, pr.id as property_id, concat('Kỳ ', to_char(b.period_start, 'MM/YYYY')) as title, pr.name as subtitle,
               null::bigint as amount, false as overdue, to_char(b.period_start, 'YYYY-MM-DD') as sort_key
        from pr join billing_periods b on b.organization_id = pr.org and b.property_id = pr.id
        where b.status = 'reviewing'`;
    case "dirtyUnits":
      return sql`
        select u.id, pr.id as property_id, concat('Phòng ', u.code) as title,
               case u.housekeeping_status when 'dirty' then 'Bẩn' when 'assigned' then 'Đã giao dọn' else 'Đang dọn' end as subtitle,
               null::bigint as amount, false as overdue, u.code as sort_key
        from pr join units u on u.organization_id = pr.org and u.property_id = pr.id
        where u.archived_at is null and u.housekeeping_status in ('dirty','assigned','cleaning')`;
    case "workOrders":
      return sql`
        select w.id, pr.id as property_id, concat('Phòng ', u.code, ': ', w.title) as title,
               case w.status when 'open' then 'Mới báo' when 'assigned' then 'Đã giao' else 'Đang sửa' end as subtitle,
               null::bigint as amount, false as overdue, to_char(w.created_at, 'YYYY-MM-DD HH24:MI:SS') as sort_key
        from pr join work_orders w on w.organization_id = pr.org and w.property_id = pr.id
        join units u on u.organization_id = w.organization_id and u.id = w.unit_id
        where w.status in ('open','assigned','in_progress')`;
    case "residenceNotices":
      return sql`
        select n.id, pr.id as property_id, concat('Phòng ', u.code) as title,
               concat('Hạn ', to_char(n.due_at at time zone pr.timezone, 'HH24:MI DD/MM/YYYY')) as subtitle,
               null::bigint as amount, n.due_at < ${now} as overdue, to_char(n.due_at, 'YYYY-MM-DD HH24:MI:SS') as sort_key
        from pr join residence_notices n on n.organization_id = pr.org and n.property_id = pr.id
        join stays s on s.organization_id = n.organization_id and s.id = n.stay_id
        join units u on u.organization_id = s.organization_id and u.id = s.unit_id
        where n.status in ('pending','exported') and n.due_at is not null
          and n.due_at <= ${now}::timestamptz + make_interval(hours => ${RESIDENCE_NOTICE_HORIZON_HOURS})`;
  }
}

const withProps = (actor: Actor, now: Date, propertyId: string | undefined, body: RawBuilder<unknown>) => sql`
  with pr as (select x.*, ${actor.orgId}::uuid as org from (${props(actor, now, propertyId)}) x)
  ${body}`;

function checkProperty(propertyId?: string): void {
  if (propertyId !== undefined && !UUID.test(propertyId)) throw notFound();
}

async function assertInScope(db: Kysely<unknown>, actor: Actor, propertyId?: string): Promise<void> {
  if (propertyId === undefined) return;
  if (!actor.allProperties && !actor.propertyIds.includes(propertyId)) throw notFound();
  const r = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, (trx) =>
    sql`select 1 from properties where organization_id = ${actor.orgId} and id = ${propertyId} and archived_at is null`.execute(
      trx,
    ),
  );
  if (r.rows.length === 0) throw notFound();
}

/** `today.getSummary` (S-006…S-008). */
export async function getSummary(
  db: Kysely<unknown>,
  actor: Actor,
  input: { propertyId?: string; now?: Date } = {},
): Promise<TodaySummary> {
  const cards = cardsFor(actor);
  checkProperty(input.propertyId);
  await assertInScope(db, actor, input.propertyId);
  const now = input.now ?? new Date();
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const p = await sql<{ id: string; name: string; bd: string }>`
      select id, name, bd::text as bd from (${props(actor, now, input.propertyId)}) x order by name, id`.execute(
      trx,
    );
    const out: TodaySummary["cards"] = [];
    for (const key of cards) {
      const r = await sql<{ n: number; amount: string | null }>`
        ${withProps(actor, now, input.propertyId, sql`select count(*)::int as n, sum(amount)::text as amount from (${listSql(key, now)}) l`)}`.execute(
        trx,
      );
      const row = r.rows[0];
      out.push({
        key,
        label: LABEL[key],
        count: row?.n ?? 0,
        ...(MONEY.has(key) ? { amount: Number(row?.amount ?? 0) } : {}),
      });
    }
    return {
      properties: p.rows.map((x) => ({ id: x.id, name: x.name, businessDate: x.bd })),
      cards: out,
      asOf: now,
    };
  });
}

/** `today.listItems`: danh sách chi tiết của một thẻ — vai trò không có thẻ đó → 403. */
export async function listItems(
  db: Kysely<unknown>,
  actor: Actor,
  input: { card: TodayCard; propertyId?: string; now?: Date },
): Promise<TodayItem[]> {
  if (!cardsFor(actor).includes(input.card)) throw forbidden();
  checkProperty(input.propertyId);
  await assertInScope(db, actor, input.propertyId);
  const now = input.now ?? new Date();
  const money = MONEY.has(input.card);
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<{
      id: string;
      property_id: string;
      title: string;
      subtitle: string | null;
      amount: string | null;
      overdue: boolean;
    }>`${withProps(actor, now, input.propertyId, sql`select * from (${listSql(input.card, now)}) l order by l.sort_key, l.id limit 500`)}`.execute(
      trx,
    );
    return r.rows.map((x) => ({
      id: x.id,
      propertyId: x.property_id,
      title: x.title,
      subtitle: x.subtitle,
      ...(money ? { amount: Number(x.amount ?? 0) } : {}),
      ...(input.card === "receivables" || input.card === "residenceNotices" ? { overdue: x.overdue } : {}),
    }));
  });
}
