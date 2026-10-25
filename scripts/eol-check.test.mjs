// Test cho scripts/eol-check.mjs (BASE-DEP-003, OPS-MAINT-003; T-802) — không gọi mạng: dữ liệu endoflife.date giả.
import { describe, expect, it } from "vitest";
import {
  collectUsages,
  cycleCandidates,
  evaluate,
  parseImageRef,
  usagesFromGoMod,
  usagesFromImageLines,
} from "./eol-check.mjs";

const TODAY = "2026-10-17";
const plus = (days) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const node = (eol) => [{ cycle: "24", eol }];
const use = (over = {}) => ({ product: "nodejs", version: "24.22.0", source: "test", ...over });

describe("cycleCandidates", () => {
  it.each([
    ["24.22.0", ["24.22", "24"]],
    ["v24.22.0", ["24.22", "24"]],
    [">=24.11.0 <25", ["24.11", "24"]],
    ["17", ["17"]],
    ["2.11.7-alpine", ["2.11", "2"]],
    ["", []],
    [undefined, []],
    ["latest", []],
  ])("%s", (v, want) => expect(cycleCandidates(v)).toEqual(want));
});

describe("parseImageRef", () => {
  it.each([
    [`postgres:17.11-trixie@sha256:${"a".repeat(64)}`, { name: "postgres", tag: "17.11-trixie" }],
    ["chrislusf/seaweedfs:4.48", { name: "seaweedfs", tag: "4.48" }],
    ["localhost:5000/team/app", { name: "app", tag: "" }],
    ["node", { name: "node", tag: "" }],
    ["scratch", null],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: chủ ý: tham chiếu image dạng biến shell `${IMAGE}` là dữ liệu của test
    ["${IMAGE}", null],
  ])("%s", (ref, want) => expect(parseImageRef(ref)).toEqual(want));
});

describe("usagesFromImageLines", () => {
  it("lấy sản phẩm + phiên bản + bản Debian từ tag; bỏ image không theo dõi và tag không phải số", () => {
    const text = [
      `FROM node:24.22.0-trixie-slim@sha256:${"b".repeat(64)} AS base`,
      "    image: postgres:17.11-trixie",
      `    image: caddy:2.11.7-alpine@sha256:${"c".repeat(64)}`,
      "    image: chrislusf/seaweedfs:4.48",
      "    image: postgres:latest",
      "# FROM node:18",
    ].join("\n");
    expect(usagesFromImageLines(text, "f").map((u) => [u.product, u.version ?? u.codename])).toEqual([
      ["nodejs", "24.22.0-trixie-slim"],
      ["debian", "trixie"],
      ["postgresql", "17.11-trixie"],
      ["debian", "trixie"],
      ["caddy", "2.11.7-alpine"],
    ]);
  });
  it("rỗng → []", () => expect(usagesFromImageLines("", "f")).toEqual([]));
  it("image nền tự dựng (D-110): golang → go, alpine → alpine-linux", () => {
    const text = [
      `FROM golang:1.26.10-alpine3.24@sha256:${"a".repeat(64)} AS build`,
      `FROM alpine:3.24.3@sha256:${"b".repeat(64)}`,
    ].join("\n");
    expect(usagesFromImageLines(text, "f").map((u) => [u.product, u.version])).toEqual([
      ["go", "1.26.10-alpine3.24"],
      ["alpine-linux", "3.24.3"],
    ]);
  });
});

describe("usagesFromGoMod (image tự dựng, D-110)", () => {
  it("lấy phiên bản module đã biết ở dòng require (khối và một dòng); bỏ module khác, chú thích, pseudo-version không số", () => {
    const text = [
      "module hotel-manager/deploy/caddy",
      "require github.com/caddyserver/caddy/v2 v2.11.7",
      "require (",
      "\tgithub.com/caddyserver/caddy/v2 v2.12.0 // indirect",
      "\tgolang.org/x/net v0.61.0",
      ")",
      "// github.com/caddyserver/caddy/v2 v9.9.9",
    ].join("\n");
    expect(usagesFromGoMod(text, "g").map((u) => [u.product, u.version, u.source])).toEqual([
      ["caddy", "2.11.7", "g"],
      ["caddy", "2.12.0", "g"],
    ]);
  });
  it("rỗng → []", () => expect(usagesFromGoMod("", "g")).toEqual([]));
});

