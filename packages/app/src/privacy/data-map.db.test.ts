// T-309 (CMP-PRIV-001, STD-PRIV-002, CMP-INTL-002, CMP-VN-004): sổ dữ liệu cá nhân `docs/privacy/data-map.yaml` ↔ catalog CSDL
// thật. Rào theo TÊN cột: cột có tên khớp mẫu PII trong schema public/auth mà chưa khai → ĐỎ; cột jsonb/chữ tự do (memo, note,
// reason, detail, payload…) chưa khai ở entries/not_pii/free_text → ĐỎ; mục khai mà không có trong catalog → ĐỎ. Máy KHÔNG thấy
// cột PII đặt tên lạ hay PII nhét vào cột tự do: phần đó phải rà tay (free_text.risk). Đặt ở packages/app vì gói db không phụ
// thuộc @hm/testkit (testkit phụ thuộc db — tránh vòng).
import { readFileSync } from "node:fs";
import { createTestDb, type TestDb } from "@hm/testkit";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------- YAML tối thiểu (map lồng, list of map, scalar có/không nháy) ----------
type Yaml = string | Yaml[] | { [k: string]: Yaml };
interface Line {
  indent: number;
  text: string;
}

function scalar(v: string): string {
  const t = v.trim();
  if (t.startsWith('"')) return JSON.parse(t) as string;
  return t;
}

function parseYaml(text: string): { [k: string]: Yaml } {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() });
  }
  const at = (i: number): Line => {
    const l = lines[i];
    if (!l) throw new Error("YAML kết thúc bất ngờ");
    return l;
  };
  function block(start: number, indent: number): [Yaml, number] {
    let i = start;
    if (at(i).text.startsWith("- ")) {
      const arr: Yaml[] = [];
      while (i < lines.length && at(i).indent === indent && at(i).text.startsWith("- ")) {
        lines[i] = { indent: indent + 2, text: at(i).text.slice(2).trim() };
        const [v, next] = block(i, indent + 2);
        arr.push(v);
        i = next;
      }
      return [arr, i];
    }
    const obj: { [k: string]: Yaml } = {};
    while (i < lines.length && at(i).indent === indent && !at(i).text.startsWith("- ")) {
      const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(at(i).text);
      if (!m) throw new Error(`dòng YAML không hiểu được: ${at(i).text}`);
      const key = m[1] as string;
      const val = m[2];
      const next = lines[i + 1];
      if (val === undefined || val === "") {
        if (next && next.indent > indent) {
          const [v, after] = block(i + 1, next.indent);
          obj[key] = v;
          i = after;
        } else {
          obj[key] = "";
          i += 1;
        }
      } else {
        obj[key] = scalar(val);
        i += 1;
      }
    }
    return [obj, i];
  }
  const [root] = block(0, at(0).indent);
  return root as { [k: string]: Yaml };
}

describe("parseYaml (tối thiểu)", () => {
  it("map, list of map, nháy kép có dấu hai chấm; bỏ chú thích", () => {
    const y = parseYaml(
      ["# c", "a: 1", "d:", '  k: "x: y"', "l:", "  - t: a", "    c: b", "  - t: c"].join("\n"),
    );
    expect(y).toEqual({ a: "1", d: { k: "x: y" }, l: [{ t: "a", c: "b" }, { t: "c" }] });
  });
});

// ---------- mẫu PII ----------
// Khớp THEO TỪ (tách snake_case/camelCase) thay vì chuỗi con: `ip` không bắt `description`/`membership_id`, `name` không bắt
// `rename`. Mẫu gốc của task: email|phone|full_name|address|doc_number|dob|birth|national|ip|user_agent|name — thêm thông tin
// tài chính cá nhân (account_number/account_name) và bí mật xác thực (password/secret/token/backup_codes) vì cùng thuộc
// phạm vi hồ sơ xử lý; thêm số giấy tờ (id_number/cccd/passport), biển số, ngân hàng, giới tính, mã số thuế, giấy phép.
// Cột kết thúc `_id`/`_ids` (khoá ngoại uuid) không xét theo tên: `bank_transaction_id`, `tax_profile_id` không chứa giá trị người.
const PII_RE =
  /(^|_)(email|phone|full_name|address|doc_number|id_number|cccd|cmnd|passport|plate|bank|gender|tax|license|iban|dob|birth|birthday|national|nationality|ip|user_agent|name|account_number|account_name|password|secret|backup_codes|access_token|refresh_token|id_token|token)(_|$)/;

