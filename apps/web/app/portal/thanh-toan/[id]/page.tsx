import { randomUUID } from "node:crypto";
import { getPaymentInstructions, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../../components/command/command-form.tsx";
import { Money } from "../../../../components/portal/money.tsx";
import { QrCode } from "../../../../components/portal/qr-code.tsx";
import { EmptyState } from "../../../../components/ui/state.tsx";
import { vnd } from "../../../../lib/format.ts";
import { withPortal } from "../../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: "Thanh toán — Hotel Manager" };

// SPEC-portal S-010/S-011: QR + thông tin chuyển khoản + "Tôi đã chuyển" (chỉ tạo báo chuyển; phiếu chưa đổi — INV-F3).
export default async function PortalPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPortal("Thanh toán", "/portal", async ({ actor }) => {
    let p: Awaited<ReturnType<typeof getPaymentInstructions>>;
    try {
      p = await getPaymentInstructions(serverContext().db, actor, id, { correlationId: randomUUID() });
    } catch (e) {
      if ((e as { code?: string }).code === "NOT_FOUND") notFound();
      throw e;
    }
    if (p.amountDue <= 0)
      return (
        <EmptyState
          title="Phiếu này đã được thanh toán đủ"
          action={
            <a className="btn btn--secondary" href={`/portal/phieu/${p.invoiceId}`}>
              Xem phiếu
            </a>
          }
        />
      );
    const alt = p.account
      ? `Mã QR chuyển khoản tới tài khoản ${p.account.accountNumber} (${p.account.bankCode}) tên ${p.account.accountName}, số tiền ${vnd(p.amountDue)}, nội dung ${p.transferContent}`
      : "";
    return (
      <>
        <section aria-labelledby="ck" className="panel">
          <h2 id="ck">Chuyển khoản</h2>
          {p.account && p.qrPayload ? <QrCode payload={p.qrPayload} label={alt} /> : null}
          {p.account ? (
            <dl className="facts">
              <dt>Ngân hàng</dt>
              <dd>{p.account.bankCode}</dd>
              <dt>Số tài khoản</dt>
              <dd data-testid="pay-account">{p.account.accountNumber}</dd>
              <dt>Tên tài khoản</dt>
              <dd>{p.account.accountName}</dd>
              <dt>Số tiền còn nợ</dt>
              <dd>
                <Money value={p.amountDue} testId="pay-amount" />
              </dd>
              <dt>Nội dung chuyển khoản</dt>
              <dd data-testid="pay-content">{p.transferContent}</dd>
            </dl>
          ) : (
            <EmptyState
              title="Chủ trọ chưa khai báo tài khoản nhận tiền"
              text="Hãy hỏi chủ trọ thông tin chuyển khoản, rồi quay lại bấm Tôi đã chuyển."
            />
          )}
          <p className="card__meta">{p.notice}</p>
        </section>
        <section aria-labelledby="da" className="panel">
          <h2 id="da">Tôi đã chuyển</h2>
          <CommandForm
            path="portal/submitPaymentClaim"
            fixed={{ invoice_id: p.invoiceId }}
            fields={[
              {
                name: "amount",
                label: "Số tiền đã chuyển (đồng)",
                type: "money",
                required: true,
                defaultValue: p.amountDue,
                hint: "Chuyển khác số còn nợ vẫn ghi nhận; chủ trọ sẽ đối chiếu.",
              },
            ]}
            submitLabel="Tôi đã chuyển"
            successText="Đã ghi nhận báo chuyển — chủ trọ sẽ xác nhận khi thấy tiền"
            testId="claim-form"
          />
        </section>
      </>
    );
  });
}
