// Hàm thuần của scripts/check-github-live.mjs — lệnh "Kiểm:" cho mục blueprint đọc ruleset/Release thật (T-1108).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  badTags,
  bypassProblems,
  checksumProblems,
  nonSquashSubjects,
  rulesetProblems,
  sbomCoverage,
} from "./check-github-live.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const code = JSON.parse(readFileSync(join(ROOT, ".github/rulesets/main.json"), "utf8"));

describe("rulesetProblems — rule đang áp so với .github/rulesets/main.json", () => {
  it("rule đúng như bản code ⇒ không lỗi", () => {
    expect(rulesetProblems(code.rules, code)).toEqual([]);
  });

  it("thiếu loại rule, pull_request lỏng, required check thiếu/thừa ⇒ báo từng lỗi", () => {
    const checks = code.rules.find((r) => r.type === "required_status_checks");
    const live = [
      { type: "deletion" },
      {
        type: "pull_request",
        parameters: { required_review_thread_resolution: false, allowed_merge_methods: ["squash", "merge"] },
      },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            ...checks.parameters.required_status_checks.filter((c) => c.context !== "quality"),
            { context: "readme-smoke" },
          ],
        },
      },
    ];
    expect(rulesetProblems(live, code)).toEqual([
      "thiếu rule non_fast_forward",
      "pull_request không bắt resolve thread (required_review_thread_resolution)",
      "pull_request cho kiểu merge khác squash",
      'thiếu required check "quality" so với main.json',
      'required check "readme-smoke" không có trong main.json',
      "required_status_checks không bật strict (nhánh phải cập nhật trước merge)",
    ]);
  });

  it("không có rule nào ⇒ thiếu đủ 4 loại và mọi required check", () => {
    const errs = rulesetProblems([], code);
    expect(errs.slice(0, 4)).toEqual([
      "thiếu rule deletion",
      "thiếu rule non_fast_forward",
      "thiếu rule pull_request",
      "thiếu rule required_status_checks",
    ]);
    expect(errs.length).toBeGreaterThan(4);
  });

  it("bản code bật strict mà rule đang áp tắt ⇒ lỗi", () => {
    const live = code.rules.map((r) =>
      r.type === "required_status_checks"
        ? { ...r, parameters: { ...r.parameters, strict_required_status_checks_policy: false } }
        : r,
    );
    expect(rulesetProblems(live, code)).toEqual([
      "required_status_checks không bật strict (nhánh phải cập nhật trước merge)",
    ]);
  });
});

describe("bypassProblems", () => {
  it("chỉ báo ruleset nhánh đang active có bypass", () => {
    expect(
      bypassProblems([
        { name: "a", target: "branch", enforcement: "active", bypass_actors: [] },
        { name: "b", target: "branch", enforcement: "active", bypass_actors: [{ actor_id: 5 }] },
        { name: "c", target: "branch", enforcement: "disabled", bypass_actors: [{ actor_id: 5 }] },
        { name: "d", target: "tag", enforcement: "active", bypass_actors: [{ actor_id: 5 }] },
      ]),
    ).toEqual(['ruleset "b" có bypass_actors (1)']);
  });

  it("không đọc được bypass_actors (token thiếu quyền) ⇒ lỗi, không coi là rỗng", () => {
    expect(bypassProblems([{ name: "main", target: "branch", enforcement: "active" }])).toEqual([
      'ruleset "main": không đọc được bypass_actors (token thiếu quyền quản trị?)',
    ]);
  });
});

describe("nonSquashSubjects / badTags", () => {
  it("chỉ nhận tiêu đề squash PR kết thúc bằng (#N); bỏ dòng trống", () => {
    expect(
      nonSquashSubjects([
        "fix(x): a (#12)",
        "Merge pull request #3 from x/y",
        "chore: push thẳng",
        "",
        "feat: b (#7) ",
      ]),
    ).toEqual(["Merge pull request #3 from x/y", "chore: push thẳng"]);
  });

  it("tag v* phải là vX.Y.Z (cho phép pre-release/build); tag không bắt đầu bằng v bỏ qua", () => {
    expect(badTags(["v0.2.0", "v1.0.0-rc.1", "v1.0.0+build.5", "v1.2", "v01", "release-1", "vX"])).toEqual([
      "v1.2",
      "v01",
      "vX",
    ]);
  });
});

describe("sbomCoverage (D-077: chỉ tính gói, bỏ file/operating-system)", () => {
  it("đếm gói có license; mục file và hệ điều hành không tính", () => {
    const cdx = {
      components: [
        { type: "library", licenses: [{ license: { id: "MIT" } }] },
        { type: "library", licenses: [] },
        { type: "application" },
        { type: "file" },
        { type: "file" },
        { type: "operating-system" },
      ],
    };
    expect(sbomCoverage(cdx)).toEqual({ licensed: 1, total: 3 });
  });

  it("SBOM rỗng/thiếu components ⇒ 0/0", () => {
    expect(sbomCoverage({})).toEqual({ licensed: 0, total: 0 });
  });
});

describe("checksumProblems", () => {
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const files = { "a.json": Buffer.from("A"), "b.json": Buffer.from("B") };

  it("dạng của release.yml (`<hex>  ./tên`) và dạng `*tên` đều được đọc; khớp ⇒ rỗng", () => {
    expect(
      checksumProblems(`${sha("A")}  ./a.json\n${sha("B")} *b.json\n${sha("C")}  ./c.tar.gz\n`, files),
    ).toEqual([]);
  });

  it("băm lệch ⇒ báo tên tệp (kể cả khi tên có ./)", () => {
    expect(checksumProblems(`${sha("A")}  ./a.json\n${sha("X")}  ./b.json\n`, files)).toEqual([
      "b.json: SHA-256 không khớp SHA256SUMS",
    ]);
  });

  it("tệp tải về không có dòng trong SHA256SUMS (hoặc SHA256SUMS rỗng) ⇒ lỗi, không bỏ qua im lặng", () => {
    expect(checksumProblems(`${sha("A")}  ./a.json\n`, files)).toEqual(["b.json: không có trong SHA256SUMS"]);
    expect(checksumProblems("", files)).toEqual([
      "a.json: không có trong SHA256SUMS",
      "b.json: không có trong SHA256SUMS",
    ]);
  });
});
