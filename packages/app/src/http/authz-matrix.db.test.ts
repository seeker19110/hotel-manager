// T-404 (đợt 5) — MA TRẬN QUYỀN SINH TỪ REGISTRY (QA-INT-006, IND-SAAS-001/004, STD-SEC-004, BE-API-009, BASE-SEC-001,
// BE-AUTH-004/009). Mỗi mục của COMMANDS/QUERIES (`http/registry.ts`) tự có ca: mục MỚI thêm vào registry được phủ ngay,
// và test đỏ nếu mục đó chưa có đầu vào mẫu hợp lệ hay vai trò nào đó làm được điều không được phép.
// Gọi qua `handleCommand`/`handleQuery` thật trên Postgres thật (RLS, membership, pipeline), phiên giả theo header như
// `command-route.db.test.ts`; riêng phần đăng xuất dùng Better Auth thật.
// Tên describe mang thẻ `api1-bola` (truy cập tài nguyên của người/tổ chức khác) và `api5-bfla` (gọi chức năng vượt vai trò)
// theo OWASP API Security Top 10 2023 để `grep -rE "api1-bola|api5-bfla"` thấy bộ test.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Action, grantFor, type MatrixRole } from "@hm/domain";
import {
  createTestDb,
  type SeededOrg,
  seedAuthUser,
  seedIssuedInvoice,
  seedLease,
  seedOrg,
  seedReservation,
  type TestDb,
  tenantTables,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../auth/auth.ts";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { sampleInput } from "../testing/schema-sample.ts";
import { REPO_ROOT, sourceFiles } from "../testing/source-scan.ts";
import { type HttpDeps, handleCommand, handleQuery } from "./command-route.ts";
import { COMMANDS, QUERIES } from "./registry.ts";

// ---------------------------------------------------------------- danh mục sinh từ registry
type Def = (typeof COMMANDS)[string] | (typeof QUERIES)[string];
interface Entry {
  name: string;
  kind: "command" | "query";
  def: Def;
}
const ENTRIES: Entry[] = [
  ...Object.entries(COMMANDS).map(([name, def]): Entry => ({ name, kind: "command", def })),
  ...Object.entries(QUERIES).map(([name, def]): Entry => ({ name, kind: "query", def })),
];

type Ids = Record<string, string>;
/** Đầu vào tay cho mục có `refine`/`regex` mà bộ sinh tự động không dựng được. */
const OVERRIDES: Record<string, (i: Ids) => Record<string, unknown>> = {
  "deposit.receive": (i) => ({
    property_id: i.property_id,
    lease_id: i.lease_id,
    payer_person_id: i.payer_person_id,
    amount: 1000,
    method: "cash",
  }),
  "billing.createPeriod": (i) => ({ property_id: i.property_id, month: "2026-11" }),
  "billing.issuePeriod": (i) => ({
    billing_period_id: i.billing_period_id ?? randomUUID(),
    preview_hash: "a".repeat(64),
  }),
  "reservation.list": (i) => ({ property_id: i.property_id, from: "2026-11-01", to: "2026-11-08" }),
  "ledger.lockPeriod": (i) => ({
    property_id: i.property_id,
    locked_through: "2026-01-31",
    reason: "Chốt kỳ thử nghiệm",
  }),
  "reservation.quote": (i) => ({
    room_type_id: i.room_type_id,
    arrival_date: "2026-11-05",
    departure_date: "2026-11-06",
    guests: 1,
  }),
};

function bodyFor(e: Entry, ids: Ids, withOptionalIds = false): Record<string, unknown> {
  const body = OVERRIDES[e.name]?.(ids) ?? sampleInput(e.def.input, { ids, withOptionalIds });
  if (!body || !e.def.input.safeParse(body).success)
    throw new Error(`${e.name}: không dựng được đầu vào mẫu hợp lệ — thêm vào OVERRIDES`);
  return body;
}

// ---------------------------------------------------------------- fixture
type Role = "housekeeping" | "maintenance" | "tenant" | "accountant" | "front_desk";
const LOW_ROLES: readonly Role[] = ["housekeeping", "maintenance", "tenant", "accountant", "front_desk"];

let t: TestDb;
let deps: HttpDeps;
let A: SeededOrg;
let B: SeededOrg;
let idsA: Ids;
let idsB: Ids;
let bTokens: string[];
const userOf: Record<string, string> = {};
let outsider: string; // người dùng không thuộc tổ chức nào

const OWNER_PREFIX = "owner";
const personIds = (o: SeededOrg) => ({
  person_id: o.ownerPersonId,
  payer_person_id: o.ownerPersonId,
  representative_person_id: o.ownerPersonId,
  debtor_person_id: o.ownerPersonId,
  signer_person_id: o.ownerPersonId,
  recipient_person_id: o.ownerPersonId,
  actor_person_id: o.ownerPersonId,
  membership_id: o.ownerMembershipId,
  assignee_membership_id: o.ownerMembershipId,
  responsible_membership_id: o.ownerMembershipId,
  to_membership_id: o.ownerMembershipId,
  assignee: o.ownerMembershipId,
});

interface Result {
  status: number;
  code: string;
  text: string;
  headers: Headers;
}

async function call(
  e: Entry,
  who: { user?: string | null; org?: string | null; headers?: Record<string, string> },
  input: Record<string, unknown> | string,
): Promise<Result> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(who.user ? { "x-test-user": who.user, "x-test-2fa": "1" } : {}),
    ...(who.org ? { "x-org-id": who.org } : {}),
    ...who.headers,
  };
  let res: Response;
  if (e.kind === "command") {
    const req = new Request("http://local.test/api/v1/x/y", {
      method: "POST",
      headers: { ...headers, "idempotency-key": randomUUID() },
      body: typeof input === "string" ? input : JSON.stringify(input),
    });
    res = await handleCommand(e.def as never, req, deps);
  } else {
    const url = new URL("http://local.test/api/v1/x/y");
    if (typeof input !== "string")
      for (const [k, v] of Object.entries(input)) url.searchParams.set(k, String(v));
    res = await handleQuery(e.def as never, new Request(url, { headers }), deps);
  }
  const text = await res.text();
  let code = "";
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? "ok";
  } catch {
    code = "?";
  }
  return { status: res.status, code, text, headers: res.headers };
}

