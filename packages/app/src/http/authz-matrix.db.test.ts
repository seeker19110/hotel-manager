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
  withSignUpConsent,
} from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../auth/auth.ts";
import { signSim } from "../ledger/bank-inbox.ts";
import { testServices } from "../server/services.ts";
import { seedMember } from "../testing/helpers.ts";
import { sampleInput } from "../testing/schema-sample.ts";
import { REPO_ROOT, sourceFiles } from "../testing/source-scan.ts";
import { type HttpDeps, handleCommand, handleQuery, handleUserCommand } from "./command-route.ts";
import { handleFileUpload } from "./file-upload.ts";
import { handleGuestStay } from "./guest-stay.ts";
import { handleImportUpload } from "./import-upload.ts";
import { COMMANDS, QUERIES, USER_COMMANDS } from "./registry.ts";
import { handleSwitchOrganization } from "./switch-organization.ts";
import { handleUnsubscribe } from "./unsubscribe.ts";
import { handleWebhook } from "./webhook-route.ts";

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
  // Mọi trường ngoài `property_id` đều tuỳ chọn nhưng cần ≥ 1 trường để đổi.
  "property.update": (i) => ({ property_id: i.property_id, name: "Tên cơ sở mới" }),
  // Không gửi membership_id = tự thu hồi phiên của mình (ai cũng được) — ma trận cần ca "thu hồi phiên NGƯỜI KHÁC".
  "session.revokeAll": (i) => ({ membership_id: i.membership_id }),
  "billing.createPeriod": (i) => ({ property_id: i.property_id, month: "2026-11" }),
  // Phòng có hợp đồng nháp chưa kết thúc ⇒ chủ luôn nhận 409 UNIT_IN_USE (không bao giờ lưu trữ thật phòng dùng chung của
  // fixture — nếu không các lệnh khác dùng `unit_id` sẽ nhận 404 tuỳ thứ tự chạy).
  "unit.archive": (i) => ({ unit_id: i.leased_unit_id as string }),
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
  "inventory.getCalendar": (i) => ({ property_id: i.property_id, from: "2026-11-01", to: "2026-11-08" }),
  "inventory.searchAvailability": (i) => ({
    property_id: i.property_id,
    start: "2026-11-05T14:00:00+07:00",
    end: "2026-11-06T12:00:00+07:00",
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
/** Lệnh nạp phòng/loại phòng/cơ sở trước khi kiểm quyền: người thuê ngoài cơ sở nhận 404 vì RLS giấu danh mục (migration 0064). */
const TENANT_HIDDEN = new Set([
  "room_type.update",
  "rate.set",
  "meter.install",
  "unit.archive",
  "lease.createDraft",
  "reservation.create",
  "stay.walkIn",
  "inventory.setUnitAvailability",
]);
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
    // Ma trận gọi hàng trăm lệnh vào CÙNG tổ chức trong < 1 phút — nới hạn mức T-401 (đã có test riêng `command-quota`).
    commandQuotaPerMinute: 100_000,
    commandMemberQuotaPerMinute: 100_000,
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
    leased_unit_id: lB.unitId,
    ...personIds(B),
  };
  bTokens = [
    "KS-B-BI-MAT",
    B.orgId,
    B.propertyId,
    B.unitId,
    lB.unitId,
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
    leased_unit_id: lA.unitId,
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

  it("SPEC-access S-013: api1-bola: chủ A cầm id thật của B → 404 (hoặc ngoại lệ có lý do), không ghi vào B, không lộ dữ liệu B", async () => {
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
  "inventory.getCalendar": [
    "calendar.read_status",
    ["housekeeping", "maintenance", "accountant", "front_desk"],
  ],
  "inventory.searchAvailability": [
    "calendar.read_status",
    ["housekeeping", "maintenance", "accountant", "front_desk"],
  ],
  "property.list": ["calendar.read_status", ["housekeeping", "maintenance", "accountant", "front_desk"]],
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
  // SPEC-access S-005/S-006: chỉ chủ/quản lý được tạo/lưu trữ phòng (`unit.manage`).
  ...["unit.create", "unit.archive"].map((n) => [n, "unit.manage", ALL5] as const),
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
  ["member.invite", "member.invite_senior", ALL5],
  ["member.list", "member.invite_staff", ALL5],
  ["property.list", "calendar.read_status", ["tenant"]],
  ["session.revokeAll", "session.revoke_other", ALL5],
  ["member.updateRole", "member.change_role", ALL5],
  ["member.updateScope", "member.change_role", ALL5],
  ["property.create", "org.configure", ALL5],
  ["property.update", "org.configure", ALL5],
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
  ["inventory.getCalendar", "calendar.read_status", ["tenant"]],
  ["inventory.searchAvailability", "calendar.read_status", ["tenant"]],
  ["inventory.setUnitAvailability", "unit.set_availability", ALL5],
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
        // AUD-DATA-001 (0064): người thuê không có hợp đồng ở cơ sở của đối tượng thì RLS giấu luôn phòng/loại phòng ⇒ lệnh dành
        // cho nhân viên trả 404 (không lộ sự tồn tại) thay vì 403; vẫn bị từ chối và không ghi gì.
        const want = role === "tenant" && TENANT_HIDDEN.has(name) ? 404 : 403;
        if (r?.status !== want) bad.push(`${name} (${role}): ${r?.status} ${r?.code}`);
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

  it("đầu vào xấu: sai kiểu, null, chuỗi quá dài, Unicode lạ ở trường đầu tiên → 4xx có kiểm soát (không 2xx, không 5xx)", async () => {
    const bad: string[] = [];
    let trials = 0;
    for (const e of ENTRIES) {
      const base = bodyFor(e, idsA);
      const first = Object.keys(base)[0];
      if (!first) continue;
      for (const evil of [null, 12345, { a: 1 }, "x".repeat(20_000), "‮\u0000💩", [] as unknown[]]) {
        const r = await call(e, ownerA(), { ...base, [first]: evil });
        trials++;
        if (r.status >= 500 || (r.status >= 200 && r.status < 300))
          bad.push(`${e.name}.${first}=${JSON.stringify(evil)?.slice(0, 20)}: ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
    expect(trials).toBeGreaterThan(300); // vòng lặp không rỗng
  });

  it("quan hệ sai giữa các trường (kết thúc < bắt đầu) → 4xx có kiểm soát: không 2xx, không 5xx", async () => {
    // Cặp (đầu, cuối) cùng nằm trong một đầu vào; giá trị cuối được đặt SỚM hơn giá trị đầu.
    const PAIRS: [string, string][] = [
      ["from", "to"],
      ["arrival_date", "departure_date"],
      ["start", "end"],
      ["effective_from", "effective_to"],
    ];
    const FORMS = [
      { early: "2000-01-01", late: "2030-01-01" },
      { early: "2000-01-01T00:00:00Z", late: "2030-01-01T00:00:00Z" },
    ];
    const bad: string[] = [];
    const exercised: string[] = [];
    for (const e of ENTRIES) {
      const keys = Object.keys(((e.def.input as unknown as { shape?: object }).shape ?? {}) as object);
      for (const withOptionalIds of [false, true]) {
        const base = bodyFor(e, idsA, withOptionalIds);
        for (const [a, b] of PAIRS) {
          if (!keys.includes(a) || !keys.includes(b)) continue; // kể cả trường tuỳ chọn mà đầu vào mẫu bỏ qua
          // Dạng ngày hay thời điểm: chọn dạng mà đầu vào ĐÚNG THỨ TỰ qua được schema.
          const form = FORMS.find(
            (f) => e.def.input.safeParse({ ...base, [a]: f.early, [b]: f.late }).success,
          );
          if (!form) continue;
          exercised.push(`${e.name}.${a}/${b}`);
          const r = await call(e, ownerA(), { ...base, [a]: form.late, [b]: form.early });
          if (r.status < 400 || r.status >= 500) bad.push(`${e.name}.${a}>${b}: ${r.status} ${r.code}`);
        }
      }
    }
    // Điều khoản hợp đồng lồng (`terms.effective_from/effective_to`).
    for (const e of ENTRIES) {
      const base = bodyFor(e, idsA);
      const terms = base.terms as Record<string, unknown> | undefined;
      if (!terms || typeof terms !== "object" || !("effective_from" in terms)) continue;
      exercised.push(`${e.name}.terms`);
      const r = await call(e, ownerA(), {
        ...base,
        terms: { ...terms, effective_from: "2030-01-01", effective_to: "2000-01-01" },
      });
      if (r.status < 400 || r.status >= 500) bad.push(`${e.name}.terms: ${r.status} ${r.code}`);
    }
    expect(bad).toEqual([]);
    expect(exercised.length).toBeGreaterThanOrEqual(8); // không vô hiệu hoá âm thầm khi registry đổi
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

  it("SPEC-access S-014: gửi user_id/person_id/organization_id/role/membership_id không khai báo → 422, không lệnh nào chạy", async () => {
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
    const signedUp = await created.auth.api.signUpEmail({
      body: withSignUpConsent({ email, password: PASSWORD, name: email }),
    });
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
    "version/route.ts":
      "app.getVersion (SPEC-pwa S-009): chỉ trả phiên bản build + mức client tối thiểu, hằng số, không dữ liệu người dùng",
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
    "v1/session/switchOrganization/route.ts": /handleSwitchOrganization/,
    // T-2310: đồng ý của CHÍNH người đăng nhập — handleConsentsGet/Post trả 401 khi không có phiên (privacy/consent.db.test.ts).
    "v1/privacy/consents/route.ts": /handleConsentsGet[\s\S]*handleConsentsPost/,
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
      ["packages/app/src/http/file-upload.ts", "handleFileUpload"],
      ["packages/app/src/http/import-upload.ts", "handleImportUpload"],
    ] as const) {
      const src = body(file);
      const fnBody = (decl: string) => {
        const start = src.search(new RegExp(`(?:export )?(?:async )?function ${decl}\\b`));
        expect(start, `${file}: ${decl}`).toBeGreaterThan(-1);
        const next = src.slice(start + 10).search(/\n(?:export |async function |function )/);
        return src.slice(start, next < 0 ? undefined : start + 10 + next);
      };
      let text = fnBody(fn);
      // T-406 bọc hàm công khai để đo metric và gọi hàm `run…` bên trong — kiểm thân hàm đó.
      const inner = /\b(run[A-Z]\w*)\(/.exec(text)?.[1];
      if (!/actorFromRequest\(/.test(text) && inner) text = fnBody(inner);
      expect(text, fn).toMatch(/actorFromRequest\(/);
    }
    // /api/v1/me: route lấy phiên (getSession) và giao cho handleMe; handleMe trả 401 khi không có người dùng (AUD-XFEAT-004).
    const me = routes.find((r) => r.rel === "v1/me/route.ts")?.text ?? "";
    expect(me).toMatch(/getSession\(/);
    expect(me).toMatch(/return handleMe\(req,/);
    expect(readFileSync(new URL("./me-route.ts", import.meta.url), "utf8")).toMatch(
      /if \(!user\) return simpleProblem\("UNAUTHENTICATED", 401,/,
    );
  });

  it("không phiên → upload/trạng thái lệnh 401 (gọi hàm xử lý thật)", async () => {
    const { handleFileUpload } = await import("./file-upload.ts");
    const { handleImportUpload } = await import("./import-upload.ts");
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
    const { handleUnsubscribe } = await import("./unsubscribe.ts");
    const { handleGuestStay } = await import("./guest-stay.ts");
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

// ---------------------------------------------------------------- BASE-SEC-001: entrypoint NGOÀI registry (T-607)
// Registry đã phủ ở trên (schema strict + đầu vào xấu cho từng mục). Phần còn lại là các route tự phân tích đầu vào:
// upload, import-upload, webhook, huỷ đăng ký, liên kết khách, chọn tổ chức, Better Auth. Mỗi cái nhận đầu vào xấu
// (sai kiểu, null, quá dài, Unicode lạ, quan hệ/định dạng sai) phải trả 4xx CÓ KIỂM SOÁT: không 2xx, không 5xx, thân là
// problem+json (riêng Better Auth: JSON của thư viện) và không lộ stack/SQL.
describe("BASE-SEC-001 — entrypoint ngoài registry: đầu vào xấu → 4xx có kiểm soát", () => {
  const WEBHOOK_SECRET = "khoa-chi-dung-trong-test-base-sec-001-0123456789";
  const LONG = "x".repeat(20_000);
  const WEIRD = "‮\u0000💩\ud800"; // đảo chiều, NUL, emoji, surrogate lẻ
  const WEIRD_HEADER = "é\u00ff¡"; // header chỉ nhận ByteString (≤ U+00FF): ký tự lạ trong phạm vi đó
  const uuid = () => randomUUID();
  let webhookAccount: string;

  /** 4xx (không 2xx/5xx), không lộ chi tiết nội bộ; `problem` = phải là problem+json. */
  async function expectControlled(res: Response, label: string, opts: { problem?: boolean } = {}) {
    const text = await res.text();
    expect(res.status, `${label}: ${res.status} ${text.slice(0, 160)}`).toBeGreaterThanOrEqual(400);
    expect(res.status, `${label}: ${res.status} ${text.slice(0, 160)}`).toBeLessThan(500);
    expect(text, label).not.toMatch(/stack|node_modules|select .* from|syntax error|at .*\(.*:\d+:\d+\)/i);
    if (opts.problem !== false)
      expect(res.headers.get("content-type") ?? "", label).toContain("application/problem+json");
    return text;
  }

  beforeAll(async () => {
    webhookAccount = uuid();
    await sql`insert into receiving_accounts (id, organization_id, property_id, bank_code, account_number_masked, account_number, account_name)
              values (${webhookAccount}, ${A.orgId}, ${A.propertyId}, 'VCB', '****0010', '1017590010', 'NGUYEN VAN A')`.execute(
      t.admin,
    );
  });

  const asOwner = (extra: Record<string, string> = {}) => ({
    "x-test-user": A.ownerAuthUserId,
    "x-test-2fa": "1",
    "x-org-id": A.orgId,
    ...extra,
  });

  it("mỗi route.ts có lớp validate đầu vào KHAI BÁO (schema/regex allowlist) hoặc không nhận đầu vào; route mới chưa khai báo → đỏ", () => {
    const src = (f: string) => readFileSync(`${REPO_ROOT}packages/app/src/http/${f}`, "utf8");
    /** route → [tệp chứa lớp validate, dấu vết bắt buộc]; `null` = không nhận đầu vào từ người gọi (kèm lý do). */
    const GUARDS: Record<string, [string, RegExp] | { none: string }> = {
      "v1/[module]/[command]/route.ts": [
        "command-route.ts",
        /def\.input\.safeParse\(body\)[\s\S]*def\.input\.safeParse\(params\)/,
      ],
      "v1/commands/[id]/route.ts": [
        "../pipeline/command.ts",
        /getCommandResult[\s\S]*UUID\.test\(commandId\)/,
      ],
      "v1/session/switchOrganization/route.ts": [
        "switch-organization.ts",
        /z\.strictObject\([\s\S]*safeParse/,
      ],
      "v1/privacy/consents/route.ts": [
        "consents-route.ts",
        /z\.strictObject\([\s\S]*consentChangeInput\.safeParse\(raw\)/,
      ],
      "v1/files/upload/route.ts": ["file-upload.ts", /OWNER_TYPES\.includes[\s\S]*UUID\.test\(propertyId\)/],
      "v1/import/upload/route.ts": ["import-upload.ts", /UUID\.test\(propertyId\)[\s\S]*kind\.length > 40/],
      "v1/webhooks/[provider]/[account]/route.ts": [
        "webhook-route.ts",
        /z\.strictObject\([\s\S]*UUID\.test\(account\)/,
      ],
      "v1/notifications/unsubscribe/route.ts": ["unsubscribe.ts", /token\.length > 512/],
      "v1/portal/guest/stays/[id]/route.ts": ["../portal/guest.ts", /TOKEN\.test\(input\.token\)/],
      "auth/[...all]/route.ts": {
        none: "Better Auth tự validate (schema zod của thư viện); đầu vào xấu kiểm ở mô tả 'Better Auth' dưới",
      },
      "v1/me/route.ts": { none: "GET không tham số; chỉ đọc phiên" },
      "health/route.ts": { none: "GET không tham số" },
      "ready/route.ts": { none: "GET không tham số" },
      "metrics/route.ts": { none: "GET không tham số; Bearer token so khớp hằng-thời-gian" },
      "version/route.ts": {
        none: "GET không tham số, công khai; chỉ trả hằng phiên bản build (SPEC-pwa §5)",
      },
    };
    const routes = sourceFiles(["apps/web/app/api"], /^route\.ts$/).map((f) =>
      f.path.slice("apps/web/app/api/".length),
    );
    expect(routes.sort()).toEqual(Object.keys(GUARDS).sort());
    for (const [route, g] of Object.entries(GUARDS)) {
      if ("none" in g) expect(g.none.length, route).toBeGreaterThan(10);
      else expect(src(g[0]), route).toMatch(g[1]);
    }
  });

  it("commands/{id}: id không phải UUID/Unicode/quá dài → 404 COMMAND_NOT_FOUND có kiểm soát", async () => {
    const { handleCommandStatus } = await import("./command-route.ts");
    for (const id of ["khong-phai-uuid", "", WEIRD, LONG, "00000000-0000-4000-8000-00000000000g"]) {
      const res = await handleCommandStatus(
        id,
        new Request("http://local.test/c", { headers: asOwner() }),
        deps,
      );
      expect(await expectControlled(res, `commands/${id.slice(0, 10)}`)).toContain("COMMAND_NOT_FOUND");
      expect(res.status).toBe(404);
    }
  });

  it("files/upload: owner_type/property_id sai (kiểu, Unicode, quá dài, thiếu), Idempotency-Key sai, thân quá lớn, file rác → 4xx", async () => {
    const call = (
      qs: Record<string, string>,
      headers: Record<string, string>,
      body: string | Uint8Array | FormData = "x",
    ) =>
      handleFileUpload(
        new Request(`http://local.test/api/v1/files/upload?${new URLSearchParams(qs)}`, {
          method: "POST",
          headers: { ...asOwner(), "idempotency-key": uuid(), ...headers },
          body,
        }),
        deps,
      );
    const ok = { owner_type: "work_order", property_id: A.propertyId };
    const cases: [string, Promise<Response>][] = [
      ["owner_type thiếu", call({ property_id: A.propertyId }, {})],
      ["owner_type lạ", call({ ...ok, owner_type: "lease" }, {})],
      ["owner_type Unicode", call({ ...ok, owner_type: WEIRD }, {})],
      ["owner_type quá dài", call({ ...ok, owner_type: LONG }, {})],
      ["property_id không phải UUID", call({ ...ok, property_id: "không-phải-uuid" }, {})],
      ["property_id Unicode", call({ ...ok, property_id: WEIRD }, {})],
      ["property_id quá dài", call({ ...ok, property_id: LONG }, {})],
      ["property_id rỗng", call({ ...ok, property_id: "" }, {})],
      ["thiếu Idempotency-Key", call(ok, { "idempotency-key": "" })],
      ["Idempotency-Key không phải UUID", call(ok, { "idempotency-key": WEIRD_HEADER })],
      ["thân khai báo quá lớn", call(ok, { "content-length": "999999999" })],
      ["thân rỗng", call(ok, {}, new Uint8Array())],
      ["byte rác không phải ảnh/PDF", call(ok, {}, new Uint8Array([0, 1, 2, 3, 250, 251]))],
    ];
    for (const [label, p] of cases) await expectControlled(await p, `files/upload ${label}`);
  });

  it("import/upload: không phải multipart, multipart hỏng, thiếu file, property_id/kind/cutoff_on sai → 4xx", async () => {
    const call = (init: { headers?: Record<string, string>; body: string | Uint8Array | FormData }) =>
      handleImportUpload(
        new Request("http://local.test/api/v1/import/upload", {
          method: "POST",
          headers: { ...asOwner(), "idempotency-key": uuid(), ...init.headers },
          body: init.body,
        }),
        deps,
      );
    const form = (f: Record<string, string | Blob | undefined>) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(f))
        if (v !== undefined) typeof v === "string" ? fd.append(k, v) : fd.append(k, v, "x.csv");
      return fd;
    };
    const csv = new Blob(["a,b\n1,2\n"], { type: "text/csv" });
    const good = { file: csv, property_id: A.propertyId, kind: "rooms" } as const;
    const cases: [string, Promise<Response>][] = [
      ["JSON thay vì multipart", call({ headers: { "content-type": "application/json" }, body: "{}" })],
      [
        "multipart hỏng",
        call({
          headers: { "content-type": "multipart/form-data; boundary=zzz" },
          body: "rác không có ranh giới",
        }),
      ],
      ["thiếu file", call({ body: form({ property_id: A.propertyId, kind: "rooms" }) })],
      ["file là chuỗi", call({ body: form({ ...good, file: "không phải file" }) })],
      ["property_id không phải UUID", call({ body: form({ ...good, property_id: "abc" }) })],
      ["property_id Unicode", call({ body: form({ ...good, property_id: WEIRD }) })],
      ["thiếu property_id", call({ body: form({ file: csv, kind: "rooms" }) })],
      ["kind quá dài", call({ body: form({ ...good, kind: "k".repeat(41) }) })],
      ["kind lạ", call({ body: form({ ...good, kind: WEIRD }) })],
      ["thiếu kind", call({ body: form({ file: csv, property_id: A.propertyId }) })],
      ["cutoff_on quá dài", call({ body: form({ ...good, cutoff_on: "2026-01-01T00:00:00Z" }) })],
      ["cutoff_on không phải ngày", call({ body: form({ ...good, cutoff_on: "hôm qua" }) })],
      ["thiếu Idempotency-Key", call({ headers: { "idempotency-key": "" }, body: form(good) })],
      ["thân khai báo quá lớn", call({ headers: { "content-length": "999999999" }, body: form(good) })],
      [
        "file rác nhị phân",
        call({ body: form({ ...good, file: new Blob([new Uint8Array([0, 255, 1, 254])]) }) }),
      ],
    ];
    for (const [label, p] of cases) await expectControlled(await p, `import/upload ${label}`);
  });

  it("webhooks: nhà cung cấp lạ, chữ ký/timestamp sai, thân không phải JSON, sai kiểu, null, quá dài, trường lạ, Unicode → 4xx", async () => {
    const wdeps = { db: t.runtime, simSecret: WEBHOOK_SECRET };
    const good = () => ({
      event_id: `E-bs-${uuid()}`,
      bank_txn_ref: `BS${uuid().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
      amount: 500_000,
      occurred_at: "2026-10-15T03:00:00Z",
    });
    /** Gửi thân ĐÃ KÝ ĐÚNG — kiểm riêng lớp validate sau chữ ký. */
    const signed = (raw: string, account = webhookAccount, provider = "sim") => {
      const ts = String(Math.floor(Date.now() / 1000));
      return handleWebhook(
        provider,
        account,
        new Request(`http://local.test/api/v1/webhooks/${provider}/x`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hm-timestamp": ts,
            "x-hm-signature": signSim(WEBHOOK_SECRET, ts, raw, account),
          },
          body: raw,
        }),
        wdeps,
      );
    };
    const cases: [string, Promise<Response>][] = [
      ["nhà cung cấp lạ", signed(JSON.stringify(good()), webhookAccount, "khong-co")],
      [
        "thiếu chữ ký/timestamp",
        handleWebhook(
          "sim",
          webhookAccount,
          new Request("http://local.test/w", { method: "POST", body: "{}" }),
          wdeps,
        ),
      ],
      [
        "chữ ký rác Unicode",
        handleWebhook(
          "sim",
          webhookAccount,
          new Request("http://local.test/w", {
            method: "POST",
            headers: { "x-hm-timestamp": "kh\u00f4ng-ph\u00e3i-s\u00f3", "x-hm-signature": "ab" },
            body: JSON.stringify(good()),
          }),
          wdeps,
        ),
      ],
      ["thân không phải JSON", signed("{rác")],
      ["thân là null", signed("null")],
      ["thân là mảng", signed("[]")],
      ["thân là chuỗi", signed('"x"')],
      ["event_id sai kiểu", signed(JSON.stringify({ ...good(), event_id: 12345 }))],
      ["event_id null", signed(JSON.stringify({ ...good(), event_id: null }))],
      ["event_id quá dài", signed(JSON.stringify({ ...good(), event_id: LONG }))],
      ["bank_txn_ref rỗng", signed(JSON.stringify({ ...good(), bank_txn_ref: "   " }))],
      [
        "bank_txn_ref Unicode quá dài",
        signed(JSON.stringify({ ...good(), bank_txn_ref: WEIRD.repeat(100) })),
      ],
      ["amount âm", signed(JSON.stringify({ ...good(), amount: -1 }))],
      ["amount 0", signed(JSON.stringify({ ...good(), amount: 0 }))],
      ["amount lẻ", signed(JSON.stringify({ ...good(), amount: 1.5 }))],
      ["amount là chuỗi", signed(JSON.stringify({ ...good(), amount: "500000" }))],
      [
        "amount vượt số nguyên an toàn",
        signed('{"event_id":"e","bank_txn_ref":"r","amount":1e300,"occurred_at":"2026-10-15T03:00:00Z"}'),
      ],
      ["occurred_at sai định dạng", signed(JSON.stringify({ ...good(), occurred_at: "hôm qua" }))],
      ["occurred_at là số", signed(JSON.stringify({ ...good(), occurred_at: 1 }))],
      ["description quá dài", signed(JSON.stringify({ ...good(), description: LONG }))],
      ["balance_after là chuỗi", signed(JSON.stringify({ ...good(), balance_after: "1" }))],
      ["trường lạ", signed(JSON.stringify({ ...good(), truong_la: "x" }))],
      ["account không phải UUID", signed(JSON.stringify(good()), "không-phải-uuid")],
      ["account Unicode quá dài", signed(JSON.stringify(good()), WEIRD.repeat(50))],
      ["account UUID không tồn tại", signed(JSON.stringify(good()), uuid())],
    ];
    for (const [label, p] of cases) await expectControlled(await p, `webhook ${label}`);
    // Đối chứng: thân đúng + chữ ký đúng → 200 (test không "xanh" vì từ chối mọi thứ).
    const okRes = await signed(JSON.stringify(good()));
    expect(okRes.status).toBe(200);
  });

  it("webhooks: thân vượt trần (khai báo lẫn thực tế) → 422", async () => {
    const wdeps = { db: t.runtime, simSecret: WEBHOOK_SECRET };
    const big = JSON.stringify({
      event_id: "e",
      bank_txn_ref: "r",
      amount: 1,
      occurred_at: "2026-10-15T03:00:00Z",
      description: LONG.repeat(10),
    });
    const res = await handleWebhook(
      "sim",
      webhookAccount,
      new Request("http://local.test/w", { method: "POST", body: big }),
      wdeps,
    );
    expect(res.status).toBe(422);
  });

  it("notifications/unsubscribe: không phải JSON, token null/số/mảng/ngắn/quá dài/Unicode/giả → 4xx", async () => {
    const udeps = { db: t.runtime, secret: "s".repeat(40) };
    const post = (body: string) =>
      handleUnsubscribe(
        new Request("http://local.test/u", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        udeps,
      );
    const bodies = [
      "{rác",
      "",
      "null",
      "[]",
      '{"token":null}',
      '{"token":12345678901}',
      '{"token":["a"]}',
      '{"token":{"a":1}}',
      '{"token":""}',
      '{"token":"ngan"}',
      JSON.stringify({ token: LONG }),
      JSON.stringify({ token: WEIRD.repeat(5) }),
      JSON.stringify({ token: "gia-mao-nhung-du-dai-de-qua-do-dai-toi-thieu" }),
      JSON.stringify({ token: "a".repeat(11) + ".b".repeat(40) }),
    ];
    for (const b of bodies) {
      const res = await post(b).catch((e) => {
        throw new Error(`unsubscribe ${b.slice(0, 30)}: ném lỗi ${String(e)}`);
      });
      await expectControlled(res, `unsubscribe ${b.slice(0, 30)}`);
    }
  });

  it("portal/guest/stays/{id}: stayId không phải UUID, token/phone thiếu, sai kiểu, quá dài, Unicode → 4xx (không 5xx)", async () => {
    let n = 0;
    const call = (stayId: string, headers: Record<string, string>) =>
      handleGuestStay(new Request("http://local.test/g", { headers }), stayId, {
        db: t.runtime,
        clientIp: `203.0.113.${(++n % 250) + 1}`, // IP khác nhau: không dính giới hạn tần suất của chính test
      });
    const tok = "a".repeat(43);
    const cases: [string, string, Record<string, string>][] = [
      ["stayId rác", "không-phải-uuid", { "x-guest-token": tok }],
      ["stayId Unicode", WEIRD, { "x-guest-token": tok }],
      ["stayId quá dài", LONG, { "x-guest-token": tok }],
      ["stayId rỗng", "", { "x-guest-token": tok }],
      ["thiếu token", uuid(), {}],
      ["token rỗng", uuid(), { "x-guest-token": "" }],
      ["token ngắn", uuid(), { "x-guest-token": "abc" }],
      ["token quá dài", uuid(), { "x-guest-token": LONG }],
      ["token Unicode", uuid(), { "x-guest-token": WEIRD_HEADER }],
      ["token đúng dạng nhưng không tồn tại", uuid(), { "x-guest-token": tok }],
      ["phone quá dài", uuid(), { "x-guest-token": tok, "x-guest-verify": LONG }],
      ["phone chữ", uuid(), { "x-guest-token": tok, "x-guest-verify": "abcd" }],
    ];
    for (const [label, id, headers] of cases)
      await expectControlled(await call(id, headers), `guest-stay ${label}`);
  });

  it("session/switchOrganization: không phiên 401; key sai 400; JSON hỏng 400; sai kiểu/null/quá dài/Unicode/trường lạ → 422; tổ chức lạ 404", async () => {
    const sdeps = { db: t.runtime, secureCookies: false, getSession: deps.getSession };
    const call = (body: string, headers: Record<string, string> = {}, user = A.ownerAuthUserId) =>
      handleSwitchOrganization(
        new Request("http://local.test/s", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-user": user,
            "idempotency-key": uuid(),
            ...headers,
          },
          body,
        }),
        sdeps,
      );
    const expectStatus = async (res: Response, status: number, label: string) => {
      await expectControlled(res, label);
      expect(res.status, label).toBe(status);
    };
    await expectStatus(
      await handleSwitchOrganization(
        new Request("http://local.test/s", {
          method: "POST",
          headers: { "idempotency-key": uuid() },
          body: "{}",
        }),
        sdeps,
      ),
      401,
      "không phiên",
    );
    await expectStatus(
      await call(JSON.stringify({ organization_id: A.orgId }), { "idempotency-key": "" }),
      400,
      "thiếu key",
    );
    await expectStatus(
      await call(JSON.stringify({ organization_id: A.orgId }), { "idempotency-key": "x" }),
      400,
      "key sai",
    );
    await expectStatus(await call("{rác"), 400, "JSON hỏng");
    await expectStatus(await call(""), 400, "thân rỗng");
    const unprocessable: [string, unknown][] = [
      ["null", null],
      ["mảng", []],
      ["chuỗi", "x"],
      ["thiếu organization_id", {}],
      ["organization_id null", { organization_id: null }],
      ["organization_id số", { organization_id: 12345 }],
      ["organization_id không phải UUID", { organization_id: "abc" }],
      ["organization_id quá dài", { organization_id: LONG }],
      ["organization_id Unicode", { organization_id: WEIRD }],
      ["property_id sai kiểu", { organization_id: A.orgId, property_id: 5 }],
      ["property_id rỗng", { organization_id: A.orgId, property_id: "" }],
      ["property_id không phải UUID", { organization_id: A.orgId, property_id: "abc" }],
      ["trường lạ", { organization_id: A.orgId, role: "owner" }],
    ];
    for (const [label, body] of unprocessable)
      await expectStatus(await call(JSON.stringify(body)), 422, `switchOrganization ${label}`);
    // Người ngoài/tổ chức khác → 404 (không phân biệt); property_id: null hợp lệ.
    await expectStatus(
      await call(JSON.stringify({ organization_id: A.orgId }), {}, outsider),
      404,
      "người ngoài",
    );
    await expectStatus(await call(JSON.stringify({ organization_id: uuid() })), 404, "tổ chức lạ");
    const ok = await call(JSON.stringify({ organization_id: A.orgId, property_id: null }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^hm_org=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax$/);
  });

  describe("Better Auth (/api/auth/*)", () => {
    const BASE = "https://hm.example.vn";
    let created: ReturnType<typeof createAuth>;
    beforeAll(() => {
      created = createAuth({
        databaseUrl: t.runtimeUrl,
        secret: "s".repeat(48),
        baseURL: BASE,
        ipRateLimit: false,
      });
    });
    afterAll(async () => {
      await created?.close();
    });
    const post = (path: string, body: string) =>
      created.auth.handler(
        new Request(`${BASE}/api/auth/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body,
        }),
      );

    it("sign-in/sign-up với email/mật khẩu sai kiểu, null, quá dài, Unicode, thân hỏng → 4xx", async () => {
      // Mật khẩu giả ghép lúc chạy (không để chuỗi giống bí mật trong mã nguồn — gitleaks).
      const pw = ["mat", "khau", "du", "dai", "12345"].join("-");
      const bodies = [
        "{rác",
        "",
        "null",
        "[]",
        "{}",
        '{"email":null,"password":null}',
        '{"email":12345,"password":true}',
        '{"email":["a"],"password":{"a":1}}',
        JSON.stringify({ email: "khong-phai-email", password: pw }),
        JSON.stringify({ email: `${LONG}@example.test`, password: pw }),
        JSON.stringify({ email: "a@example.test", password: LONG }),
        JSON.stringify({ email: `${WEIRD}@example.test`, password: WEIRD }),
        JSON.stringify({ email: "a@example.test", password: "" }),
        JSON.stringify({ email: "a@example.test", password: "ngan" }),
      ];
      for (const path of ["sign-in/email", "sign-up/email"])
        for (const b of bodies) {
          const res = await post(path, b);
          await expectControlled(res, `auth ${path} ${b.slice(0, 30)}`, { problem: false });
        }
    });
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

// ---------------------------------------------------------------- lệnh cấp người dùng (USER_COMMANDS)
describe("api1-bola — lệnh cấp người dùng (org.create, member.acceptInvitation): cần phiên, không nhận ngữ cảnh tổ chức", () => {
  const userCall = async (name: string, who: { user?: string; org?: string }, body: unknown) => {
    const def = USER_COMMANDS[name];
    const req = new Request("http://local.test/api/v1/x/y", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        ...(who.user ? { "x-test-user": who.user, "x-test-2fa": "1" } : {}),
        ...(who.org ? { "x-org-id": who.org } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const res = await handleUserCommand(def as never, req, deps);
    const text = await res.text();
    return { status: res.status, code: (JSON.parse(text) as { code?: string }).code ?? "ok", text };
  };
  const sample = (name: string) =>
    sampleInput((USER_COMMANDS[name] as unknown as { input: never }).input, { ids: {} });

  it("khoá registry = tên lệnh; có ít nhất org.create và member.acceptInvitation", () => {
    for (const [k, d] of Object.entries(USER_COMMANDS)) expect(d.command).toBe(k);
    expect(Object.keys(USER_COMMANDS)).toEqual(
      expect.arrayContaining(["org.create", "member.acceptInvitation"]),
    );
  });

  it("không phiên → 401 UNAUTHENTICATED, trước cả validate (thân rác)", async () => {
    for (const name of Object.keys(USER_COMMANDS)) {
      const r = await userCall(name, { org: A.orgId }, "{rác");
      expect([r.status, r.code], name).toEqual([401, "UNAUTHENTICATED"]);
    }
  });

  it("trường lạ (organization_id, role, user_id…) → 422 unrecognized_keys; không lệnh nào chạy", async () => {
    for (const name of Object.keys(USER_COMMANDS)) {
      for (const extra of ["organization_id", "role", "user_id", "membership_id"]) {
        const r = await userCall(name, { user: outsider }, { ...sample(name), [extra]: B.orgId });
        expect([r.status, r.code], `${name}+${extra}`).toEqual([422, "VALIDATION_FAILED"]);
        expect(r.text).toContain("unrecognized_keys");
      }
    }
  });

  it("đầu vào xấu (sai kiểu, null, quá dài, NUL/Unicode lạ) ở từng trường → 4xx có kiểm soát, không 2xx, không 5xx", async () => {
    const bad: string[] = [];
    for (const name of Object.keys(USER_COMMANDS)) {
      const base = sample(name) as Record<string, unknown>;
      for (const key of Object.keys(base)) {
        for (const evil of [null, 12345, { a: 1 }, "x".repeat(20_000), "\u202e\u0000💩", [] as unknown[]]) {
          const r = await userCall(name, { user: outsider }, { ...base, [key]: evil });
          if (r.status >= 500 || (r.status >= 200 && r.status < 300))
            bad.push(`${name}.${key}=${JSON.stringify(evil)?.slice(0, 12)}: ${r.status}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("X-Org-Id của tổ chức khác không đổi kết quả: org.create vẫn tạo tổ chức MỚI cho chính người gọi, không ghi vào tổ chức B", async () => {
    const before = await rowsOf(B.orgId);
    const r = await userCall(
      "org.create",
      { user: outsider, org: B.orgId },
      { name: "Tổ chức của người ngoài" },
    );
    expect(r.status).toBe(201);
    expect(r.text).not.toContain(B.orgId);
    expect(await rowsOf(B.orgId)).toEqual(before);
  });
});