describe("evaluate", () => {
  it("EOL: hôm nay hoặc đã qua → đỏ; ngày hợp lệ nhưng true → đỏ", () => {
    expect(evaluate(use(), node(plus(0)), TODAY).status).toBe("error");
    expect(evaluate(use(), node(plus(-1)), TODAY).message).toMatch(/đã EOL/);
    expect(evaluate(use(), node(true), TODAY).status).toBe("error");
  });
  it("runtime còn ≤ 90 ngày → đỏ; 91 → cảnh báo (dưới 180)", () => {
    expect(evaluate(use(), node(plus(90)), TODAY).status).toBe("error");
    expect(evaluate(use(), node(plus(90)), TODAY).message).toMatch(/BASE-DEP-003/);
    expect(evaluate(use(), node(plus(91)), TODAY).status).toBe("warn");
  });
  it("sản phẩm không phải runtime: còn 30 ngày vẫn chỉ cảnh báo, 1 ngày cũng chỉ cảnh báo", () => {
    const pg = [{ cycle: "17", eol: plus(30) }];
    expect(evaluate(use({ product: "postgresql", version: "17.11" }), pg, TODAY).status).toBe("warn");
    expect(
      evaluate(use({ product: "postgresql", version: "17.11" }), [{ cycle: "17", eol: plus(1) }], TODAY)
        .status,
    ).toBe("warn");
  });
  it("biên 180 ngày: 179 cảnh báo, 180 đạt", () => {
    expect(evaluate(use(), node(plus(179)), TODAY).status).toBe("warn");
    expect(evaluate(use(), node(plus(180)), TODAY).status).toBe("ok");
  });
  it("eol: false/null → đạt (chưa có ngày)", () => {
    expect(evaluate(use(), node(false), TODAY).status).toBe("ok");
    expect(evaluate(use(), node(null), TODAY).status).toBe("ok");
  });
  it("không tìm thấy chu kỳ / dữ liệu hỏng / ngày hỏng → đỏ (không xanh giả)", () => {
    expect(evaluate(use({ version: "99.0.0" }), node(plus(900)), TODAY).message).toMatch(
      /không tìm thấy chu kỳ/,
    );
    expect(evaluate(use(), undefined, TODAY).status).toBe("error");
    expect(evaluate(use(), { not: "array" }, TODAY).status).toBe("error");
    expect(evaluate(use(), node("không-phải-ngày"), TODAY).status).toBe("error");
    expect(evaluate(use({ version: "" }), node(plus(900)), TODAY).status).toBe("error");
  });
  it("chu kỳ cụ thể ưu tiên hơn chu kỳ chung; Debian khớp theo codename không phân biệt hoa thường", () => {
    const cycles = [
      { cycle: "24", eol: plus(900) },
      { cycle: "24.22", eol: plus(10) },
    ];
    expect(evaluate(use(), cycles, TODAY).status).toBe("error");
    const deb = [{ cycle: "13", codename: "Trixie", eol: plus(900) }];
    expect(evaluate({ product: "debian", codename: "trixie", source: "t" }, deb, TODAY).status).toBe("ok");
    expect(evaluate({ product: "debian", codename: "bookworm", source: "t" }, deb, TODAY).status).toBe(
      "error",
    );
  });
});

describe("collectUsages trên repo thật", () => {
  const usages = collectUsages();
  const products = new Set(usages.map((u) => u.product));
  it("thấy đủ sản phẩm đang dùng: Node, Next.js, PostgreSQL, Caddy, Debian, Go, Alpine", () => {
    for (const p of ["nodejs", "nextjs", "postgresql", "caddy", "debian", "go", "alpine-linux"])
      expect(products.has(p)).toBe(true);
  });
  it("Caddy tự dựng (D-110): phiên bản lấy từ deploy/caddy/go.mod", () => {
    expect(usages.filter((u) => u.product === "caddy").map((u) => u.source)).toContain("deploy/caddy/go.mod");
  });
  it("Node lấy từ .nvmrc, engines và Dockerfile; Postgres từ Dockerfile và workflow", () => {
    const src = (p) => usages.filter((u) => u.product === p).map((u) => u.source);
    expect(src("nodejs")).toEqual(
      expect.arrayContaining([".nvmrc", "package.json engines.node", "deploy/web.Dockerfile"]),
    );
    expect(src("postgresql")).toEqual(
      expect.arrayContaining(["deploy/postgres/Dockerfile", ".github/workflows/ci.yml"]),
    );
  });
});