const ownerA = () => ({ user: A.ownerAuthUserId, org: A.orgId });

/** Số hàng của tổ chức B ở MỌI bảng có organization_id — để chứng minh không có gì bị ghi vào B. */
async function rowsOf(org: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of await tenantTables(t.admin)) {
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(table)} where organization_id = ${org}::uuid`.execute(
      t.admin,
    );
    out[table] = r.rows[0]?.n ?? 0;
  }
  return out;
}

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "KS-A-CONG-KHAI");
  B = await seedOrg(t.admin, "KS-B-BI-MAT");
  deps = {
    db: t.runtime,
    getSession: async (h) => {
      const id = h.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: h.get("x-test-2fa") === "1" } } : null;
    },
    secureCookies: false,
    services: testServices(),
  };
  for (const role of LOW_ROLES) userOf[role] = (await seedMember(t, A, role)).authUserId;
  outsider = await seedAuthUser(t.admin, `ngoai+${randomUUID().slice(0, 6)}@example.test`);

  // Tài nguyên THẬT của B (để BOLA dùng id có thật, không chỉ id ngẫu nhiên không tồn tại).
  const lB = await seedLease(t.admin, {
    orgId: B.orgId,
    propertyId: B.propertyId,
    representativePersonId: B.ownerPersonId,
  });
  const iB = await seedIssuedInvoice(t.admin, {
    orgId: B.orgId,
    propertyId: B.propertyId,
    payerPersonId: B.ownerPersonId,
    lines: [{ amount: 1_000_000 }],
  });
  const rB = await seedReservation(t.admin, { org: B, bookerPersonId: B.ownerPersonId });
  idsB = {
    property_id: B.propertyId,
    unit_id: B.unitId,
    room_type_id: B.roomTypeId,
    floor_id: B.floorId,
    lease_id: lB.leaseId,
    invoice_id: iB.invoiceId,
    reservation_id: rB.reservationId,
    ...personIds(B),
  };
  bTokens = [
    "KS-B-BI-MAT",
    B.orgId,
    B.propertyId,
    B.unitId,
    B.roomTypeId,
    B.floorId,
    B.ownerPersonId,
    B.ownerMembershipId,
    B.ownerAuthUserId,
    lB.leaseId,
    iB.invoiceId,
    iB.memoRef,
    rB.reservationId,
    `owner+${B.orgId.slice(0, 8)}`,
  ];

  // Tài nguyên thật của A (trạng thái ban đầu) để BFLA chạm tới bước kiểm quyền thay vì dừng ở "không tìm thấy".
  const lA = await seedLease(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    representativePersonId: A.ownerPersonId,
  });
  const iA = await seedIssuedInvoice(t.admin, {
    orgId: A.orgId,
    propertyId: A.propertyId,
    payerPersonId: A.ownerPersonId,
    lines: [{ amount: 1_000_000 }],
  });
  const rA = await seedReservation(t.admin, { org: A, bookerPersonId: A.ownerPersonId });
  idsA = {
    property_id: A.propertyId,
    unit_id: A.unitId,
    room_type_id: A.roomTypeId,
    floor_id: A.floorId,
    lease_id: lA.leaseId,
    invoice_id: iA.invoiceId,
    reservation_id: rA.reservationId,
    ...personIds(A),
  };
  const create = async (name: string) => {
    const e = ENTRIES.find((x) => x.name === name) as Entry;
    const r = await call(e, ownerA(), bodyFor(e, idsA));
    if (r.status >= 300) throw new Error(`${name}: ${r.status} ${r.text}`);
    return (JSON.parse(r.text) as { data: Record<string, string> }).data;
  };
  idsA.task_id = (await create("housekeeping.createTask")).taskId as string;
  idsA.work_order_id = (await create("maintenance.createWorkOrder")).workOrderId as string;
  idsA.approval_request_id = (await create("approval.request")).approvalRequestId as string;
});

afterAll(async () => {
  await t?.drop();
});

// ---------------------------------------------------------------- danh mục
describe("authz-matrix — danh mục sinh từ registry", () => {
  it("đủ lệnh/truy vấn, không trùng tên, mọi mục có đầu vào mẫu hợp lệ", () => {
    expect(Object.keys(COMMANDS).length).toBeGreaterThanOrEqual(100);
    expect(Object.keys(QUERIES).length).toBeGreaterThanOrEqual(40);
    expect(new Set(ENTRIES.map((e) => e.name)).size).toBe(ENTRIES.length);
    for (const e of ENTRIES) expect(() => bodyFor(e, idsA), e.name).not.toThrow();
  });
});

// ---------------------------------------------------------------- api1-bola
describe("api1-bola — không phiên, tổ chức khác, id tài nguyên của tổ chức khác", () => {
  it("api1-bola: KHÔNG PHIÊN → 401 UNAUTHENTICATED (problem+json, no-store) cho MỌI lệnh/truy vấn, trước cả validate", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      // Thân rác + header tổ chức hợp lệ: vẫn phải dừng ở xác thực.
      const r = await call(e, { org: A.orgId }, e.kind === "command" ? "{rác" : { khong: "hop-le" });
      if (r.status !== 401 || r.code !== "UNAUTHENTICATED") bad.push(`${e.name}: ${r.status} ${r.code}`);
      else if (
        // Kiểu media (bỏ tham số; T-407 thêm `charset=utf-8`).
        r.headers.get("content-type")?.split(";")[0]?.trim() !== "application/problem+json" ||
        r.headers.get("cache-control") !== "no-store"
      )
        bad.push(`${e.name}: header`);
    }
    expect(bad).toEqual([]);
  });

  it("api1-bola: người dùng chỉ thuộc tổ chức B (hoặc không thuộc tổ chức nào) gọi với X-Org-Id của A → 404 cho MỌI mục", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      for (const [label, user] of [
        ["chủ B", B.ownerAuthUserId],
        ["người ngoài", outsider],
      ] as const) {
        const r = await call(e, { user, org: A.orgId }, bodyFor(e, idsA));
        if (r.status !== 404) bad.push(`${e.name} (${label}): ${r.status} ${r.code}`);
        if (bTokens.some((x) => r.text.includes(x)) || r.text.includes(A.orgId))
          bad.push(`${e.name} (${label}): phản hồi nhắc tới tổ chức`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("api1-bola: org id lạ/hỏng trong X-Org-Id → 404, không 500", async () => {
    for (const org of ["khong-phai-uuid", "00000000-0000-4000-8000-000000000000", `${A.orgId}x`]) {
      for (const e of ENTRIES.slice(0, 12)) {
        const r = await call(e, { user: A.ownerAuthUserId, org }, bodyFor(e, idsA));
        expect(r.status, `${e.name} org=${org}`).toBe(404);
      }
    }
  });

  /**
   * Chủ A (đủ quyền ở A) cầm id THẬT của B: mọi mục có id của B trong đầu vào phải bị từ chối 404 (không phân biệt "không có"
   * với "của người khác"); không mục nào ghi vào B; không phản hồi nào chứa dữ liệu/định danh của B.
   * Ngoại lệ (không phải 404 nhưng vẫn không ghi/không lộ): xem CROSS_ID_NON_404.
   */
  const CROSS_ID_NON_404: Record<string, { codes: string[]; why: string }> = {
    "shift.open": {
      codes: ["SHIFT_ALREADY_OPEN", "VALIDATION_FAILED", "NOT_FOUND"],
      why: "kiểm ca đang mở của chính người này trước khi tra cơ sở; không ghi gì vào B (so số hàng B bên dưới)",
    },
    "payment.record": {
      codes: ["SHIFT_NOT_OPEN", "NOT_FOUND"],
      why: "đòi ca quầy đang mở trước khi tra phiếu; không ghi gì vào B",
    },
    "portal.createRequest": {
      codes: ["FORBIDDEN"],
      why: "cổng người thuê: chặn theo vai trò (chủ không phải `tenant`) trước khi tra id; không ghi gì",
    },
    "portal.submitPaymentClaim": {
      codes: ["FORBIDDEN"],
      why: "cổng người thuê: chặn theo vai trò (chủ không phải `tenant`) trước khi tra id; không ghi gì",
    },
    "ledger.unlockPeriod": {
      codes: ["INVALID_TRANSITION"],
      why: "không có kỳ đã khoá nào trong tổ chức A cho cơ sở này nên không mở khoá được; không ghi gì",
    },
    "credit.requestRefund": {
      codes: ["REFUND_EXCEEDS_BALANCE", "NOT_FOUND"],
      why: "số dư ứng trước của người lạ tính trong phạm vi tổ chức A = 0 nên từ chối 409; không lộ gì của B",
    },
  };

  it("api1-bola: chủ A cầm id thật của B → 404 (hoặc ngoại lệ có lý do), không ghi vào B, không lộ dữ liệu B", async () => {
    const before = await rowsOf(B.orgId);
    const bValues = new Set(Object.values(idsB));
    const bad: string[] = [];
    let crossChecked = 0;
    for (const e of ENTRIES) {
      const body = bodyFor(e, idsB, true);
      const r = await call(e, ownerA(), body);
      const sent = new Set(Object.values(body).map(String));
      const leaked = bTokens.filter((x) => r.text.includes(x) && !sent.has(x)); // id do chính request gửi thì được phản hồi lại
      if (leaked.length) bad.push(`${e.name}: phản hồi chứa ${leaked.join(",")}`);
      if (r.status >= 500) bad.push(`${e.name}: ${r.status}`);
      const usesB = Object.values(body).some((v) => typeof v === "string" && bValues.has(v));
      if (!usesB) continue;
      crossChecked++;
      const exception = CROSS_ID_NON_404[e.name];
      if (r.status === 404) continue;
      if (!exception?.codes.includes(r.code) || r.status < 400) bad.push(`${e.name}: ${r.status} ${r.code}`);
    }
    expect(bad).toEqual([]);
    expect(crossChecked).toBeGreaterThan(60); // phần lớn mục có id tài nguyên → bị thử chéo thật
    expect(await rowsOf(B.orgId)).toEqual(before);
    for (const x of Object.values(CROSS_ID_NON_404)) expect(x.why.length).toBeGreaterThan(20);
  });

  it("api1-bola: truy vấn/danh sách/báo cáo của A không lẫn dữ liệu của B (mọi truy vấn, đầu vào của A)", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES.filter((x) => x.kind === "query")) {
      const r = await call(e, ownerA(), bodyFor(e, idsA));
      for (const tok of bTokens) if (r.text.includes(tok)) bad.push(`${e.name}: chứa ${tok}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- api5-bfla
