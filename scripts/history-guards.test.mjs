// DB-MIG-003 (migration đã có không được sửa) + ARC-ADR-004 (ADR accepted chỉ đổi dòng status/superseded) + git-history.
// Hàm thuần kiểm bằng dữ liệu dựng sẵn; đường git kiểm bằng repo tạm (scripts/git-test-repo.mjs). CI chạy các script này ở job `pr-policy`.
import { afterEach, describe, expect, it } from "vitest";
import {
  changedLines,
  checkAgainst as checkAdr,
  findAdrViolations,
  isAccepted,
  statusOf,
} from "./check-adr-immutable.mjs";
import {
  checkAgainst as checkMig,
  findMigrationViolations,
  MIGRATIONS_DIR,
} from "./check-migrations-immutable.mjs";
import { argValue, changedEntries, filesAt, refExists, showAt } from "./git-history.mjs";
import { makeRepo } from "./git-test-repo.mjs";

const M = MIGRATIONS_DIR;
const baseFiles = [`${M}/0001_a.ts`, `${M}/0002_b.ts`, `${M}/index.ts`];

describe("findMigrationViolations", () => {
  const run = (entries) => findMigrationViolations({ entries, baseFiles });
  it("không đổi gì → đạt", () => expect(run([])).toEqual([]));
  it("thêm migration số sau bản cuối + sửa index.ts → đạt", () => {
    expect(
      run([
        { status: "A", path: `${M}/0003_c.ts` },
        { status: "M", path: `${M}/index.ts` },
      ]),
    ).toEqual([]);
  });
  it("sửa migration đã có → đỏ", () => {
    const v = run([{ status: "M", path: `${M}/0002_b.ts` }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("0002_b.ts");
    expect(v[0]).toContain("sửa");
  });
  it("xoá migration đã có → đỏ", () => {
    expect(run([{ status: "D", path: `${M}/0001_a.ts` }])[0]).toContain("xoá");
  });
  it("xoá index.ts → đỏ", () => {
    expect(run([{ status: "D", path: `${M}/index.ts` }])).toHaveLength(1);
  });
  it("migration mới có số ≤ bản cuối của gốc → đỏ (kể cả đúng bằng)", () => {
    expect(run([{ status: "A", path: `${M}/0002_x.ts` }])[0]).toContain("không lớn hơn");
    expect(run([{ status: "A", path: `${M}/0001_x.ts` }])).toHaveLength(1);
  });
  it("hai migration mới trùng số → đỏ", () => {
    const v = run([
      { status: "A", path: `${M}/0003_a.ts` },
      { status: "A", path: `${M}/0003_b.ts` },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("trùng số");
  });
  it("tên sai dạng → đỏ", () => {
    expect(run([{ status: "A", path: `${M}/migration.ts` }])[0]).toContain("NNNN_");
    expect(run([{ status: "A", path: `${M}/0003_Hoa.ts` }])).toHaveLength(1);
  });
  it("gốc rỗng (chưa có migration) → số 0001 đạt", () => {
    expect(
      findMigrationViolations({ entries: [{ status: "A", path: `${M}/0001_a.ts` }], baseFiles: [] }),
    ).toEqual([]);
  });
});

describe("statusOf / isAccepted", () => {
  it.each([
    ["---\nstatus: accepted\n---\n# x", "accepted", true],
    [
      "---\nstatus: Accepted — bị thay một phần\nimplementation-status: done\n---\n",
      "accepted — bị thay một phần",
      true,
    ],
    ["---\nstatus: proposed\n---\n", "proposed", false],
    ["# ADR\n\nStatus: accepted\n", "accepted", true],
    ["# ADR không trạng thái\n", null, false],
    ["---\nstatus: acceptedx\n---\n", "acceptedx", false],
  ])("%j", (text, status, accepted) => {
    expect(statusOf(text)).toBe(status);
    expect(isAccepted(statusOf(text))).toBe(accepted);
  });
});

describe("findAdrViolations", () => {
  const baseText =
    "---\nstatus: accepted\nimplementation-status: not-started\n---\n# ADR\nNội dung quyết định.\n";
  const diffOf = (...lines) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${lines.join("\n")}\n`;
  const run = (headText, diff) => findAdrViolations({ path: "docs/adr/0009-x.md", baseText, headText, diff });

  it("ADR chưa accepted → sửa thoải mái", () => {
    expect(
      findAdrViolations({
        path: "p",
        baseText: "---\nstatus: proposed\n---\nA",
        headText: "---\nstatus: proposed\n---\nB",
        diff: diffOf("-A", "+B"),
      }),
    ).toEqual([]);
  });
  it("accepted: chỉ đổi dòng status/implementation-status → đạt", () => {
    const head = baseText
      .replace("status: accepted", "status: superseded by ADR-0010")
      .replace("not-started", "done");
    expect(
      run(
        head,
        diffOf(
          "-status: accepted",
          "+status: superseded by ADR-0010",
          "-implementation-status: not-started",
          "+implementation-status: done",
        ),
      ),
    ).toEqual([]);
  });
  it("accepted: thêm dòng liên kết 'Bị thay bởi ADR-…' / 'Superseded by ADR-…' hoặc khoá superseded-by → đạt", () => {
    expect(run(baseText, diffOf("+Bị thay bởi ADR-0010 (0010-y.md)."))).toEqual([]);
    expect(run(baseText, diffOf("+> Superseded by ADR-0010."))).toEqual([]);
    const withKey = baseText.replace("---\n#", "superseded-by: ADR-0010\n---\n#");
    expect(run(withKey, diffOf("+superseded-by: ADR-0010"))).toEqual([]);
  });
  it("accepted: dòng nội dung chỉ NHẮC 'thay thế'/'superseded' (chuỗi con) vẫn là sửa nội dung → đỏ", () => {
    for (const line of [
      "+Quyết định mới này thay thế toàn bộ phần hosting ở trên.",
      "+Đã bị thay thế bởi [ADR-0010](0010-y.md).",
      "-Không dùng API superseded của thư viện.",
      "+Bị thay bởi quyết định miệng, không có ADR.",
      "+Ghi chú: supersedes ADR-0001",
    ]) {
      const v = run(baseText, diffOf(line));
      expect(v, line).toHaveLength(1);
      expect(v[0]).toContain("sửa nội dung");
    }
  });
  it("accepted: khoá status/superseded-by ngoài frontmatter (trong thân) là sửa nội dung → đỏ", () => {
    const head = `${baseText}\nstatus: accepted — đã đổi ý trong thân\n`;
    const diff =
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -6,0 +7,2 @@\n+\n+status: accepted — đã đổi ý trong thân\n";
    expect(run(head, diff)[0]).toContain("sửa nội dung");
    const inFront = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,0 +4 @@\n+superseded-by: ADR-0010\n";
    expect(run(baseText.replace("---\n#", "superseded-by: ADR-0010\n---\n#"), inFront)).toEqual([]);
  });
  it("accepted: dòng nội dung bị xoá bắt đầu bằng '--' (diff hiện '---') không bị nhầm với header → đỏ", () => {
    const diff =
      "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -6 +5,0 @@\n--- Quyết định cốt lõi\n";
    const v = run(baseText, diff);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("sửa nội dung");
    const added = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -6,0 +7 @@\n+++ thêm dòng bắt đầu bằng ++\n";
    expect(run(baseText, added)[0]).toContain("sửa nội dung");
  });
  it("header diff (trước hunk đầu tiên) không bị tính là dòng đổi", () => {
    expect(changedLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n")).toEqual([]);
    expect(changedLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n")).toEqual([
      { sign: "-", text: "a", line: 1 },
      { sign: "+", text: "b", line: 1 },
    ]);
  });
  it("accepted: sửa nội dung → đỏ", () => {
    const v = run(baseText.replace("quyết định", "khác"), diffOf("-Nội dung quyết định.", "+Nội dung khác."));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("sửa nội dung");
  });
  it("accepted: dòng trống thêm/bớt không tính", () => {
    expect(run(baseText, diffOf("+", "-"))).toEqual([]);
  });
  it("accepted → proposed (lùi) → đỏ; thiếu status → đỏ", () => {
    const back = baseText.replace("accepted", "proposed");
    expect(run(back, diffOf("-status: accepted", "+status: proposed"))[0]).toContain("chỉ được chuyển");
    expect(run("# ADR\n", diffOf("-status: accepted"))[0]).toContain("thiếu status");
  });
  it("accepted: xoá file → đỏ", () => {
    expect(run(null, "")[0]).toContain("không được xoá");
  });
});

describe("git thật (repo tạm)", () => {
  const repos = [];
  afterEach(() => {
    for (const r of repos.splice(0)) r.destroy();
  });
  function setup() {
    const r = makeRepo();
    repos.push(r);
    r.write(`${M}/0001_a.ts`, "export const a = 1;\n");
    r.write(`${M}/0002_b.ts`, "export const b = 1;\n");
    r.write(`${M}/index.ts`, "// registry\n");
    r.write("docs/adr/0001-a.md", "---\nstatus: accepted\n---\n# A\nQuyết định gốc.\n");
    r.write("docs/adr/0002-b.md", "---\nstatus: proposed\n---\n# B\nChưa chốt.\n");
    r.commit("chore: nền");
    r.branch("feature");
    return r;
  }

  it("refExists / showAt / filesAt / changedEntries / argValue", () => {
    const r = setup();
    r.write(`${M}/0003_c.ts`, "x\n");
    r.commit("feat: thêm");
    expect(refExists("main", r.dir)).toBe(true);
    expect(refExists("khong-co", r.dir)).toBe(false);
    expect(showAt("main", `${M}/0001_a.ts`, r.dir)).toBe("export const a = 1;\n");
    expect(showAt("main", `${M}/0003_c.ts`, r.dir)).toBeNull();
    expect(filesAt("main", M, r.dir)).toEqual([`${M}/0001_a.ts`, `${M}/0002_b.ts`, `${M}/index.ts`]);
    expect(changedEntries("main", [M], r.dir)).toEqual([{ status: "A", path: `${M}/0003_c.ts` }]);
    expect(argValue(["--base", "x"], "--base", "y")).toBe("x");
    expect(argValue([], "--base", "y")).toBe("y");
    expect(argValue(["--base"], "--base", "y")).toBe("y");
  });

  it("migration: chỉ thêm → đạt; sửa file cũ → đỏ; xoá → đỏ; số trùng gốc → đỏ", () => {
    const r = setup();
    r.write(`${M}/0003_c.ts`, "x\n");
    r.write(`${M}/index.ts`, "// registry + c\n");
    r.commit("feat: thêm 0003");
    expect(checkMig("main", r.dir)).toEqual([]);

    r.write(`${M}/0002_b.ts`, "export const b = 2;\n");
    r.commit("fix: sửa trộm");
    expect(checkMig("main", r.dir).join("\n")).toContain("0002_b.ts");

    r.write(`${M}/0002_b.ts`, "export const b = 1;\n");
    r.commit("revert: hoàn lại");
    expect(checkMig("main", r.dir)).toEqual([]);

    r.remove(`${M}/0001_a.ts`);
    r.commit("fix: xoá");
    expect(checkMig("main", r.dir).join("\n")).toContain("xoá");
  });

  it("migration: file mới số 0002 khi gốc đã có 0002 → đỏ", () => {
    const r = setup();
    r.write(`${M}/0002_khac.ts`, "x\n");
    r.commit("feat: trùng số");
    expect(checkMig("main", r.dir).join("\n")).toContain("không lớn hơn");
  });

  it("ADR: sửa nội dung accepted → đỏ; đổi status → đạt; ADR proposed sửa → đạt", () => {
    const r = setup();
    r.write("docs/adr/0002-b.md", "---\nstatus: proposed\n---\n# B\nĐã đổi nội dung.\n");
    r.write("docs/adr/0001-a.md", "---\nstatus: superseded by ADR-0002\n---\n# A\nQuyết định gốc.\n");
    r.commit("docs: đổi status ADR-0001, sửa ADR-0002 proposed");
    expect(checkAdr("main", r.dir)).toEqual([]);

    r.write("docs/adr/0001-a.md", "---\nstatus: superseded by ADR-0002\n---\n# A\nQuyết định bị sửa lén.\n");
    r.commit("docs: sửa nội dung");
    const v = checkAdr("main", r.dir);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("0001-a.md");
  });

  it("ADR: xoá ADR accepted → đỏ; thêm ADR mới → đạt", () => {
    const r = setup();
    r.write("docs/adr/0003-c.md", "---\nstatus: accepted\n---\n# C\n");
    r.commit("docs: ADR mới");
    expect(checkAdr("main", r.dir)).toEqual([]);
    r.remove("docs/adr/0001-a.md");
    r.commit("docs: xoá");
    expect(checkAdr("main", r.dir)[0]).toContain("không được xoá");
  });
});
