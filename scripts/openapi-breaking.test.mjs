// STD-PROC-003: rào phá vỡ hợp đồng API (scripts/check-openapi-breaking.mjs) — quy tắc request/response, luật MAJOR + BREAKING CHANGE.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  deref,
  diffSchema,
  evaluate,
  findBreakingChanges,
  hasBreakingAck,
} from "./check-openapi-breaking.mjs";
import { makeRepo } from "./git-test-repo.mjs";

const clone = (x) => structuredClone(x);
const ok = (schema) => ({ description: "ok", content: { "application/json": { schema } } });
const base = () => ({
  openapi: "3.1.0",
  info: { title: "t", version: "1.2.0" },
  security: [{ sessionCookie: [] }],
  paths: {
    "/api/v1/items": {
      get: {
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 100 } },
          { $ref: "#/components/parameters/OrgId" },
        ],
        responses: {
          200: ok({ $ref: "#/components/schemas/Item" }),
          404: { description: "không thấy" },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", maxLength: 50 },
                  kind: { type: "string", enum: ["a", "b"] },
                  note: { type: "string" },
                },
              },
            },
          },
        },
        responses: { 201: ok({ $ref: "#/components/schemas/Item" }) },
      },
    },
  },
  components: {
    parameters: { OrgId: { name: "org", in: "header", required: true, schema: { type: "string" } } },
    schemas: {
      Item: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          state: { type: "string", enum: ["open", "closed"] },
          child: { $ref: "#/components/schemas/Item" },
        },
      },
    },
  },
});
const breakingOf = (mutate) => {
  const next = clone(base());
  mutate(next);
  return findBreakingChanges(base(), next);
};
const PATH = "/api/v1/items";
const BODY = (d) => d.paths[PATH].post.requestBody.content["application/json"].schema;

describe("findBreakingChanges — không phá vỡ", () => {
  it("giống hệt → rỗng (kể cả schema đệ quy)", () => expect(findBreakingChanges(base(), base())).toEqual([]));
  it("thêm đường dẫn / phương thức / tham số tuỳ chọn / trường phản hồi / phản hồi lỗi mới", () => {
    expect(
      breakingOf((d) => {
        d.paths["/api/v1/new"] = { get: { responses: { 200: { description: "x" } } } };
        d.paths[PATH].delete = { responses: { 204: { description: "x" } } };
        d.paths[PATH].get.parameters.push({
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
        });
        d.components.schemas.Item.properties.extra = { type: "string" };
        d.paths[PATH].get.responses[500] = { description: "lỗi" };
        delete d.paths[PATH].get.responses[404];
      }),
    ).toEqual([]);
  });
  it("nới request: tăng maxLength, thêm giá trị enum, bỏ bắt buộc, tham số bắt buộc → tuỳ chọn", () => {
    expect(
      breakingOf((d) => {
        BODY(d).properties.name.maxLength = 80;
        BODY(d).properties.kind.enum.push("c");
        BODY(d).required = [];
        d.components.parameters.OrgId.required = false;
        d.paths[PATH].get.parameters[0].schema.maximum = 500;
      }),
    ).toEqual([]);
  });
  it("tham số/loại tuỳ chọn bị bỏ không tính; thêm tham số tuỳ chọn ở request body không tính", () => {
    expect(
      breakingOf((d) => {
        d.paths[PATH].get.parameters.splice(0, 1);
        BODY(d).properties.more = { type: "string" };
      }),
    ).toEqual([]);
  });
  it("kiểu integer → number ở request (rộng hơn) không phá vỡ", () => {
    expect(
      breakingOf((d) => {
        d.paths[PATH].get.parameters[0].schema.type = "number";
      }),
    ).toEqual([]);
  });
});

