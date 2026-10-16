// Quy tắc nhập liệu dùng chung client/server (PLAN đợt 5 T-411, FE-FORM-001): ca biên + bằng chứng cả hai phía import cùng một module.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fillConfirmLabel,
  MONEY_MAX,
  parseDecimalInput,
  parseIntegerInput,
  parseMoneyInput,
} from "./form-rules.ts";
import { COMMANDS } from "./registry.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;

describe("parseMoneyInput", () => {
  it.each([
    ["0", 0],
    ["3580000", 3_580_000],
    ["3.580.000", 3_580_000],
    ["  930.000 ", 930_000],
    [String(MONEY_MAX), MONEY_MAX],
  ])("%s → %s", (raw, want) => expect(parseMoneyInput(raw)).toBe(want));

  it.each([
    "",
    " ",
    "-1",
    "1,5",
    "12.34",
    "1.2345",
    "3.58.000",
    "1e3",
    "٣٥٨",
    "9007199254740992",
    "1.000.000.000.000.000.000",
  ])("từ chối %j", (raw) => expect(parseMoneyInput(raw)).toBeNull());
});

describe("parseIntegerInput / parseDecimalInput", () => {
  it("số nguyên: chữ số thuần, trần an toàn", () => {
    expect(parseIntegerInput("0")).toBe(0);
    expect(parseIntegerInput("12")).toBe(12);
    expect(parseIntegerInput("1.5")).toBeNull();
    expect(parseIntegerInput("")).toBeNull();
    expect(parseIntegerInput("9007199254740993")).toBeNull();
  });
  it("thập phân: tối đa 3 chữ số sau dấu chấm", () => {
    expect(parseDecimalInput("0")).toBe(0);
    expect(parseDecimalInput("1250.5")).toBe(1250.5);
    expect(parseDecimalInput("0.125")).toBe(0.125);
    expect(parseDecimalInput("0.1234")).toBeNull();
    expect(parseDecimalInput("1,5")).toBeNull();
    expect(parseDecimalInput("-1")).toBeNull();
    expect(parseDecimalInput(".5")).toBeNull();
  });
});

describe("fillConfirmLabel", () => {
  it("thay {tên_ô}; ô thiếu → —; một lượt (giá trị chứa {x} không bị thay lần hai)", () => {
    expect(fillConfirmLabel("Thu {amount} cho P-1", { amount: "930.000 đ" })).toBe("Thu 930.000 đ cho P-1");
    expect(fillConfirmLabel("Thu {amount}", {})).toBe("Thu —");
    expect(fillConfirmLabel("Ghi {a}", { a: "{b}", b: "x" })).toBe("Ghi {b}");
    expect(fillConfirmLabel("Không có chỗ thay", { a: "1" })).toBe("Không có chỗ thay");
  });
});

describe("một nguồn quy tắc cho client và server", () => {
  it("form ở trình duyệt và registry server cùng import form-rules; client không tự parse tay", () => {
    const form = readFileSync(`${ROOT}apps/web/components/command/command-form.tsx`, "utf8");
    const registry = readFileSync(`${ROOT}packages/app/src/http/registry.ts`, "utf8");
    expect(form).toMatch(/from "@hm\/app\/form-rules"/);
    expect(registry).toMatch(/from "\.\/form-rules\.ts"/);
    expect(form).not.toMatch(/function parseMoney/);
  });

  it("trần tiền của schema server = MONEY_MAX: vượt trần → 422 theo trường, bằng trần → qua", () => {
    const schema = COMMANDS["deposit.receive"]?.input;
    expect(schema).toBeDefined();
    const base = {
      property_id: "00000000-0000-4000-8000-000000000001",
      lease_id: "00000000-0000-4000-8000-000000000002",
      payer_person_id: "00000000-0000-4000-8000-000000000003",
      method: "cash",
    };
    expect(schema?.safeParse({ ...base, amount: MONEY_MAX }).success).toBe(true);
    expect(schema?.safeParse({ ...base, amount: MONEY_MAX + 2 }).success).toBe(false);
  });
});
