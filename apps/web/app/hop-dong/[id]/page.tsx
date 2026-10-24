import { getLease, leaseExtras, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm, type FieldSpec } from "../../../components/command/command-form.tsx";
import { day, leaseStatusLabel, meterLabel, vnd } from "../../../lib/format.ts";
import { messagesFor } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.lease_status.", "label.meter.");

export const metadata: Metadata = { title: "Chi tiết hợp đồng — Hotel Manager" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor("Chi tiết hợp đồng", "/hop-dong", async (actor) => {
    const db = serverContext().db;
    const x = await leaseExtras(db, actor, id);
    if (!x) notFound();
    const lease = await getLease(db, actor, id);
    const v = lease.versions.at(-1);
    const moveIn = lease.handovers.find((h) => h.kind === "move_in" && h.confirmed_at);
    const moveOut = lease.handovers.find((h) => h.kind === "move_out" && h.confirmed_at);
    const readingFields = (prefix: string): FieldSpec[] =>
      x.meters.map((m) => ({
        name: `${prefix}_${m.kind}`,
        path: `readings.${m.kind}`,
        label: `Chỉ số ${meterLabel(LABELS, m.kind)?.toLowerCase() ?? m.kind}`,
        type: "decimal",
        required: true,
        hint: `Lần đọc trước: ${m.last}`,
      }));
    const handoverFixed = (kind: string) => ({
      lease_id: id,
      kind,
      assets: [],
      photo_file_ids: [],
      tenant_confirmation: { method: "in_person" },
    });
    return (
      <>
        <section aria-labelledby="tt" className="panel">
          <h2 id="tt">
            Phòng {x.unit} — {x.tenant}
          </h2>
          <dl className="facts">
            <dt>Số hợp đồng</dt>
            <dd>{lease.number}</dd>
            <dt>Trạng thái</dt>
            <dd data-testid="lease-status">{leaseStatusLabel(LABELS, lease.status)}</dd>
            <dt>Cơ sở</dt>
            <dd>{x.property}</dd>
            <dt>Điện thoại</dt>
            <dd>{x.tenant_phone ?? "—"}</dd>
            <dt>Giá thuê</dt>
            <dd>{v ? `${vnd(v.rent_amount)}/tháng` : "—"}</dd>
            <dt>Hiệu lực</dt>
            <dd>
              {day(v?.effective_from)} – {v?.effective_to ? day(v.effective_to) : "không thời hạn"}
            </dd>
            <dt>Cọc đang giữ</dt>
            <dd data-testid="deposit-balance">
              {x.deposit_balance === null ? "Chưa nhận" : vnd(x.deposit_balance)}
            </dd>
            <dt>Còn phải thu</dt>
            <dd>{vnd(x.open_ar)}</dd>
          </dl>
        </section>

        {lease.status === "draft" ? (
          <section aria-labelledby="a-submit" className="panel">
            <h2 id="a-submit">Trình ký</h2>
            <CommandForm
              path="lease/submitForSignature"
              fixed={{ lease_id: id }}
              submitLabel="Trình ký"
              successText="Đã chuyển sang chờ ký."
            />
          </section>
        ) : null}

        {lease.status === "pending_signature" ? (
          <section aria-labelledby="a-sign" className="panel">
            <h2 id="a-sign">Ký hợp đồng</h2>
            <p>Người đứng hợp đồng ký trực tiếp; điều khoản được khoá sau khi ký.</p>
            <CommandForm
              path="lease/sign"
              confirm="Ký hợp đồng sẽ chốt điều khoản và giữ phòng; không sửa lại được — muốn đổi phải lập phụ lục."
              confirmLabel={`Ký hợp đồng ${lease.number}`}
              fixed={{ lease_id: id, signer_person_id: lease.representative_person_id }}
              submitLabel="Ký hợp đồng"
              successText="Đã ký hợp đồng."
            />
          </section>
        ) : null}

        {lease.status === "signed_awaiting_handover" && !moveIn ? (
          <section aria-labelledby="a-in" className="panel">
            <h2 id="a-in">Bàn giao nhận phòng</h2>
            <CommandForm
              path="lease/recordHandover"
              fixed={handoverFixed("move_in")}
              fields={[
                {
                  name: "handed_over_on",
                  label: "Ngày bàn giao",
                  type: "date",
                  required: true,
                  defaultValue: lease.billing_start_on,
                },
                ...readingFields("in"),
                {
                  name: "keys_count",
                  label: "Số chìa khoá",
                  type: "integer",
                  required: true,
                  defaultValue: 2,
                },
              ]}
              submitLabel="Xác nhận bàn giao"
              successText="Đã lưu biên bản bàn giao."
            />
          </section>
        ) : null}

        {lease.status === "signed_awaiting_handover" && moveIn ? (
          <section aria-labelledby="a-act" className="panel">
            <h2 id="a-act">Kích hoạt hợp đồng</h2>
            <p>Đã bàn giao ngày {day(moveIn.handed_over_on)}.</p>
            <CommandForm
              path="lease/activate"
              confirm="Hợp đồng chuyển sang đang thuê và bắt đầu tính tiền theo kỳ."
              confirmLabel={`Kích hoạt hợp đồng ${lease.number}`}
              fixed={{ lease_id: id }}
              submitLabel="Kích hoạt"
              successText="Hợp đồng đang hiệu lực."
            />
          </section>
        ) : null}

        {["active", "notice_given"].includes(lease.status) && x.deposit_balance === null ? (
          <section aria-labelledby="a-dep" className="panel">
            <h2 id="a-dep">Nhận cọc (tiền mặt)</h2>
            {x.open_shift ? (
              <CommandForm
                path="deposit/receive"
                confirm="Ghi nhận tiền cọc vào sổ; muốn sửa phải lập bút toán điều chỉnh có duyệt."
                confirmLabel={`Nhận cọc {amount} cho ${lease.number}`}
                fixed={{
                  property_id: lease.property_id,
                  lease_id: id,
                  payer_person_id: lease.representative_person_id,
                  method: "cash",
                }}
                fields={[
                  {
                    name: "amount",
                    label: "Số tiền cọc (đồng)",
                    type: "money",
                    required: true,
                    defaultValue: v?.deposit_amount ?? "",
                  },
                ]}
                submitLabel="Nhận cọc"
                successText="Đã ghi nhận cọc — chờ xác nhận tiền mặt ở trang Thu tiền."
              />
            ) : (
              <p>
                Mở ca tiền mặt ở trang Thu tiền trước khi nhận cọc.{" "}
                <a className="btn btn--secondary" href="/thu-tien">
                  Đến trang Thu tiền
                </a>
              </p>
            )}
          </section>
        ) : null}

        {lease.status === "active" ? (
          <section aria-labelledby="a-notice" className="panel">
            <h2 id="a-notice">Báo trả phòng</h2>
            <CommandForm
              path="lease/giveNotice"
              confirm="Ghi nhận người thuê báo trả phòng; hợp đồng chuyển sang chờ trả, không rút lại được trên hệ thống."
              confirmLabel={`Ghi nhận báo trả phòng ${x.unit} (${lease.number}) ngày {planned_move_out_on}`}
              fixed={{ lease_id: id }}
              fields={[
                { name: "planned_move_out_on", label: "Ngày dự kiến trả", type: "date", required: true },
              ]}
              submitLabel="Ghi nhận báo trả"
              successText="Đã ghi nhận báo trả."
              variant="secondary"
            />
          </section>
        ) : null}

        {["active", "notice_given"].includes(lease.status) && !moveOut ? (
          <section aria-labelledby="a-out" className="panel">
            <h2 id="a-out">Bàn giao trả phòng</h2>
            <CommandForm
              path="lease/recordHandover"
              confirm="Bàn giao trả phòng chốt ngày trả và chỉ số cuối; hợp đồng chuyển sang quyết toán, không quay lại đang thuê."
              confirmLabel={`Chốt trả phòng ${x.unit} (${lease.number}) ngày {handed_over_on}`}
              fixed={handoverFixed("move_out")}
              fields={[
                { name: "handed_over_on", label: "Ngày trả phòng", type: "date", required: true },
                ...readingFields("out"),
                {
                  name: "keys_count",
                  label: "Số chìa khoá nhận lại",
                  type: "integer",
                  required: true,
                  defaultValue: 2,
                },
              ]}
              submitLabel="Xác nhận trả phòng"
              successText="Đã lưu biên bản trả phòng — chuyển sang thanh lý."
              variant="secondary"
            />
          </section>
        ) : null}

        {lease.status === "settling" ? (
          <section aria-labelledby="a-settle" className="panel">
            <h2 id="a-settle">Thanh lý</h2>
            <p>
              Lập bảng quyết toán: cọc đối trừ công nợ, phần còn lại hoàn cho khách. Người khác (theo hạn mức)
              duyệt rồi mới ghi sổ.
            </p>
            <CommandForm
              path="lease/prepareSettlement"
              confirm="Lập quyết toán từ chỉ số và công nợ hiện tại của hợp đồng."
              confirmLabel={`Lập quyết toán ${lease.number}`}
              fixed={{ lease_id: id, fees: [] }}
              submitLabel="Lập quyết toán"
              successText="Đã lập quyết toán — chờ duyệt."
            />
          </section>
        ) : null}
      </>
    );
  });
}