describe("findBreakingChanges — phá vỡ", () => {
  it.each([
    ["bỏ đường dẫn", (d) => delete d.paths[PATH], "bỏ đường dẫn"],
    ["bỏ phương thức", (d) => delete d.paths[PATH].post, "bỏ phương thức"],
    ["bỏ phản hồi 2xx", (d) => delete d.paths[PATH].post.responses[201], "bỏ phản hồi 201"],
    [
      "phản hồi 2xx không còn json",
      (d) => (d.paths[PATH].get.responses[200] = { description: "x" }),
      "không còn application/json",
    ],
    ["bỏ trường phản hồi", (d) => delete d.components.schemas.Item.properties.name, "bỏ trường 'name'"],
    [
      "trường phản hồi hết bắt buộc",
      (d) => (d.components.schemas.Item.required = ["id"]),
      "không còn bắt buộc",
    ],
    [
      "đổi kiểu trường phản hồi",
      (d) => (d.components.schemas.Item.properties.name.type = "integer"),
      "kiểu response",
    ],
    [
      "response thêm giá trị enum",
      (d) => d.components.schemas.Item.properties.state.enum.push("lost"),
      "response thêm giá trị enum",
    ],
    [
      "đổi format phản hồi",
      (d) => (d.components.schemas.Item.properties.id.format = "date-time"),
      "đổi format",
    ],
    [
      "thêm tham số bắt buộc",
      (d) =>
        d.paths[PATH].get.parameters.push({
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string" },
        }),
      "thêm tham số bắt buộc 'q'",
    ],
    ["tham số thành bắt buộc", (d) => (d.paths[PATH].get.parameters[0].required = true), "thành bắt buộc"],
    ["bỏ tham số bắt buộc", (d) => d.paths[PATH].get.parameters.splice(1, 1), "bỏ tham số bắt buộc"],
    ["siết maximum tham số", (d) => (d.paths[PATH].get.parameters[0].schema.maximum = 50), "đổi maximum"],
    ["đổi kiểu tham số", (d) => (d.paths[PATH].get.parameters[0].schema.type = "string"), "request hẹp lại"],
    ["request body thêm trường bắt buộc", (d) => BODY(d).required.push("kind"), "'kind' thành bắt buộc"],
    [
      "request body trường mới bắt buộc",
      (d) => {
        BODY(d).properties.fresh = { type: "string" };
        BODY(d).required.push("fresh");
      },
      "'fresh' thành bắt buộc",
    ],
    ["request siết maxLength", (d) => (BODY(d).properties.name.maxLength = 10), "đổi maxLength"],
    ["request bớt enum", (d) => (BODY(d).properties.kind.enum = ["a"]), "bớt giá trị enum"],
    ["request thêm enum vào trường tự do", (d) => (BODY(d).properties.note.enum = ["x"]), "bớt giá trị enum"],
    [
      "request không còn nhận trường (additionalProperties false)",
      (d) => {
        BODY(d).additionalProperties = false;
        delete BODY(d).properties.note;
      },
      "không còn nhận trường 'note'",
    ],
    [
      "request đổi media type",
      (d) => (d.paths[PATH].post.requestBody.content = { "text/plain": { schema: { type: "string" } } }),
      "không còn nhận application/json",
    ],
  ])("%s", (_name, mutate, expected) => {
    const next = clone(base());
    mutate(next);
    const found = findBreakingChanges(base(), next);
    expect(found.join("\n")).toContain(expected);
  });

  it("request body tuỳ chọn → bắt buộc", () => {
    const old = clone(base());
    old.paths[PATH].post.requestBody.required = false;
    expect(findBreakingChanges(old, base()).join("\n")).toContain("request body thành bắt buộc");
  });
  it("xác thực: không → có, đổi cơ chế", () => {
    const open = clone(base());
    open.paths[PATH].get.security = [];
    expect(findBreakingChanges(open, base()).join("\n")).toContain("thêm yêu cầu xác thực");
    const swapped = clone(base());
    swapped.security = [{ apiKey: [] }];
    expect(findBreakingChanges(base(), swapped).join("\n")).toContain("đổi cơ chế xác thực");
    const relaxed = clone(base());
    relaxed.security = [];
    expect(findBreakingChanges(base(), relaxed)).toEqual([]);
  });
  it("anyOf đổi số nhánh", () => {
    const a = {
      paths: {
        "/x": { get: { responses: { 200: ok({ anyOf: [{ type: "string" }, { type: "integer" }] }) } } },
      },
    };
    const b = clone(a);
    b.paths["/x"].get.responses[200].content["application/json"].schema.anyOf.pop();
    expect(findBreakingChanges(a, b).join("\n")).toContain("đổi cấu trúc anyOf");
  });
  it("path-level parameters được tính", () => {
    const a = { paths: { "/x": { get: { responses: {} } } } };
    const b = {
      paths: {
        "/x": {
          parameters: [{ name: "t", in: "header", required: true, schema: { type: "string" } }],
          get: { responses: {} },
        },
      },
    };
    expect(findBreakingChanges(a, b).join("\n")).toContain("thêm tham số bắt buộc 't'");
  });
});

