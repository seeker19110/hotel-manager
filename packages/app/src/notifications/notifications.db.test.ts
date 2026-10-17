// PLAN đợt 3 T-213 — thông báo + gửi email trên Postgres thật (SPEC-notifications S-001…S-006, S-008, S-009, S-012).
// Đường đi thật: command ghi outbox cùng transaction → (relay) → `dispatchNotification` (worker, đúng tổ chức của hàng
// outbox) → `sendDueEmails` với `FakeEmailSender`.
import { randomUUID } from "node:crypto";
import { createTestDb, type SeededOrg, seedLease, seedOrg, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../access/actor.ts";
import { CommandError } from "../pipeline/problem.ts";
import { ownerOf, runAs, seedMember } from "../testing/helpers.ts";
import { createNotification, type DispatchJob, dispatchNotification } from "./dispatch.ts";
import type { EmailMessage } from "./email.ts";
import { EmailSendError, FakeEmailSender } from "./email.ts";
import { MAX_ATTEMPTS, RETRY_BACKOFF_MINUTES, RETRY_JITTER_RATIO, sendDueEmails } from "./send.ts";

let t: TestDb;
let A: SeededOrg;
let B: SeededOrg;
let owner: Actor;
let tenant: Actor;
let tenantEmail: string;
let leaseId: string;
const NOW = new Date("2026-10-16T02:00:00Z");

beforeAll(async () => {
  t = await createTestDb();
  A = await seedOrg(t.admin, "Nhà trọ Hoa Sen");
  B = await seedOrg(t.admin, "Nhà trọ khác");
  owner = await ownerOf(t, A);
  tenant = await seedMember(t, A, "tenant", { name: "Người thuê An" });
  tenantEmail = `an.${randomUUID().slice(0, 6)}@example.test`;
  await sql`update persons set email = ${tenantEmail} where id = ${tenant.personId}`.execute(t.admin);
  leaseId = (
    await seedLease(t.admin, {
      orgId: A.orgId,
      propertyId: A.propertyId,
      representativePersonId: tenant.personId,
    })
  ).leaseId;
});

afterAll(async () => {
  await t?.drop();
});

async function invoice(opts: { payer?: string; total?: number; allocated?: number } = {}): Promise<string> {
  const id = randomUUID();
  const total = opts.total ?? 1_580_000;
  await t.admin.transaction().execute(async (trx) => {
    await sql`insert into invoices (id, organization_id, property_id, kind, lease_id, number, memo_ref, payer_person_id,
                                    business_date, due_on, total)
              values (${id}, ${A.orgId}, ${A.propertyId}, 'fee', ${leaseId}, ${`N-${id.slice(0, 8)}`},
                      ${`HM${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`}, ${opts.payer ?? tenant.personId},
                      '2026-10-01', '2026-10-10', ${total})`.execute(trx);
    await sql`insert into invoice_lines (id, organization_id, property_id, invoice_id, line_no, kind, description, revenue_account,
                                         quantity, unit_price, amount, rounding_rule, formula_version)
              values (${randomUUID()}, ${A.orgId}, ${A.propertyId}, ${id}, 1, 'fee', 'Phí (giả)', 'REV_FEE', 1, ${total},
                      ${total}, 'HALF_UP_1', 1)`.execute(trx);
  });
  if (opts.allocated !== undefined)
    await sql`update invoices set allocated_total = ${opts.allocated} where id = ${id}`.execute(t.admin);
  return id;
}

/** Phát `invoice.issued` qua pipeline lệnh thật (outbox cùng transaction); `fail` = lỗi sau khi ghi outbox. */
async function issue(invoiceId: string, fail = false) {
  return runAs(t, owner, async (ctx) => {
    await ctx.emit({
      eventType: "invoice.issued",
      aggregateType: "invoice",
      aggregateId: invoiceId,
      propertyId: A.propertyId,
      payload: { invoice_id: invoiceId },
    });
    if (fail) throw new CommandError("VALIDATION_FAILED", 422, "lỗi sau khi ghi outbox");
    return {};
  });
}

/** Hàng outbox → job như relay đưa cho consumer. */
async function jobsFor(invoiceId: string): Promise<DispatchJob[]> {
  const r = await sql<DispatchJob & { id: string }>`
    select id as outbox_id, organization_id, event_type, aggregate_id, payload from outbox
    where aggregate_id = ${invoiceId} and event_type = 'invoice.issued'`.execute(t.admin);
  return r.rows;
}

const delivery = async (invoiceId: string) =>
  (
    await sql<{
      id: string;
      status: string;
      attempts: number;
      next_attempt_at: Date | null;
      last_error_code: string | null;
      suppressed_reason: string | null;
      provider_message_id: string | null;
    }>`
      select d.id, d.status, d.attempts, d.next_attempt_at, d.last_error_code, d.suppressed_reason, d.provider_message_id
      from notification_deliveries d join notifications n on n.id = d.notification_id
      where n.dedupe_key in (${`invoice_issued:${invoiceId}`}, ${`invoice_overdue:${invoiceId}:2026-10-11`})`.execute(
      t.admin,
    )
  ).rows;

describe("S-001 phát hành phiếu → thông báo trong app + email", () => {
  it("outbox → dispatch → 1 notification + delivery queued → sending → sent; Fake nhận đúng 1 email, không số tiền", async () => {
    const inv = await invoice();
    expect((await issue(inv)).status).toBe("committed");
    const [job] = await jobsFor(inv);
    if (!job) throw new Error("không có outbox");
    expect(await dispatchNotification(t.worker, job, NOW)).toBe(1);
    const n = await sql<{ type: string; recipient_person_id: string; body: string; link: string }>`
      select type, recipient_person_id, body, link from notifications where dedupe_key = ${`invoice_issued:${inv}`}`.execute(
      t.admin,
    );
    expect(n.rows[0]).toMatchObject({ type: "invoice_issued", recipient_person_id: tenant.personId });
    expect(n.rows[0]?.body).toContain("1.580.000 đ");
    expect((await delivery(inv))[0]?.status).toBe("queued");
    const fake = new FakeEmailSender();
    const s = await sendDueEmails(t.worker, fake, { now: NOW, baseUrl: "https://app.example" });
    expect(s.sent).toBe(1);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.to).toBe(tenantEmail);
    expect(fake.sent[0]?.text).not.toContain("1.580.000");
    expect(fake.sent[0]?.text).toContain(`https://app.example/portal/phieu-thu/${inv}`);
    const d = (await delivery(inv))[0];
    expect(d).toMatchObject({ status: "sent", attempts: 1, provider_message_id: "fake-1" });
    expect(fake.sent[0]?.idempotencyKey).toBe(d?.id);
  });
});

describe("S-002 outbox chỉ phát sau commit", () => {
  it("lệnh rollback sau khi ghi outbox → không hàng outbox, không thông báo", async () => {
    const inv = await invoice();
    expect((await issue(inv, true)).status).toBe("failed");
    expect(await jobsFor(inv)).toHaveLength(0);
    const n = await sql<{ n: number }>`
      select count(*)::int as n from notifications where dedupe_key = ${`invoice_issued:${inv}`}`.execute(
      t.admin,
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});

describe("S-003 dedupe khi xử lý hai lần", () => {
  it("dispatch 2 lần → 1 thông báo, 1 delivery; worker lỗi sau khi nhà cung cấp nhận → gửi lại cùng khoá, Fake nhận 1", async () => {
    const inv = await invoice();
    await issue(inv);
    const [job] = await jobsFor(inv);
    if (!job) throw new Error("không có outbox");
    expect(await dispatchNotification(t.worker, job, NOW)).toBe(1);
    expect(await dispatchNotification(t.worker, job, NOW)).toBe(0);
    expect(await delivery(inv)).toHaveLength(1);
    // (a) Nhà cung cấp đã nhận nhưng worker không ghi được `sent` (timeout/chết) → lần sau gửi lại cùng khoá.
    const fake = new FakeEmailSender();
    let crash = true;
    const flaky = {
      send: async (m: Parameters<FakeEmailSender["send"]>[0]) => {
        const r = await fake.send(m);
        if (crash) {
          crash = false;
          throw new Error("worker mất kết nối sau khi gửi");
        }
        return r;
      },
    };
    await sendDueEmails(t.worker, flaky, { now: NOW, random: () => 0 });
    expect((await delivery(inv))[0]?.status).toBe("retrying");
    await sendDueEmails(t.worker, flaky, { now: new Date(NOW.getTime() + 60_000) });
    const id = (await delivery(inv))[0]?.id as string;
    expect(fake.attempts.filter((m) => m.idempotencyKey === id)).toHaveLength(2);
    expect(fake.sent.filter((m) => m.idempotencyKey === id)).toHaveLength(1);
    expect((await delivery(inv))[0]?.status).toBe("sent");
  });
});

describe("sending quá hạn khoá → retrying", () => {
  it("lô bị nhận rồi bỏ dở (worker chết) → quá locked_until thì nhận lại và gửi", async () => {
    const inv = await invoice();
    await issue(inv);
    await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    await sql`select * from app.claim_due_deliveries(${NOW}, 50, 10, 30, ${MAX_ATTEMPTS})`.execute(t.worker);
    expect((await delivery(inv))[0]).toMatchObject({ status: "sending", attempts: 1 });
    const fake = new FakeEmailSender();
    expect((await sendDueEmails(t.worker, fake, { now: new Date(NOW.getTime() + 10_000) })).claimed).toBe(0);
    // Quá hạn khoá → `retrying` chờ lùi 1 phút (worker cũ có thể vẫn đang gửi), không nhận lại ngay trong lượt đó.
    expect((await sendDueEmails(t.worker, fake, { now: new Date(NOW.getTime() + 31_000) })).claimed).toBe(0);
    const d = (await delivery(inv))[0];
    expect(d).toMatchObject({ status: "retrying", attempts: 1, last_error_code: "PROVIDER_TEMPORARY" });
    expect(d?.next_attempt_at?.getTime()).toBe(NOW.getTime() + 31_000 + 60_000);
    const s = await sendDueEmails(t.worker, fake, { now: new Date(NOW.getTime() + 91_000) });
    expect(s.sent).toBe(1);
    expect((await delivery(inv))[0]).toMatchObject({ status: "sent", attempts: 2 });
  });
});

describe("S-004 retry có backoff rồi dead", () => {
  it("lỗi tạm mọi lần → retrying attempts 1…5 chờ 1/5/30/120/360 phút → lần 6 dead; thông báo trong app còn; log che email", async () => {
    const inv = await invoice();
    await issue(inv);
    const [job] = await jobsFor(inv);
    await dispatchNotification(t.worker, job as DispatchJob, NOW);
    const fake = new FakeEmailSender();
    fake.failWith = () => new EmailSendError("temporary", "421 thử lại sau");
    const logs: string[] = [];
    let at = NOW;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const s = await sendDueEmails(t.worker, fake, {
        now: at,
        // Jitter xác định: lần i dùng nguồn ngẫu nhiên cố định → thêm đúng i·4 % (≤ RETRY_JITTER_RATIO).
        random: () => (i * 0.2) % 1,
        log: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`),
      });
      const d = (await delivery(inv))[0];
      expect(d?.attempts).toBe(i);
      if (i < MAX_ATTEMPTS) {
        expect(d?.status).toBe("retrying");
        const wait = (RETRY_BACKOFF_MINUTES[i - 1] as number) * 60_000;
        const next = d?.next_attempt_at as Date;
        const jittered = wait * (1 + RETRY_JITTER_RATIO * ((i * 0.2) % 1));
        expect(Math.abs(next.getTime() - at.getTime() - jittered)).toBeLessThanOrEqual(1);
        // Chưa tới hạn (mốc Q-05 không bị đẩy sớm) → không nhận lại.
        expect(
          (await sendDueEmails(t.worker, fake, { now: new Date(at.getTime() + wait - 1000) })).claimed,
        ).toBe(0);
        at = d?.next_attempt_at as Date;
      } else {
        expect(s.dead).toBe(1);
        expect(d).toMatchObject({ status: "dead", last_error_code: "PROVIDER_TEMPORARY" });
      }
    }
    expect(fake.sent).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(tenantEmail);
    expect(logs.at(-1)).toContain("notification_dead_total");
    const n = await sql<{ n: number }>`
      select count(*)::int as n from notifications where dedupe_key = ${`invoice_issued:${inv}`}`.execute(
      t.admin,
    );
    expect(n.rows[0]?.n).toBe(1);
  });
});

describe("S-005 lỗi vĩnh viễn không retry", () => {
  it("địa chỉ không hợp lệ → failed ngay, attempts=1, RECIPIENT_INVALID; lượt sau không nhận lại", async () => {
    const inv = await invoice();
    await issue(inv);
    await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    const fake = new FakeEmailSender();
    fake.failWith = () => new EmailSendError("permanent", "550 5.1.1 no such user");
    await sendDueEmails(t.worker, fake, { now: NOW });
    expect((await delivery(inv))[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error_code: "RECIPIENT_INVALID",
    });
    expect((await sendDueEmails(t.worker, fake, { now: new Date(NOW.getTime() + 86_400_000) })).claimed).toBe(
      0,
    );
  });
});

describe("Kiểm lại trước khi gửi", () => {
  it("không có email → suppressed NO_ADDRESS; vẫn có thông báo trong app", async () => {
    const p = randomUUID();
    await sql`insert into persons (id, organization_id, full_name) values (${p}, ${A.orgId}, 'Không email')`.execute(
      t.admin,
    );
    const inv = await invoice({ payer: p });
    await issue(inv);
    await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    await sendDueEmails(t.worker, new FakeEmailSender(), { now: NOW });
    expect((await delivery(inv))[0]).toMatchObject({ status: "suppressed", suppressed_reason: "NO_ADDRESS" });
  });

  it("S-009 tắt email loại invoice_overdue → suppressed OPTED_OUT; invoice_issued vẫn gửi", async () => {
    await sql`insert into notification_preferences (id, organization_id, person_id, type, channel, state, source)
              values (${randomUUID()}, ${A.orgId}, ${tenant.personId}, 'invoice_overdue', 'email', 'opted_out', 'user')`.execute(
      t.admin,
    );
    const inv = await invoice();
    await withWorker(inv, "invoice_overdue");
    await issue(inv);
    await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    const fake = new FakeEmailSender();
    await sendDueEmails(t.worker, fake, { now: NOW });
    const ds = await sql<{ type: string; status: string; reason: string | null }>`
      select n.type, d.status, d.suppressed_reason as reason from notification_deliveries d
      join notifications n on n.id = d.notification_id where n.vars->>'invoiceId' = ${inv} order by n.type`.execute(
      t.admin,
    );
    expect(ds.rows).toEqual([
      { type: "invoice_issued", status: "sent", reason: null },
      { type: "invoice_overdue", status: "suppressed", reason: "OPTED_OUT" },
    ]);
    await sql`delete from notification_preferences where person_id = ${tenant.personId}`.execute(t.admin);
  });

  it("S-008 nhắc quá hạn mà phiếu đã tất toán sau khi xếp hàng → suppressed SETTLED, không email", async () => {
    const inv = await invoice();
    await withWorker(inv, "invoice_overdue");
    await sql`update invoices set allocated_total = total where id = ${inv}`.execute(t.admin);
    const fake = new FakeEmailSender();
    await sendDueEmails(t.worker, fake, { now: NOW });
    expect((await delivery(inv))[0]).toMatchObject({ status: "suppressed", suppressed_reason: "SETTLED" });
    expect(fake.sent).toHaveLength(0);
  });

  it("mẫu hỏng (thiếu biến) → failed TEMPLATE_ERROR, không gửi email rỗng", async () => {
    const inv = await invoice();
    await withWorker(inv, "invoice_overdue");
    // Mẫu đổi giữa lúc tạo và lúc gửi (bản triển khai mới): tắt trigger bất biến trong transaction admin để mô phỏng.
    await t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update notifications set vars = vars - 'dueOn' where vars->>'invoiceId' = ${inv}`.execute(
        trx,
      );
    });
    const fake = new FakeEmailSender();
    await sendDueEmails(t.worker, fake, { now: NOW });
    expect((await delivery(inv))[0]).toMatchObject({ status: "failed", last_error_code: "TEMPLATE_ERROR" });
    expect(fake.attempts).toHaveLength(0);
  });
});

/** Nhắc quá hạn tạo trực tiếp (job quét là T-215) — dùng chung `createNotification` của worker. */
async function withWorker(inv: string, type: "invoice_overdue") {
  const { withTenant } = await import("@hm/db");
  await withTenant(t.worker, { orgId: A.orgId }, (trx) =>
    createNotification(
      trx,
      A.orgId,
      {
        propertyId: A.propertyId,
        recipientPersonId: tenant.personId,
        type,
        vars: {
          propertyName: "Nhà trọ Hoa Sen",
          period: "10/2026",
          dueOn: "2026-10-10",
          amount: 1_580_000,
          invoiceId: inv,
        },
        dedupeKey: `invoice_overdue:${inv}:2026-10-11`,
      },
      { now: NOW },
    ),
  );
}

describe("Rate limit + cách ly tổ chức", () => {
  it("mỗi tổ chức tối đa perOrg lần gửi mỗi lượt", async () => {
    for (let i = 0; i < 3; i++) {
      const inv = await invoice();
      await issue(inv);
      await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    }
    const s = await sendDueEmails(t.worker, new FakeEmailSender(), { now: NOW, perOrg: 2 });
    expect(s.claimed).toBe(2);
    await sendDueEmails(t.worker, new FakeEmailSender(), { now: NOW });
  });

  it("job mang organization_id của B mà invoice của A → không thông báo (đọc theo tổ chức của hàng outbox)", async () => {
    const inv = await invoice();
    const job: DispatchJob = {
      organization_id: B.orgId,
      outbox_id: randomUUID(),
      event_type: "invoice.issued",
      aggregate_id: inv,
      payload: { invoice_id: inv },
    };
    expect(await dispatchNotification(t.worker, job, NOW)).toBe(0);
  });

  it("RLS: người nhận chỉ thấy thông báo của mình; chỉ đổi được read_at; người khác 0 hàng; buồng phòng không thấy lịch sử gửi", async () => {
    const other = await seedMember(t, A, "tenant", { name: "Bình" });
    const hk = await seedMember(t, A, "housekeeping");
    const { withTenant } = await import("@hm/db");
    const mine = await withTenant(t.runtime, { orgId: A.orgId, actorId: tenant.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from notifications`.execute(trx),
    );
    expect(mine.rows[0]?.n).toBeGreaterThan(0);
    const theirs = await withTenant(t.runtime, { orgId: A.orgId, actorId: other.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from notifications`.execute(trx),
    );
    expect(theirs.rows[0]?.n).toBe(0);
    await expect(
      withTenant(t.runtime, { orgId: A.orgId, actorId: tenant.membershipId }, (trx) =>
        sql`update notifications set title = 'x'`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
    const hkSees = await withTenant(t.runtime, { orgId: A.orgId, actorId: hk.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from notification_deliveries`.execute(trx),
    );
    expect(hkSees.rows[0]?.n).toBe(0);
    const ownerSees = await withTenant(t.runtime, { orgId: A.orgId, actorId: owner.membershipId }, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from notification_deliveries`.execute(trx),
    );
    expect(ownerSees.rows[0]?.n).toBeGreaterThan(0);
  });
});

/** Cổng chặn `send()` cho đúng một lần gửi — mô phỏng worker đang chờ nhà cung cấp. */
function gated(onlyKey: () => string | undefined, outcome: "ok" | "temporary", fake = new FakeEmailSender()) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const inside = new Promise<void>((r) => {
    entered = r;
  });
  return {
    fake,
    release,
    inside,
    sender: {
      send: async (m: EmailMessage) => {
        if (m.idempotencyKey === onlyKey()) {
          entered();
          await gate;
          if (outcome === "temporary") throw new EmailSendError("temporary", "timeout");
        }
        return fake.send(m);
      },
    },
  };
}

describe("Review PR #10 — rào khoá khi worker chậm bị nhận lại", () => {
  it("worker A quá locked_until, worker B nhận lại (attempts 2) và gửi; A lỗi muộn không ghi đè → sent bởi B", async () => {
    const inv = await invoice();
    await issue(inv);
    await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    const id = (await delivery(inv))[0]?.id as string;
    const a = gated(() => id, "temporary");
    const pA = sendDueEmails(t.worker, a.sender, { now: NOW, lockSeconds: 30 });
    await a.inside;
    expect((await delivery(inv))[0]).toMatchObject({ status: "sending", attempts: 1 });
    // B thấy khoá quá hạn → trả về retrying có chờ lùi, chưa nhận.
    expect(
      (await sendDueEmails(t.worker, new FakeEmailSender(), { now: new Date(NOW.getTime() + 31_000) }))
        .claimed,
    ).toBe(0);
    const b = gated(() => id, "ok");
    const pB = sendDueEmails(t.worker, b.sender, { now: new Date(NOW.getTime() + 92_000), lockSeconds: 30 });
    await b.inside;
    expect((await delivery(inv))[0]).toMatchObject({ status: "sending", attempts: 2 });
    a.release();
    // Kết quả về muộn của A: không ghi (0 hàng), đếm `stale`, không đếm/log như retrying.
    expect(await pA).toMatchObject({ stale: 1, retrying: 0 });
    // A (attempts 1) không đổi được hàng B đang giữ.
    expect((await delivery(inv))[0]).toMatchObject({ status: "sending", attempts: 2 });
    b.release();
    expect((await pB).sent).toBe(1);
    expect((await delivery(inv))[0]).toMatchObject({
      status: "sent",
      attempts: 2,
      provider_message_id: "fake-1",
    });
    expect(b.fake.sent).toHaveLength(1);
  });
});

describe("Review PR #10 — tên cơ sở có số điện thoại", () => {
  it("'Nhà nghỉ Hoa Mai - 0100003456' → thông báo + email vẫn tạo/gửi, số bị che ***", async () => {
    const old = await sql<{ name: string }>`select name from properties where id = ${A.propertyId}`.execute(
      t.admin,
    );
    await sql`update properties set name = 'Nhà nghỉ Hoa Mai - 0100003456' where id = ${A.propertyId}`.execute(
      t.admin,
    );
    try {
      const inv = await invoice();
      await issue(inv);
      expect(await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW)).toBe(1);
      const n = await sql<{ title: string; body: string }>`
        select title, body from notifications where dedupe_key = ${`invoice_issued:${inv}`}`.execute(t.admin);
      expect(n.rows[0]?.body).toContain("Nhà nghỉ Hoa Mai - ***");
      const fake = new FakeEmailSender();
      const s = await sendDueEmails(t.worker, fake, { now: NOW });
      expect(s.sent).toBe(1);
      expect(`${fake.sent[0]?.subject}\n${fake.sent[0]?.text}`).not.toContain("0100003456");
      expect((await delivery(inv))[0]?.status).toBe("sent");
    } finally {
      await sql`update properties set name = ${old.rows[0]?.name} where id = ${A.propertyId}`.execute(
        t.admin,
      );
    }
  });

  it("dữ liệu không render được (tên cơ sở chỉ ký tự điều khiển) → dispatch bỏ sự kiện + log, không ném (job không lặp tới dead-letter)", async () => {
    const old = await sql<{ name: string }>`select name from properties where id = ${A.propertyId}`.execute(
      t.admin,
    );
    await sql`update properties set name = ${"\u0001"} where id = ${A.propertyId}`.execute(t.admin);
    try {
      const inv = await invoice();
      await issue(inv);
      const logs: string[] = [];
      expect(
        await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW, (e) =>
          logs.push(e),
        ),
      ).toBe(0);
      expect(logs).toEqual(["notification.template_error"]);
      expect(await delivery(inv)).toHaveLength(0);
    } finally {
      await sql`update properties set name = ${old.rows[0]?.name} where id = ${A.propertyId}`.execute(
        t.admin,
      );
    }
  });
});

describe("Review PR #10 — tổ chức tồn đọng không chiếm hết lô", () => {
  it("A có 13 lần gửi đến hạn sớm hơn, B có 1 → limit 3/perOrg 3 vẫn nhận lần gửi của B", async () => {
    const bPerson = randomUUID();
    await sql`insert into persons (id, organization_id, full_name, email)
              values (${bPerson}, ${B.orgId}, 'Người nhận B', 'b@example.test')`.execute(t.admin);
    const { withTenant } = await import("@hm/db");
    const make = (orgId: string, propertyId: string, person: string, key: string, at: Date) =>
      withTenant(t.worker, { orgId }, (trx) =>
        createNotification(
          trx,
          orgId,
          {
            propertyId,
            recipientPersonId: person,
            type: "export_ready",
            vars: { exportName: "Báo cáo", exportId: randomUUID() },
            dedupeKey: key,
          },
          { now: at },
        ),
      );
    for (let i = 0; i < 13; i++)
      await make(
        A.orgId,
        A.propertyId,
        tenant.personId,
        `starve:${i}`,
        new Date(NOW.getTime() - 3_600_000 + i),
      );
    await make(B.orgId, B.propertyId, bPerson, "starve:b", NOW);
    const r = await sql<{ organization_id: string }>`
      select organization_id from app.claim_due_deliveries(${NOW}, 3, 3, 30, ${MAX_ATTEMPTS})`.execute(
      t.worker,
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows.filter((x) => x.organization_id === B.orgId)).toHaveLength(1);
    expect(r.rows.filter((x) => x.organization_id === A.orgId)).toHaveLength(2);
  });
});

describe("jitter lịch gửi lại (ARC-RES-002)", () => {
  /** Đặt CUỐI file: để lại hàng `retrying` còn hạn nên mọi test đếm `claimed` toàn cục phải chạy trước. Hai thư lỗi tạm cùng lúc: jitter khác nhau → hai mốc thử lại khác nhau, đều trong [mốc, mốc·(1+tỉ lệ)]. */
  it.each([
    ["random = 0 → đúng mốc Q-05", 0, 0],
    ["random sát 1 → mốc · (1 + tỉ lệ)", 0.999999, RETRY_JITTER_RATIO],
  ])("%s", async (_name, rnd, extra) => {
    const inv = await invoice();
    await issue(inv);
    await dispatchNotification(t.worker, (await jobsFor(inv))[0] as DispatchJob, NOW);
    const fake = new FakeEmailSender();
    fake.failWith = () => new EmailSendError("temporary", "421 thử lại sau");
    await sendDueEmails(t.worker, fake, { now: NOW, random: () => rnd, limit: 1000, perOrg: 1000 });
    const d = (await delivery(inv))[0];
    expect(d?.status).toBe("retrying");
    const delta = (d?.next_attempt_at?.getTime() ?? Number.NaN) - NOW.getTime();
    expect(delta).toBeGreaterThanOrEqual(60_000);
    expect(delta).toBeLessThanOrEqual(60_000 * (1 + RETRY_JITTER_RATIO));
    expect(Math.abs(delta - 60_000 * (1 + extra))).toBeLessThanOrEqual(1);
  });
});
