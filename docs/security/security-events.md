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
| `guest_link.issued` | Cấp liên kết khách (token xem lưu trú): `target` = id liên kết; **token không bao giờ vào log** (CSDL chỉ giữ băm) | `portal/guest.ts` `createGuestLink` | `logging/security-events-sec-log.db.test.ts` |
| `portal.tenant_access_granted` | Cấp quyền portal cho người thuê (membership vai `tenant`, lần đầu; mời lại cùng người không phát lại): `target` = id membership, không email | `portal/access.ts` `inviteTenant` | idem |
| `config.changed` | Đổi cấu hình (hiện: cấu hình thông báo/hạn lưu trú theo cơ sở): `target` = `notification_settings`/id cơ sở, `reason` = tên audit; giá trị trước/sau ở `audit_events`, không vào log | `notifications/preferences.ts` `updateSettings` | idem |
| `file.uploaded` | Tải file lên thành công (`ready`; file nguồn của lô nhập): `target` = `file`/`import_batch` + id; không ghi tên file | `files/files.ts` `uploadFile`, `import/import.ts` `uploadBatch` | idem |
| `file.upload_rejected` | Tải file bị từ chối: quét an toàn từ chối (`SCAN_REJECTED`, sau commit), quá lớn (`FILE_TOO_LARGE`), loại không cho phép (`FILE_TYPE_NOT_ALLOWED`) | `files/files.ts`, `http/file-upload.ts`, `http/import-upload.ts`, `pipeline/command.ts` | idem |
| `input.validation_failed` | Đầu vào bị 422: sai schema ở biên HTTP (lệnh, truy vấn, upload, webhook) hoặc quy tắc nghiệp vụ `VALIDATION_FAILED`; chỉ mã lý do, **không** giá trị người dùng gửi | `http/command-route.ts` (`rejectInput`), `http/webhook-route.ts`, `pipeline/command.ts` | idem |
| `input.deserialize_failed` | Thân yêu cầu không đọc được (không phải JSON/multipart hợp lệ, 400 `MALFORMED_REQUEST`) | idem | idem |
| `backend.tls_error` | Lỗi TLS/chứng chỉ khi nối backend (CSDL, S3, SMTP…): nhận theo mã lỗi OpenSSL/Node (`CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_*`…), `outcome = failure`, `reason` = mã | `logging/tls-errors.ts` (gọi từ `reportUnexpectedError`) | `logging/tls-errors.test.ts` |
| `member.invited` | Cấp lời mời nhân viên (token 256 bit dẫn xuất, chỉ băm được lưu): `target` = id lời mời; **token/email không vào log** | `access/invitations.ts` `inviteMember` | `access/invitations.db.test.ts` |
| `member.accepted` | Chấp nhận lời mời ⇒ cấp quyền (membership mới): `target` = id membership | `access/accept-invitation.ts` | idem |
| `invitation.rejected` | Chấp nhận lời mời bị từ chối (410 `INVITATION_INVALID`): `reason` = `unknown_token` · `status_<accepted\|expired\|revoked>` · `expired` · `email_mismatch` — phản hồi cho client không phân biệt | `access/accept-invitation.ts` | idem |
| `member.role_changed` | Owner đổi vai trò nhân viên (lần thay đổi thật; đặt lại đúng vai trò cũ không phát): `target` = id membership, `reason` = vai trò mới; trước/sau + lý do ở `audit_events`. Lần thử bị từ chối ⇒ `authz.denied` + audit `member.role_change_denied` | `access/members.ts` `updateMemberRole` | `access/members.db.test.ts` |
| `member.scope_changed` | Owner đổi phạm vi cơ sở của nhân viên: `target` = id membership. Lần thử bị từ chối ⇒ `authz.denied` + audit `member.scope_change_denied` | `access/members.ts` `updateMemberScope` | idem |
| `session.revoked` | Thu hồi MỌI phiên của một tài khoản (`session.revokeAll`, tự mình hoặc owner/manager thu hồi nhân viên): `target` = id membership; số phiên ở `audit_events` (`session.revoked`). Request kế tiếp mang cookie phiên đó ⇒ 401 `SESSION_REVOKED` ⇒ `auth.unauthenticated` với `reason = SESSION_REVOKED` | `access/sessions.ts` `revokeAllSessions`; `http/command-route.ts` | `access/sessions.db.test.ts` |
| `privacy.dsar_requested` | Người dùng thực hiện quyền chủ thể dữ liệu với CHÍNH tài khoản mình (T-2311): xuất dữ liệu, yêu cầu xoá tài khoản, bật/tắt hạn chế xử lý; `target` = `dsar_request` + id yêu cầu, `reason` = loại (`access`/`delete`/`restrict`). Bị từ chối vì chưa xác thực lại ⇒ `auth.reauth_required`; owner duy nhất ⇒ `outcome = denied`, `reason = SOLE_OWNER`. Không ghi email/tên | `http/dsar-route.ts` | `privacy/dsar.db.test.ts` |
| `support.access_granted` | Owner cấp truy cập hỗ trợ có thời hạn (≤ 72 giờ, có lý do) cho nhân viên hỗ trợ nền tảng: `target` = id `support_grants`; lý do + hạn ở `audit_events` (`support.access_granted`). Mọi truy cập của hỗ trợ sau đó ghi `audit_events` `actor_type = platform_support` + `support_grant_id` | `access/support.ts` `grantSupportAccess` | `access/support.db.test.ts` |
| `support.access_revoked` | Owner thu hồi truy cập hỗ trợ (một bước): `target` = id `support_grants`; request kế tiếp của hỗ trợ ⇒ 404 (không còn membership hiệu lực) | `access/support.ts` `revokeSupportAccess` | idem |

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

**Phạm vi của "cấp/thu hồi token" và "đổi vai/quyền" trong sản phẩm này.** Token do hệ thống cấp: liên kết khách (`guest_link.issued`/`guest_link.revoked`; link khách là token thật, chỉ băm được lưu). Phiên đăng nhập do Better Auth quản (`auth.login`/`auth.logout`). Quyền: các thao tác đổi quyền truy cập là mời/chấp nhận nhân viên (`member.invited`/`member.accepted`), đổi vai trò/phạm vi nhân viên (`member.role_changed`/`member.scope_changed`), cấp/thu hồi quyền người thuê (`portal.tenant_access_granted`/`portal.tenant_access_revoked`), cấp/thu hồi truy cập hỗ trợ (`support.access_granted`/`support.access_revoked`) và đặt lại MFA (`member.mfa_reset`). Khi thêm lệnh đổi vai/quyền mới phải thêm sự kiện (và dòng ở bảng trên) cùng lúc.

**Cấu hình.** Mọi lệnh đổi cấu hình tổ chức/cơ sở phải gọi `ctx.security({ event: "config.changed", … })`. Bảng giá/loại phòng/dịch vụ là dữ liệu nghiệp vụ (audit_events), không phải cấu hình bảo mật.

**Trace.** Mọi bản ghi phát ra trong request HTTP hoặc job worker có `trace_id` + `span_id` (W3C `traceparent`; xem `docs/design/API-CONTRACT.md` §Trace). Mọi bản ghi (kể cả sự kiện bảo mật) phải hợp lệ với `packages/app/src/logging/log-record.schema.json`.
