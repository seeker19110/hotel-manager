// PRF-WEB-009: compare key names only; never parse env files or values.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 1024 * 1024;
const SERVICE = /^[a-z][a-z0-9_-]{0,63}$/;
const KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function validateManifest(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error("manifest không hợp lệ");
  const services = new Map();
  for (const entry of data) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("manifest không hợp lệ");
    const [name, keys] = entry;
    if (typeof name !== "string" || !SERVICE.test(name) || !Array.isArray(keys) || services.has(name))
      throw new Error("manifest không hợp lệ");
    const set = new Set();
    for (const key of keys) {
      if (typeof key !== "string" || !KEY.test(key) || set.has(key)) throw new Error("manifest không hợp lệ");
      set.add(key);
    }
    services.set(name, set);
  }
  return services;
}

export function compareManifests(staging, production) {
  const result = [];
  for (const name of [...new Set([...staging.keys(), ...production.keys()])].sort()) {
    const st = staging.get(name);
    const prod = production.get(name);
    if (!st || !prod) {
      result.push(`${name}: thiếu dịch vụ ở ${st ? "production" : "staging"}`);
      continue;
    }
    for (const key of [...prod].filter((key) => !st.has(key)).sort())
      result.push(`${name}: staging thiếu ${key}`);
    for (const key of [...st].filter((key) => !prod.has(key)).sort())
      result.push(`${name}: production thiếu ${key}`);
  }
  return result;
}

export function readManifest(path) {
  if (extname(path).toLowerCase() !== ".json" || basename(path).toLowerCase().startsWith(".env"))
    throw new Error("chỉ chấp nhận tệp JSON danh sách tên khóa");
  const real = realpathSync(path);
  if (extname(real).toLowerCase() !== ".json" || basename(real).toLowerCase().startsWith(".env"))
    throw new Error("chỉ chấp nhận tệp JSON danh sách tên khóa");
  const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("tệp không hợp lệ");
    return validateManifest(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

function main() {
  if (process.argv.length !== 4) {
    console.error("Dùng: node scripts/compare-env-keys.mjs <staging.json> <production.json>");
    return 2;
  }
  try {
    const differences = compareManifests(readManifest(process.argv[2]), readManifest(process.argv[3]));
    if (differences.length) {
      for (const difference of differences) console.error(difference);
      return 1;
    }
    console.log("Tập dịch vụ và tên biến khớp.");
    return 0;
  } catch {
    // Do not echo JSON, filenames, system errors or potentially secret values.
    console.error("Không thể so sánh: tệp JSON hoặc manifest không hợp lệ.");
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
