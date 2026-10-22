// Khoá `attack`/`perf` của xt.yaml (release-check của khung chạy trước phát hành; exit ≠ 0 = NO-GO) trỏ vào scripts/dast.sh và
// scripts/perf-load.sh — CI (security-scan.yml job `dast`, perf-nightly.yml job `k6`) gọi NGUYÊN VĂN cùng lệnh. Kiểm hành vi
// các bước chặn sớm (trước build/khởi động app): đầu vào sai → exit 2, cổng bận/khoá bởi lượt khác → exit 1, đích lạ → chặn;
// và chạy trọn với app/k6/docker giả trên PATH: mã thoát, dọn nhóm tiến trình, dọn tàn dư của lượt bị SIGKILL.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    expect(readdirSync(tmp).filter((n) => !/\.(lock|run)$/.test(n))).toEqual([]);
  });
});

/** Trạng thái tiến trình từ /proc/<pid>/stat (sau tên lệnh trong ngoặc): [trạng thái, ppid, pgid, …]; null khi không còn. */
function procStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** Tiến trình còn sống (zombie chờ init thu dọn tính là đã chết)? */
const alive = (pid) => {
  const f = procStat(pid);
  return f !== null && f[0] !== "Z";
};

/** Còn thành viên nào (không phải zombie) trong nhóm tiến trình `pgid`? */
const groupAlive = (pgid) =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .some((n) => {
      const f = procStat(n);
      return f !== null && f[0] !== "Z" && Number(f[2]) === pgid;
    });

