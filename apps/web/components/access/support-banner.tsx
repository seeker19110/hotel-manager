// Biểu ngữ truy cập hỗ trợ (T-2313, D-128) trên MỌI trang của tổ chức khi đang có tài khoản hỗ trợ còn hiệu lực: ai, đến khi nào,
// và (chỉ owner) nút thu hồi một bước. Quyền thật kiểm ở server (`member.revokeSupportAccess` chỉ owner).
import type { SupportAccessRow } from "@hm/app";
import { DEFAULT_TIME_ZONE, dateTime } from "../../lib/format.ts";
import { t } from "../../lib/i18n.ts";
import { CommandForm } from "../command/command-form.tsx";

export function SupportBanner({ rows, owner }: { rows: readonly SupportAccessRow[]; owner: boolean }) {
  return (
    <div className="banner banner--warn" role="status" data-testid="support-banner">
      <h2>{t("support_banner.title")}</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.invitationId}>
            <p>
              {t("support_banner.item", {
                who: r.name ?? r.email ?? t("support_banner.unnamed"),
                until: dateTime(r.until, DEFAULT_TIME_ZONE),
              })}
            </p>
            {r.reason ? <p>{t("support_banner.reason", { reason: r.reason })}</p> : null}
            {owner ? (
              <CommandForm
                path="member/revokeSupportAccess"
                fixed={{ invitation_id: r.invitationId }}
                submitLabel={t("support_banner.revoke")}
                successText={t("support_banner.revoked")}
                variant="secondary"
                testId="support-revoke"
              />
            ) : null}
          </li>
        ))}
      </ul>
      <p>{t("support_banner.note")}</p>
    </div>
  );
}
