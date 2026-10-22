// Khoá `attack`/`perf` của xt.yaml (release-check của khung chạy trước phát hành; exit ≠ 0 = NO-GO) trỏ vào scripts/dast.sh và
// scripts/perf-load.sh — CI (security-scan.yml job `dast`, perf-nightly.yml job `k6`) gọi NGUYÊN VĂN cùng lệnh. Kiểm hành vi
// các bước chặn sớm (trước build/khởi động app): đầu vào sai → exit 2, cổng bận/khoá bởi lượt khác → exit 1, đích lạ → chặn.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const SCRIPTS = ["scripts/dast.sh", "scripts/perf-load.sh", "scripts/lib-e2e-app.sh"];

const xt = Object.fromEntries(
  read("xt.yaml")
    .split("\n")
    .map((l) => /^([a-z0-9_]+):\s*"?(.*?)"?\s*(?:#.*)?$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

/** Cổng TCP trống (cùng cổng+1 trống) trên 127.0.0.1. */
async function freePortPair() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    if (port < 65000) return port;
  }
}

/** Server TCP giả nghe ở cổng cho trước; trả hàm đóng. */
function listen(port) {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => c.end());
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(() => new Promise((r) => s.close(r))));
  });
}

describe("xt.yaml attack/perf ↔ CI: một lệnh, gọi nguyên văn", () => {
  it("attack/perf là lệnh thật (không no-op), trỏ tới script có trong repo", () => {
    expect(xt.attack).toBe("bash scripts/dast.sh");
    expect(xt.perf).toBe("bash scripts/perf-load.sh");
    for (const f of SCRIPTS) expect(existsSync(join(ROOT, f)), f).toBe(true);
    expect(xt.delivery_phase).toBe("build");
  });

  it("job dast và job k6 chạy đúng lệnh của xt.yaml; điều kiện chạy (if:) của job dast giữ nguyên (D-085)", () => {
    const sec = read(".github/workflows/security-scan.yml");
    const perf = read(".github/workflows/perf-nightly.yml");
    expect(sec).toContain(`run: ${xt.attack}\n`);
    expect(perf).toContain(`run: ${xt.perf}\n`);
    expect(sec.match(/^ {4}if: github\.event_name == 'workflow_dispatch'$/gm)).toHaveLength(2);
  });

  it.each(SCRIPTS)("%s: cú pháp bash hợp lệ, set -euo pipefail ở script chạy", (f) => {
    expect(spawnSync("bash", ["-n", join(ROOT, f)]).status).toBe(0);
    if (!f.includes("lib-")) expect(read(f)).toMatch(/^set -euo pipefail$/m);
  });

  it("kết quả mặc định ra `mktemp -d`, không ghi vào cây git", () => {
    expect(read("scripts/lib-e2e-app.sh")).toMatch(/mktemp -d "\$\{TMPDIR:-\/tmp\}\/hm-\$\{hm_tag\}-XXXXXX"/);
    expect(read("scripts/dast.sh")).toMatch(/OUT="\$\(hm_out_dir "\$\{DAST_OUT:-\}"\)"/);
    expect(read("scripts/perf-load.sh")).toMatch(/OUT="\$\(hm_out_dir "\$\{PERF_OUT:-\}"\)"/);
  });
});

