// T-502 — rào quét tĩnh về transaction (chạy trong `pnpm test`, không đổi cấu hình cổng/CI):
//   · ARC-INT-003 / DB-TX-003: KHÔNG gọi mạng (fetch/HTTP), object storage, pg-boss (`boss.`), gửi mail BÊN TRONG transaction —
//     tức trong callback `.transaction().execute(...)`, `withTenant(...)`, `withTenantRetry(...)`, handler của `executeCommand(...)`,
//     và thân hàm nhận `CommandContext`/`Transaction<…>` (chạy trong transaction của người gọi). Tác dụng phụ đi qua outbox
//     (ghi cùng transaction, phát sau) hoặc làm TRƯỚC/SAU transaction. Ngoại lệ phải có trong `ALLOWLIST` kèm lý do; số lần khớp
//     phải đúng bằng số khai báo (ratchet hai chiều: thêm vi phạm mới → đỏ; sửa bớt mà quên giảm allowlist → đỏ).
//   · DB-TX-002: mức cô lập `repeatable read`/`serializable` chỉ đặt qua `withTenantRetry` (packages/db/src/tenant.ts), nơi có
//     retry 40001/40P01 — không `setIsolationLevel(`/`ISOLATION LEVEL` ở nơi khác.
//   · Không còn vòng retry tự viết (`2 **` lùi mũ / `attempt <` …) ngoài helper `packages/db/src/retry.ts` (ARC-RES-002).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, type SourceFile, sourceFiles } from "./testing/source-scan.ts";
import { FORBIDDEN, maskCode, scanSource, transactionRegions, type Violation } from "./testing/tx-scan.ts";

/** Mã chạy của sản phẩm (không test/e2e/.d.ts). */
function productFiles(): SourceFile[] {
  const roots = [
    "packages/domain/src",
    "packages/app/src",
    "packages/db/src",
    "apps/worker/src",
    "apps/web/app",
    "apps/web/components",
    "apps/web/lib",
    "apps/web/src",
  ];
  const files = roots.flatMap((r) => {
    try {
      return sourceFiles([r], /\.(ts|tsx)$/);
    } catch {
      return []; // thư mục chưa tồn tại
    }
  });
  files.push(...sourceFiles(["apps/web"], /^proxy\.ts$/).filter((f) => f.path === "apps/web/proxy.ts"));
  return files.filter((f) => !f.path.includes("/e2e/") && !f.path.endsWith(".d.ts"));
}

// ───────────────────────── allowlist ─────────────────────────

/**
 * Ngoại lệ ĐƯỢC DUYỆT, mỗi dòng một lý do. `hits` = số lần khớp hiện có (phải đúng) — thêm vi phạm mới trong cùng file/quy tắc
 * làm đỏ, bớt đi mà không giảm số này cũng đỏ (chỉ được giảm). Mục tiêu là dần về rỗng.
 */
const ALLOWLIST: readonly { file: string; rule: string; hits: number; why: string }[] = [
  {
    file: "packages/app/src/files/files.ts",
    rule: "object-storage",
    hits: 6,
    why: "Đường cũ uploadFile/storeTabularFile/storeGeneratedFile (không có `prepared`): ghi object trong transaction lệnh, có onRollback xoá bù (INV-G7). Đường sản phẩm đã tách prepare/commit ngoài transaction (T-303); đường cũ chỉ còn cho test/gọi trực tiếp — gỡ khi mọi nơi gọi dùng prepare/commit.",
  },
  {
    file: "packages/app/src/files/files.ts",
    rule: "av-scan",
    hits: 2,
    why: "Cùng đường cũ không `prepared` (uploadFile, storeTabularFile): quét clamd trong transaction chỉ khi gọi trực tiếp/test; đường sản phẩm quét ở prepare ngoài transaction (T-303). Gỡ cùng mục object-storage ở trên.",
  },
];

/** Mẫu mã nguồn viết `§{` thay cho `${` (tránh cảnh báo lint chuỗi chứa placeholder). */
const fix = (src: string) => src.replaceAll("§{", `${String.fromCharCode(36)}{`);

