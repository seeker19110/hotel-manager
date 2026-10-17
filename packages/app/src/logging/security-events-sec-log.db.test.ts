// T-501 (SEC-LOG-001, BASE-ERR-006, XC-UNITS-001) — sự kiện bảo mật còn thiếu, MỖI SỰ KIỆN MỘT CA, trên Postgres thật:
// cấp token (`guest_link.issued`), cấp quyền (`portal.tenant_access_granted`), đổi cấu hình (`config.changed`), upload
// (`file.uploaded`, `file.upload_rejected`), lỗi validate/deserialize (`input.*`); `backend.tls_error` ở tls-errors.test.ts.
// Mọi dòng log bắt được đều phải hợp lệ với log-record.schema.json, và mang trace_id trùng header `traceparent` của phản hồi.
import { randomUUID } from "node:crypto";
import { activateLease, seedLease, testS3Config } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Actor } from "../access/actor.ts";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { MAX_FILE_BYTES } from "../files/files.ts";
import { ObjectStorage } from "../files/storage.ts";
import { type CommandDef, type HttpDeps, handleCommand, handleQuery } from "../http/command-route.ts";
import { handleFileUpload } from "../http/file-upload.ts";
import { handleImportUpload } from "../http/import-upload.ts";
import { findCommand, findQuery } from "../http/registry.ts";
import { updateSettings } from "../notifications/preferences.ts";
import { withHttpMetrics } from "../observability/http-metrics.ts";
import { inviteTenant, revokeTenantAccess } from "../portal/access.ts";
import { createGuestLink, revokeGuestLink } from "../portal/guest.ts";
import { testServices } from "../server/services.ts";
import { confirmReservation, createReservation, holdReservation } from "../stay/reservations.ts";
import { checkIn } from "../stay/stays.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { assertLogRecords } from "../testing/log-schema.ts";
import { createLogger } from "./logger.ts";
import { setAppLogger } from "./runtime.ts";
import { securityRecordSchema } from "./security-events.ts";

let h: Hotel;
let storage: ObjectStorage;
let lines: string[] = [];
const pii = createPiiCipher(devKeyring());

const TID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";
const JPEG = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0,
  16,
  ...Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  0xff,
  0xda,
  0,
  8,
  1,
  1,
  0,
  0,
  0x3f,
  0,
  0x12,
  0x34,
  0xff,
  0xd9,
]);

/** Sự kiện bảo mật đã phát (đã kiểm schema chung + schema bảo mật). */
const events = () =>
  assertLogRecords(lines)
    .filter((r) => r.category === "security")
    .map((r) => securityRecordSchema.parse(r));

beforeAll(async () => {
  h = await seedHotel();
  storage = new ObjectStorage(testS3Config());
  await storage.ensureBucket();
});
afterAll(async () => {
  setAppLogger(undefined);
  await h?.t.drop();
});
beforeEach(() => {
  lines = [];
  setAppLogger(
    createLogger({
      sink: { write: (l) => lines.push(l) },
      service: "hm-test",
      version: "0.0.0",
      env: "test",
    }),
  );
});
afterEach(() => {
  // Mọi dòng log phát ra trong từng test phải hợp lệ schema (BASE-ERR-006).
  assertLogRecords(lines);
  setAppLogger(undefined);
});