describe("dast.sh / perf-load.sh — chặn sớm trước build/khởi động", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hm-attack-perf-test-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** Chạy script với môi trường tối thiểu, từ thư mục khác gốc repo (script phải tự tìm gốc). */
  const run = (script, env) =>
    spawnSync("bash", [join(ROOT, script)], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: tmp,
        DAST_SKIP_BUILD: "1",
        PERF_SKIP_BUILD: "1",
        ...env,
      },
    });

  it.each([["scripts/dast.sh"], ["scripts/perf-load.sh"]])("%s: E2E_PORT sai → exit 2", (script) => {
    for (const port of ["abc", "80", "3100; rm -rf /", "70000", "-1"]) {
      const r = run(script, { E2E_PORT: port });
      expect(r.status, `E2E_PORT=${port}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/E2E_PORT phải là số cổng/);
    }
  });

  it("dast.sh: ZAP_IMAGE không ghim digest → exit 2 (bị từ chối); bản ghim mặc định qua được bước kiểm", async () => {
    const port = await freePortPair();
    for (const img of ["ghcr.io/zaproxy/zaproxy:latest", "ghcr.io/zaproxy/zaproxy:2.17.0@sha256:abc"]) {
      const r = run("scripts/dast.sh", { E2E_PORT: String(port), ZAP_IMAGE: img });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/ZAP_IMAGE phải ghim digest/);
    }
    // Được phép: bản ghim mặc định qua bước kiểm ảnh, dừng ở bước sau (cổng bận) — không phải lỗi ZAP_IMAGE.
    const close = await listen(port);
    try {
      const r = run("scripts/dast.sh", { E2E_PORT: String(port) });
      expect(r.status).toBe(1);
      expect(r.stderr).not.toMatch(/ZAP_IMAGE/);
    } finally {
      await close();
    }
  });

  it.each([
    ["scripts/dast.sh", "DAST_OUT"],
    ["scripts/perf-load.sh", "PERF_OUT"],
  ])(
    "%s: đã có server lạ nghe ở cổng → exit 1, không tạo thư mục kết quả, không quét/tải vào nó",
    async (script, outVar) => {
      const port = await freePortPair();
      const close = await listen(port);
      try {
        const out = join(tmp, "out");
        const r = run(script, { E2E_PORT: String(port), [outVar]: out });
        expect(r.status, r.stderr).toBe(1);
        expect(r.stderr).toMatch(new RegExp(`đã có tiến trình nghe ở 127\\.0\\.0\\.1:${port}`));
        expect(existsSync(out)).toBe(false);
      } finally {
        await close();
      }
    },
  );

  it("dast.sh: bản sao (cổng+1) bận cũng chặn — server.ts mở hai cổng khi không đặt E2E_NO_REPLICA", async () => {
    const port = await freePortPair();
    const close = await listen(port + 1);
    try {
      const r = run("scripts/dast.sh", { E2E_PORT: String(port) });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`127\\.0\\.0\\.1:${port + 1}`));
    } finally {
      await close();
    }
  });

  it.each([["scripts/dast.sh"], ["scripts/perf-load.sh"]])(
    "%s: đồng thời — lượt khác đang giữ khoá cùng cổng → exit 1 ngay (không đo/quét nhầm server của nhau)",
    async (script) => {
      const port = await freePortPair();
      const lock = join(tmp, `hm-e2e-${port}.lock`);
      const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore" });
      try {
        for (let i = 0; i < 50 && !existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 100));
        const r = run(script, { E2E_PORT: String(port) });
        expect(r.status, r.stderr).toBe(1);
        expect(r.stderr).toMatch(/đang được một lượt dast\/perf khác dùng/);
      } finally {
        holder.kill("SIGKILL");
      }
    },
  );

  it("perf-load.sh: BASE_URL khác app tạm của script → exit 2 (bị từ chối); bằng đích của script → qua (được phép)", async () => {
    const port = await freePortPair();
    for (const url of ["https://hotel.example.vn", `http://127.0.0.1:${port + 7}`]) {
      const r = run("scripts/perf-load.sh", { E2E_PORT: String(port), BASE_URL: url });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/chỉ tải vào app tạm/);
    }
    const close = await listen(port);
    try {
      const r = run("scripts/perf-load.sh", {
        E2E_PORT: String(port),
        BASE_URL: `http://127.0.0.1:${port}/`,
      });
      expect(r.stdout).toMatch(/đích an toàn/);
      expect(r.status).toBe(1); // dừng ở bước cổng bận, sau bước chặn đích
    } finally {
      await close();
    }
  });

  it("perf-load.sh: K6_ALLOWED_HOSTS có host production → k6-target-guard chặn (exit 1)", async () => {
    const port = await freePortPair();
    const r = run("scripts/perf-load.sh", {
      E2E_PORT: String(port),
      K6_ALLOWED_HOSTS: "127.0.0.1,hotel.example.vn",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/không phải loopback\/staging: hotel\.example\.vn/);
  });

  it("perf-load.sh: LOAD_VUS/LOAD_DURATION sai → exit 2", async () => {
    const port = await freePortPair();
    for (const env of [
      { LOAD_VUS: "0" },
      { LOAD_VUS: "-5" },
      { LOAD_DURATION: "3" },
      { LOAD_DURATION: "1m;true" },
    ]) {
      const r = run("scripts/perf-load.sh", { E2E_PORT: String(port), ...env });
      expect(r.status, JSON.stringify(env)).toBe(2);
    }
  });

  it("chặn sớm không để lại khoá/thư mục tạm nào ngoài file khoá", async () => {
    const port = await freePortPair();
    const close = await listen(port);
    try {
      run("scripts/perf-load.sh", { E2E_PORT: String(port) });
      run("scripts/dast.sh", { E2E_PORT: String(port) });
    } finally {
      await close();
    }
    expect(readdirSync(tmp).filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });
});