describe("tx-guards — bộ quét (kiểm chứng trên mẫu)", () => {
  const scan = (src: string) => scanSource("mau.ts", fix(src)).map((v) => `${v.rule}:${v.region}`);

  it("bắt fetch/storage/boss/mail trong từng loại vùng transaction", () => {
    expect(scan("await withTenant(db, ctx, async (trx) => { await fetch(u); });")).toEqual([
      "net-fetch:withTenant",
    ]);
    expect(
      scan("await withTenantRetry(db, ctx, async (trx) => { await deps.storage.put(k, b, 'x'); });"),
    ).toEqual(["object-storage:withTenantRetry"]);
    expect(scan("await db.transaction().execute(async (trx) => { await boss.send('q', {}); });")).toEqual([
      "queue:transaction().execute",
    ]);
    expect(
      scan(
        "await db.transaction().setIsolationLevel('serializable').execute(async (trx) => { await sender.send(m); });",
      ),
    ).toEqual(["mail:transaction().execute"]);
    expect(scan("await executeCommand(db, a, r, async (ctx) => { await storage.delete(k); });")).toEqual([
      "object-storage:executeCommand",
    ]);
    expect(
      scan(
        "async function f(ctx: CommandContext, d: D): Promise<{ id: string }> { await fetch(x); return { id }; }",
      ),
    ).toEqual(["net-fetch:fn(CommandContext|Transaction)"]);
    expect(scan("const f = async (trx: Transaction<unknown>) => { await sendMail(m); };")).toEqual([
      "mail:fn(CommandContext|Transaction)",
    ]);
    expect(scan("const f = (ctx: CommandContext) => deps.storage.put(k, b, m);")).toEqual([
      "object-storage:fn(CommandContext|Transaction)",
    ]);
    expect(scan("await withTenant(db, c, (trx) => https.request(o));")).toEqual(["net-http:withTenant"]);
    expect(scan("await withTenant(db, c, async () => { await scanOrFail(deps, bytes); });")).toEqual([
      "av-scan:withTenant",
    ]);
  });

  it("KHÔNG báo: gọi ngoài transaction, trong chuỗi/comment, trong SQL template, sau khi transaction đã đóng", () => {
    expect(
      scan(
        "await fetch(u); await withTenant(db, c, async (trx) => { await q(trx); }); await boss.send('q');",
      ),
    ).toEqual([]);
    expect(
      scan(
        "await withTenant(db, c, async (trx) => { // fetch(u)\n /* boss.send() */ const s = 'fetch(x)'; });",
      ),
    ).toEqual([]);
    expect(
      scan(
        "await withTenant(db, c, async (trx) => { await sql`select 'storage.put(x)' as a`.execute(trx); });",
      ),
    ).toEqual([]);
    expect(
      scan("await withTenant(db, c, async (trx) => { await q(trx); });\nawait deps.storage.put(k, b, m);"),
    ).toEqual([]);
    expect(scan("function g(a: string) { return fetch(a); }")).toEqual([]);
    expect(
      scan(
        "const x = signedGetUrl(k); await withTenant(db, c, async (t) => { await t.x(await storage.signedGetUrl(k)); });",
      ),
    ).toEqual([]);
  });

  it("mã trong `§{…}` của template VẪN là mã; chuỗi/regex chứa ngoặc không làm lệch vùng", () => {
    expect(
      scan("await withTenant(db, c, async (t) => { await sql`x §{await fetch(u)} y`.execute(t); });"),
    ).toEqual(["net-fetch:withTenant"]);
    expect(
      scan(
        "await withTenant(db, c, async (t) => { const a = '})'; const r = /[)}]\\/+/; const b = `}§{1}`; });\nawait fetch(u);",
      ),
    ).toEqual([]);
    expect(scan("await withTenant(db, c, async (t) => { const re = /'/; await fetch(u); });")).toEqual([
      "net-fetch:withTenant",
    ]);
  });

  it("vùng lồng nhau không đếm hai lần cùng một lời gọi", () => {
    expect(
      scan(
        "await executeCommand(db, a, r, async (ctx) => { await withTenant(db, c, async (t) => { await fetch(u); }); });",
      ),
    ).toHaveLength(1);
  });

  it("maskCode giữ độ dài/xuống dòng và báo `clean` đúng", () => {
    const src = "a // x\n'b' `c§{d}e` /* f\n g */ h";
    const { masked, clean } = maskCode(fix(src));
    expect(masked).toHaveLength(fix(src).length);
    expect(masked.split("\n")).toHaveLength(fix(src).split("\n").length);
    expect(masked).toContain("d");
    expect(masked).not.toMatch(/[xbcefg]/);
    expect(clean).toBe(true);
    expect(maskCode("const a = `chưa đóng").clean).toBe(false);
  });
});