const waitFor = async (cond, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

// Đọc /proc, setsid, flock: chỉ Linux (CI ubuntu, môi trường dev); nơi khác bỏ qua thay vì đỏ giả (review #119).
describe.skipIf(!existsSync("/proc/self/environ"))(
  "dast.sh / perf-load.sh với app/k6/docker giả trên PATH — mã thoát và dọn tiến trình",
  () => {
    let tmp;
    let port;
    const pidOf = (name) => Number(readFileSync(join(tmp, `${name}.pid`), "utf8"));
    const stub = (name, body) => {
      const f = join(tmp, "bin", name);
      writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(f, 0o755);
    };

    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), "hm-attack-perf-stub-"));
      port = await freePortPair();
      mkdirSync(join(tmp, "bin"));
      // node: e2e/server.ts → app giả; perf-session-env.ts → phiên giả; còn lại → node thật (guard, quét PII, zap-gate).
      stub(
        "node",
        [
          'case " $* " in',
          '  *" e2e/server.ts "*) exec bash "$STUB_DIR/server.sh" ;;',
          "  *\" e2e/perf-session-env.ts \"*) printf 'K6_COOKIE=hm=gia\\nORG_ID=o\\nPROPERTY_ID=p\\nUNIT_IDS=u\\n'; exit 0 ;;",
          "esac",
          'exec "$REAL_NODE" "$@"',
        ].join("\n"),
      );
      // App giả: một tiến trình con cùng nhóm (như `next start`), log cho bộ quét PII; STUB_APP=die → chết ngay, con còn sống.
      writeFileSync(
        join(tmp, "server.sh"),
        [
          'echo $$ > "$STUB_DIR/server.pid"',
          `mkdir -p e2e-logs && echo '{"service":"web","msg":"server giả"}' > "e2e-logs/server-$E2E_PORT.log"`,
          'sleep 300 & echo $! > "$STUB_DIR/child.pid"',
          '[ "$STUB_APP" = die ] && exit 3',
          'touch "$STUB_DIR/ready"',
          "trap 'exit 0' TERM",
          "while :; do sleep 1; done",
        ].join("\n"),
      );
      stub("curl", '[ -f "$STUB_DIR/ready" ]');
      stub(
        "k6",
        [
          '[ "$1" = version ] && { echo "k6 giả"; exit 0; }',
          'echo $$ > "$STUB_DIR/k6.pid"',
          'case "$STUB_K6" in fail) exit 99 ;; hang) exec sleep 300 ;; esac',
          "exit 0",
        ].join("\n"),
      );
      stub("docker", "exit 0");
    });

    afterEach(() => {
      for (const n of ["server", "child", "k6"])
        if (existsSync(join(tmp, `${n}.pid`)) && alive(pidOf(n))) process.kill(pidOf(n), "SIGKILL");
      rmSync(join(ROOT, `apps/web/e2e-logs/server-${port}.log`), { force: true });
      rmSync(tmp, { recursive: true, force: true });
    });

    const env = (extra) => ({
      PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
      HOME: process.env.HOME,
      TMPDIR: tmp,
      STUB_DIR: tmp,
      REAL_NODE: process.execPath,
      E2E_PORT: String(port),
      DAST_SKIP_BUILD: "1",
      PERF_SKIP_BUILD: "1",
      ...extra,
    });
    const run = (script, extra) =>
      spawnSync("bash", [join(ROOT, script)], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 60_000,
        env: env(extra),
      });

    it.each([["scripts/dast.sh"], ["scripts/perf-load.sh"]])(
      "%s: app chết trước khi sẵn sàng → exit 1; cả nhóm tiến trình của app (con còn sót) bị dọn",
      (script) => {
        const r = run(script, { STUB_APP: "die" });
        expect(r.status, r.stderr).toBe(1);
        expect(r.stderr).toMatch(/app thoát trước khi sẵn sàng/);
        expect(groupAlive(pidOf("server"))).toBe(false);
        expect(alive(pidOf("child"))).toBe(false);
      },
      60_000,
    );

    it("perf-load.sh: k6 thoát 99 (vượt thresholds) → script exit 99, quét PII vẫn chạy, nhóm app đã dừng", () => {
      const r = run("scripts/perf-load.sh", { STUB_K6: "fail" });
      expect(r.status, r.stderr).toBe(99);
      expect(r.stdout).toMatch(/\[pii-log-scan\] 1 tệp · 0 phát hiện/);
      expect(r.stderr).toMatch(/k6 đỏ \(exit 99/);
      expect(groupAlive(pidOf("server"))).toBe(false);
    }, 60_000);

    it("perf-load.sh: k6 xanh → exit 0, nhóm app đã dừng (được phép)", () => {
      const r = run("scripts/perf-load.sh", {});
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/✓ kiểm tải xanh/);
      expect(groupAlive(pidOf("server"))).toBe(false);
    }, 60_000);

    it("lượt trước bị SIGKILL (hết trần release-check): con không giữ khoá cổng; lượt sau dọn app + k6 còn sót rồi chạy xanh", async () => {
      const first = spawn("bash", [join(ROOT, "scripts/perf-load.sh")], {
        cwd: tmp,
        stdio: "ignore",
        env: env({ STUB_K6: "hang" }),
      });
      expect(await waitFor(() => existsSync(join(tmp, "k6.pid")) && alive(pidOf("k6")))).toBe(true);
      first.kill("SIGKILL"); // như subprocess.run(timeout=…) — trap EXIT không chạy
      await waitFor(() => first.exitCode !== null || first.signalCode !== null);
      const old = { server: pidOf("server"), child: pidOf("child"), k6: pidOf("k6") };
      // Tàn dư thật sự còn đó (tái hiện lỗi rò)…
      expect(alive(old.server) && alive(old.child) && alive(old.k6)).toBe(true);
      // …lượt sau không bị "cổng đang được một lượt khác dùng", dọn sạch rồi chạy xanh.
      rmSync(join(tmp, "ready"), { force: true });
      const r = run("scripts/perf-load.sh", {});
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/dọn tàn dư của lượt trước bị dừng ngang/);
      for (const [name, pid] of Object.entries(old)) expect(alive(pid), name).toBe(false);
    }, 90_000);

    it("không chạm tiến trình của lượt khác: dấu id khác không bị dọn", async () => {
      const bystander = spawn("sleep", ["300"], {
        stdio: "ignore",
        env: { PATH: process.env.PATH, HM_E2E_RUN_ID: "deadbeefdeadbeef" },
      });
      writeFileSync(join(tmp, `hm-e2e-${port}.run`), "0123456789abcdef\n");
      try {
        const r = run("scripts/perf-load.sh", {});
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).not.toMatch(/dọn tàn dư/);
        expect(alive(bystander.pid)).toBe(true);
      } finally {
        bystander.kill("SIGKILL");
      }
    }, 60_000);
  },
);