function makeDeps(): HttpDeps {
  return {
    db: h.t.runtime,
    getSession: async (hd) => {
      const id = hd.get("x-test-user");
      return id ? { user: { id, twoFactorEnabled: true } } : null;
    },
    secureCookies: false,
    services: testServices({ storage }),
  };
}
const CLIENT = { "x-forwarded-for": "10.0.0.1, 203.0.113.77", "user-agent": "HM-Test/1.0" };
const as = (a: Actor) => ({ "x-test-user": a.authUserId, "x-org-id": a.orgId });
const post = (headers: Record<string, string>, body: unknown) =>
  new Request("http://local.test/api/v1/x/y", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID(), ...CLIENT, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let seq = 0;
async function stayId(): Promise<string> {
  seq += 1;
  const unitId = randomUUID();
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${unitId}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`SL${seq}`}, 'inspected')`.execute(
    h.t.admin,
  );
  const d = await okAs(h.t, h.manager, (ctx) =>
    createReservation(ctx, {
      unitId,
      arrivalDate: "2026-10-20",
      departureDate: "2026-10-22",
      guests: 1,
      source: "direct",
      booker: { fullName: "Khách SL", phone: "0100005678" },
    }),
  );
  await okAs(h.t, h.manager, (ctx) => holdReservation(ctx, { reservationId: d.reservationId }));
  await okAs(h.t, h.manager, (ctx) =>
    confirmReservation(ctx, {
      reservationId: d.reservationId,
      payment: {
        amount: 500_000,
        method: "bank_transfer",
        kind: "advance",
        receivingAccountId: h.receivingAccountId,
        bankTxn: { ref: `FT-${randomUUID().slice(0, 12)}`, occurredAt: "2026-10-16T03:00:00Z" },
      },
    }),
  );
  const s = await okAs(h.t, h.frontDesk, (ctx) =>
    checkIn(ctx, pii, {
      reservationId: d.reservationId,
      guests: [
        {
          fullName: "Khách SL",
          phone: "0100005678",
          docType: "cccd",
          docNumber: `0019${String(seq).padStart(8, "0")}`,
        },
      ],
      now: new Date("2026-10-20T08:00:00Z"),
    }),
  );
  return s.stayId;
}

describe("cấp/thu hồi token", () => {
  it("guest_link.issued: cấp liên kết khách → một sự kiện (id liên kết), token KHÔNG vào log; thu hồi → guest_link.revoked", async () => {
    const sid = await stayId();
    const link = await okAs(h.t, h.manager, (ctx) =>
      createGuestLink(ctx, { stayId: sid, now: new Date("2026-10-21T03:00:00Z") }),
    );
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "guest_link.issued",
      outcome: "success",
      actor: { role: "manager", membership_id: h.manager.membershipId },
      target: { type: "guest_access_link", id: link.linkId },
    });
    expect(lines.join("\n")).not.toContain(link.token);
    lines = [];
    await okAs(h.t, h.manager, (ctx) => revokeGuestLink(ctx, { linkId: link.linkId }));
    expect(events()).toMatchObject([{ event: "guest_link.revoked", target: { id: link.linkId } }]);
  });

  it("guest_link.issued: không đủ quyền (kế toán) → authz.denied, KHÔNG có guest_link.issued", async () => {
    const sid = await stayId();
    lines = [];
    expect(await codeOf(runAs(h.t, h.accountant, (ctx) => createGuestLink(ctx, { stayId: sid })))).toBe(
      "FORBIDDEN",
    );
    expect(events().map((e) => e.event)).toEqual(["authz.denied"]);
  });
});

describe("đổi vai/quyền truy cập", () => {
  it("portal.tenant_access_granted: mời người thuê → một sự kiện (id membership, không email); mời lại cùng người không phát lại; thu hồi → portal.tenant_access_revoked", async () => {
    const personId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${h.org.orgId}, 'Người thuê SL')`.execute(
      h.t.admin,
    );
    const lease = await seedLease(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      representativePersonId: personId,
      effectiveFrom: "2026-09-01",
    });
    await activateLease(h.t.admin, { org: h.org, leaseId: lease.leaseId, effectiveFrom: "2026-09-01" });
    lines = [];
    const email = "nguoi.thue.sl@example.test";
    const r = await okAs(h.t, h.owner, (ctx) => inviteTenant(ctx, { personId, email }));
    expect(r.created).toBe(true);
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "portal.tenant_access_granted",
      outcome: "success",
      actor: { role: "owner" },
      target: { type: "membership", id: r.membershipId },
    });
    expect(lines.join("\n")).not.toContain(email);

    lines = [];
    expect((await okAs(h.t, h.owner, (ctx) => inviteTenant(ctx, { personId, email }))).created).toBe(false);
    expect(events()).toHaveLength(0);

    await okAs(h.t, h.owner, (ctx) => revokeTenantAccess(ctx, { membershipId: r.membershipId }));
    expect(events().map((x) => x.event)).toEqual(["portal.tenant_access_revoked"]);
  });

  it("portal.tenant_access_granted: người mời không đủ quyền (kế toán) → authz.denied, không cấp", async () => {
    const personId = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${personId}, ${h.org.orgId}, 'Người thuê SL2')`.execute(
      h.t.admin,
    );
    const lease = await seedLease(h.t.admin, {
      orgId: h.org.orgId,
      propertyId: h.org.propertyId,
      representativePersonId: personId,
      effectiveFrom: "2026-09-01",
    });
    await activateLease(h.t.admin, { org: h.org, leaseId: lease.leaseId, effectiveFrom: "2026-09-01" });
    lines = [];
    expect(
      await codeOf(
        runAs(h.t, h.accountant, (ctx) => inviteTenant(ctx, { personId, email: "x.sl@example.test" })),
      ),
    ).toBe("FORBIDDEN");
    expect(events().map((e) => e.event)).toEqual(["authz.denied"]);
  });
});

describe("đổi cấu hình", () => {
  it("config.changed: updateSettings thành công → một sự kiện; quyền không đủ → authz.denied; giá trị sai → input.validation_failed, không config.changed", async () => {
    await okAs(h.t, h.owner, (ctx) =>
      updateSettings(ctx, { propertyId: h.org.propertyId, overdueReminderOffsetsDays: [1, 3] }),
    );
    expect(events()).toMatchObject([
      {
        event: "config.changed",
        outcome: "success",
        actor: { role: "owner" },
        target: { type: "notification_settings", id: h.org.propertyId },
        reason: "notification.settings_updated",
      },
    ]);
    lines = [];
    expect(
      await codeOf(
        runAs(h.t, h.housekeeping, (ctx) =>
          updateSettings(ctx, { propertyId: h.org.propertyId, overdueReminderOffsetsDays: [2] }),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(events().map((e) => e.event)).toEqual(["authz.denied"]);
    lines = [];
    expect(
      await codeOf(
        runAs(h.t, h.owner, (ctx) =>
          updateSettings(ctx, { propertyId: h.org.propertyId, overdueReminderOffsetsDays: [-5] }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(events().map((e) => e.event)).toEqual(["input.validation_failed"]);
  });

  it("config.changed qua HTTP: lệnh thật notifications.updateSettings; replay cùng Idempotency-Key không phát lại", async () => {
    const def = findCommand("notifications", "updateSettings") as NonNullable<ReturnType<typeof findCommand>>;
    const key = randomUUID();
    const body = { property_id: h.org.propertyId, lease_expiry_offsets_days: [30, 7, 1] };
    const mk = () => post({ ...as(h.owner), "idempotency-key": key }, body);
    expect((await handleCommand(def, mk(), makeDeps())).status).toBe(200);
    expect((await handleCommand(def, mk(), makeDeps())).status).toBe(200);
    expect(events().map((e) => e.event)).toEqual(["config.changed"]);
  });
});

describe("upload", () => {
  const q = () => `owner_type=work_order&property_id=${h.org.propertyId}`;
  const up = (body: Uint8Array | null, headers: Record<string, string> = {}, query = q()) =>
    new Request(`http://local.test/api/v1/files/upload?${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "idempotency-key": randomUUID(),
        ...CLIENT,
        ...as(h.manager),
        ...headers,
      },
      ...(body ? { body: Buffer.from(body) } : {}),
    });

  it("file.uploaded: tải ảnh hợp lệ → một sự kiện (id file, IP cắt /24, UA); phản hồi có traceparent trùng trace_id của log", async () => {
    // Như route thật: handler bọc bởi `withHttpMetrics` (đo + ngữ cảnh trace + header traceparent).
    const route = withHttpMetrics("/api/v1/files/upload", (r: Request) => handleFileUpload(r, makeDeps()));
    const res = await route(up(JPEG, { traceparent: `00-${TID}-${PARENT}-01` }));
    expect(res.status).toBe(201);
    const fileId = ((await res.json()) as { data: { fileId: string } }).data.fileId;
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "file.uploaded",
      outcome: "success",
      actor: { role: "manager" },
      target: { type: "file", id: fileId },
      source_ip: "203.0.113.0",
      user_agent: "HM-Test/1.0",
    });
    const rec = assertLogRecords(lines).find((r) => r.event === "file.uploaded");
    expect(rec?.trace_id).toBe(TID);
    expect(res.headers.get("traceparent")).toBe(`00-${TID}-${rec?.span_id}-01`);
  });

  it("file.upload_rejected: EICAR bị quét từ chối (SCAN_REJECTED, denied), không phát file.uploaded", async () => {
    const eicar = Uint8Array.from([
      ...JPEG,
      ...Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "latin1"),
    ]);
    const res = await handleFileUpload(up(eicar), makeDeps());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe("rejected");
    expect(events()).toMatchObject([
      { event: "file.upload_rejected", outcome: "denied", reason: "SCAN_REJECTED", target: { type: "file" } },
    ]);
  });

  it("file.upload_rejected: loại không cho phép (415) và quá lớn (413) → mỗi lần một sự kiện với mã lý do", async () => {
    const txt = await handleFileUpload(up(new TextEncoder().encode("khong phai anh")), makeDeps());
    expect(txt.status).toBe(415);
    const big = await handleFileUpload(up(new Uint8Array(MAX_FILE_BYTES + 1)), makeDeps());
    expect(big.status).toBe(413);
    expect(events().map((e) => `${e.event}:${e.reason}`)).toEqual([
      "file.upload_rejected:FILE_TYPE_NOT_ALLOWED",
      "file.upload_rejected:FILE_TOO_LARGE",
    ]);
  });

  it("upload thiếu/sai tham số → input.validation_failed (endpoint, không giá trị người dùng)", async () => {
    const res = await handleFileUpload(
      up(JPEG, {}, "owner_type=hacker&property_id=khong-phai-uuid"),
      makeDeps(),
    );
    expect(res.status).toBe(422);
    expect(events()).toMatchObject([
      { event: "input.validation_failed", target: { type: "endpoint", id: "/api/v1/files/upload" } },
    ]);
    expect(lines.join("\n")).not.toContain("hacker");
  });

  it("file.uploaded: lô nhập CSV (import.upload) → một sự kiện target import_batch, không tên file", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File(["external_id,unit_code,floor,capacity\r\nU-sl,SL-9,T1,2\r\n"], "ten-nguoi-nhay-cam.csv", {
        type: "text/csv",
      }),
    );
    form.set("property_id", h.org.propertyId);
    form.set("kind", "units");
    const res = await handleImportUpload(
      new Request("http://local.test/api/v1/import/upload", {
        method: "POST",
        headers: { "idempotency-key": randomUUID(), ...CLIENT, ...as(h.owner) },
        body: form,
      }),
      makeDeps(),
    );
    expect(res.status).toBe(201);
    const batchId = ((await res.json()) as { data: { batchId: string } }).data.batchId;
    expect(events()).toMatchObject([
      { event: "file.uploaded", target: { type: "import_batch", id: batchId } },
    ]);
    expect(lines.join("\n")).not.toContain("ten-nguoi-nhay-cam");
  });

  it("import.upload: thân không phải multipart → input.deserialize_failed; thiếu trường → input.validation_failed", async () => {
    const notMultipart = await handleImportUpload(
      new Request("http://local.test/api/v1/import/upload", {
        method: "POST",
        headers: { "idempotency-key": randomUUID(), "content-type": "application/json", ...as(h.owner) },
        body: "{}",
      }),
      makeDeps(),
    );
    expect(notMultipart.status).toBe(400);
    const form = new FormData();
    form.set("property_id", h.org.propertyId);
    form.set("kind", "units");
    const noFile = await handleImportUpload(
      new Request("http://local.test/api/v1/import/upload", {
        method: "POST",
        headers: { "idempotency-key": randomUUID(), ...as(h.owner) },
        body: form,
      }),
      makeDeps(),
    );
    expect(noFile.status).toBe(422);
    expect(events().map((e) => e.event)).toEqual(["input.deserialize_failed", "input.validation_failed"]);
  });
});

