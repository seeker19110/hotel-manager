// BE-JOB-007 (T-401): schema payload job theo event_type; khoá cấm; lỗi là vĩnh viễn.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFY_EVENT_TYPES } from "../notifications/dispatch.ts";
import {
  FORBIDDEN_PAYLOAD_KEY,
  InvalidJobPayloadError,
  OUTBOX_PAYLOAD_SCHEMAS,
  parseOutboxPayload,
} from "./payloads.ts";

const ID = "0192f7a0-0000-7000-8000-000000000001";

describe("payload job — schema theo event_type", () => {
  it("mọi consumer có sẵn đều có schema (chặn quên khi thêm consumer)", () => {
    const need = [...NOTIFY_EVENT_TYPES, "export.requested", "bank_transaction.received"];
    for (const t of need) expect(Object.keys(OUTBOX_PAYLOAD_SCHEMAS), t).toContain(t);
  });

  it("payload đúng ⇒ qua; khoá thừa không làm hỏng", () => {
    expect(parseOutboxPayload("invoice.issued", { invoice_id: ID, total: 5 })).toEqual({
      invoice_id: ID,
      total: 5,
    });
    expect(
      parseOutboxPayload("work_order.status_changed", { work_order_id: ID, status: "done" }),
    ).toBeTruthy();
    expect(parseOutboxPayload("portal.tenant_invited", { membership_id: ID, person_id: ID })).toBeTruthy();
    expect(parseOutboxPayload("export.requested", { export_id: ID })).toBeTruthy();
    expect(
      parseOutboxPayload("bank_transaction.received", { bank_transaction_id: ID, inbox_id: ID }),
    ).toBeTruthy();
  });

  it.each([
    ["thiếu khoá", "invoice.issued", {}],
    ["sai kiểu số", "invoice.issued", { invoice_id: 7 }],
    ["null", "invoice.issued", { invoice_id: null }],
    ["chuỗi rỗng", "export.requested", { export_id: "" }],
    ["không phải id", "export.requested", { export_id: "../etc/passwd" }],
    ["trạng thái rỗng", "work_order.status_changed", { work_order_id: ID, status: "" }],
    ["thiếu một trong hai", "portal.tenant_invited", { membership_id: ID }],
  ])("sai schema (%s) ⇒ InvalidJobPayloadError vĩnh viễn", (_n, type, payload) => {
    let err: unknown;
    try {
      parseOutboxPayload(type, payload);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidJobPayloadError);
    expect((err as InvalidJobPayloadError).permanent).toBe(true);
  });

  it("payload không phải đối tượng (null, mảng, chuỗi) ⇒ lỗi", () => {
    for (const bad of [null, [], "x", 3, undefined])
      expect(() => parseOutboxPayload("invoice.issued", bad)).toThrow(InvalidJobPayloadError);
  });

  it("khoá cấm password/token/secret bị từ chối kể cả loại chưa có schema; thông điệp không lộ giá trị", () => {
    for (const k of ["password", "access_token", "client_secret", "api_key", "apiKey"])
      expect(FORBIDDEN_PAYLOAD_KEY.test(k), k).toBe(true);
    let msg = "";
    try {
      parseOutboxPayload("demo.event", { password: "hunter2-giá-trị-bí-mật" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("password");
    expect(msg).not.toContain("hunter2");
    expect(parseOutboxPayload("demo.event", { seq: 1 })).toEqual({ seq: 1 });
  });

  it("không schema nào khai khoá cấm (BE-JOB-007: payload không chứa password/token)", () => {
    for (const [type, schema] of Object.entries(OUTBOX_PAYLOAD_SCHEMAS)) {
      const keys = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
      for (const k of keys) expect(FORBIDDEN_PAYLOAD_KEY.test(k), `${type}.${k}`).toBe(false);
    }
  });

  it("mã nguồn: payload của mọi ctx.emit không có khoá password/token/secret", () => {
    const root = new URL("..", import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
      });
    let seen = 0;
    for (const f of walk(root)) {
      for (const m of readFileSync(f, "utf8").matchAll(/payload:\s*\{([^}]*)\}/g)) {
        seen++;
        for (const k of (m[1] ?? "").matchAll(/(?:^|[,\s])([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/g))
          expect(FORBIDDEN_PAYLOAD_KEY.test(k[1] ?? ""), `${f}: ${k[1]}`).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(5);
  });
});
