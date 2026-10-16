import { getFolio, opsProperties, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { ShiftPanel } from "../../../components/hotel/shift-panel.tsx";
import { StatusBadge } from "../../../components/ui/badge.tsx";
import { ErrorState } from "../../../components/ui/state.tsx";
import {
  CHARGE_KIND,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  STAY_STATUS,
  vnd,
  vndUnitPrice,
} from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";
import { safe } from "../../../lib/safe.ts";

export const metadata: Metadata = { title: "Lượt ở và folio — Hotel Manager" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE = ["owner", "manager", "front_desk"];

// SPEC-reservation-stay S-017…S-020, S-026, S-027: folio (cọc tách riêng, INV-F5), dịch vụ, trả phòng với tiền mặt trong ca của mình.
export default async function StayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor("Lượt ở và folio", "/dat-phong", async (actor) => {
    const db = serverContext().db;
    const r = await safe(getFolio(db, actor, id));
    if (!r.ok) {
      if (r.status === 404) notFound();
      return <ErrorState title="Không xem được folio" text={r.message} />;
    }
    const f = r.data;
    const props = await safe(opsProperties(db, actor));
    const property = props.ok ? props.data.find((p) => p.id === f.propertyId) : undefined;
    const canManage = MANAGE.includes(actor.role);
    const inHouse = f.stayStatus === "in_house";
    const owes = f.balance > 0;
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">Phòng {f.unitCode}</h2>
          <dl className="facts">
            <dt>Trạng thái</dt>
            <dd>
              <StatusBadge
                status={f.stayStatus}
                label={STAY_STATUS[f.stayStatus] ?? f.stayStatus}
                testId="stay-status"
              />
            </dd>
            <dt>Tổng phải thu</dt>
            <dd data-testid="folio-charges">{vnd(f.chargesTotal)}</dd>
            <dt>Đã thu</dt>
            <dd data-testid="folio-paid">{vnd(f.paidTotal)}</dd>
            <dt>Còn phải thu</dt>
            <dd data-testid="folio-balance">{vnd(f.balance)}</dd>
            <dt>Cọc đang giữ (tách riêng)</dt>
            <dd data-testid="folio-deposit">{f.deposit ? vnd(f.deposit.balance) : "Không có"}</dd>
          </dl>
          <p>
            <a className="btn btn--secondary" href={`/dat-phong/${f.reservationId}`}>
              Mở đặt phòng
            </a>
          </p>
        </section>

        <section aria-labelledby="khoan" className="panel">
          <h2 id="khoan">Các khoản</h2>
          <table className="lines">
            <caption>Khoản phải thu của lượt ở</caption>
            <thead>
              <tr>
                <th scope="col">Khoản</th>
                <th scope="col">Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              {f.charges.map((c) => (
                <tr key={c.id} data-testid="charge">
                  <th scope="row">
                    {CHARGE_KIND[c.kind] ?? c.kind}: {c.description}
                    {c.quantity > 1 ? ` (${c.quantity} × ${vndUnitPrice(c.unitPrice)})` : ""}
                    {c.voided ? " — đã huỷ" : ""}
                  </th>
                  <td>{c.voided ? <s>{vnd(c.amount)}</s> : vnd(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.payments.length > 0 ? (
            <ul className="card-list" aria-label="Khoản đã thu">
              {f.payments.map((p) => (
                <li key={p.id} className="card" data-testid="folio-payment">
                  {PAYMENT_METHOD[p.method] ?? p.method} {vnd(p.amount)} —{" "}
                  {PAYMENT_STATUS[p.status] ?? p.status}
                  {p.receiptNo ? ` · biên nhận ${p.receiptNo}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {canManage && inHouse ? (
          <section aria-labelledby="dv" className="panel">
            <h2 id="dv">Thêm dịch vụ / phụ thu / giảm giá</h2>
            <CommandForm
              path="stay/postCharge"
              fixed={{ stay_id: id }}
              fields={[
                {
                  name: "kind",
                  label: "Loại khoản",
                  type: "select",
                  defaultValue: "service",
                  options: [
                    { value: "service", label: "Dịch vụ" },
                    { value: "fee", label: "Phụ thu" },
                    { value: "discount", label: "Giảm giá" },
                  ],
                },
                { name: "description", label: "Nội dung", required: true, maxLength: 500 },
                { name: "quantity", label: "Số lượng", type: "integer", defaultValue: 1, required: true },
                { name: "unit_price", label: "Đơn giá (đồng)", type: "money", required: true },
              ]}
              submitLabel="Thêm khoản"
              successText="Đã thêm khoản vào folio."
              testId="charge-form"
            />
            {f.charges
              .filter((c) => !c.voided && c.kind !== "room")
              .map((c) => (
                <details key={c.id} className="details-box">
                  <summary>Huỷ khoản: {c.description}</summary>
                  <CommandForm
                    path="stay/voidCharge"
                    confirm="Huỷ khoản phí này khỏi folio; thao tác được ghi nhật ký."
                    confirmLabel={`Huỷ khoản "${c.description}" (phòng ${f.unitCode})`}
                    fixed={{ charge_id: c.id }}
                    fields={[
                      {
                        name: "reason",
                        label: `Lý do huỷ "${c.description}"`,
                        required: true,
                        maxLength: 1000,
                      },
                    ]}
                    submitLabel="Huỷ khoản này"
                    successText="Đã huỷ khoản."
                    variant="secondary"
                  />
                </details>
              ))}
          </section>
        ) : null}

        {canManage && inHouse ? (
          <section aria-labelledby="out" className="panel">
            <h2 id="out">Trả phòng</h2>
            {property ? <ShiftPanel property={property} /> : null}
            {/* key theo số tiền: form mount lại khi folio đổi → ô tiền luôn mặc định đúng số còn lại */}
            {owes ? (
              <>
                <p>
                  Khách còn phải trả <strong>{vnd(f.balance)}</strong>. Thu tiền mặt rồi trả phòng (khoản thu
                  được xác nhận ngay trong ca của bạn).
                </p>
                <CommandForm
                  key={`cash-${f.balance}`}
                  path="stay/checkOut"
                  confirm="Trả phòng sẽ phát hành folio, ghi sổ và tạo việc dọn phòng; không quay lại được."
                  confirmLabel={`Thu {cash} và trả phòng ${f.unitCode}`}
                  fixed={{ stay_id: id, payments: [{ method: "cash" }] }}
                  fields={[
                    {
                      name: "cash",
                      path: "payments.0.amount",
                      label: "Tiền mặt thu (đồng)",
                      type: "money",
                      required: true,
                      defaultValue: f.balance,
                    },
                  ]}
                  submitLabel="Thu tiền mặt và trả phòng"
                  successText="Đã trả phòng. Việc dọn phòng đã được tạo cho buồng phòng."
                  testId="checkout-cash"
                />
                <p className="card__meta">
                  Khách chưa trả đủ: cho ghi nợ cần quản lý duyệt — lập yêu cầu duyệt trước khi trả phòng.
                </p>
              </>
            ) : f.deposit && f.deposit.balance > 0 ? (
              <>
                <CommandForm
                  key={`refund-${f.deposit.balance}`}
                  path="stay/checkOut"
                  confirm="Trả phòng sẽ phát hành folio, ghi sổ và tạo việc dọn phòng; không quay lại được."
                  confirmLabel={`Hoàn cọc {refund} và trả phòng ${f.unitCode}`}
                  fixed={{ stay_id: id, deposit_refund: { method: "cash" } }}
                  fields={[
                    {
                      name: "refund",
                      path: "deposit_refund.amount",
                      label: "Hoàn cọc tiền mặt (đồng)",
                      type: "money",
                      required: true,
                      defaultValue: f.deposit.balance,
                    },
                  ]}
                  submitLabel="Trả phòng và hoàn cọc"
                  successText="Đã trả phòng và hoàn cọc. Việc dọn phòng đã được tạo."
                  testId="checkout-refund"
                />
                <CommandForm
                  path="stay/checkOut"
                  confirm="Trả phòng sẽ phát hành folio, ghi sổ và tạo việc dọn phòng; không quay lại được."
                  confirmLabel={`Trả phòng ${f.unitCode} (chưa hoàn cọc)`}
                  fixed={{ stay_id: id }}
                  submitLabel="Trả phòng (chưa hoàn cọc)"
                  successText="Đã trả phòng. Việc dọn phòng đã được tạo."
                  variant="secondary"
                />
              </>
            ) : (
              <CommandForm
                path="stay/checkOut"
                confirm="Trả phòng sẽ phát hành folio, ghi sổ và tạo việc dọn phòng; không quay lại được."
                confirmLabel={`Trả phòng ${f.unitCode}`}
                fixed={{ stay_id: id }}
                submitLabel="Trả phòng"
                successText="Đã trả phòng. Việc dọn phòng đã được tạo."
                testId="checkout-plain"
              />
            )}
          </section>
        ) : null}

        {f.stayStatus === "checked_out" ? (
          <p>
            <a className="btn" href="/buong-phong">
              Xem việc dọn phòng
            </a>
          </p>
        ) : null}
      </>
    );
  });
}