function snake(column: string): string {
  return column.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function isPiiName(column: string): boolean {
  const c = snake(column);
  return !/_ids?$/.test(c) && PII_RE.test(c);
}

// Cột chữ/jsonb tự do: tên không nói lên nội dung có PII hay không ⇒ buộc khai và rà tay (free_text).
const FREE_TEXT_RE =
  /(^|_)(memo|note|reason|detail|payload|description|title|snapshot|file_key|error|errors|resolution|comment|header|message|body|content)(_|$)/;
function isFreeTextName(column: string): boolean {
  return FREE_TEXT_RE.test(snake(column));
}

describe("mẫu tên cột PII", () => {
  it.each([
    ["email", true],
    ["emailVerified", true],
    ["ipAddress", true],
    ["userAgent", true],
    ["ip_hash", true],
    ["doc_number_enc", true],
    ["full_name", true],
    ["nationality", true],
    ["backupCodes", true],
    ["accessToken", true],
    ["token_hash", true],
    ["name", true],
    ["id_number", true],
    ["idNumber", true],
    ["cccd", true],
    ["passport_no", true],
    ["plate_number", true],
    ["bank_account", true],
    ["gender", true],
    ["tax_code", true],
    ["bank_transaction_id", false],
    ["tax_profile_id", false],
    ["description", false],
    ["membership_id", false],
    ["exif_stripped", false],
    ["recipient_person_id", false],
    ["rename_to", false],
    ["receipt_no", false],
    ["amount", false],
  ])("%s → %s", (column, expected) => {
    expect(isPiiName(column)).toBe(expected);
  });
});

// ---------- data map ----------
interface Entry {
  table: string;
  column: string;
  classification: string;
  purpose: string;
  legal_basis: string;
  legal_basis_status: string;
  retention: string;
  storage: string;
  backup_copy: string;
  processors: string;
  region: string;
}
interface Excluded {
  table: string;
  column: string;
  reason: string;
}
interface FreeText {
  table: string;
  column: string;
  risk: string;
  note: string;
}

const MAP = parseYaml(
  readFileSync(new URL("../../../../docs/privacy/data-map.yaml", import.meta.url), "utf8"),
);
const defaults = (MAP.defaults ?? {}) as Record<string, string>;
const entries = ((MAP.entries ?? []) as Record<string, string>[]).map((e) => ({
  ...defaults,
  ...e,
})) as unknown as Entry[];
const notPii = (MAP.not_pii ?? []) as unknown as Excluded[];
const freeText = (MAP.free_text ?? []) as unknown as FreeText[];
const key = (t: string, c: string) => `${t}.${c}`;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

async function catalog(): Promise<Set<string>> {
  const r = await sql<{ table_schema: string; table_name: string; column_name: string }>`
    select c.table_schema, c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema in ('public', 'auth') and tb.table_type = 'BASE TABLE'
       and c.table_name not in ('kysely_migration', 'kysely_migration_lock')`.execute(t.admin);
  return new Set(r.rows.map((x) => key(`${x.table_schema}.${x.table_name}`, x.column_name)));
}

/** Cột jsonb/json (mọi tên) và cột có tên kiểu "chữ tự do" trong public/auth. */
async function freeTextColumns(): Promise<Set<string>> {
  const r = await sql<{ table_schema: string; table_name: string; column_name: string; data_type: string }>`
    select c.table_schema, c.table_name, c.column_name, c.data_type
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema in ('public', 'auth') and tb.table_type = 'BASE TABLE'
       and c.table_name not in ('kysely_migration', 'kysely_migration_lock')`.execute(t.admin);
  return new Set(
    r.rows
      .filter((x) => x.data_type === "jsonb" || x.data_type === "json" || isFreeTextName(x.column_name))
      .map((x) => key(`${x.table_schema}.${x.table_name}`, x.column_name)),
  );
}

/** Cột tự do chưa khai ở entries/not_pii/free_text. */
function undeclaredFreeText(cols: Set<string>): string[] {
  const declared = new Set([...entries, ...notPii, ...freeText].map((e) => key(e.table, e.column)));
  return [...cols].filter((k) => !declared.has(k)).sort();
}

/** Cột khớp mẫu PII mà chưa khai ở entries/not_pii. */
function undeclared(cols: Set<string>): string[] {
  const declared = new Set([...entries, ...notPii].map((e) => key(e.table, e.column)));
  return [...cols].filter((k) => isPiiName(k.slice(k.lastIndexOf(".") + 1)) && !declared.has(k)).sort();
}

describe("data-map.yaml — cấu trúc", () => {
  it("đánh dấu đề xuất chờ DPIA/pháp lý", () => {
    expect(MAP.status).toMatch(/chờ DPIA/);
    expect(MAP.version).toBe("1");
  });

  it("mỗi mục có đủ trường: phân loại, mục đích, cơ sở pháp lý đề xuất (chờ DPIA), hạn giữ, nơi lưu, bên xử lý, region", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
    for (const e of entries) {
      const id = key(e.table, e.column);
      for (const f of [
        "purpose",
        "legal_basis",
        "retention",
        "storage",
        "backup_copy",
        "processors",
        "region",
      ] as const)
        expect(e[f], `${id}: thiếu ${f}`).toBeTruthy();
      expect(["co_ban", "nhay_cam", "xac_thuc"], `${id}: phân loại`).toContain(e.classification);
      expect(e.legal_basis_status, `${id}: cơ sở pháp lý phải đánh dấu chờ DPIA`).toMatch(/chờ DPIA/);
      expect(e.legal_basis, `${id}: cơ sở pháp lý phải ghi là đề xuất`).toMatch(/đề xuất/);
      expect(e.region, `${id}: region`).toMatch(/VN/);
    }
  });

  it("không trùng khoá; không vừa khai vừa loại trừ; loại trừ có lý do", () => {
    const keys = entries.map((e) => key(e.table, e.column));
    expect(new Set(keys).size).toBe(keys.length);
    for (const x of notPii) {
      expect(x.reason.length, `${key(x.table, x.column)}: thiếu lý do`).toBeGreaterThan(10);
      expect(keys).not.toContain(key(x.table, x.column));
    }
  });

  it("free_text: risk hợp lệ, có ghi chú, không trùng entries/not_pii", () => {
    expect(freeText.length).toBeGreaterThanOrEqual(40);
    const other = new Set([...entries, ...notPii].map((e) => key(e.table, e.column)));
    const seen = new Set<string>();
    for (const f of freeText) {
      const id = key(f.table, f.column);
      expect(["co_the_chua_pii", "khong_pii"], `${id}: risk`).toContain(f.risk);
      expect(f.note.length, `${id}: thiếu ghi chú`).toBeGreaterThan(10);
      expect(other.has(id), `${id}: vừa ở free_text vừa ở entries/not_pii`).toBe(false);
      expect(seen.has(id), `${id}: trùng`).toBe(false);
      seen.add(id);
    }
    // sáu cột tự do đã biết là có thể chứa PII phải được rà (không được hạ xuống khong_pii)
    for (const [tb, col] of [
      ["public.approval_requests", "payload"],
      ["public.journal_entries", "memo"],
      ["public.invoices", "memo_ref"],
      ["public.lease_versions", "terms_snapshot"],
      ["public.reconciliation_breaks", "detail"],
      ["public.export_jobs", "file_key"],
    ] as const)
      expect(freeText.find((f) => f.table === tb && f.column === col)?.risk, key(tb, col)).toBe(
        "co_the_chua_pii",
      );
  });

  it("giấy tờ nhận dạng xếp nhạy cảm; bí mật xác thực xếp xac_thuc", () => {
    for (const e of entries.filter(
      (x) => x.table === "public.identity_documents" && /doc_number_(enc|hash|last4)/.test(x.column),
    ))
      expect(e.classification, key(e.table, e.column)).toBe("nhay_cam");
    for (const e of entries.filter((x) => /password|backupCodes|secret|token_hash/.test(x.column)))
      expect(e.classification, key(e.table, e.column)).toBe("xac_thuc");
  });
});