describe("lỗi validate / deserialize đầu vào", () => {
  const STRICT: CommandDef<{ a: string }, { ok: true }> = {
    command: "test.strict",
    input: z.strictObject({ a: z.string().max(5) }),
    run: async () => ({ data: { ok: true } }),
  };

  it("input.validation_failed: body sai schema → 422 + một sự kiện (actor, lệnh, mã lý do); giá trị người dùng gửi KHÔNG vào log", async () => {
    const res = await handleCommand(
      STRICT,
      post(as(h.owner), { a: "giá-trị-bí-mật-dài", mat_khau: "hunter2" }),
      makeDeps(),
    );
    expect(res.status).toBe(422);
    const [e, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({
      event: "input.validation_failed",
      outcome: "denied",
      actor: { role: "owner" },
      target: { type: "command", id: "test.strict" },
      reason: "VALIDATION_FAILED",
      correlation_id: res.headers.get("x-correlation-id"),
    });
    expect(lines.join("\n")).not.toMatch(/hunter2|giá-trị-bí-mật/);
  });

  it("input.deserialize_failed: body không phải JSON → 400 + một sự kiện; body rỗng cũng vậy", async () => {
    for (const body of ["{không phải json", ""]) {
      lines = [];
      const res = await handleCommand(STRICT, post(as(h.owner), body), makeDeps());
      expect(res.status).toBe(400);
      expect(events()).toMatchObject([
        {
          event: "input.deserialize_failed",
          target: { type: "command", id: "test.strict" },
          reason: "MALFORMED_REQUEST",
        },
      ]);
    }
  });

  it("input.validation_failed: truy vấn tham số sai → 422 + sự kiện target query", async () => {
    const def = findQuery("audit", "listEvents") as NonNullable<ReturnType<typeof findQuery>>;
    const res = await handleQuery(
      def,
      new Request("http://local.test/api/v1/audit/listEvents?limit=abc", {
        headers: { ...as(h.owner), ...CLIENT },
      }),
      makeDeps(),
    );
    expect(res.status).toBe(422);
    expect(events()).toMatchObject([
      { event: "input.validation_failed", target: { type: "query", id: "audit.listEvents" } },
    ]);
  });

  it("không phiên: 401 trước khi đọc body ⇒ chỉ auth.unauthenticated (không rò thông tin validate cho người lạ)", async () => {
    const res = await handleCommand(STRICT, post({}, { sai: 1 }), makeDeps());
    expect(res.status).toBe(401);
    expect(events().map((e) => e.event)).toEqual(["auth.unauthenticated"]);
  });
});

describe("XC-UNITS-001 — API từ chối thời điểm không offset (HTTP, trên registry thật)", () => {
  it("lệnh maintenance.proposeBlock: start/end không offset → 422 VALIDATION_FAILED (trường nêu đúng) + input.validation_failed; có Z → qua bước validate", async () => {
    const def = findCommand("maintenance", "proposeBlock") as NonNullable<ReturnType<typeof findCommand>>;
    const base = { work_order_id: randomUUID(), end: "2026-10-20T10:00:00Z", reason: "Sửa điều hoà" };
    const naive = await handleCommand(
      def,
      post(as(h.owner), { ...base, start: "2026-10-19T10:00:00" }),
      makeDeps(),
    );
    expect(naive.status).toBe(422);
    const body = (await naive.json()) as { code: string; errors: unknown[] };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.errors).toEqual([{ path: "start", field: "start", code: "invalid_format" }]);
    expect(events().map((e) => e.event)).toEqual(["input.validation_failed"]);
    lines = [];
    const ok = await handleCommand(
      def,
      post(as(h.owner), { ...base, start: "2026-10-19T10:00:00+07:00" }),
      makeDeps(),
    );
    // Qua validate; work_order_id ngẫu nhiên nên nghiệp vụ trả 404 — quan trọng là KHÔNG 422 vì thời điểm.
    expect(ok.status).not.toBe(422);
  });

  it("truy vấn audit.listEvents?from=… không offset → 422; có offset → 200", async () => {
    const def = findQuery("audit", "listEvents") as NonNullable<ReturnType<typeof findQuery>>;
    const get = (qs: string) =>
      handleQuery(
        def,
        new Request(`http://local.test/api/v1/audit/listEvents?${qs}`, {
          headers: { ...as(h.owner), ...CLIENT },
        }),
        makeDeps(),
      );
    for (const bad of ["2026-10-17T00:00:00", "2026-10-17", "2026-10-17 00:00:00Z", "1760000000"]) {
      const r = await get(`from=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(422);
    }
    expect((await get(`from=${encodeURIComponent("2026-10-17T00:00:00+07:00")}`)).status).toBe(200);
    expect((await get("from=2026-10-17T00:00:00Z")).status).toBe(200);
  });
});

describe("trace trong đường ghi: outbox.traceparent", () => {
  it("lệnh qua handleCommand ghi outbox kèm traceparent = span của request (trace_id từ header client), job kế nhận đúng trace", async () => {
    const EMIT: CommandDef<Record<string, never>, { ok: true }> = {
      command: "test.emit",
      input: z.strictObject({}),
      run: async (ctx) => {
        await ctx.emit({ eventType: "test.traced", payload: { n: 1 } });
        return { data: { ok: true } };
      },
    };
    const key = randomUUID();
    const res = await handleCommand(
      EMIT,
      post({ ...as(h.owner), "idempotency-key": key, traceparent: `00-${TID}-${PARENT}-01` }, {}),
      makeDeps(),
    );
    expect(res.status).toBe(200);
    const out = await sql<{ traceparent: string | null }>`
      select traceparent from outbox where organization_id = ${h.org.orgId} and command_id = ${key}`.execute(
      h.t.admin,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.traceparent).toBe(res.headers.get("traceparent"));
    expect(out.rows[0]?.traceparent).toMatch(new RegExp(`^00-${TID}-[0-9a-f]{16}-01$`));
  });

  it("ngoài request (executeCommand gọi trực tiếp, không ngữ cảnh trace) → traceparent NULL", async () => {
    const key = randomUUID();
    const r = await runAs(h.t, h.owner, async (ctx) => {
      await ctx.emit({ eventType: "test.untraced", payload: {}, dedupeKey: key });
      return undefined;
    });
    expect(r.status).toBe("committed");
    const out = await sql<{ traceparent: string | null }>`
      select traceparent from outbox where organization_id = ${h.org.orgId} and dedupe_key = ${key}`.execute(
      h.t.admin,
    );
    expect(out.rows).toEqual([{ traceparent: null }]);
  });
});
