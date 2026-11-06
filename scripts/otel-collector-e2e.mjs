// Chạy THẬT Collector contrib với deploy/otel/collector.yaml trên file log kiểu Docker json-file (OPS-OBS-001):
// log JSON hợp lệ → Resource service.name/version/deployment.environment + severity + body; dòng rác/JSON hỏng → vẫn được lưu
// với thuộc tính `unparsed`; truy vấn theo service.name trả đúng. Dùng: `node scripts/otel-collector-e2e.mjs` (cần `otelcol-contrib`
// trong PATH hoặc biến OTELCOL_BIN; cài bằng `bash scripts/ops-tools.sh install otelcol-contrib`). CI: job `otel-collector`.
// OPS-OBS-008: canary email/SĐT/CCCD/token/mật khẩu đi qua resource, attributes (kể cả object lồng) và body của dòng đã parse lẫn
// dòng không parse được; kiểm trên dữ liệu exporter THỰC NHẬN (không chỉ đọc cấu hình) rằng không giá trị canary nào lọt ra.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Giá trị AnyValue của OTLP/JSON → giá trị JS. */
function anyValue(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("boolValue" in v) return v.boolValue;
  if ("doubleValue" in v) return v.doubleValue;
  return v;
}
const attrMap = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, anyValue(a.value)]));

/** Các dòng JSONL của file exporter → danh sách bản ghi phẳng {resource, attributes, body, severityNumber, traceId, spanId, time}. */
export function flattenRecords(jsonl) {
  const out = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    for (const rl of doc.resourceLogs ?? []) {
      const resource = attrMap(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          out.push({
            resource,
            attributes: attrMap(lr.attributes),
            body: anyValue(lr.body),
            severityNumber: lr.severityNumber,
            traceId: lr.traceId ?? "",
            spanId: lr.spanId ?? "",
            time: lr.timeUnixNano ? BigInt(lr.timeUnixNano) : 0n,
          });
        }
      }
    }
  }
  return out;
}

/** Truy vấn theo `service.name` (tương đương lọc theo Resource ở backend log). */
export const queryByService = (records, name) => records.filter((r) => r.resource["service.name"] === name);

const line = (obj) =>
  `${JSON.stringify({ log: `${obj}\n`, stream: "stdout", time: "2026-10-18T01:02:03.456789012Z" })}\n`;
const app = (o) => line(JSON.stringify(o));

/** Giá trị canary (giả, không phải dữ liệu thật) — không được xuất hiện nguyên văn ở exporter. */
export const CANARY = {
  email: "canary.pii@example.com",
  phone: "0912345678",
  idNumber: "001203004567",
  bearer: "cnryTOKEN0123456789abcdef",
  password: "S3cr3t-canary-pw",
  accessKey: "AKIACANARYKEY0001",
  dsnPassword: "Canary-Db-Pw",
};

/** Mẫu input: 4 dòng hợp lệ của 2 dịch vụ + 3 dòng không parse được (rác, JSON cụt, `{` mở không đóng). */
export function sampleDockerLog() {
  return [
    app({
      ts: "2026-10-18T01:02:03.123Z",
      level: "info",
      severity_number: 9,
      service: "hm-web",
      version: "1.2.3",
      env: "staging",
      msg: "thanh toán đã ghi",
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      span_id: "b7ad6b7169203331",
    }),
    app({
      ts: "2026-10-18T01:02:04.000Z",
      level: "error",
      severity_number: 17,
      service: "hm-web",
      version: "1.2.3",
      env: "staging",
      msg: "lỗi CSDL",
    }),
    app({
      ts: "2026-10-18T01:02:05.500Z",
      level: "warn",
      severity_number: 13,
      service: "hm-worker",
      version: "1.2.3",
      env: "staging",
      msg: "outbox chậm",
    }),
    app({
      ts: "2026-10-18T01:02:06.000Z",
      level: "debug",
      severity_number: 5,
      service: "hm-worker",
      version: "1.2.3",
      env: "staging",
      msg: "nhịp worker",
    }),
    line("Segmentation noise ### không phải JSON"),
    line('{"ts":"2026-10-18T01:02:07.000Z","service":"hm-web","msg":"cụt'),
    line("{"),
    ...canaryLines(),
  ].join("");
}

