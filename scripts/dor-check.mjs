// WF-TEAM-003: nhãn `ready` của issue chỉ hợp lệ khi checklist Definition of Ready trong thân issue đã tick hết
// (mẫu .github/ISSUE_TEMPLATE/task.md). Workflow `dor-check.yml` chạy script này khi gán nhãn `ready` và gỡ nhãn nếu chưa đủ.
// Dùng: `ISSUE_BODY="…" node scripts/dor-check.mjs` (thân issue qua biến môi trường, không nội suy vào lệnh). Test: scripts/dor-check.test.mjs.
import { isMain } from "./git-history.mjs";

export const DOR_HEADING = /^##\s+Definition of Ready\b[^\n]*$/m;

/** Nội dung mục DoR (tới `## ` kế tiếp), bỏ chú thích HTML; không có mục → null. */
export function dorSection(body) {
  const m = DOR_HEADING.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/<!--[\s\S]*?-->/g, "");
}

/** Danh sách lý do chưa Ready (rỗng = Ready). */
export function unmetDor(body) {
  const section = dorSection(body ?? "");
  if (section === null) return ["thiếu mục '## Definition of Ready' (dùng mẫu task.md)"];
  const items = [...section.matchAll(/^\s*- \[( |x|X)\]\s*(.*)$/gm)];
  if (items.length === 0) return ["mục Definition of Ready không có checklist"];
  return items.filter((i) => i[1] === " ").map((i) => `chưa tick: ${i[2].trim() || "(trống)"}`);
}

function main() {
  const unmet = unmetDor(process.env.ISSUE_BODY ?? "");
  if (unmet.length === 0) {
    process.stdout.write("✓ Definition of Ready đủ.\n");
    return 0;
  }
  for (const u of unmet) process.stderr.write(`✗ ${u}\n`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(main());
