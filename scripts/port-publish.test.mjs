// BASE-SEC-010 (T-2627): Docker không mở lại cổng mã đã đóng. Lint đảo chiều — bắt MỌI publish (compose `ports:` dạng chuỗi lẫn
// dạng dài, `docker run -p/--publish/-P` trong tài liệu) rồi chỉ cho qua publish loopback; ngoại lệ là cổng vào công khai có chủ đích
// (Caddy 80/443 — reverse proxy TLS duy nhất ra Internet), ghi lý do ở PUBLIC_INGRESS. Chỉ xét tệp do dự án quản (git ls-files),
// bỏ thư viện khung `.xtemplates/` (ví dụ minh hoạ) và BLUEPRINT.md (trích lệnh kiểm).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;

/** Cổng công khai có chủ đích: `service:port[/proto]` → lý do. */
const PUBLIC_INGRESS = {
  "deploy/compose.yaml#caddy:80/tcp": "HTTP chỉ để chuyển hướng sang HTTPS (Caddy), không phục vụ nội dung",
  "deploy/compose.yaml#caddy:443/tcp": "HTTPS — cổng vào duy nhất của ứng dụng, TLS ở Caddy",
  "deploy/compose.yaml#caddy:443/udp": "HTTP/3 (QUIC) của cùng cổng vào HTTPS",
};

/** Các publish của một service compose: [{ host_ip, published, target, protocol }] — chuẩn hoá dạng ngắn và dạng dài. */
function composePublishes(ports) {
  const out = [];
  for (const p of ports ?? []) {
    if (typeof p === "object" && p !== null) {
      out.push({
        hostIp: p.host_ip ?? "",
        published: p.published === undefined ? "" : String(p.published),
        target: String(p.target),
        protocol: p.protocol ?? "tcp",
      });
      continue;
    }
    const raw = String(p);
    const [spec, proto = "tcp"] = raw.split("/");
    // [IP:]published:target | target (Docker chọn cổng ngẫu nhiên trên MỌI interface)
    const m = /^(?:(\[[^\]]+\]|[^:]+):)?(?:([0-9-]*):)?([0-9-]+)$/.exec(spec);
    if (!m) throw new Error(`không đọc được ports: ${raw}`);
    const [, a, b, target] = m;
    const hostIp = b === undefined ? "" : (a ?? "");
    const published = b === undefined ? (a ?? "") : b;
    out.push({ hostIp, published, target, protocol: proto });
  }
  return out;
}