/** 3 dòng canary OPS-OBS-008: 2 dòng parse được (dịch vụ hm-pii) + 1 dòng JSON hỏng chứa bí mật thô. */
export function canaryLines() {
  const c = CANARY;
  return [
    app({
      ts: "2026-10-18T01:02:08.000Z",
      level: "info",
      severity_number: 9,
      service: "hm-pii",
      version: `build-for ${c.email}`,
      env: "staging",
      msg: `gửi tới ${c.email}, gọi ${c.phone}, CCCD ${c.idNumber}, Authorization: Bearer ${c.bearer}, db postgres://app:${c.dsnPassword}@db:5432/hm`,
      user_email: c.email,
      password: c.password,
      accessKeyId: c.accessKey,
      ctx: { contact: c.email, note: `password=${c.password}`, phone: c.phone, auth: { token: c.bearer } },
    }),
    app({
      ts: "2026-10-18T01:02:09.000Z",
      level: "warn",
      severity_number: 13,
      service: "hm-pii",
      version: "1.2.3",
      env: "staging",
      msg: "gọi lại",
      detail: `số giấy tờ ${c.idNumber}; liên hệ ${c.phone}`,
    }),
    line(`{"password":"${c.password}","email":"${c.email}","authorization":"Bearer ${c.bearer}"`),
  ];
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return pred();
}

/** OTELCOL_BIN → binary do `scripts/ops-tools.sh install` cài ($HM_TOOLS_DIR hoặc ~/.cache/hm-tools) → PATH. */
export function collectorBin(env = process.env) {
  if (env.OTELCOL_BIN) return env.OTELCOL_BIN;
  const installed = join(env.HM_TOOLS_DIR || join(homedir(), ".cache/hm-tools"), "bin/otelcol-contrib");
  return existsSync(installed) ? installed : "otelcol-contrib";
}

export async function main() {
  const bin = collectorBin();
  const work = mkdtempSync(join(tmpdir(), "hm-otel-"));
  const input = join(work, "container-json.log");
  const output = join(work, "logs.jsonl");
  writeFileSync(input, sampleDockerLog());
  const child = spawn(
    bin,
    ["--config", process.env.OTEL_CONFIG || join(ROOT, "deploy/otel/collector.yaml")],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        HM_LOG_INCLUDE: input,
        HM_OTEL_STATE_DIR: join(work, "state"),
        HM_LOG_EXPORT_PATH: output,
        HM_DEPLOYMENT_ENV: "e2e-default",
      },
    },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const count = () => (existsSync(output) ? flattenRecords(readFileSync(output, "utf8")).length : 0);
  try {
    await waitFor(() => count() >= TOTAL || exited, 60_000);
  } finally {
    child.kill("SIGTERM");
    await waitFor(() => exited, 10_000);
    if (!exited) child.kill("SIGKILL");
  }
  const records = existsSync(output) ? flattenRecords(readFileSync(output, "utf8")) : [];
  rmSync(work, { recursive: true, force: true });
  return records;
}

const TOTAL = 10;

