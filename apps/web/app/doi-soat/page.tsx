import { listOpenBreaks, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { vnd } from "../../lib/format.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: "Đối soát — Hotel Manager" };

const REASON: Record<string, string> = {
  WRONG_REFERENCE: "Sai nội dung chuyển khoản",
  COMBINED: "Gộp nhiều phiếu",
  OVERPAID: "Chuyển thừa",
  THIRD_PARTY_PAYER: "Người khác trả hộ",
  UNMATCHED: "Không khớp phiếu nào",
  HASH_MISMATCH: "Dữ liệu ngân hàng không khớp",
};

export default async function BreaksPage() {
  return withActor("Đối soát ngân hàng", "/doi-soat", async (actor) => {
    const breaks = await listOpenBreaks(serverContext().db, actor);
    if (breaks.length === 0)
      return (
        <EmptyState
          title="Không có giao dịch chờ đối soát"
          text="Giao dịch ngân hàng khớp đúng một phiếu được ghi tự động."
        />
      );
    return (
      <ul className="card-list">
        {breaks.map((b) => (
          <li key={b.id} className="card" data-testid="break">
            <p className="card__title">
              {REASON[b.reason] ?? b.reason}
              {b.amount === null ? "" : ` — ${vnd(b.amount)}`}
            </p>
            <p className="card__meta">
              {b.property}
              {b.description ? ` · "${b.description}"` : ""}
            </p>
            <CommandForm
              path="reconciliation/resolveBreak"
              confirm="Đóng chênh lệch đối soát với cách xử lý đã ghi; không mở lại được."
              fixed={{ break_id: b.id }}
              fields={[{ name: "resolution", label: "Cách xử lý (ghi rõ)", required: true }]}
              submitLabel="Đánh dấu đã xử lý"
              successText="Đã xử lý."
              variant="secondary"
            />
          </li>
        ))}
      </ul>
    );
  });
}