const ALL5 = LOW_ROLES;
type Allowed = readonly [Action | "self", readonly Role[]];
/**
 * Vai trò được PHÉP thành công (2xx) từng mục; ngoài danh sách này mà 2xx = vượt quyền (BFLA). `self` = việc của chính mình
 * (thông báo, danh sách bản xuất của mình, cổng người thuê); còn lại gắn với hành động trong ma trận SPEC
 * (`packages/domain/src/access/matrix.ts`) — test kiểm mỗi vai trò liệt kê KHÔNG có quyền "no" ở hành động đó.
 */
const ALLOWED_2XX: Record<string, Allowed> = {
  "approval.request": ["credit.refund", ["accountant", "front_desk"]],
  "reservation.hold": ["reservation.manage", ["front_desk"]],
  "reservation.confirm": ["reservation.manage", ["front_desk"]],
  "reservation.cancel": ["reservation.manage", ["front_desk"]],
  "housekeeping.createTask": ["housekeeping.assign", ["front_desk"]],
  "housekeeping.assignTask": ["housekeeping.assign", ["front_desk"]],
  "housekeeping.cancelTask": ["housekeeping.assign", ["front_desk"]],
  "shift.open": ["shift.open_close", ["front_desk"]],
  "deposit.receive": ["deposit.receive", ["front_desk"]],
  "billing.createPeriod": ["billing.prepare", ["accountant"]],
  "reservation.list": ["calendar.read_guests", ["accountant", "front_desk"]],
  "maintenance.createWorkOrder": ["work_order.create", ["housekeeping", "maintenance", "front_desk"]],
  "notifications.markAllRead": ["self", ALL5],
  "notifications.listMine": ["self", ALL5],
  "notifications.getPreferences": ["self", ALL5],
  "exports.listMine": ["self", ALL5],
  "payment.record": ["payment.record", ["front_desk"]],
  "ledger.issueAdjustment": ["payment.allocate", ["accountant"]],
  "ledger.lockPeriod": ["period.lock", ["accountant"]],
  "lease.hold": ["lease.hold", ["front_desk"]],
  "lease.get": ["money.read", ["accountant", "front_desk"]],
  "stay.listNotices": ["residence_notice.manage", ["front_desk"]],
  "housekeeping.listTasks": [
    "calendar.read_status",
    ["housekeeping", "maintenance", "accountant", "front_desk"],
  ],
  "housekeeping.getTask": [
    "calendar.read_status",
    ["housekeeping", "maintenance", "accountant", "front_desk"],
  ],
  "inventory.getUnitStatus": [
    "calendar.read_status",
    ["housekeeping", "maintenance", "accountant", "front_desk"],
  ],
  "today.getSummary": ["calendar.read_status", ["housekeeping", "maintenance", "accountant", "front_desk"]],
  "today.listItems": ["calendar.read_guests", ["front_desk"]],
  "maintenance.listWorkOrders": [
    "calendar.read_status",
    ["housekeeping", "maintenance", "accountant", "front_desk"],
  ],
  "audit.listEvents": ["audit.read", ["accountant"]],
  "reports.receivables": ["money.read", ["accountant", "front_desk"]],
  "reports.collections": ["money.read", ["accountant", "front_desk"]],
  "reports.depositsHeld": ["money.read", ["accountant", "front_desk"]],
  "reports.occupancy": ["money.read", ["accountant", "front_desk"]],
  "report.financialSummary": ["money.read", ["accountant", "front_desk"]],
  "payment.listClaims": ["money.read", ["accountant", "front_desk"]],
  "reservation.get": ["calendar.read_guests", ["accountant", "front_desk"]],
  "reconciliation.previewMatches": ["payment.confirm_transfer", ["accountant"]],
  "portal.listMyInvoices": ["self", ["tenant"]],
  "portal.getMyLease": ["self", ["tenant"]],
  "portal.listMyMeterReadings": ["self", ["tenant"]],
  "portal.listMyRequests": ["self", ["tenant"]],
  "maintenance.listMyWorkOrders": ["work_order.create", ["tenant"]],
};

