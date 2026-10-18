import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDir, checkWorkflows, deployFiles, findUnpinned, workflowFiles } from "./check-image-pins.mjs";

const DEPLOY = fileURLToPath(new URL("../deploy", import.meta.url));
const WORKFLOWS = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const D = `sha256:${"a".repeat(64)}`;

describe("findUnpinned", () => {
  it.each([
    [`image: caddy:2.11.7-alpine@${D}`, []],
    ["image: caddy:2.11.7-alpine", ["caddy:2.11.7-alpine"]],
    ["    image: 'postgres:latest'  # trôi", ["postgres:latest"]],
    [`FROM postgres:17@${D}`, []],
    ["FROM --platform=linux/amd64 node:24", ["node:24"]],
    ["FROM scratch", []],
    [`image: x@sha256:${"a".repeat(63)}`, [`x@sha256:${"a".repeat(63)}`]],
    ["# image: chú thích không tính", []],
    [`FROM node:24@${D} AS build\nFROM build`, []],
    ["FROM node:24 AS build\nFROM build", ["node:24"]],
  ])("%s", (text, expected) => {
    expect(findUnpinned(text)).toEqual(expected);
  });
});

describe("deploy/", () => {
  it("có compose và Dockerfile để kiểm", () => {
    const files = deployFiles(DEPLOY).map((f) => f.slice(DEPLOY.length + 1));
    expect(files).toContain("compose.yaml");
    expect(files).toContain("postgres/Dockerfile");
  });

  it("mọi image ghim digest sha256", () => {
    expect(checkDir(DEPLOY)).toEqual([]);
  });
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: chủ ý: dữ liệu mẫu là biểu thức workflow `${{ … }}`, không phải template literal
const WORKFLOW_EXPR = "${{matrix.ref}}";

describe("findUnpinned — biểu thức workflow", () => {
  it("mặc định biểu thức workflow bị coi là chưa ghim; với skipExpressions thì bỏ qua, image thật vẫn bị bắt", () => {
    const yml = `      image: ${WORKFLOW_EXPR}\n      image: postgres:17\n`;
    expect(findUnpinned(yml)).toEqual([WORKFLOW_EXPR, "postgres:17"]);
    expect(findUnpinned(yml, { skipExpressions: true })).toEqual(["postgres:17"]);
  });
  it("service image của workflow ghim digest thì sạch", () => {
    expect(
      findUnpinned(`    services:\n      postgres:\n        image: postgres:17.11-trixie@${D}\n`),
    ).toEqual([]);
  });
});

describe(".github/workflows", () => {
  it("có workflow để kiểm", () => {
    const names = workflowFiles(WORKFLOWS).map((f) => f.slice(WORKFLOWS.length + 1));
    expect(names).toContain("ci.yml");
  });

  it("service/container image trong workflow ghim digest sha256 (BASE-DEP-008)", () => {
    expect(checkWorkflows(WORKFLOWS)).toEqual([]);
  });
});