describe("deref / diffSchema biên", () => {
  it("$ref hỏng, ngoài tài liệu, vòng → {} không treo", () => {
    expect(deref({}, { $ref: "#/nope/x" })).toEqual({});
    expect(deref({}, { $ref: "https://x.test/s.json" })).toEqual({});
    const loop = { a: { $ref: "#/b" }, b: { $ref: "#/a" } };
    expect(deref(loop, { $ref: "#/a" })).toEqual({});
    expect(deref({}, undefined)).toEqual({});
  });
  it("schema thiếu một phía → bỏ qua", () => {
    const out = [];
    diffSchema({}, undefined, {}, { type: "string" }, "request", "w", out);
    diffSchema({}, { type: "string" }, {}, undefined, "response", "w", out);
    expect(out).toEqual([]);
  });
  it("hướng response: kiểu nhiều lựa chọn bị thu hẹp thì không phá vỡ, mở rộng thì phá vỡ", () => {
    const out = [];
    diffSchema({}, { type: ["string", "null"] }, {}, { type: "string" }, "response", "w", out);
    expect(out).toEqual([]);
    diffSchema({}, { type: "string" }, {}, { type: ["string", "null"] }, "response", "w", out);
    expect(out).toHaveLength(1);
  });
  it("pattern: request đổi → đỏ; thêm minLength ở request → đỏ; response bỏ minLength → đỏ", () => {
    const out = [];
    diffSchema(
      {},
      { type: "string", pattern: "^a$" },
      {},
      { type: "string", pattern: "^b$" },
      "request",
      "p",
      out,
    );
    diffSchema({}, { type: "string" }, {}, { type: "string", minLength: 1 }, "request", "m", out);
    diffSchema({}, { type: "string", minLength: 1 }, {}, { type: "string" }, "response", "r", out);
    expect(out.map((s) => s.split(":")[0])).toEqual(["p", "m", "r"]);
  });
});

describe("hasBreakingAck", () => {
  it.each([
    [["feat(api)!: bỏ trường x"], true],
    [["feat: x\n\nBREAKING CHANGE: bỏ trường x"], true],
    [["feat: x\n\nBREAKING-CHANGE: bỏ trường x"], true],
    [["feat: x\n\nbreaking change: viết thường"], false],
    [["feat: x\n\nBREAKING CHANGE:"], false],
    [["feat: x\n\nghi chú: chuyện! không phải"], false],
    [["fix: a", "feat!: b"], true],
    [[], false],
  ])("%j", (texts, expected) => expect(hasBreakingAck(texts)).toBe(expected));
});

describe("evaluate — luật phiên bản", () => {
  const dropped = () => {
    const d = clone(base());
    delete d.paths[PATH].post;
    return d;
  };
  const withVersion = (d, v) => {
    d.info.version = v;
    return d;
  };
  const ack = ["feat!: bỏ POST\n\nBREAKING CHANGE: bỏ POST /api/v1/items"];

  it("không phá vỡ, version giữ nguyên → đạt", () => {
    expect(evaluate({ oldDoc: base(), newDoc: base(), texts: [] }).problems).toEqual([]);
  });
  it("phá vỡ, MAJOR không tăng → đỏ (kể cả khi tăng minor/patch)", () => {
    const r = evaluate({ oldDoc: base(), newDoc: withVersion(dropped(), "1.9.0"), texts: ack });
    expect(r.breaking.length).toBeGreaterThan(0);
    expect(r.problems.join("\n")).toContain("MAJOR không tăng");
  });
  it("phá vỡ, MAJOR tăng nhưng thiếu BREAKING CHANGE → đỏ", () => {
    const r = evaluate({ oldDoc: base(), newDoc: withVersion(dropped(), "2.0.0"), texts: ["feat: bỏ POST"] });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("BREAKING CHANGE");
  });
  it("phá vỡ, MAJOR tăng + có BREAKING CHANGE → đạt", () => {
    expect(
      evaluate({ oldDoc: base(), newDoc: withVersion(dropped(), "2.0.0"), texts: ack }).problems,
    ).toEqual([]);
  });
  it("MAJOR giảm → đỏ; version không phải SemVer → đỏ; 0.x → 1.0.0 tính là tăng", () => {
    expect(
      evaluate({ oldDoc: base(), newDoc: withVersion(clone(base()), "0.9.0"), texts: [] }).problems.join(),
    ).toContain("giảm MAJOR");
    expect(
      evaluate({ oldDoc: base(), newDoc: withVersion(clone(base()), "abc"), texts: [] }).problems.join(),
    ).toContain("SemVer");
    expect(
      evaluate({
        oldDoc: withVersion(clone(base()), "0.9.0"),
        newDoc: withVersion(dropped(), "1.0.0"),
        texts: ack,
      }).problems,
    ).toEqual([]);
  });
  it("tăng MAJOR khi không phá vỡ → vẫn đạt", () => {
    expect(
      evaluate({ oldDoc: base(), newDoc: withVersion(clone(base()), "2.0.0"), texts: [] }).problems,
    ).toEqual([]);
  });
});