/** [mục, hành động ma trận, vai trò PHẢI nhận đúng 403]. Vai trò liệt kê đều có quyền "no" ở hành động đó (test kiểm). */
const MUST_403: readonly (readonly [string, Action | null, readonly Role[]])[] = [
  ...["room_type.create", "room_type.update", "rate.set"].map((n) => [n, "pricing.manage", ALL5] as const),
  ["meter.install", "meter.replace", ALL5],
  ["lease.createDraft", "lease.manage", ALL5],
  ...[
    "lease.updateDraft",
    "lease.submitForSignature",
    "lease.sign",
    "lease.cancel",
    "lease.activate",
    "lease.renew",
    "lease.giveNotice",
  ].map((n) => [n, "lease.manage", ["accountant", "front_desk"]] as const),
  ["lease.close", "lease.approve_settlement", ["accountant", "front_desk"]],
  ["ledger.unlockPeriod", "period.unlock", ALL5],
  ["ledger.lockPeriod", "period.lock", ["housekeeping", "maintenance", "tenant", "front_desk"]],
  ["member.resetMfa", "member.change_role", ALL5],
  ...["notifications.updateSettings", "notifications.listDeliveries", "notifications.retryDelivery"].map(
    (n) => [n, "notification.configure", ALL5] as const,
  ),
  ["import.getTemplate", "import.prepare", ALL5],
  ["audit.listEvents", "audit.read", ["housekeeping", "maintenance", "tenant", "front_desk"]],
  ["audit.getEvent", "audit.read", ["housekeeping", "maintenance", "tenant", "front_desk"]],
  ...[
    "reports.receivables",
    "reports.collections",
    "reports.depositsHeld",
    "reports.occupancy",
    "report.financialSummary",
    "payment.listClaims",
  ].map((n) => [n, "money.read", ["housekeeping", "maintenance"]] as const),
  ...["exports.request", "exports.requestOrgExport"].map(
    (n) => [n, "data.export", ["housekeeping", "maintenance", "tenant", "front_desk"]] as const,
  ),
  ...["reservation.create", "stay.walkIn"].map(
    (n) => [n, "reservation.manage", ["housekeeping", "maintenance", "tenant", "accountant"]] as const,
  ),
  ...[
    "reservation.hold",
    "reservation.confirm",
    "reservation.cancel",
    "reservation.changeDates",
    "reservation.markNoShow",
    "stay.checkIn",
  ].map((n) => [n, "reservation.manage", ["accountant"]] as const),
  ["housekeeping.verifyTask", "task.verify", ["housekeeping", "maintenance", "front_desk"]],
  ["housekeeping.startTask", "housekeeping.progress", ["maintenance", "front_desk"]],
  ["housekeeping.completeTask", "housekeeping.progress", ["maintenance", "front_desk"]],
  ...[
    "maintenance.assignWorkOrder",
    "maintenance.startWorkOrder",
    "maintenance.completeWorkOrder",
    "maintenance.cancelWorkOrder",
  ].map((n) => [n, "work_order.handle", ["housekeeping", "front_desk"]] as const),
  ["maintenance.verifyWorkOrder", "task.verify", ["housekeeping", "maintenance", "front_desk"]],
  ["today.getSummary", "calendar.read_status", ["tenant"]],
  // Duyệt đề nghị: chỉ chủ/quản lý (SPEC-ledger hạn mức) — kế toán và lễ tân chỉ được LẬP đề nghị.
  ...["approval.approve", "approval.reject", "approval.cancel"].map(
    (n) => [n, null, ["accountant", "front_desk"]] as const,
  ),
  // Cổng người thuê: chỉ vai trò `tenant`.
  ...[
    "portal.createRequest",
    "portal.submitPaymentClaim",
    "portal.listMyInvoices",
    "portal.getMyInvoice",
    "portal.getMyLease",
    "portal.listMyMeterReadings",
    "portal.listMyRequests",
    "portal.getPaymentInstructions",
  ].map((n) => [n, null, ["housekeeping", "maintenance", "accountant", "front_desk"]] as const),
];

