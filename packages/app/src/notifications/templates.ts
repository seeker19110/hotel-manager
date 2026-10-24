// Mẫu thông báo trong app + email văn bản thuần (SPEC-notifications S-001, S-006, S-012; Q-03). Thuần, không I/O.
// - Mỗi mẫu chỉ đọc đúng các biến khai báo — trường thừa (CCCD, SĐT, số tài khoản…) có trong `vars` cũng không lọt ra.
// - Email KHÔNG ghi số tiền (Q-03); thông báo trong app (đã đăng nhập) ghi đủ.
// - Giá trị bị bỏ ký tự điều khiển/xuống dòng (chống chèn header khi có adapter SMTP), cắt độ dài.
// - Giá trị chữ tự do (tên cơ sở, mã phòng…) có dạng số CCCD/CMND (9/12 chữ số liền), SĐT Việt Nam hay số tài khoản
//   10–19 chữ số → thay bằng `***` (vd tên "Nhà nghỉ Hoa Mai - 0100003456" vẫn gửi được, không lộ số).
// - Lưới cuối: nội dung render vẫn còn các dạng đó → TemplateError (mặc định an toàn: không gửi thay vì lộ).
import { formatDate, formatVnd } from "@hm/domain";
import { t } from "../i18n.ts";

export const NOTIFICATION_TYPES = [
  "account_security",
  "invoice_issued",
  "invoice_overdue",
  "lease_expiring",
  "stay_notice_due",
  "maintenance_status",
  "export_ready",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** Loại bắt buộc — không tắt được (S-011, ERD `ck_notification_preferences_required`). */
export const REQUIRED_TYPES: ReadonlySet<NotificationType> = new Set(["account_security"]);

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export type Vars = Readonly<Record<string, unknown>>;

export interface Rendered {
  title: string;
  body: string;
  link: string | null;
  emailSubject: string;
  emailText: string;
}

const MAX_VALUE = 200;

// Biên: không dính chữ số, và dấu chấm chỉ bị coi là một phần số khi là dấu phân cách nghìn (`1.580.000`) — số dính dấu
// chấm câu/viết tắt (`ĐT.0905123456`, `… 0905123456.`) vẫn bị bắt.
const DOC_NO = /(?<!\d)(?<!\d\.)\d{9}(?:\d{3})?(?!\d)(?!\.\d)/;
const PHONE = /(?<!\d)(?<!\d\.)(?:\+?84|0)(?:[\s.-]?\d){9,10}(?!\d)(?!\.\d)/;
const ACCOUNT_NO = /(?<!\d)(?<!\d\.)\d{10,19}(?!\d)(?!\.\d)/;

/** Dạng nhạy cảm không được xuất hiện trong nội dung render (S-012). */
const SENSITIVE: readonly [string, RegExp][] = [
  [t("notify.sensitive.document_no"), DOC_NO],
  [t("notify.sensitive.phone"), PHONE],
  [t("notify.sensitive.account_no"), ACCOUNT_NO],
];

/** Che các dạng nhạy cảm trong một giá trị biến (SĐT trước: dạng có dấu cách/chấm dài hơn dạng số liền). */
function redact(s: string): string {
  let out = s;
  for (const rx of [PHONE, DOC_NO, ACCOUNT_NO]) out = out.replace(new RegExp(rx.source, "g"), "***");
  return out;
}

function clean(v: unknown, name: string, opts: { redact?: boolean } = {}): string {
  if (v === undefined || v === null || v === "")
    throw new TemplateError(t("notify.error.missing_var", { name }));
  if (typeof v !== "string" && typeof v !== "number")
    throw new TemplateError(t("notify.error.var_wrong_type", { name }));
  // Ký tự điều khiển (CR/LF/NUL…) → khoảng trắng: chống chèn header khi có adapter SMTP.
  const s = Array.from(String(v), (ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x20 || c === 0x7f ? " " : ch;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!s) throw new TemplateError(t("notify.error.missing_var", { name }));
  const cut = (x: string) => (x.length > MAX_VALUE ? `${x.slice(0, MAX_VALUE - 1)}…` : x);
  if (opts.redact === false) return cut(s);
  // Che → cắt → che lại: che trước để số nằm vắt qua chỗ cắt không còn lại phần dở (8/10 chữ số SĐT), che lại để dãy số
  // quá dài (≥ 20 chữ số, không khớp mẫu) bị cắt còn 10–19 chữ số cũng bị che.
  return redact(cut(redact(s)));
}

function str(vars: Vars, name: string): string {
  return clean(vars[name], name);
}

function vnd(vars: Vars, name: string): string {
  const v = vars[name];
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    throw new TemplateError(t("notify.error.var_not_integer_vnd", { name }));
  return formatVnd(v);
}

/** `YYYY-MM-DD` → `DD/MM/YYYY`. */
export function viDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new TemplateError(t("notify.error.invalid_date", { iso }));
  try {
    return formatDate(iso);
  } catch {
    throw new TemplateError(t("notify.error.invalid_date", { iso }));
  }
}

function date(vars: Vars, name: string): string {
  return viDate(str(vars, name));
}

function uuidLink(prefix: string, vars: Vars, name: string): string {
  // Mã kiểm bằng định dạng UUID, không che (nhóm cuối 12 chữ số liền là UUID hợp lệ).
  const id = clean(vars[name], name, { redact: false });
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new TemplateError(t("notify.error.var_not_id", { name }));
  return `${prefix}/${id}`;
}

const MAINTENANCE_LABEL: Readonly<Record<string, string>> = {
  assigned: t("notify.maintenance.assigned"),
  in_progress: t("notify.maintenance.in_progress"),
  done: t("notify.maintenance.done"),
  verified: t("notify.maintenance.verified"),
  cancelled: t("notify.maintenance.cancelled"),
};

const SEVERITY_PREFIX: Readonly<Record<string, string>> = {
  normal: "",
  urgent: t("notify.severity.urgent"),
  overdue: t("notify.severity.overdue"),
};

type Builder = (vars: Vars) => Omit<Rendered, "emailText"> & { emailLines: string[] };

const BUILDERS: Readonly<Record<NotificationType, Builder>> = {
  account_security: (v) => {
    const org = str(v, "orgName");
    if (v.kind === "tenant_invited") {
      // Lời mời vào cổng người thuê (SPEC-portal S-014): đăng nhập bằng mã gửi về chính email này (không mật khẩu).
      return {
        title: t("notify.invite.title", { org }),
        body: t("notify.invite.body"),
        link: "/dang-nhap",
        emailSubject: t("notify.invite.title", { org }),
        emailLines: [
          t("notify.invite.email_1", { org }),
          t("notify.invite.email_2"),
          t("notify.invite.email_3"),
        ],
      };
    }
    if (v.kind === "mfa_reset" || v.kind === "password_changed" || v.kind === "mfa_disabled") {
      // Sự kiện bảo mật của chính tài khoản (T-405): nêu việc đã xảy ra + cách xử lý, KHÔNG kèm IP/thiết bị/người thực hiện.
      const what =
        v.kind === "mfa_reset"
          ? t("notify.security.mfa_reset")
          : v.kind === "mfa_disabled"
            ? t("notify.security.mfa_disabled")
            : t("notify.security.password_changed");
      const act = str(v, "action");
      return {
        title: `${org}: ${act}`,
        body: t("notify.security.body", { what }),
        link: "/tai-khoan",
        emailSubject: `${org}: ${act}`,
        emailLines: [`${what}`, t("notify.security.advice")],
      };
    }
    const action = str(v, "action");
    return {
      title: `${org}: ${action}`,
      body: t("notify.security.generic_body", { action }),
      link: "/tai-khoan",
      emailSubject: `${org}: ${action}`,
      emailLines: [
        t("notify.security.generic_email_1", { org, action }),
        t("notify.security.generic_email_2"),
      ],
    };
  },
  invoice_issued: (v) => {
    const p = str(v, "propertyName");
    const period = str(v, "period");
    const due = date(v, "dueOn");
    return {
      title: t("notify.invoice_issued.title", { period }),
      body: t("notify.invoice_issued.body", { property: p, period, amount: vnd(v, "amount"), due }),
      link: uuidLink("/portal/phieu-thu", v, "invoiceId"),
      emailSubject: t("notify.invoice_issued.email_subject", { property: p, period }),
      emailLines: [t("notify.invoice_issued.email_line", { property: p, period, due })],
    };
  },
  invoice_overdue: (v) => {
    const p = str(v, "propertyName");
    const period = str(v, "period");
    const due = date(v, "dueOn");
    return {
      title: t("notify.invoice_overdue.title", { period }),
      body: t("notify.invoice_overdue.body", { property: p, period, amount: vnd(v, "amount"), due }),
      link: uuidLink("/portal/phieu-thu", v, "invoiceId"),
      emailSubject: t("notify.invoice_overdue.email_subject", { property: p, period }),
      emailLines: [t("notify.invoice_overdue.email_line", { period, property: p, due })],
    };
  },
  lease_expiring: (v) => {
    const p = str(v, "propertyName");
    const unit = str(v, "unitCode");
    const end = date(v, "endOn");
    return {
      title: t("notify.lease_expiring.title", { unit, end }),
      body: t("notify.lease_expiring.body", { property: p, unit, end }),
      // Người thuê (người đại diện) mở portal; nhân viên mở trang hợp đồng.
      link: v.audience === "tenant" ? "/portal/hop-dong" : uuidLink("/hop-dong", v, "leaseId"),
      emailSubject: t("notify.lease_expiring.email_subject", { property: p, unit }),
      emailLines: [t("notify.lease_expiring.email_line", { unit, property: p, end })],
    };
  },
  stay_notice_due: (v) => {
    const p = str(v, "propertyName");
    if (v.kind === "config_missing") {
      // S-020: cơ sở chưa cấu hình hạn thông báo lưu trú (không có mặc định cứng — Q-08).
      return {
        title: t("notify.stay_config.title"),
        body: t("notify.stay_config.body", { property: p }),
        link: "/cai-dat/thong-bao",
        emailSubject: t("notify.stay_config.email_subject", { property: p }),
        emailLines: [t("notify.stay_config.email_line", { property: p })],
      };
    }
    const unit = str(v, "unitCode");
    const dueAt = str(v, "dueAtLocal");
    const sev = SEVERITY_PREFIX[String(v.severity ?? "normal")] ?? "";
    return {
      title: t("notify.stay_notice.title", { sev, unit }),
      body: t("notify.stay_notice.body", { sev, unit, due: dueAt }),
      link: uuidLink("/luu-tru", v, "noticeId"),
      emailSubject: t("notify.stay_notice.email_subject", { property: p, sev, unit }),
      emailLines: [t("notify.stay_notice.email_line", { sev, unit, property: p, due: dueAt })],
    };
  },
  maintenance_status: (v) => {
    const p = str(v, "propertyName");
    const unit = str(v, "unitCode");
    const label = MAINTENANCE_LABEL[str(v, "status")];
    if (!label) throw new TemplateError(t("notify.error.invalid_work_order_status"));
    return {
      title: t("notify.maintenance_status.title", { unit, label }),
      body: t("notify.maintenance_status.body", { property: p, unit, label }),
      link: uuidLink("/portal/su-co", v, "workOrderId"),
      emailSubject: t("notify.maintenance_status.email_subject", { property: p, unit, label }),
      emailLines: [t("notify.maintenance_status.email_line", { unit, property: p, label })],
    };
  },
  export_ready: (v) => {
    const name = str(v, "exportName");
    return {
      title: t("notify.export_ready.title", { name }),
      body: t("notify.export_ready.body", { name }),
      link: uuidLink("/xuat-du-lieu", v, "exportId"),
      emailSubject: t("notify.export_ready.title", { name }),
      emailLines: [t("notify.export_ready.email_line", { name })],
    };
  },
};

function assertNoSensitive(text: string): void {
  for (const [what, rx] of SENSITIVE)
    if (rx.test(text)) throw new TemplateError(t("notify.error.sensitive_content", { what }));
}

/** Render thông báo; `baseUrl` (vd https://app.example) để email có liên kết tuyệt đối tới trang cần đăng nhập. */
export function render(
  type: NotificationType,
  vars: Vars,
  opts: { baseUrl?: string; unsubscribeUrl?: string } = {},
): Rendered {
  const b = BUILDERS[type];
  if (!b) throw new TemplateError(t("notify.error.no_template", { type }));
  const r = b(vars);
  const lines = [
    t("notify.email.greeting"),
    "",
    ...r.emailLines,
    ...(r.link
      ? ["", t("notify.email.link", { url: `${(opts.baseUrl ?? "").replace(/\/$/, "")}${r.link}` })]
      : []),
    "",
    "—",
    t("notify.email.footer"),
    ...(opts.unsubscribeUrl && !REQUIRED_TYPES.has(type)
      ? [t("notify.email.unsubscribe", { url: opts.unsubscribeUrl })]
      : []),
  ];
  const out: Rendered = {
    title: r.title,
    body: r.body,
    link: r.link,
    emailSubject: r.emailSubject,
    emailText: lines.join("\n"),
  };
  assertNoSensitive([out.title, out.body, out.emailSubject, ...r.emailLines].join("\n"));
  return out;
}

/** Che email trong log: `an.nguyen@example.com` → `a***@example.com` (S-012). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export type DeliveryStatus = "queued" | "sending" | "sent" | "retrying" | "failed" | "dead" | "suppressed";

/** Nhãn trung thực cho lịch sử gửi (S-006): không bao giờ "đã nhận"; `sent` = đã chuyển cho nhà cung cấp. */
export function deliveryStatusLabel(status: DeliveryStatus, suppressedReason?: string | null): string {
  switch (status) {
    case "queued":
    case "sending":
      return t("notify.delivery.pending");
    case "retrying":
      return t("notify.delivery.retrying");
    case "sent":
      return t("notify.delivery.sent");
    case "failed":
    case "dead":
      return t("notify.delivery.failed");
    case "suppressed":
      return suppressedReason === "OPTED_OUT"
        ? t("notify.delivery.opted_out")
        : suppressedReason === "NO_ADDRESS"
          ? t("notify.delivery.no_address")
          : t("notify.delivery.settled");
  }
}