describe("data-map.yaml ↔ catalog CSDL (sau migrate)", () => {
  it("mọi mục khai (entries, not_pii) tồn tại thật trong catalog", async () => {
    const cols = await catalog();
    const missing = [...entries, ...notPii, ...freeText]
      .map((e) => key(e.table, e.column))
      .filter((k) => !cols.has(k));
    expect(missing, `mục không có trong catalog (đổi tên/xoá cột?): ${missing.join(", ")}`).toEqual([]);
  });

  it("mọi cột có tên khớp mẫu PII trong public/auth đều được khai (hoặc loại trừ có lý do)", async () => {
    const cols = await catalog();
    const missing = undeclared(cols);
    expect(missing, `cột PII chưa khai trong docs/privacy/data-map.yaml: ${missing.join(", ")}`).toEqual([]);
    // chống mẫu hỏng thành "xanh rỗng": phải thật sự thấy các cột lõi
    const matched = [...cols].filter((k) => isPiiName(k.slice(k.lastIndexOf(".") + 1)));
    for (const k of [
      "public.persons.full_name",
      "public.persons.phone",
      "public.persons.email",
      "auth.user.email",
      "auth.session.ipAddress",
    ])
      expect(matched).toContain(k);
    expect(matched.length).toBeGreaterThanOrEqual(35);
  });

  it("mọi cột jsonb và cột chữ tự do đều được khai (entries, not_pii hoặc free_text)", async () => {
    const missing = undeclaredFreeText(await freeTextColumns());
    expect(missing, `cột tự do chưa rà trong docs/privacy/data-map.yaml: ${missing.join(", ")}`).toEqual([]);
  });

  it("cột PII mới chưa khai → bị phát hiện (đỏ); khai xong thì hết", async () => {
    await sql`alter table persons add column phone_backup text, add column dob date`.execute(t.admin);
    try {
      expect(undeclared(await catalog())).toEqual(["public.persons.dob", "public.persons.phone_backup"]);
    } finally {
      await sql`alter table persons drop column phone_backup, drop column dob`.execute(t.admin);
    }
    expect(undeclared(await catalog())).toEqual([]);
  });

  it("ca âm: thêm cột id_number / bank_account / plate_number / gender / tax_code → đỏ; cột tự do mới (staff_note, extra jsonb) chưa rà → đỏ", async () => {
    await sql`alter table persons add column id_number text, add column bank_account text, add column plate_number text,
      add column gender text, add column tax_code text, add column staff_note text, add column extra jsonb`.execute(
      t.admin,
    );
    try {
      expect(undeclared(await catalog())).toEqual([
        "public.persons.bank_account",
        "public.persons.gender",
        "public.persons.id_number",
        "public.persons.plate_number",
        "public.persons.tax_code",
      ]);
      expect(undeclaredFreeText(await freeTextColumns())).toEqual([
        "public.persons.extra",
        "public.persons.staff_note",
      ]);
    } finally {
      await sql`alter table persons drop column id_number, drop column bank_account, drop column plate_number,
        drop column gender, drop column tax_code, drop column staff_note, drop column extra`.execute(t.admin);
    }
    expect(undeclared(await catalog())).toEqual([]);
    expect(undeclaredFreeText(await freeTextColumns())).toEqual([]);
  });
});