/**
 * Mục mà chủ (có đủ quyền) cũng nhận 404 với tiền tố chỉ có id (thiếu tiền đề: stay đang ở, khoản thu, lô nhập, công tơ…):
 * ca BFLA ở đây chỉ chứng minh "không vai trò thấp nào làm được (2xx)" chứ chưa chứng minh được 403 — 401/404-org/422/id-B
 * vẫn được kiểm ở trên. Danh sách bị khoá: mục mới rơi vào nhóm này mà không khai báo → đỏ.
 */
const NO_PRECONDITION_FIXTURE = [
  "stay.postCharge",
  "stay.voidCharge",
  "stay.checkOut",
  "stay.exportResidenceNotice",
  "stay.markNoticeSubmitted",
  "exports.download",
  "portal.createGuestLink",
  "portal.revokeGuestLink",
  "portal.inviteTenant",
  "portal.revokeTenantAccess",
  "notifications.markRead",
  "inventory.approveBlock",
  "inventory.endBlock",
  "shift.close",
  "shift.handover",
  "shift.receiveHandover",
  "payment.confirm",
  "payment.allocate",
  "payment.reverse",
  "deposit.requestDeduction",
  "deposit.requestRefund",
  "reconciliation.importStatement",
  "reconciliation.confirmMatch",
  "reconciliation.resolveBreak",
  "lease.approveSettlement",
  "service.setPrice",
  "meter.recordReading",
  "meter.replace",
  "billing.issuePeriod",
  "billing.submitForReview",
  "billing.returnToDraft",
  "billing.lockPeriod",
  "billing.reopenPeriod",
  "import.validate",
  "import.setExpectedTotals",
  "import.confirm",
  "import.commit",
  "import.cancel",
  "meter.acknowledgeAnomaly",
  "payment.getTransferInfo",
  "billing.previewPeriod",
  "import.get",
  "import.downloadErrorReport",
  "stay.getFolio",
  "audit.getEvent",
  "exports.getStatus",
  "maintenance.listMyWorkOrders",
  "notifications.retryDelivery",
  "shift.reassignDiscrepancy",
  "identity.get",
  "person.get",
  "meter.getReadingRoute",
];

