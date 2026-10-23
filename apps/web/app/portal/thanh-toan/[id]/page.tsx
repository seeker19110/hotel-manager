import { randomUUID } from "node:crypto";
import { getPaymentInstructions, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../../components/command/command-form.tsx";
import { Money } from "../../../../components/portal/money.tsx";
import { QrCode } from "../../../../components/portal/qr-code.tsx";
import { EmptyState } from "../../../../components/ui/state.tsx";
import { vnd } from "../../../../lib/format.ts";
import { t } from "../../../../lib/i18n.ts";
import { withPortal } from "../../../../lib/portal-page.tsx";

export const metadata: Metadata = { title: t("portal.payment.metadata.title") };

// SPEC-portal S-010/S-011: QR + thông tin chuyển khoản + "Tôi đã chuyển" (chỉ tạo báo chuyển; phiếu chưa đổi — INV-F3).
export default async function PortalPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPortal(t("portal.payment.page.title"), "/portal", async ({ actor }) => {
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
          title={t("portal.payment.paid.title")}
          action={
            <a className="btn btn--secondary" href={`/portal/phieu/${p.invoiceId}`}>
              {t("portal.payment.paid.view")}
            </a>
          }
        />
      );
    const alt = p.account
      ? t("portal.payment.qr.alt", {
          account: p.account.accountNumber,
          bank: p.account.bankCode,
          name: p.account.accountName,
          amount: vnd(p.amountDue),
          content: p.transferContent,
        })
      : "";
    return (
      <>
        <section aria-labelledby="ck" className="panel">
          <h2 id="ck">{t("portal.payment.transfer.heading")}</h2>
          {p.account && p.qrPayload ? <QrCode payload={p.qrPayload} label={alt} /> : null}
          {p.account ? (
            <dl className="facts">
              <dt>{t("portal.payment.transfer.bank")}</dt>
              <dd>{p.account.bankCode}</dd>
              <dt>{t("portal.payment.transfer.account_number")}</dt>
              <dd data-testid="pay-account">{p.account.accountNumber}</dd>
              <dt>{t("portal.payment.transfer.account_name")}</dt>
              <dd>{p.account.accountName}</dd>
              <dt>{t("portal.payment.transfer.amount_due")}</dt>
              <dd>
                <Money value={p.amountDue} testId="pay-amount" />
              </dd>
              <dt>{t("portal.payment.transfer.content")}</dt>
              <dd data-testid="pay-content">{p.transferContent}</dd>
            </dl>
          ) : (
            <EmptyState
              title={t("portal.payment.no_account.title")}
              text={t("portal.payment.no_account.text")}
            />
          )}
          <p className="card__meta">{p.notice}</p>
        </section>
        <section aria-labelledby="da" className="panel">
          <h2 id="da">{t("portal.payment.claim.heading")}</h2>
          <CommandForm
            path="portal/submitPaymentClaim"
            confirm={t("portal.payment.claim.confirm")}
            confirmLabel={t("portal.payment.claim.label", { amount: "{amount}" })}
            fixed={{ invoice_id: p.invoiceId }}
            fields={[
              {
                name: "amount",
                label: t("portal.payment.claim.amount"),
                type: "money",
                required: true,
                defaultValue: p.amountDue,
                hint: t("portal.payment.claim.hint"),
              },
            ]}
            submitLabel={t("portal.payment.claim.submit")}
            successText={t("portal.payment.claim.success")}
            testId="claim-form"
          />
        </section>
      </>
    );
  });
}
