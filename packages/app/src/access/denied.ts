// Lần thử bị từ chối vẫn để lại dấu vết (SPEC-access S-018): `AuthzError` → `CommandError` kèm `persist`, nên pipeline ghi thêm một
// audit_events (chi tiết: ai thử làm gì trên ai) NGOÀI audit `command.denied` chung — ghi ở transaction riêng sau rollback,
// đúng một lần cho mỗi Idempotency-Key. Sự kiện bảo mật `authz.denied` do pipeline phát như mọi 403.
import { AuthzError } from "@hm/domain";
import { type AuditInput, CommandError } from "../pipeline/index.ts";

export function withDeniedAudit(err: unknown, audit: AuditInput): unknown {
  if (!(err instanceof AuthzError)) return err;
  return new CommandError(err.code, err.status, err.message, {
    persist: async (_trx, write) => {
      await write({ ...audit, reason: audit.reason ?? err.code });
      return {};
    },
  });
}

/** Chạy kiểm quyền; từ chối ⇒ ném lỗi đã gắn audit "lần thử bị từ chối". */
export function authorizeOrAudit(check: () => void, audit: AuditInput): void {
  try {
    check();
  } catch (err) {
    throw withDeniedAudit(err, audit);
  }
}
