// Integration check of the actual Caddyfile, with an isolated Docker network and no published ports.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const name = `hm-caddy-map-test-${randomUUID().slice(0, 12)}`;
const network = `${name}-net`;
const upstream = `${name}-web`;
let child;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (child && child.exitCode === null) child.kill();
  spawnSync("docker", ["rm", "-f", name, upstream], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanup();
    process.exit(code);
  });
}
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
function get(path) {
  const code = `const http = require('node:http');
    const req = http.request({host:'caddy',port:80,path:process.argv[1],headers:{host:'127.0.0.1'},timeout:2000}, res => {
      let body=''; res.on('data', x => body+=x); res.on('end', () => console.log(JSON.stringify({status:res.statusCode,body})));
    }); req.on('error', () => process.exit(1)); req.on('timeout', () => req.destroy()); req.end();`;
  const result = spawnSync("docker", ["exec", upstream, "node", "-e", code, path], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error("Caddy request failed");
  return JSON.parse(result.stdout);
}

try {
  const created = spawnSync("docker", ["network", "create", "--internal", network], { stdio: "ignore" });
  assert.equal(created.status, 0, "cannot create isolated Docker network");
  const web = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--pull",
      "never",
      "--name",
      upstream,
      "--network",
      network,
      "--network-alias",
      "web",
      process.env.CADDY_TEST_NODE_IMAGE ?? "hm-node-base:scan",
      "node",
      "-e",
      "require('node:http').createServer((req,res)=>res.end('upstream-ok')).listen(3000,'0.0.0.0')",
    ],
    { stdio: "ignore" },
  );
  assert.equal(web.status, 0, "cannot start fake upstream");
  child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      network,
      "--network-alias",
      "caddy",
      "-e",
      "HM_DOMAIN=http://127.0.0.1",
      "-e",
      "HM_FILES_DOMAIN=http://localhost:81",
      "-e",
      "HM_ACME_EMAIL=test@example.test",
      "-v",
      `${resolve("deploy/Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      process.env.CADDY_TEST_IMAGE ?? "caddy:2.11.7-alpine",
    ],
    { stdio: "ignore" },
  );
  let ready = false;
  let startupError = "not ready";
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null) break;
    try {
      if (get("/health-check").body === "upstream-ok") {
        ready = true;
        break;
      }
    } catch (err) {
      startupError = err instanceof Error ? err.message : "unknown startup error";
    }
    await wait(100);
  }
  assert.ok(ready, `Caddy did not start with deploy/Caddyfile and fake upstream: ${startupError}`);
  for (const path of [
    "/_next/static/app.js.map",
    "/_next/static/app.js.MAP?x=1",
    "/_next/static/app.js%2Emap",
    "/_next%2fstatic/app.js.%6dap",
    "/other.map",
  ]) {
    const result = get(path);
    assert.equal(result.status, 404, path);
    assert.notEqual(result.body, "upstream-ok", path);
  }
  for (const path of ["/_next/static/app.js", "/_next/static/app.js?x=.map", "/assets/map.png"]) {
    const result = get(path);
    assert.equal(result.status, 200, path);
    assert.equal(result.body, "upstream-ok", path);
  }
  console.log("Caddy source map guard: 5 blocked, 3 normal assets forwarded");
} finally {
  cleanup();
}