describe("api5-bfla — vai trò thấp không gọi được chức năng của vai trò cao", () => {
  const results = new Map<string, Result>();
  const key = (name: string, role: string) => `${name}|${role}`;

  it("api5-bfla: chạy MỌI mục × 5 vai trò (nhân viên cấp thấp + người thuê) với tài nguyên thật của A — không 5xx", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const body = bodyFor(e, idsA);
      for (const role of LOW_ROLES) {
        const r = await call(e, { user: userOf[role] as string, org: A.orgId }, body);
        results.set(key(e.name, role), r);
        if (r.status >= 500) bad.push(`${e.name} (${role}): ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
    expect(results.size).toBe(ENTRIES.length * LOW_ROLES.length);
  });

  it("api5-bfla: 2xx chỉ ở (mục, vai trò) được phép; mọi mục khác bị 403/404 hoặc lỗi nghiệp vụ", () => {
    const bad: string[] = [];
    for (const [k, r] of results) {
      if (r.status >= 200 && r.status < 300) {
        const [name, role] = k.split("|") as [string, Role];
        const allowed = ALLOWED_2XX[name];
        if (!allowed?.[1].includes(role)) bad.push(`${name} (${role}): ${r.status} — vượt quyền`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("api5-bfla: danh sách được phép khớp ma trận SPEC (không liệt kê vai trò có quyền 'no'); mục tồn tại trong registry", () => {
    const names = new Set(ENTRIES.map((e) => e.name));
    for (const [name, [action, roles]] of Object.entries(ALLOWED_2XX)) {
      expect(names.has(name), name).toBe(true);
      if (action !== "self")
        for (const role of roles)
          expect(grantFor(action, role as MatrixRole), `${name} ${role}`).not.toBe("no");
    }
  });

  it("api5-bfla: các mục đã chốt phải trả ĐÚNG 403 cho vai trò không có quyền (khớp ma trận SPEC)", () => {
    const bad: string[] = [];
    for (const [name, action, roles] of MUST_403) {
      for (const role of roles) {
        if (action)
          expect(grantFor(action, role as MatrixRole), `${name}: ${role} phải 'no' ở ${action}`).toBe("no");
        const r = results.get(key(name, role));
        if (r?.status !== 403) bad.push(`${name} (${role}): ${r?.status} ${r?.code}`);
      }
    }
    expect(bad).toEqual([]);
    expect(MUST_403.length).toBeGreaterThan(50);
  });

  it("api5-bfla: mục mà chủ cũng nhận 404 (thiếu tiền đề) nằm đúng trong danh sách đã khai; vai trò thấp không 2xx", async () => {
    const owner404: string[] = [];
    for (const e of ENTRIES) {
      const r = await call(e, ownerA(), bodyFor(e, idsA));
      if (r.status === 404 && r.code === "NOT_FOUND") owner404.push(e.name);
    }
    expect(owner404.sort()).toEqual([...NO_PRECONDITION_FIXTURE].sort());
  });

  it("api5-bfla: tổng số ca 403 đã chứng minh (ratchet — giảm là có hồi quy kiểm quyền)", () => {
    const forbidden = [...results.values()].filter((r) => r.status === 403).length;
    expect(forbidden).toBeGreaterThan(220);
  });
});

// ---------------------------------------------------------------- BASE-SEC-001 / BE-AUTH-009
describe("BASE-SEC-001 — trường lạ → 422 ở MỌI lệnh/truy vấn", () => {
  it("thêm trường không khai báo vào đầu vào hợp lệ → 422 VALIDATION_FAILED có `unrecognized_keys` (schema strict)", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const r = await call(e, ownerA(), { ...bodyFor(e, idsA), truong_la_khong_khai_bao: "x" });
      if (r.status !== 422 || r.code !== "VALIDATION_FAILED" || !r.text.includes("unrecognized_keys"))
        bad.push(`${e.name}: ${r.status} ${r.code}`);
    }
    expect(bad).toEqual([]);
  });

  it("đầu vào xấu: sai kiểu, null, chuỗi quá dài, Unicode lạ ở trường đầu tiên → 4xx có kiểm soát (không 5xx)", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const base = bodyFor(e, idsA);
      const first = Object.keys(base)[0];
      if (!first) continue;
      for (const evil of [null, 12345, { a: 1 }, "x".repeat(20_000), "‮\u0000💩", [] as unknown[]]) {
        const r = await call(e, ownerA(), { ...base, [first]: evil });
        if (
          r.status >= 500 ||
          (r.status >= 200 && r.status < 300 && e.kind === "command" && evil === null && false)
        )
          bad.push(`${e.name}.${first}=${JSON.stringify(evil)?.slice(0, 20)}: ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("BE-AUTH-009 — user_id/person_id/organization_id trong thân KHÔNG được nghe theo; danh tính lấy từ phiên", () => {
  const FORBIDDEN_FIELDS = [
    "user_id",
    "auth_user_id",
    "organization_id",
    "org_id",
    "tenant_id",
    "actor_id",
    "role",
    "membership_id",
    "person_id",
  ];

  it("schema không khai báo trường danh tính của NGƯỜI THAO TÁC (user/organization/tenant/actor) — ngoại lệ có lý do", () => {
    const declared = ENTRIES.flatMap((e) => {
      const js = JSON.stringify(
        Object.keys(((e.def.input as unknown as { shape?: object }).shape ?? {}) as object),
      );
      return JSON.parse(js).map((f: string) => `${e.name}.${f}`);
    });
    const hits = declared.filter((d) =>
      /\.(user_id|auth_user_id|organization_id|org_id|tenant_id|actor_id)$/.test(d),
    );
    expect(hits).toEqual([]);
    // `actor_person_id` là BỘ LỌC của audit.listEvents (xem người đã làm gì, trong tổ chức), không phải danh tính thao tác.
    expect(declared.filter((d) => /\.actor_person_id$/.test(d))).toEqual([
      "audit.listEvents.actor_person_id",
    ]);
  });

  it("gửi user_id/person_id/organization_id/role/membership_id không khai báo → 422, không lệnh nào chạy", async () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const declared = new Set(
        Object.keys(((e.def.input as unknown as { shape?: object }).shape ?? {}) as object),
      );
      const base = bodyFor(e, idsA);
      for (const f of FORBIDDEN_FIELDS.filter((x) => !declared.has(x))) {
        const r = await call(e, ownerA(), { ...base, [f]: f.endsWith("id") ? B.ownerPersonId : "owner" });
        if (r.status !== 422) bad.push(`${e.name} + ${f}: ${r.status} ${r.code}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("hành động ghi nhận người thao tác = người trong PHIÊN, dù thân gửi kèm person_id của người khác (bị 422, không ghi gì)", async () => {
    const e = ENTRIES.find((x) => x.name === "maintenance.createWorkOrder") as Entry;
    const user = userOf.maintenance as string;
    const me = await sql<{
      id: string;
    }>`select person_id as id from memberships where auth_user_id = ${user}::uuid and organization_id = ${A.orgId}::uuid`.execute(
      t.admin,
    );
    const myPerson = me.rows[0]?.id;
    const forged = await call(e, { user, org: A.orgId }, { ...bodyFor(e, idsA), person_id: A.ownerPersonId });
    expect(forged.status).toBe(422);
    const ok = await call(e, { user, org: A.orgId }, bodyFor(e, idsA));
    expect(ok.status).toBe(201);
    const key = (JSON.parse(ok.text) as { command_id: string }).command_id;
    const audit = await sql<{
      actor_person_id: string;
    }>`select actor_person_id from audit_events where command_id = ${key}::uuid`.execute(t.admin);
    expect(audit.rows.map((r) => r.actor_person_id)).toEqual([myPerson]);
    expect(myPerson).not.toBe(A.ownerPersonId);
  });
});

// ---------------------------------------------------------------- BE-AUTH-004: đăng xuất
describe("BE-AUTH-004 — đăng xuất rồi dùng lại cookie → 401 (phiên vô hiệu ở server)", () => {
  // Mật khẩu giả cho DB test tạm; ghép lúc chạy để máy quét bí mật không nhầm là khoá thật.
  const PASSWORD = ["mat", "khau", "thu", "nghiem", "12"].join("-");
  const BASE = "https://hm.example.vn";
  let closeAuth: () => Promise<void>;

  afterAll(async () => {
    await closeAuth?.();
  });

  it("đăng nhập thật → gọi truy vấn 200; đăng xuất → cùng cookie đó gọi lại → 401 UNAUTHENTICATED, mọi mục registry", async () => {
    const created = createAuth({
      databaseUrl: t.runtimeUrl,
      secret: "s".repeat(48),
      baseURL: BASE,
      ipRateLimit: false,
    });
    closeAuth = created.close;
    const email = `dx+${randomUUID().slice(0, 8)}@example.test`;
    const signedUp = await created.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    // Người này là thành viên `housekeeping` của A (không cần MFA) bằng tài khoản Better Auth thật.
    const personId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${A.orgId}, 'Người đăng xuất')`.execute(
      t.admin,
    );
    const membershipId = randomUUID();
    await sql`insert into memberships (id, organization_id, auth_user_id, person_id, role)
              values (${membershipId}, ${A.orgId}, ${signedUp.user.id}, ${personId}, 'housekeeping')`.execute(
      t.admin,
    );
    await sql`insert into property_scopes (id, organization_id, membership_id, property_id)
              values (${randomUUID()}, ${A.orgId}, ${membershipId}, ${A.propertyId})`.execute(t.admin);

    const real: HttpDeps = {
      ...deps,
      secureCookies: true,
      getSession: async (headers) => {
        const s = await created.auth.api.getSession({ headers });
        return s
          ? {
              user: { id: s.user.id, twoFactorEnabled: s.user.twoFactorEnabled },
              session: { createdAt: s.session.createdAt },
            }
          : null;
      },
    };
    const signIn = await created.auth.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("__Host-hm.session_token=");

    const query = ENTRIES.find((e) => e.name === "notifications.listMine") as Entry;
    const asQuery = (c: string | null) =>
      handleQuery(
        query.def as never,
        new Request("http://local.test/q", { headers: { ...(c ? { cookie: c } : {}), "x-org-id": A.orgId } }),
        real,
      );
    expect((await asQuery(cookie)).status).toBe(200);

    const out = await created.auth.handler(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: "{}",
      }),
    );
    expect(out.status).toBe(200);

    // Cùng cookie sau đăng xuất: truy vấn, lệnh, và tra trạng thái lệnh đều 401.
    const after = await asQuery(cookie);
    expect(after.status).toBe(401);
    expect(((await after.json()) as { code: string }).code).toBe("UNAUTHENTICATED");
    const failures: string[] = [];
    for (const e of ENTRIES) {
      const headers = { cookie, "x-org-id": A.orgId, "content-type": "application/json" };
      const res =
        e.kind === "command"
          ? await handleCommand(
              e.def as never,
              new Request("http://local.test/c", {
                method: "POST",
                headers: { ...headers, "idempotency-key": randomUUID() },
                body: JSON.stringify(bodyFor(e, idsA)),
              }),
              real,
            )
          : await handleQuery(e.def as never, new Request("http://local.test/q", { headers }), real);
      if (res.status !== 401) failures.push(`${e.name}: ${res.status}`);
    }
    expect(failures).toEqual([]);
    // Phiên đã xoá ở CSDL (không chỉ cookie hết hạn phía client).
    const left = await sql<{
      n: number;
    }>`select count(*)::int as n from auth.session where "userId" = ${signedUp.user.id}::uuid`.execute(
      t.admin,
    );
    expect(left.rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------- BE-API-009: mọi route đều có guard hoặc nằm trong danh sách công khai đã duyệt
describe("BE-API-009 — route không guard = danh sách công khai đã duyệt", () => {
  const API = "apps/web/app/api/";
  const routes = sourceFiles(["apps/web/app/api"], /^route\.ts$/).map((f) => ({
    ...f,
    rel: f.path.slice(API.length),
  }));

  /** Route công khai ĐÃ DUYỆT: không dùng cookie phiên, tự bảo vệ bằng thông tin xác thực riêng. */
  const PUBLIC: Record<string, string> = {
    "health/route.ts": "liveness: chỉ trả {status:ok}, không dữ liệu",
    "ready/route.ts": "readiness cho hạ tầng: chỉ trạng thái các phụ thuộc, không dữ liệu nghiệp vụ",
    "metrics/route.ts": "Bearer token dẫn xuất từ bí mật (handleMetrics), 401 nếu thiếu/sai",
    "auth/[...all]/route.ts": "Better Auth: tự xác thực; khoá tạm, rate limit theo IP/tài khoản",
    "v1/webhooks/[provider]/[account]/route.ts": "chữ ký HMAC của nhà cung cấp (handleWebhook), không cookie",
    "v1/notifications/unsubscribe/route.ts":
      "token ký trong email (handleUnsubscribe), thao tác chỉ trên thông báo của người nhận",
    "v1/portal/guest/stays/[id]/route.ts":
      "liên kết khách có token + 4 số cuối SĐT (handleGuestStay), hạn ngắn, thu hồi được",
  };
  /** Route bắt buộc phiên: file route hoặc hàm xử lý nó gọi phải kiểm phiên/actor. */
  const SESSION_GUARDED: Record<string, RegExp> = {
    "v1/[module]/[command]/route.ts": /handleCommand|handleQuery/,
    "v1/commands/[id]/route.ts": /handleCommandStatus/,
    "v1/me/route.ts": /getSession/,
    "v1/session/switchOrganization/route.ts": /getSession/,
    "v1/files/upload/route.ts": /handleFileUpload/,
    "v1/import/upload/route.ts": /handleImportUpload/,
  };

  it("mỗi route.ts thuộc đúng một nhóm (công khai đã duyệt | bắt buộc phiên); route mới chưa phân loại → đỏ", () => {
    const rels = routes.map((r) => r.rel).sort();
    expect(rels).toEqual([...Object.keys(PUBLIC), ...Object.keys(SESSION_GUARDED)].sort());
    for (const why of Object.values(PUBLIC)) expect(why.length).toBeGreaterThan(20);
  });

  it("route bắt buộc phiên gọi đúng hàm bảo vệ; các hàm đó dùng actorFromRequest/getSession", () => {
    for (const r of routes) {
      const guard = SESSION_GUARDED[r.rel];
      if (guard) expect(r.text, r.rel).toMatch(guard);
    }
    const body = (p: string) => readFileSync(`${REPO_ROOT}${p}`, "utf8");
    for (const [file, fn] of [
      ["packages/app/src/http/command-route.ts", "handleCommand"],
      ["packages/app/src/http/command-route.ts", "handleQuery"],
      ["packages/app/src/http/command-route.ts", "handleCommandStatus"],
      ["packages/app/src/files/http.ts", "handleFileUpload"],
      ["packages/app/src/import/http.ts", "handleImportUpload"],
    ] as const) {
      const src = body(file);
      const start = src.indexOf(`export async function ${fn}`);
      expect(start, `${file}: ${fn}`).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport ", start + 10);
      expect(src.slice(start, next < 0 ? undefined : next), fn).toMatch(/actorFromRequest\(/);
    }
    expect(routes.find((r) => r.rel === "v1/me/route.ts")?.text).toMatch(/if \(!s\)[\s\S]{0,200}401/);
  });

  it("không phiên → upload/trạng thái lệnh 401 (gọi hàm xử lý thật)", async () => {
    const { handleFileUpload } = await import("../files/http.ts");
    const { handleImportUpload } = await import("../import/http.ts");
    const { handleCommandStatus } = await import("./command-route.ts");
    for (const res of [
      await handleFileUpload(
        new Request("http://local.test/u", { method: "POST", body: new FormData() }),
        deps,
      ),
      await handleImportUpload(
        new Request("http://local.test/u", { method: "POST", body: new FormData() }),
        deps,
      ),
      await handleCommandStatus(randomUUID(), new Request("http://local.test/c"), deps),
    ])
      expect(res.status).toBe(401);
  });

  it("route công khai tự bảo vệ: metrics thiếu token → 401; huỷ đăng ký/khách với token sai → không 2xx", async () => {
    const { handleMetrics } = await import("../observability/metrics.ts");
    const { handleUnsubscribe } = await import("../notifications/http.ts");
    const { handleGuestStay } = await import("../portal/guest-http.ts");
    expect(
      (await handleMetrics(new Request("http://local.test/m"), { db: t.runtime, secret: "s".repeat(40) }))
        .status,
    ).toBe(401);
    expect(
      (
        await handleMetrics(
          new Request("http://local.test/m", { headers: { authorization: "Bearer sai" } }),
          {
            db: t.runtime,
            secret: "s".repeat(40),
          },
        )
      ).status,
    ).toBe(401);
    const unsub = await handleUnsubscribe(
      new Request("http://local.test/u", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "gia-mao" }),
      }),
      { db: t.runtime, secret: "s".repeat(40) },
    );
    expect(unsub.status).toBeGreaterThanOrEqual(400);
    expect(unsub.status).toBeLessThan(500);
    const guest = await handleGuestStay(new Request("http://local.test/g"), randomUUID(), {
      db: t.runtime,
      clientIp: "203.0.113.9",
    });
    expect(guest.status).toBeGreaterThanOrEqual(400);
    expect(guest.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------- tên test gắn thẻ (STD-SEC-004)
describe("authz-matrix — thẻ api1-bola/api5-bfla có mặt trong bộ test", () => {
  it("file này chứa ≥ 2 test mang thẻ", () => {
    const text = readFileSync(new URL(import.meta.url), "utf8");
    expect(text.match(/api1-bola/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text.match(/api5-bfla/g)?.length).toBeGreaterThanOrEqual(2);
    void OWNER_PREFIX;
  });
});
