// Đồng bộ ma trận quyền giữa SPEC (nguồn duyệt) và code (nguồn chạy) — S-016 của SPEC-access-and-property.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Grant, MATRIX, ROLES } from "./matrix.ts";

const SPEC = new URL("../../../../docs/specs/SPEC-access-and-property.md", import.meta.url);

function parseCell(cell: string): Grant {
  const c = cell.replace(/³/g, "").trim();
  if (c === "—" || c.startsWith("— ")) return "no";
  if (c.startsWith("HM")) return "limit";
  if (c.startsWith("Mình") || c.startsWith("Xác nhận phần mình")) return "own";
  if (c.startsWith("Đọc")) return "read";
  if (c.startsWith("Đề nghị")) return "request";
  if (c.startsWith("Có")) return "yes";
  throw new Error(`Ô không nhận dạng được: "${cell}"`);
}

function specRows(): Map<string, Grant[]> {
  const text = readFileSync(SPEC, "utf8");
  const section = text.slice(text.indexOf("### 5.3"), text.indexOf("### 5.4"));
  const rows = new Map<string, Grant[]>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Hành động") || line.startsWith("|---")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const [label, ...grants] = cells;
    if (!label || grants.length !== ROLES.length) throw new Error(`Dòng sai số cột: ${line}`);
    rows.set(label, grants.map(parseCell));
  }
  return rows;
}

describe("ma trận quyền SPEC ↔ code", () => {
  const spec = specRows();
  const code = new Map(Object.values(MATRIX).map(([label, row]) => [label as string, [...row] as Grant[]]));

  it("mọi dòng của SPEC có trong code và ngược lại", () => {
    expect([...code.keys()].sort()).toEqual([...spec.keys()].sort());
  });

  it.each([...spec.entries()])("%s", (label, grants) => {
    expect(code.get(label)).toEqual(grants);
  });
});
