import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDir, deployFiles, findUnpinned } from "./check-image-pins.mjs";

const DEPLOY = fileURLToPath(new URL("../deploy", import.meta.url));
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