/** OPS-OBS-008: lỗi khi giá trị canary lọt ra ở bất kỳ resource/attribute/body nào, hoặc phần che không như mong đợi. */
export function verifyRedaction(records) {
  const errors = [];
  const expect = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  const all = JSON.stringify(records, (_, v) => (typeof v === "bigint" ? String(v) : v));
  for (const [name, value] of Object.entries(CANARY))
    expect(!all.includes(value), `canary ${name} lọt tới exporter: ${value}`);
  const pii = queryByService(records, "hm-pii");
  expect(pii.length === 2, `service.name=hm-pii cần 2 bản ghi, có ${pii.length}`);
  const first = pii.find((r) => String(r.body).startsWith("gửi tới"));
  expect(Boolean(first), "thiếu bản ghi canary đầu (body phải giữ phần không nhạy cảm)");
  if (first) {
    const body = String(first.body);
    expect(body.includes("c***@example.com"), "email trong body phải che, giữ tên miền");
    expect(body.includes("091****678"), "SĐT trong body phải che, giữ đầu/cuối");
    expect(body.includes("****4567"), "CCCD trong body phải che, giữ 4 số cuối");
    expect(body.includes("Bearer ***"), "token Bearer trong body phải che");
    expect(body.includes("postgres://app:***@db"), "mật khẩu trong URL kết nối phải che");
    expect(first.resource["service.version"] === "build-for c***@example.com", "email ở Resource phải che");
    expect(first.attributes.user_email === "c***@example.com", "email ở attribute phải che");
    expect(
      first.attributes["ctx.contact"] === "c***@example.com",
      "email ở object lồng phải che (sau flatten)",
    );
    expect(first.attributes["ctx.note"] === "password=***", "password=… trong giá trị phải che");
    expect(first.attributes["ctx.phone"] === "091****678", "SĐT ở object lồng phải che");
    for (const k of ["password", "accessKeyId", "ctx.auth.token"])
      expect(!(k in first.attributes), `khoá nhạy cảm ${k} phải bị xoá`);
  }
  const second = pii.find((r) => r.body === "gọi lại");
  expect(
    second?.attributes.detail === "số giấy tờ ****4567; liên hệ 091****678",
    `CCCD/SĐT trong attribute phải che, có ${second?.attributes.detail}`,
  );
  const raw = records.find((r) => r.attributes.unparsed === "true" && String(r.body).includes('"password"'));
  expect(Boolean(raw), "dòng JSON hỏng chứa bí mật vẫn phải được lưu (không drop)");
  if (raw) expect(String(raw.body).includes('"password":"***"'), "JSON thô: giá trị password phải che");
  return errors;
}

export function verify(records) {
  const errors = [];
  const expect = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  expect(records.length === TOTAL, `cần đủ ${TOTAL} bản ghi (không drop dòng nào), có ${records.length}`);
  const unparsed = records.filter((r) => r.attributes.unparsed === "true");
  expect(unparsed.length === 4, `cần 4 dòng gắn unparsed, có ${unparsed.length}`);
  for (const r of unparsed) {
    expect(
      r.resource["service.name"] === "hotel-manager",
      "dòng unparsed phải có service.name mặc định của Collector",
    );
    expect(
      r.resource["deployment.environment"] === "e2e-default",
      "dòng unparsed phải có deployment.environment mặc định",
    );
  }
  expect(
    unparsed.some((r) => String(r.body).includes("Segmentation noise")),
    "dòng rác phải giữ nguyên nội dung trong body",
  );
  const web = queryByService(records, "hm-web").filter((r) => r.attributes.unparsed !== "true");
  const worker = queryByService(records, "hm-worker");
  expect(web.length === 2, `service.name=hm-web (đã parse) cần 2 bản ghi, có ${web.length}`);
  expect(worker.length === 2, `service.name=hm-worker cần 2 bản ghi, có ${worker.length}`);
  for (const r of [...web, ...worker]) {
    expect(r.resource["service.version"] === "1.2.3", "thiếu service.version từ log");
    expect(
      r.resource["deployment.environment"] === "staging",
      "deployment.environment phải lấy từ trường env của log",
    );
    expect(r.attributes.unparsed === undefined, "dòng hợp lệ không được gắn unparsed");
  }
  const first = web.find((r) => r.body === "thanh toán đã ghi");
  expect(Boolean(first), "body phải là msg (giữ Unicode)");
  expect(first?.severityNumber === 9, `severityNumber INFO=9, có ${first?.severityNumber}`);
  expect(first?.traceId === "0af7651916cd43dd8448eb211c80319c", "trace_id phải thành traceId của OTel");
  expect(first?.spanId === "b7ad6b7169203331", "span_id phải thành spanId của OTel");
  expect(first?.time === 1792285323123000000n, `timestamp phải lấy từ ts (UTC), có ${first?.time}`);
  expect(web.find((r) => r.body === "lỗi CSDL")?.severityNumber === 17, "ERROR=17");
  expect(worker.find((r) => r.body === "outbox chậm")?.severityNumber === 13, "WARN=13");
  errors.push(...verifyRedaction(records));
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = await main();
  const errors = verify(records);
  for (const e of errors) process.stderr.write(`LỖI: ${e}\n`);
  process.stdout.write(`[otel-e2e] ${records.length} bản ghi · ${errors.length} lỗi\n`);
  process.exit(errors.length ? 1 : 0);
}
