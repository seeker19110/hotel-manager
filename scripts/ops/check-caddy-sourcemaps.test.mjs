import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");
const harness = readFileSync(new URL("./check-caddy-sourcemaps.mjs", import.meta.url), "utf8");

describe("Caddy source map access", () => {
  it("web site returns 404 for the source map matcher before forwarding", () => {
    const web = config.split("{$HM_DOMAIN} {")[1]?.split("\n}")[0];
    expect(web).toBeDefined();
    const matcher = /@source_map\s+path_regexp\s+source_map\s+(\S+)/.exec(web);
    expect(matcher?.[1]).toBe("(?i)\\.map$");
    expect(web).toMatch(/respond\s+@source_map\s+404/);
    expect(web).toMatch(/reverse_proxy\s+web:3000/);
    // Caddy matches the decoded path rather than the query string.
    const pattern = new RegExp(matcher[1].slice(4), "i");
    for (const raw of ["/app.js.map", "/app.js.MAP", "/app.js%2Emap", "/app.js.%6dap"])
      expect(pattern.test(decodeURIComponent(raw)), raw).toBe(true);
    for (const raw of ["/app.js", "/asset.map.png"])
      expect(pattern.test(decodeURIComponent(raw)), raw).toBe(false);
  });

  it("integration harness tests the actual config on an internal network and cleans up", () => {
    expect(harness).toContain('resolve("deploy/Caddyfile")');
    expect(harness).toContain('"--internal"');
    expect(harness).not.toContain('"host",\n      "--add-host"');
    expect(harness).not.toMatch(/"(?:-p|--publish|--publish-all)"/);
    expect(harness).toContain('"SIGINT"');
    expect(harness).toContain('"SIGTERM"');
    expect(harness).toContain('"rm", "-f", name, upstream');
    expect(harness).toContain('"network", "rm", network');
  });
});
