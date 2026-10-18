// Chạy THẬT Collector contrib với deploy/otel/collector.yaml trên file log kiểu Docker json-file (OPS-OBS-001):
// log JSON hợp lệ → Resource service.name/version/deployment.environment + severity + body; dòng rác/JSON hỏng → vẫn được lưu
// với thuộc tính `unparsed`; truy vấn theo service.name trả đúng. Dùng: `node scripts/otel-collector-e2e.mjs` (cần `otelcol-contrib`
// trong PATH hoặc biến OTELCOL_BIN; cài bằng `bash scripts/ops-tools.sh install otelcol-contrib`). CI: job `otel-collector`.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  ].join("");
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return pred();
}

export async function main() {
  const bin = process.env.OTELCOL_BIN || "otelcol-contrib";
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
    await waitFor(() => count() >= 7 || exited, 60_000);
  } finally {
    child.kill("SIGTERM");
    await waitFor(() => exited, 10_000);
    if (!exited) child.kill("SIGKILL");
  }
  const records = existsSync(output) ? flattenRecords(readFileSync(output, "utf8")) : [];
  rmSync(work, { recursive: true, force: true });
  return records;
}

export function verify(records) {
  const errors = [];
  const expect = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  expect(records.length === 7, `cần đủ 7 bản ghi (không drop dòng nào), có ${records.length}`);
  const unparsed = records.filter((r) => r.attributes.unparsed === "true");
  expect(unparsed.length === 3, `cần 3 dòng gắn unparsed, có ${unparsed.length}`);
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
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = await main();
  const errors = verify(records);
  for (const e of errors) process.stderr.write(`LỖI: ${e}\n`);
  process.stdout.write(`[otel-e2e] ${records.length} bản ghi · ${errors.length} lỗi\n`);
  process.exit(errors.length ? 1 : 0);
}