describe("hợp đồng thật apps/web/openapi.json", () => {
  const real = JSON.parse(
    readFileSync(fileURLToPath(new URL("../apps/web/openapi.json", import.meta.url)), "utf8"),
  );
  it("so với chính nó → không phá vỡ; version là SemVer", () => {
    expect(findBreakingChanges(real, real)).toEqual([]);
    expect(evaluate({ oldDoc: real, newDoc: real, texts: [] }).problems).toEqual([]);
  });
  it("bỏ một đường dẫn thật → bị bắt (rào đỏ khi vi phạm)", () => {
    const next = clone(real);
    const first = Object.keys(next.paths)[0];
    delete next.paths[first];
    expect(findBreakingChanges(real, next)).toContain(`${first}: bỏ đường dẫn`);
  });
  it("siết tham số `limit` thật thành bắt buộc → bị bắt", () => {
    const next = clone(real);
    const op = Object.values(next.paths)
      .flatMap((p) => Object.values(p))
      .find((o) => o.parameters?.some((x) => x.name === "limit"));
    expect(op).toBeDefined();
    op.parameters.find((x) => x.name === "limit").required = true;
    expect(findBreakingChanges(real, next).join("\n")).toContain("'limit'");
  });
});

describe("CLI (repo tạm)", () => {
  const repos = [];
  afterEach(() => {
    for (const r of repos.splice(0)) r.destroy();
  });
  const script = fileURLToPath(new URL("./check-openapi-breaking.mjs", import.meta.url));
  const run = (cwd, ...args) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [script, "--base", "main", ...args], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stderr) };
    }
  };
  it("đạt khi giống gốc; đỏ khi bỏ đường dẫn mà giữ version; đạt khi tăng MAJOR + footer", () => {
    const r = makeRepo();
    repos.push(r);
    const doc = base();
    r.write("apps/web/openapi.json", `${JSON.stringify(doc)}\n`);
    r.commit("chore: nền");
    r.branch("feature");
    expect(run(r.dir).code).toBe(0);

    delete doc.paths[PATH];
    r.write("apps/web/openapi.json", `${JSON.stringify(doc)}\n`);
    r.commit("feat: bỏ đường dẫn");
    const bad = run(r.dir);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("MAJOR không tăng");

    doc.info.version = "2.0.0";
    r.write("apps/web/openapi.json", `${JSON.stringify(doc)}\n`);
    r.commit("feat!: bỏ đường dẫn\n\nBREAKING CHANGE: bỏ /api/v1/items");
    expect(run(r.dir).code).toBe(0);
  });
  it("ghi chú PR (--extra-file) cũng tính là xác nhận; nhánh gốc không tồn tại → mã 2", () => {
    const r = makeRepo();
    repos.push(r);
    const doc = base();
    r.write("apps/web/openapi.json", `${JSON.stringify(doc)}\n`);
    r.commit("chore: nền");
    r.branch("feature");
    delete doc.paths[PATH];
    doc.info.version = "2.0.0";
    r.write("apps/web/openapi.json", `${JSON.stringify(doc)}\n`);
    r.commit("feat: bỏ đường dẫn");
    expect(run(r.dir).code).toBe(1);
    r.write("pr.txt", "feat(api)!: bỏ đường dẫn\n\nmô tả");
    expect(run(r.dir, "--extra-file", join(r.dir, "pr.txt")).code).toBe(0);
    const noBase = (() => {
      try {
        execFileSync("node", [script, "--base", "khong-co"], { cwd: r.dir, stdio: "pipe" });
        return 0;
      } catch (e) {
        return e.status;
      }
    })();
    expect(noBase).toBe(2);
  });
});
