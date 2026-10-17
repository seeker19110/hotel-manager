# Sự kiện bảo mật (SEC-LOG-001/002)

Mọi sự kiện đi qua `emitSecurity` (`packages/app/src/logging/security-events.ts`) → `logger.security()`: một dòng JSON, `category = "security"`,
`level = "warn"`, `severity_number = 13`. Hình dạng cố định (schema kiểm bằng `securityRecordSchema` trong test):

| Trường | Ý nghĩa |
|---|---|
| `event` (= `msg`) | Tên sự kiện trong bảng dưới |
| `actor` | `{ user_id, org_id, membership_id, role }` (UUID/vai trò, không tên/email/SĐT); `null` khi chưa xác thực. Chưa xác định được membership → chỉ có `user_id` + `org_id` |
| `target` | `{ type, id }` — `endpoint`/`command`/`query`/`membership`/`export_job`/`guest_access_link`; `null` nếu không có |
| `outcome` | `success` · `denied` · `failure` |
| `source_ip` | IP **đã cắt**: IPv4 → `/24` (`a.b.c.0`), IPv6 → `/48` (`x:y:z::`); không hợp lệ → `null` |
| `user_agent` | ≤ 200 ký tự, bỏ ký tự điều khiển; `null` nếu thiếu |
| `reason` | Mã lý do ngắn (mã lỗi nghiệp vụ…) hoặc `null` |
| `correlation_id` | Khớp `x-correlation-id` của response và `audit_events.correlation_id` |

Cộng các trường chung của logger: `ts`, `service`, `version`, `env`.

**IP:** không ghi IP đầy đủ, cũng không ghi băm trần (IPv4 chỉ 2^32 giá trị — băm không muối đảo ngược được trong vài giây). IP cắt đủ để gom
theo mạng/nhà cung cấp, không định danh một thiết bị. Cần IP đầy đủ khi điều tra → nhật ký reverse proxy (hạn giữ ngắn, quyền hạn chế).
Nguồn IP: hop PHẢI NHẤT của `X-Forwarded-For` (do proxy tin cậy duy nhất nối thêm; hop đầu do client tự khai nên không dùng) — ràng buộc triển khai ở RUNBOOK §11.

## Danh mục

| `event` | Khi nào | Phát ở | Test |
|---|---|---|---|
| `auth.unauthenticated` | 401 không có phiên | `http/command-route.ts` `actorFromRequest` | `logging/security-events.db.test.ts` |
| `authz.denied` | 403 (thiếu quyền, thiếu MFA) từ command hoặc query | `pipeline/command.ts` (lệnh), `command-route.ts` (query, MFA) | idem |
| `authz.org_not_found` | 404 vì không thuộc tổ chức được yêu cầu (dò tổ chức khác) | `command-route.ts` | idem |
| `rate_limit.exceeded` | 429 (xuất dữ liệu ≤ 10/giờ/người; liên kết khách ≤ 10 lần sai/phút/IP) | `pipeline/command.ts`, `portal/guest.ts` | idem |
| `auth.reauth_required` | 401 `REAUTH_REQUIRED` (xuất dữ liệu cần xác thực lại ≤ 5 phút) | `pipeline/command.ts` | idem |
| `export.downloaded` | Cấp link tải bản xuất (sau commit) | `exports/exports.ts` `downloadExport` | idem |
| `member.mfa_reset` | Owner đặt lại MFA của thành viên | `access/mfa-recovery.ts` | idem |
| `portal.tenant_access_revoked` | Thu hồi quyền portal của người thuê (lần đầu, không phát lại khi đã thu hồi) | `portal/access.ts` | idem |
| `guest_link.revoked` | Nhân viên thu hồi liên kết khách | `portal/guest.ts` `revokeGuestLink` | idem |
| `guest_link.denied` | Liên kết khách bị từ chối (token sai, sai bước hai, đã thu hồi/khoá) — không ghi token | `portal/guest.ts` `guestGetStay` | idem |
| `guest_link.locked` | Liên kết khách bị khoá do sai bước hai quá số lần | `portal/guest.ts` | idem |
| `auth.login` | Đăng nhập: `success` (`reason` = `password` · `email_otp` · `mfa`), `failure` (`invalid_credentials` · `otp_invalid` · `otp_not_allowed` · `mfa_invalid`), `denied` (`account_locked`). Mật khẩu đúng nhưng còn bước hai (MFA) ⇒ CHƯA phát `success`; phát khi xác minh bước hai xong | `auth/auth.ts` hook → `auth/auth-events.ts` | `auth/auth-events.db.test.ts` |
| `auth.logout` | Đăng xuất (phiên có thật) | idem | idem |
| `auth.account_locked` | Lần sai khiến tài khoản bị khoá tạm (5 lần/15 phút) | idem | idem |
| `auth.password_changed` | Đổi mật khẩu: `success`; `failure` (`invalid_password`) | idem | idem |
| `auth.mfa_enabled` | Hoàn tất đăng ký MFA lần đầu (`success`); mã xác minh sai (`failure`, `mfa_invalid`) | idem | idem |
| `auth.mfa_disabled` | Tắt MFA: `success`; `failure` (`invalid_password`) | idem | idem |

Sự kiện thành công (`ctx.security`) chỉ phát **sau commit**; lệnh bị rollback hoặc replay cùng `Idempotency-Key` không phát. Sự kiện từ chối của
command phát một lần cho mỗi `Idempotency-Key`.

**Sự kiện xác thực (T-405).** Phát từ hook Better Auth; `actor.user_id` + `target {type: "account", id}` là UUID người dùng (không email/tên). Không bao giờ
ghi mật khẩu, OTP, mã TOTP. Đăng nhập sai với email lạ: `actor = null`, `target.id = null`. Ngoài log, các sự kiện **đã xác thực hoặc chuyển trạng thái**
(đăng nhập thành công, đăng xuất, bật/tắt MFA, đổi mật khẩu, khoá tài khoản) được ghi `audit_events` (`action` = tên sự kiện, `entity_type = membership`) ở **mỗi tổ chức**
người đó còn membership hiệu lực, kèm `source_ip`/`user_agent` — owner xem được "ai đăng nhập/đổi bảo mật ở đâu". Từng lần đăng nhập SAI chỉ ở log, không vào audit
(ai biết email cũng gây được; bảng append-only sẽ bị làm đầy). Đổi mật khẩu/tắt MFA còn sinh sự kiện outbox `member.password_changed`/`member.mfa_disabled` ⇒ thông báo `account_security`
(cùng `member.mfa_reset` khi owner đặt lại MFA) cho chính người đó.

**Audit "từ đâu".** `audit_events.source_ip` (đã cắt /24, /48; CSDL chặn dạng khác) và `user_agent` (≤ 200 ký tự, NFC) do pipeline lệnh ghi từ `requestClient`; việc của worker/hệ thống: `NULL`.
Còn lại, đường ghi audit ngoài pipeline (truy vấn bị từ chối `person.read`/`portal.access_denied`, job worker) chưa có client ⇒ `NULL`.

Chưa có (xem `docs/autopilot/BLUEPRINT-GAPS.md` mục `SEC-LOG-001`): cấp/thu hồi token, đổi cấu hình, upload, lỗi validate/deserialize.
