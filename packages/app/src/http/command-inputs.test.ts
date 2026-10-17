// FE-FORM-001 — một schema cho mỗi form, import ở cả client và server: (1) module schema chỉ phụ thuộc zod + form-rules (vào
// bundle trình duyệt được), (2) `registry.ts` dùng ĐÚNG đối tượng schema đó làm `input`, (3) mọi lệnh form ở web gọi đều có
// schema dùng chung, (4) lỗi theo trường của client khớp lỗi 422 của server cho cùng thân sai (client chỉ báo sớm).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, sourceFiles } from "../testing/source-scan.ts";
import { COMMAND_INPUTS, checkCommandInput } from "./command-inputs.ts";
import { validationProblem } from "./command-route.ts";
import { MONEY_MAX } from "./form-rules.ts";
import { COMMANDS, findCommand } from "./registry.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const fields = (r: ReturnType<typeof checkCommandInput>) => (r ?? []).map((i) => i.field).sort();

describe("module schema an toàn cho client", () => {
  it("chỉ import zod và ./form-rules.ts (không kéo CSDL/S3/xác thực vào bundle trình duyệt)", () => {
    const text = readFileSync(`${REPO_ROOT}packages/app/src/http/command-inputs.ts`, "utf8");
    const imports = [...text.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./form-rules.ts", "zod"]);
    expect(readFileSync(`${REPO_ROOT}packages/app/src/http/form-rules.ts`, "utf8")).not.toMatch(/^import\s/m);
  });

  it("package.json xuất ./command-inputs; form ở web import qua export đó, không tự đào vào src", () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}packages/app/package.json`, "utf8"));
    expect(pkg.exports["./command-inputs"]).toBe("./src/http/command-inputs.ts");
    const form = readFileSync(`${REPO_ROOT}apps/web/components/command/command-form.tsx`, "utf8");
    const hook = readFileSync(`${REPO_ROOT}apps/web/components/command/use-command.ts`, "utf8");
    for (const src of [form, hook]) expect(src).toMatch(/from "@hm\/app\/command-inputs"/);
  });

  it.skipIf(!existsSync(`${REPO_ROOT}apps/web/.next/static`))(
    "bundle client (sau `pnpm build`) không chứa dấu vết mã server của registry",
    () => {
      const js = sourceFiles(["apps/web/.next/static"], /\.js$/, { includeTests: true })
        .map((f) => f.text)
        .join("\n");
      // Không vacuous: schema dùng chung CÓ trong bundle (câu lỗi chỉ định nghĩa ở command-inputs.ts).
      expect(js).toContain("Giá trị không nằm trong lựa chọn");
      // Chuỗi chỉ có trong mã server mà registry import (pipeline/CSDL/S3); schema dùng chung thì không chứa chúng.
      for (const marker of ["idempotency_keys", "audit_events", "aws4fetch", "pg_advisory"])
        expect(js, marker).not.toContain(marker);
    },
  );
});

describe("registry dùng đúng schema dùng chung", () => {
  it("mọi khoá COMMAND_INPUTS là lệnh có thật và `input` là CÙNG đối tượng schema", () => {
    const keys = Object.keys(COMMAND_INPUTS);
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) expect(COMMANDS[k]?.input, k).toBe((COMMAND_INPUTS as Record<string, unknown>)[k]);
  });

  it("mọi lệnh web gọi (path=…, useCommand(…), hộp thoại khách) có trong registry VÀ có schema dùng chung", () => {
    const src = sourceFiles(["apps/web/app", "apps/web/components"], /\.tsx?$/);
    const literal = /"([a-z]+)\/([A-Za-z]+)"/g;
    const used = new Set<string>();
    for (const f of src) {
      if (f.path.includes("/app/api/")) continue;
      for (const line of f.text.split("\n")) {
        if (!/path=|path:|useCommand\(/.test(line)) continue;
        for (const m of line.matchAll(literal))
          if (findCommand(m[1] as string, m[2] as string)) used.add(`${m[1]}.${m[2]}`);
      }
    }
    expect(used.size).toBeGreaterThan(30);
    const missing = [...used].filter((n) => !Object.hasOwn(COMMAND_INPUTS, n));
    expect(missing).toEqual([]);
  });
});

describe("checkCommandInput", () => {
  it("thân hợp lệ → mảng rỗng; lệnh lạ / tên kế thừa của Object → null (không kiểm được)", () => {
    expect(checkCommandInput("reservation/hold", { reservation_id: UUID })).toEqual([]);
    expect(checkCommandInput("nope/nothing", {})).toBeNull();
    for (const p of ["constructor", "toString/x", "__proto__/y", "hasOwnProperty"])
      expect(checkCommandInput(p, {})).toBeNull();
  });

  it("rỗng/null/0: chuỗi chỉ khoảng trắng (có dấu tiếng Việt) = thiếu; 0 đồng bị từ chối ở lệnh dương, được ở lệnh không âm", () => {
    expect(checkCommandInput("reservation/cancel", { reservation_id: UUID, reason: "   " })).toEqual([
      { field: "reason", message: "Bắt buộc nhập" },
    ]);
    expect(checkCommandInput("reservation/cancel", { reservation_id: UUID })).toEqual([
      { field: "reason", message: "Bắt buộc nhập" },
    ]);
    expect(checkCommandInput("reservation/cancel", { reservation_id: UUID, reason: "Khách huỷ" })).toEqual(
      [],
    );
    expect(checkCommandInput("payment/collectCash", { invoice_id: UUID, amount: 0 })).toHaveLength(1);
    expect(checkCommandInput("shift/open", { property_id: UUID, opening_cash: 0 })).toEqual([]);
    expect(checkCommandInput("shift/open", { property_id: UUID, opening_cash: null })).toHaveLength(1);
  });

  it("trần tiền, số thập phân, trường lạ, đường dẫn lồng", () => {
    expect(checkCommandInput("shift/open", { property_id: UUID, opening_cash: MONEY_MAX })).toEqual([]);
    expect(
      fields(checkCommandInput("shift/open", { property_id: UUID, opening_cash: MONEY_MAX + 2 })),
    ).toEqual(["opening_cash"]);
    expect(fields(checkCommandInput("shift/open", { property_id: UUID, opening_cash: 1.5 }))).toEqual([
      "opening_cash",
    ]);
    expect(fields(checkCommandInput("shift/open", { property_id: UUID, opening_cash: 1, x: 1 }))).toEqual([
      "",
    ]);
    const stay = { stay_id: UUID, payments: [{ method: "cash", amount: -5 }] };
    expect(fields(checkCommandInput("stay/checkOut", stay))).toEqual(["payments.0.amount"]);
  });

  it("độ dài tính theo ký tự Unicode chuẩn của zod; thông báo không lặp lại giá trị người dùng nhập", () => {
    const secret = "ệ".repeat(1001);
    const r = checkCommandInput("reservation/cancel", { reservation_id: UUID, reason: secret });
    expect(r).toEqual([{ field: "reason", message: "Tối đa 1000 ký tự" }]);
    expect(JSON.stringify(r)).not.toContain("ệ");
    expect(
      checkCommandInput("reservation/cancel", { reservation_id: UUID, reason: "ệ".repeat(1000) }),
    ).toEqual([]);
  });

  it("thân không phải đối tượng (null, mảng, chuỗi) → lỗi, không ném", () => {
    for (const body of [null, undefined, [], "x", 5]) {
      const r = checkCommandInput("reservation/hold", body);
      expect(r?.length, String(body)).toBeGreaterThan(0);
    }
  });
});

describe("client ↔ server: cùng thân sai ⇒ cùng tập trường lỗi (server vẫn là ranh giới tin cậy)", () => {
  const bad: [string, unknown][] = [
    ["reservation/cancel", { reservation_id: "x", reason: "" }],
    ["shift/open", { property_id: UUID, opening_cash: -1 }],
    ["stay/postCharge", { stay_id: UUID, kind: "service", description: "", unit_price: 0 }],
    ["meter/recordReading", { meter_id: UUID, billing_period_id: UUID, value: -2 }],
    ["lease/giveNotice", { lease_id: UUID, planned_move_out_on: "31/12/2026" }],
    ["billing/createPeriod", { property_id: UUID, month: "2026-13" }],
    ["stay/checkOut", { stay_id: UUID, payments: [{ method: "momo", amount: 1 }] }],
  ];
  it.each(bad)("%s", async (path, body) => {
    const def = findCommand(...(path.split("/") as [string, string]));
    const parsed = def?.input.safeParse(body);
    expect(parsed?.success).toBe(false);
    if (!parsed || parsed.success) return;
    const res = validationProblem(parsed.error, "corr-test");
    expect(res.status).toBe(422);
    const server = [
      ...new Set(((await res.json()) as { errors: { field: string }[] }).errors.map((e) => e.field)),
    ].sort();
    expect(server.length).toBeGreaterThan(0);
    expect(fields(checkCommandInput(path, body))).toEqual(server);
  });
});
