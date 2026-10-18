// Rào cho SeaweedFS tạm của test (s3-server.ts): `weed` tự suy cổng gRPC = cổng HTTP + 10000 mà không kiểm cổng đó
// còn trống — 2026-10-18 `loop verify` đỏ T-207 vì "master failed to listen on grpc port … address already in use".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freePorts } from "./s3-server.ts";

const src = readFileSync(new URL("./s3-server.ts", import.meta.url), "utf8");

describe("s3-server — SeaweedFS tạm cho test", () => {
  it("mọi dịch vụ có cổng HTTP đều khai cổng gRPC tường minh", () => {
    const http = [...src.matchAll(/`-(\w+)\.port=\$\{/g)].map((m) => m[1]);
    expect(http.sort()).toEqual(["filer", "master", "s3", "volume"]);
    for (const svc of http) expect(src).toContain(`\`-${svc}.port.grpc=\${`);
  });

  it("freePorts trả đủ n cổng khác nhau, đều là cổng hợp lệ", async () => {
    const ports = await freePorts(8);
    expect(ports).toHaveLength(8);
    expect(new Set(ports).size).toBe(8);
    for (const p of ports) expect(p).toBeGreaterThan(0);
  });

  it("không gửi telemetry ra ngoài, log và socket nằm trong thư mục tạm", () => {
    expect(src).toContain('"-master.telemetry=false"');
    expect(src).toMatch(/`-logdir=\$\{dir\}`/);
    expect(src).toMatch(/-filer\.localSocket=\$\{join\(dir,/);
    expect(src).toMatch(/-s3\.localSocket=\$\{join\(dir,/);
  });
});