/** Đối số publish của `docker|podman run` trong một khối Markdown (kể cả nối dòng `\`). Trả về các đối số KHÔNG loopback. */
function dockerRunPublishes(md) {
  const bad = [];
  const joined = md.replace(/\\\n/g, " ");
  for (const line of joined.split("\n")) {
    if (!/\b(docker( container)?|podman) run\b/.test(line)) continue;
    const args = line.split(/\s+/);
    for (let i = 0; i < args.length; i++) {
      const a = args[i].replace(/^['"`]|['"`]$/g, "");
      // Đối số publish là ánh xạ cổng (có chữ số) như lệnh kiểm của blueprint — chữ mô tả "-p/-P" không phải lệnh.
      const mapping = (v) => /^[[\]0-9a-z.:-]*[0-9][[\]0-9a-z.:/-]*$/i.test(v);
      if (a === "-P" || a === "--publish-all") bad.push(a);
      else if (a === "-p" || a === "--publish") {
        const v = (args[i + 1] ?? "").replace(/^['"`]|['"`]$/g, "");
        if (mapping(v) && !/^(127\.0\.0\.1|localhost|\[::1\]):/.test(v)) bad.push(`${a} ${v}`);
      } else if (/^(-p|--publish=)/.test(a) && a.length > 2) {
        const v = a.replace(/^(-p=?|--publish=)/, "");
        if (mapping(v) && !/^(127\.0\.0\.1|localhost|\[::1\]):/.test(v)) bad.push(a);
      }
    }
  }
  return bad;
}

const tracked = (glob) =>
  execFileSync("git", ["ls-files", "--", glob], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.startsWith(".xtemplates/") && f !== "BLUEPRINT.md");

describe("BASE-SEC-010 — publish cổng chỉ loopback, trừ cổng vào công khai có lý do", () => {
  it("mọi compose của repo: publish không loopback phải nằm trong PUBLIC_INGRESS (có lý do), và ngoại lệ không mồ côi", () => {
    const files = [...tracked("*compose*.yml"), ...tracked("*compose*.yaml")];
    expect(files.length).toBeGreaterThan(0);
    const seen = new Set();
    const bad = [];
    for (const file of files) {
      const doc = parse(readFileSync(join(ROOT, file), "utf8")) ?? {};
      for (const [name, svc] of Object.entries(doc.services ?? {})) {
        for (const p of composePublishes(svc?.ports)) {
          if (LOOPBACK.test(p.hostIp)) continue;
          const key = `${file}#${name}:${p.target}/${p.protocol}`;
          if (Object.hasOwn(PUBLIC_INGRESS, key)) seen.add(key);
          else bad.push(`${key} (host_ip="${p.hostIp}")`);
        }
      }
    }
    expect(bad, "publish ra mọi interface: dùng 127.0.0.1:P:P hoặc thêm PUBLIC_INGRESS kèm lý do").toEqual(
      [],
    );
    expect(
      Object.keys(PUBLIC_INGRESS).filter((k) => !seen.has(k)),
      "ngoại lệ mồ côi",
    ).toEqual([]);
    for (const why of Object.values(PUBLIC_INGRESS)) expect(why.length).toBeGreaterThan(20);
  });

  it("tài liệu của dự án không hướng dẫn `docker run -p` ra mọi interface", () => {
    const bad = [];
    for (const file of tracked("*.md"))
      for (const b of dockerRunPublishes(readFileSync(join(ROOT, file), "utf8"))) bad.push(`${file}: ${b}`);
    expect(bad).toEqual([]);
  });

  it("bộ dò bắt đủ dạng (không rỗng nghĩa): ngắn, dài, chỉ target, IPv6, docker run nối dòng, -P", () => {
    expect(composePublishes(["5432:5432", "127.0.0.1:6379:6379", "8080", "[::1]:9000:9000/udp"])).toEqual([
      { hostIp: "", published: "5432", target: "5432", protocol: "tcp" },
      { hostIp: "127.0.0.1", published: "6379", target: "6379", protocol: "tcp" },
      { hostIp: "", published: "", target: "8080", protocol: "tcp" },
      { hostIp: "[::1]", published: "9000", target: "9000", protocol: "udp" },
    ]);
    expect(composePublishes([{ target: 5432, published: 5432 }])[0]).toMatchObject({
      hostIp: "",
      target: "5432",
    });
    expect(composePublishes([{ target: 5432, published: 5432, host_ip: "127.0.0.1" }])[0].hostIp).toBe(
      "127.0.0.1",
    );
    expect(dockerRunPublishes("docker run --rm \\\n  -p 5432:5432 postgres")).toEqual(["-p 5432:5432"]);
    expect(dockerRunPublishes("docker run -p 127.0.0.1:5432:5432 -p=8080:80 -P x")).toEqual([
      "-p=8080:80",
      "-P",
    ]);
    expect(dockerRunPublishes("podman run --publish=0.0.0.0:80:80 x")).toEqual(["--publish=0.0.0.0:80:80"]);
    expect(dockerRunPublishes("docker run -p localhost:3000:3000 x")).toEqual([]);
    // Văn mô tả nhắc "docker run -p/-P" không phải lệnh publish.
    expect(dockerRunPublishes("lint `docker run -p/-P` trong tài liệu")).toEqual([]);
    expect(dockerRunPublishes("`docker run -p 8080:80 nginx`")).toEqual(["-p 8080:80"]);
  });

  it("địa chỉ bind ghi trong SECURITY.md khớp mã: dev/start 127.0.0.1; container 0.0.0.0 chỉ trên mạng nội bộ, không publish", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "apps/web/package.json"), "utf8"));
    for (const s of ["dev", "start"]) expect(pkg.scripts[s], s).toMatch(/-H \$\{HOST:-127\.0\.0\.1\}/);
    expect(readFileSync(join(ROOT, "deploy/web.Dockerfile"), "utf8")).toMatch(/HOSTNAME=0\.0\.0\.0/);
    const compose = parse(readFileSync(join(ROOT, "deploy/compose.yaml"), "utf8"));
    expect(compose.networks?.backend?.internal).toBe(true);
    for (const svc of ["web", "worker", "postgres", "seaweedfs"]) {
      expect(compose.services[svc], svc).toBeDefined();
      expect(compose.services[svc].ports, `${svc} không publish cổng`).toBeUndefined();
    }
    const sec = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
    for (const claim of [
      "127.0.0.1",
      "HOSTNAME=0.0.0.0",
      "internal: true",
      "443/udp",
      "scripts/port-publish.test.mjs",
    ])
      expect(sec, claim).toContain(claim);
  });
});