describe("tx-guards — mã sản phẩm (ARC-INT-003, DB-TX-003)", () => {
  const files = productFiles();

  it("quét được mã nguồn và bộ che không bị lệch ở file nào (trạng thái cuối là mã)", () => {
    expect(files.length).toBeGreaterThan(150);
    const dirty = files.filter((f) => !maskCode(f.text).clean).map((f) => f.path);
    expect(dirty).toEqual([]);
  });

  it("thấy các vùng transaction thật (không quét rỗng) — withTenant, executeCommand, hàm nhận CommandContext", () => {
    const kinds = new Set(
      files.flatMap((f) => transactionRegions(maskCode(f.text).masked).map((r) => r.kind)),
    );
    for (const k of ["withTenant", "withTenantRetry", "executeCommand", "fn(CommandContext|Transaction)"])
      expect(kinds, `thiếu loại vùng ${k}`).toContain(k);
    const total = files.flatMap((f) => transactionRegions(maskCode(f.text).masked)).length;
    expect(total).toBeGreaterThan(100);
  });

  const all = files.flatMap((f) => scanSource(f.path, f.text));

  it("mỗi mục allowlist có lý do thật (≥ 30 ký tự), không trùng khoá, quy tắc hợp lệ", () => {
    const ids = new Set(FORBIDDEN.map((r) => r.id));
    const keys = ALLOWLIST.map((a) => `${a.file}#${a.rule}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of ALLOWLIST) {
      expect(ids, `quy tắc lạ ${a.rule}`).toContain(a.rule);
      expect(a.why.trim().length, `${a.file}#${a.rule} thiếu lý do`).toBeGreaterThanOrEqual(30);
      expect(a.hits).toBeGreaterThan(0);
    }
  });

  it("không có lời gọi mạng/storage/boss/mail trong transaction ngoài allowlist; allowlist khớp đúng số lần", () => {
    const byKey = new Map<string, Violation[]>();
    for (const v of all) byKey.set(`${v.file}#${v.rule}`, [...(byKey.get(`${v.file}#${v.rule}`) ?? []), v]);
    const problems: string[] = [];
    for (const [key, vs] of byKey) {
      const allowed = ALLOWLIST.find((a) => `${a.file}#${a.rule}` === key)?.hits ?? 0;
      if (vs.length > allowed)
        problems.push(
          `${key}: ${vs.length} lần (cho phép ${allowed}) — ${vs.map((v) => `dòng ${v.line} [${v.region}] ${v.text}`).join(" | ")}`,
        );
      if (vs.length < allowed)
        problems.push(`${key}: chỉ còn ${vs.length} lần, allowlist ghi ${allowed} — hãy giảm allowlist`);
    }
    for (const a of ALLOWLIST)
      if (!byKey.has(`${a.file}#${a.rule}`))
        problems.push(`${a.file}#${a.rule}: không còn vi phạm — xoá khỏi allowlist`);
    expect(problems).toEqual([]);
  });
});

describe("tx-guards — mức cô lập và vòng retry tự viết (DB-TX-002, ARC-RES-002)", () => {
  const files = productFiles();
  const HELPER_TENANT = "packages/db/src/tenant.ts";

  it("`setIsolationLevel(` / `ISOLATION LEVEL` chỉ nằm trong packages/db/src/tenant.ts (nơi có retry 40001/40P01)", () => {
    const bad = files
      .filter((f) => f.path !== HELPER_TENANT)
      .filter((f) =>
        /setIsolationLevel\s*\(|\bISOLATION\s+LEVEL\b|\bSERIALIZABLE\b|\bREPEATABLE\s+READ\b/i.test(
          maskCode(f.text).masked,
        ),
      )
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("tenant.ts: mọi `setIsolationLevel(` đi qua runTenantTx, và chỉ `withTenantRetry` truyền mức cô lập", () => {
    const src = maskCode(readFileSync(`${REPO_ROOT}${HELPER_TENANT}`, "utf8")).masked;
    expect(src.match(/setIsolationLevel\s*\(/g)).toHaveLength(1);
    const calls = [...src.matchAll(/runTenantTx\s*\(([^;]*?)\)/g)].map((m) => m[1] as string);
    expect(calls.filter((c) => c.includes("isolationLevel"))).toHaveLength(1);
    expect(src).toMatch(/withTenantRetry[\s\S]*?retryAsync\s*\([\s\S]*?runTenantTx[\s\S]*?isolationLevel/);
  });

  it("không có vòng lùi mũ tự viết (`2 **`, `Math.pow(2`) ngoài helper retry", () => {
    const bad = files
      .filter((f) => f.path !== "packages/db/src/retry.ts")
      .filter((f) => /(?<![\w$])2\s*\*\*\s*[\w(]|Math\.pow\s*\(\s*2\b/.test(maskCode(f.text).masked))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("mọi chỗ bắt SQLSTATE 40001/40P01 nằm ở helper (packages/db/src/retry.ts) — không tự phân loại rải rác", () => {
    const bad = files
      .filter((f) => f.path !== "packages/db/src/retry.ts")
      .filter((f) =>
        /['"]40001['"]|['"]40P01['"]/.test(f.text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      )
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });
});
