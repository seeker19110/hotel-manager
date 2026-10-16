import { previewPeriod, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { month, PERIOD_STATUS, vnd, vndUnitPrice } from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";

export const metadata: Metadata = { title: "Kỳ thu — xem trước — Hotel Manager" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor("Kỳ thu", "/ky-thu", async (actor) => {
    let pv: Awaited<ReturnType<typeof previewPeriod>>;
    try {
      pv = await previewPeriod(serverContext().db, actor, { billingPeriodId: id });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") notFound();
      if (code === "FORBIDDEN")
        return <ErrorState title="Không có quyền" text="Vai trò của bạn không lập/xem trước kỳ thu." />;
      throw e;
    }
    const missing = pv.items.filter((i) => i.missing.length > 0);
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">Kỳ {month(pv.period_start)}</h2>
          <dl className="facts">
            <dt>Trạng thái</dt>
            <dd data-testid="period-status">{PERIOD_STATUS[pv.status] ?? pv.status}</dd>
            <dt>Tổng kỳ</dt>
            <dd data-testid="period-total">{vnd(pv.total)}</dd>
          </dl>
          {pv.status === "draft" ? (
            <p>
              <a className="btn btn--secondary" href={`/chi-so/${id}`}>
                Nhập chỉ số theo tầng
              </a>
            </p>
          ) : null}
        </section>
        {missing.length > 0 ? (
          <div className="banner banner--warn" role="note">
            Còn phòng thiếu chỉ số: {missing.map((i) => `${i.unit} (${i.missing.join(", ")})`).join("; ")}.
          </div>
        ) : null}
        <section aria-labelledby="xt" className="panel">
          <h2 id="xt">Xem trước từng phòng</h2>
          {pv.items.length === 0 ? (
            <EmptyState title="Không có hợp đồng tính tiền trong kỳ" />
          ) : (
            pv.items.map((i) => (
              <table key={i.lease_id} className="lines" data-testid="preview-room">
                <caption>
                  Phòng {i.unit} — tổng <strong>{vnd(i.total)}</strong>
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Khoản</th>
                    <th scope="col">Lượng</th>
                    <th scope="col">Đơn giá</th>
                    <th scope="col">Thành tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {i.lines.map((l) => (
                    <tr key={`${l.kind}-${l.description}-${l.periodFrom}`}>
                      <th scope="row">{l.description}</th>
                      <td>{l.quantity}</td>
                      <td>{vndUnitPrice(Number(l.unitPrice))}</td>
                      <td>{vnd(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))
          )}
        </section>
        {pv.status === "draft" ? (
          <section aria-labelledby="a-review" className="panel">
            <h2 id="a-review">Gửi duyệt</h2>
            <CommandForm
              path="billing/submitForReview"
              fixed={{ billing_period_id: id }}
              submitLabel="Gửi duyệt"
              successText="Đã gửi duyệt — chờ phát hành."
            />
          </section>
        ) : null}
        {pv.status === "reviewing" ? (
          <section aria-labelledby="a-issue" className="panel">
            <h2 id="a-issue">Phát hành</h2>
            <p>
              Phát hành tạo phiếu thu cho từng phòng đúng như bản xem trước ở trên; sau đó không sửa được chỉ
              số kỳ này.
            </p>
            <CommandForm
              path="billing/issuePeriod"
              confirm="Phát hành kỳ thu: phiếu gửi tới người thuê và ghi công nợ; muốn sửa phải điều chỉnh có duyệt."
              fixed={{ billing_period_id: id, preview_hash: pv.preview_hash }}
              submitLabel="Phát hành kỳ"
              successText="Đã phát hành phiếu thu."
            />
            <CommandForm
              path="billing/returnToDraft"
              fixed={{ billing_period_id: id }}
              fields={[{ name: "reason", label: "Lý do trả về nháp", required: true }]}
              submitLabel="Trả về nháp"
              successText="Đã trả về nháp."
              variant="secondary"
            />
          </section>
        ) : null}
      </>
    );
  });
}
