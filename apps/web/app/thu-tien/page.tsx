import { listOpenInvoices, listPendingPayments, rentalProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { CommandForm } from "../../components/command/command-form.tsx";
import { EmptyState } from "../../components/ui/state.tsx";
import { day, vnd } from "../../lib/format.ts";
import { withActor } from "../../lib/page.tsx";

export const metadata: Metadata = { title: "Thu tiền — Hotel Manager" };

export default async function CollectPage() {
  return withActor("Thu tiền", "/thu-tien", async (actor) => {
    const db = serverContext().db;
    const [invoices, pending, properties] = await Promise.all([
      listOpenInvoices(db, actor),
      listPendingPayments(db, actor),
      rentalProperties(db, actor),
    ]);
    const shiftOpen = new Map(properties.map((p) => [p.id, p.open_shift]));
    return (
      <>
        {properties
          .filter((p) => !p.open_shift)
          .map((p) => (
            <section key={p.id} aria-labelledby={`ca-${p.id}`} className="panel">
              <h2 id={`ca-${p.id}`}>Mở ca tiền mặt — {p.name}</h2>
              <CommandForm
                path="shift/open"
                fixed={{ property_id: p.id }}
                fields={[
                  {
                    name: "opening_cash",
                    label: "Tiền đầu ca (đồng)",
                    type: "money",
                    required: true,
                    defaultValue: 0,
                  },
                ]}
                submitLabel="Mở ca"
                successText="Đã mở ca."
              />
            </section>
          ))}
        <section aria-labelledby="cho" className="panel">
          <h2 id="cho">Chờ xác nhận</h2>
          {pending.length === 0 ? (
            <EmptyState title="Không có khoản chờ xác nhận" />
          ) : (
            <ul className="card-list">
              {pending.map((p) => (
                <li key={p.id} className="card" data-testid="pending-payment">
                  <p className="card__title">
                    {p.purpose === "deposit" ? "Cọc" : "Thu"} {vnd(p.amount)} — {p.payer}
                  </p>
                  <p className="card__meta">
                    {p.method === "cash" ? "Tiền mặt" : "Chuyển khoản"} · {p.property}
                  </p>
                  <CommandForm
                    path="payment/confirm"
                    confirm="Xác nhận khoản thu vào sổ; không xoá được, chỉ đảo bằng bút toán có duyệt."
                    fixed={{ payment_id: p.id }}
                    submitLabel="Xác nhận đã nhận tiền"
                    successText="Đã xác nhận và ghi sổ."
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="no" className="panel">
          <h2 id="no">Phiếu còn phải thu</h2>
          {invoices.length === 0 ? (
            <EmptyState title="Không còn phiếu nào phải thu" />
          ) : (
            <ul className="card-list">
              {invoices.map((i) => (
                <li key={i.id} className="card" data-testid="open-invoice">
                  <p className="card__title">
                    {i.number} — {i.unit ? `Phòng ${i.unit} · ` : ""}
                    {i.payer}
                  </p>
                  <p className="card__meta">
                    Ngày {day(i.business_date)} · tổng {vnd(i.total)} · còn{" "}
                    <strong data-testid="open-amount">{vnd(i.open_amount)}</strong>
                  </p>
                  {shiftOpen.get(i.property_id) ? (
                    <CommandForm
                      path="payment/collectCash"
                      confirm="Ghi nhận tiền mặt vào ca đang mở; không xoá được, chỉ đảo bằng bút toán có duyệt."
                      fixed={{ invoice_id: i.id }}
                      fields={[
                        {
                          name: "amount",
                          label: `Số tiền mặt thu cho ${i.number}`,
                          type: "money",
                          required: true,
                          defaultValue: i.open_amount,
                        },
                      ]}
                      submitLabel="Thu tiền mặt"
                      successText="Đã thu và phân bổ vào phiếu."
                    />
                  ) : (
                    <p className="card__meta">Mở ca để thu tiền mặt.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  });
}
