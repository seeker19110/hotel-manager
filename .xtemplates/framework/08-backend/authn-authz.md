---
title: Xác thực, phiên, token, phân quyền (RBAC/ABAC), đa yếu tố
kind: module
prefix: BE-AUTH
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-16
---

# Xác thực, phiên, token, phân quyền (RBAC/ABAC), đa yếu tố

> **Nhà duy nhất** của khung cho xác thực, phiên, token, OAuth/OIDC, passkey, MFA và phân quyền. Module khác
> (`12-security/appsec-web`, hồ sơ, gói ngành) chỉ nêu lớp lỗ hổng rồi trỏ về đây. Áp dụng cho mọi hệ có
> người dùng hoặc client cần định danh.

## Nguyên tắc

1. **Deny-by-default, kiểm ở server, mọi request (P7).** Không có "endpoint quên kiểm"; guard đặt ở tầng
   middleware/filter, danh sách endpoint công khai là allowlist có duyệt.
2. **Kiểm quyền theo object, không chỉ theo vai.** IDOR là lỗi phổ biến nhất: biết ID là xem được. Mỗi truy cập
   phải hỏi "người này có quyền trên *bản ghi này* không".
3. **Không tự chế mật mã.** Băm mật khẩu bằng Argon2id tham số OWASP; token ngẫu nhiên từ CSPRNG; JWT theo
   RFC 8725; OAuth theo RFC 9700/OAuth 2.1; passkey theo WebAuthn Level 3 — dùng thư viện đã kiểm định.
4. **Phiên có vòng đời.** Tạo lại ID khi đổi đặc quyền, hết hạn idle + tuyệt đối ở server, logout vô hiệu ở
   server, đổi mật khẩu/MFA làm hết hạn phiên khác.
5. **Đi theo NIST SP 800-63B-4:** không ép ký tự phức tạp, không bắt đổi định kỳ, kiểm blocklist mật khẩu lộ,
   cho phép dán và trình quản lý mật khẩu, giới hạn lần thử.

## Quyết định

| Câu hỏi | Chọn | Điều kiện / khi nào không |
|---|---|---|
| Web app cùng origin, có server render hoặc BFF | **Session cookie** (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax/Strict`), lưu phiên server-side | Không dùng khi client là app native/SPA nhiều domain cần token mang đi |
| SPA/mobile gọi API, nhiều dịch vụ | **Access token ngắn hạn (5–15 phút) + refresh token xoay vòng** (public client bắt buộc xoay hoặc sender-constrained); token lưu memory (SPA) / Keychain-Keystore (mobile) | Không đặt refresh token trong `localStorage`; không JWT sống 24 giờ không thu hồi được |
| Đăng nhập bằng Google/Microsoft/doanh nghiệp | **OIDC Authorization Code + PKCE** (OAuth 2.1); không implicit, không password grant | Tự viết luồng OAuth thay vì thư viện |
| Nhiều app nội bộ, SSO | IdP tập trung (Keycloak/Authentik/dịch vụ) + OIDC | Mỗi app một bảng user riêng |
| Yếu tố thứ hai | **Passkey/FIDO2 (chống phishing) > TOTP > push có number matching > SMS** (SMS chỉ khi không còn cách, không cho PII/tài chính) | — |
| Mô hình phân quyền | **RBAC** cho ≤ ~10 vai tĩnh; **ABAC/ReBAC** (OpenFGA/Cerbos/OPA/Casbin) khi multi-tenant, quyền theo object, theo quan hệ | Nhồi vai mới mỗi khi có ngoại lệ (role explosion) |
| Tự build hay dùng dịch vụ auth | Dùng thư viện/dịch vụ trưởng thành (P4); tự build chỉ phần policy nghiệp vụ | Tự viết băm, token, OAuth |
| API machine-to-machine | OAuth client credentials hoặc API key băm lưu DB, scope hẹp, xoay được | API key là chuỗi so sánh thuần, không scope |

## Checklist

- [ ] `BE-AUTH-001` **MUST** Băm mật khẩu bằng Argon2id với tham số ≥ OWASP (m=19456 KiB, t=2, p=1 hoặc tương đương); scrypt/bcrypt (cost ≥ 10, giới hạn 72 byte) chỉ khi nền tảng không có Argon2id; lưu tham số trong chuỗi PHC để nâng cấp dần. → Kiểm: test đọc hash có tiền tố `$argon2id$` và tham số đúng; không có `md5`/`sha1`/`sha256` mật khẩu trong code. · Nguồn: OWASP Password Storage Cheat Sheet, RFC 9106, ASVS 5.0 V6
- [ ] `BE-AUTH-002` **MUST@L** Chính sách mật khẩu theo NIST: tối thiểu 8 ký tự khi có MFA, 15 khi là yếu tố duy nhất; cho phép ≥ 64 ký tự và Unicode; không ép quy tắc ký tự; không bắt đổi định kỳ; kiểm blocklist mật khẩu lộ (vd Pwned Passwords k-anonymity). → Kiểm: test mật khẩu 7 ký tự → từ chối; 64 ký tự → chấp nhận; `password123` → từ chối vì blocklist. · Nguồn: NIST SP 800-63B-4 §3.1.1, OWASP Authentication Cheat Sheet
- [ ] `BE-AUTH-003` **MUST@L** Giới hạn đăng nhập thất bại theo tài khoản (không chỉ IP): khoá/trì hoãn luỹ tiến, trần ≤ 100 lần thất bại liên tiếp; thông báo lỗi chung ("sai tài khoản hoặc mật khẩu") và thời gian phản hồi đồng đều để không lộ tài khoản tồn tại. → Kiểm: test 20 lần sai → bị chặn; so sánh body/thời gian giữa user tồn tại và không tồn tại. · Nguồn: NIST SP 800-63B-4, OWASP Authentication Cheat Sheet
- [ ] `BE-AUTH-004` **MUST** Session ID ≥ 128 bit từ CSPRNG; cookie phiên có `__Host-` + `Secure` + `HttpOnly` + `SameSite` (Lax/Strict); phiên lưu và vô hiệu ở server khi logout; tạo lại ID sau đăng nhập/đổi đặc quyền. → Kiểm: test logout rồi dùng lại cookie → 401; ID trước/sau đăng nhập khác nhau; `Set-Cookie` có đủ thuộc tính. · Nguồn: OWASP Session Management Cheat Sheet, ASVS 5.0 V7
- [ ] `BE-AUTH-005` **MUST@L** Phiên có hết hạn idle và hết hạn tuyệt đối thực thi ở server (giá trị theo rủi ro: 15–30 phút idle cho app thường, 2–5 phút cho giá trị cao; tuyệt đối theo ngày làm việc); đổi mật khẩu/đặt lại MFA làm hết hạn mọi phiên khác. → Kiểm: test chỉnh đồng hồ/giả lập vượt idle → 401; đổi mật khẩu → phiên thứ hai 401. · Nguồn: OWASP Session Management Cheat Sheet
- [ ] `BE-AUTH-006` **MUST@L** JWT (nếu dùng): thuật toán cố định phía server (không đọc `alg` từ token, từ chối `none`), xác minh `iss`, `aud`, `exp`, `nbf`; khoá theo `kid` từ JWKS allowlist; access token ngắn hạn; thu hồi sớm qua denylist `jti` hoặc phiên server. → Kiểm: test token `alg: none` → 401; token `aud` khác → 401; token hết hạn → 401. · Nguồn: RFC 8725 (BCP 225), ASVS 5.0 V9
- [ ] `BE-AUTH-007` **MUST@L** Refresh token của public client (SPA/mobile) xoay vòng mỗi lần dùng, phát hiện tái sử dụng → thu hồi cả họ token; refresh token không lưu `localStorage`. → Kiểm: test dùng lại refresh token cũ → 401 và token mới bị thu hồi. · Nguồn: RFC 9700 §2.2.2, OAuth 2.1 draft-16
- [ ] `BE-AUTH-008` **MUST@L** OAuth/OIDC: chỉ Authorization Code + PKCE (S256) cho mọi client; không implicit, không resource owner password; redirect URI so khớp chuỗi chính xác; kiểm `state`/`nonce`; access token audience-restricted. → Kiểm: cấu hình IdP/client không có grant `implicit`/`password`; test redirect URI khác một ký tự → bị từ chối. · Nguồn: RFC 9700 (BCP 240) §2.1, §2.3–2.4; draft-ietf-oauth-v2-1-16
- [ ] `BE-AUTH-009` **MUST** Mọi endpoint/handler không công khai (gồm Server Action, RPC, GraphQL resolver, WebSocket handshake, job trigger) kiểm xác thực và phân quyền ở server; `user_id` lấy từ phiên/token, không từ body/query. → Kiểm: test gọi với `user_id` khác trong body → vẫn thao tác trên user của token; scan route không guard = allowlist. · Nguồn: ASVS 5.0 V8, OWASP Authorization Cheat Sheet
- [ ] `BE-AUTH-010` **MUST** Kiểm quyền theo object cho mọi truy cập có ID (IDOR): truy vấn luôn kèm điều kiện sở hữu/tenant (`WHERE id = ? AND tenant_id = ?` hoặc RLS/policy engine); trả 404 hoặc 403 nhất quán. → Kiểm: test người dùng A đọc/sửa/xoá bản ghi của B qua ID → 403/404; test chạy cho mọi tài nguyên có ID. · Nguồn: OWASP Authorization Cheat Sheet, ASVS 5.0 V8
- [ ] `BE-AUTH-011` **MUST@L** Quyết định phân quyền tập trung một nơi (policy module/engine), có unit test "deny by default" và test theo ma trận vai × hành động; không rải `if role ==` trong handler. → Kiểm: test policy với vai không khai báo → deny; grep `role ==`/`isAdmin` ngoài policy module = 0. · Nguồn: OWASP Authorization Cheat Sheet
- [ ] `BE-AUTH-012` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-LOG-001`](../12-security/logging-audit-and-incident.md): ghi sự kiện xác thực/phân quyền (đăng nhập, khoá, đổi mật khẩu/MFA, từ chối quyền) có cấu trúc theo trường của `SEC-LOG-002`, không mật khẩu/token.
- [ ] `BE-AUTH-013` **MUST@L** MFA bắt buộc cho tài khoản quản trị và hành động nhạy cảm (đổi email/mật khẩu, tắt MFA, rút tiền, nâng quyền); xác thực lại bằng yếu tố hiện có trước khi đổi yếu tố; cung cấp mã khôi phục dùng một lần; OTP có TTL ngắn, dùng một lần, giới hạn lần thử. → Kiểm: test tắt MFA không xác thực lại → 403; OTP dùng lần hai → từ chối; 10 OTP sai → khoá. · Nguồn: OWASP MFA Cheat Sheet, RFC 6238 §5.2, NIST SP 800-63B-4 AAL2
- [ ] `BE-AUTH-014` **MUST@L** Passkey/WebAuthn (nếu có): server xác minh `challenge`, `origin`, `rpIdHash`, cờ user presence/verification, chữ ký và `signCount`; challenge dùng một lần; không tự parse CBOR mà dùng thư viện. → Kiểm: test assertion với origin khác → từ chối; replay challenge → từ chối. · Nguồn: W3C WebAuthn Level 3 §7.2, OWASP Authentication Cheat Sheet
- [ ] `BE-AUTH-015` **MUST@L** Luồng quên mật khẩu: token ngẫu nhiên ≥ 128 bit, dùng một lần, hết hạn ngắn (≤ 1 giờ), gửi qua kênh đã xác minh, phản hồi giống nhau dù email tồn tại hay không; không dùng câu hỏi bảo mật. → Kiểm: test token dùng lần hai → lỗi; email không tồn tại → cùng thông báo. · Nguồn: OWASP Forgot Password Cheat Sheet, NIST SP 800-63B-4
- [ ] `BE-AUTH-016` **MUST@L** API key/service credential: băm khi lưu (chỉ hiện một lần khi tạo), gắn scope và chủ sở hữu, xoay và thu hồi được, có ngày hết hạn; so sánh thời gian hằng. → Kiểm: bảng key không chứa key dạng rõ; test key bị thu hồi → 401. · Nguồn: ASVS 5.0 V6, OWASP REST Security Cheat Sheet
- [ ] `BE-AUTH-017` **SHOULD** Thông báo cho người dùng qua kênh ngoài (email) khi: đăng nhập từ thiết bị mới, đổi mật khẩu/email/MFA, nhiều lần đăng nhập thất bại. → Kiểm: test đổi mật khẩu → có email trong outbox test. · Nguồn: OWASP MFA Cheat Sheet
- [ ] `BE-AUTH-018` **SHOULD** Multi-tenant: `tenant_id` nằm trong mọi bảng dữ liệu nghiệp vụ và mọi truy vấn; tốt nhất thực thi bằng RLS/policy ở DB; test chéo tenant tự động. → Kiểm: test đăng nhập tenant A truy vấn bản ghi tenant B → rỗng; xem [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md).
- [ ] `BE-AUTH-019` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-WEB-007`](../12-security/appsec-web.md): chống CSRF cho request đổi trạng thái dùng cookie (`SameSite` + token hoặc kiểm `Origin`/`Sec-Fetch-Site`).
- [ ] `BE-AUTH-020` **SHOULD** Nâng cấp hash cũ khi người dùng đăng nhập (rehash nếu tham số thấp hơn mục tiêu); kế hoạch loại bỏ hash legacy có ngày. → Kiểm: test đăng nhập với hash tham số cũ → hash được ghi lại với tham số mới. · Nguồn: OWASP Password Storage Cheat Sheet
- [ ] `BE-AUTH-021` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-AI-007`](../12-security/ai-security.md): identity agent AI theo người dùng/phiên, scope hẹp, token ngắn hạn; tài khoản dịch vụ quyền tối thiểu theo `SEC-SECRET-006`.
- [ ] `BE-AUTH-022` **MAY** Dùng pepper (khoá bí mật ngoài DB, trong vault/HSM) cho hash mật khẩu, kèm quy trình xoay. → Kiểm: pepper không nằm trong repo/DB; xem [`../12-security/secrets-management.md`](../12-security/secrets-management.md).
- [ ] `BE-AUTH-023` **MAY** Sender-constrained token (DPoP RFC 9449 hoặc mTLS RFC 8705) cho API giá trị cao. → Kiểm: test dùng token với khoá DPoP khác → 401. · Nguồn: RFC 9700 §2.2.1
- [ ] `BE-AUTH-024` **MAY** Bước xác thực theo rủi ro (thiết bị/vị trí mới → yêu cầu MFA), không dùng vị trí làm yếu tố xác thực. → Kiểm: test đăng nhập từ UA/IP mới → prompt MFA. · Nguồn: OWASP MFA Cheat Sheet
- [ ] `BE-AUTH-025` **MUST@L** Nhận lời mời vào workspace/tenant chỉ sau khi **xác minh quyền sở hữu email bằng token** gửi tới đúng email đó (link/mã một lần trong thư mời); không suy từ việc đã có tài khoản đăng ký với email trùng, kể cả khi tài khoản ấy bị gắn `email_verified=true` bởi đường tự đăng ký. → Kiểm: test tạo tài khoản chưa xác minh trùng email người được mời → không có membership trong tenant; chỉ token từ thư mời mới nhận được lời mời. · Nguồn: `seeker19110/stored` 07 (Overmind tự host: `LocalSessionView` tạo tài khoản `email_verified=True` rồi `claim_pending_invites()` coi email trùng là bằng chứng sở hữu; đọc 2026-10-16)

## Bẫy thường gặp

- **"Dùng UUID nên không cần kiểm quyền".** UUID chỉ khó đoán, không phải kiểm soát truy cập; ID lộ qua log, link chia sẻ, API khác. Luôn kiểm quyền theo object.
- **Kiểm quyền ở frontend/route guard phía client.** Chỉ là UX; API vẫn mở. Server Action của Next.js là POST công khai (catalog 09 §1.4).
- **JWT làm phiên, không thu hồi được.** Người dùng logout/bị khoá nhưng token còn sống 24 giờ. Dùng access token ngắn + refresh xoay, hoặc phiên server.
- **Đọc `alg` từ header token** → tấn công key confusion (RS256 → HS256 với public key làm secret). Cố định thuật toán ở server.
- **Refresh token trong `localStorage`.** Một XSS = mất tài khoản. Cookie `HttpOnly` cho BFF hoặc memory + xoay vòng.
- **Khoá theo IP thay vì tài khoản.** Kẻ tấn công xoay IP; người dùng sau NAT bị khoá oan. Đếm theo tài khoản, thêm CAPTCHA sau N lần.
- **SMS là MFA mặc định.** SIM swap, SS7; NIST xếp là restricted. Ưu tiên passkey/TOTP.
- **Role explosion.** Thêm vai `editor_but_not_delete_v2` mỗi tuần. Chuyển sang ABAC/ReBAC khi quyền phụ thuộc object/quan hệ.
- **`user_id` lấy từ body request.** Mass assignment đổi chủ bản ghi. `user_id` luôn từ token/phiên.
- **Mâu thuẫn nguồn:** OWASP Session Management ghi entropy tối thiểu 64 bit nhưng khuyến nghị sinh ID ≥ 128 bit; khung chọn **128 bit** (an toàn hơn, rẻ) — ghi để không tranh cãi lại.
- **"Email trùng = đúng người" khi nhận lời mời:** ai đăng ký trước bằng email của người được mời vào thẳng tenant. Cần token gửi tới email (`BE-AUTH-025`).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Test IDOR/ma trận quyền | bộ test tích hợp chạy mọi tài nguyên × vai (tự viết, template trong [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md)) | CI `quality` | 0 fail; thêm tài nguyên mới phải thêm test (lint danh sách) |
| Route guard scan | script liệt kê route/handler không có middleware auth so với allowlist công khai (`check:route-perms`, catalog 23 §4.3) | CI | Diff rỗng |
| Semgrep (rules OSS; chú ý license rule registry) | `semgrep --config p/jwt --config p/owasp-top-ten` | CI | 0 finding mức ERROR |
| ZAP baseline / Schemathesis | `zap-baseline.py -t $URL` · `schemathesis run --checks all` | CI nightly / staging | 0 alert High; không 5xx |
| Thư viện | argon2-cffi 25.1.0 (Python), `argon2` npm, Spring Security Argon2PasswordEncoder, `golang.org/x/crypto/argon2` (xác minh 2026-10-13, xác minh lại trước khi dùng) | code | Tham số ≥ OWASP |
| Cookie/header check | test E2E assert `Set-Cookie` có `__Host-`, `Secure`, `HttpOnly`, `SameSite` | CI | 100% cookie phiên |
| Secret scan | gitleaks v8.30.1 (MIT) — chi tiết [`../12-security/secrets-management.md`](../12-security/secrets-management.md) | pre-commit + CI | 0 leak |

## Nguồn

- OWASP Password Storage Cheat Sheet (Argon2id m=19456, t=2, p=1; scrypt N=2^17; bcrypt ≥10; PBKDF2-SHA256 600k): <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html> — xác minh 2026-10-13
- RFC 9106 Argon2 (khuyến nghị Argon2id): <https://www.rfc-editor.org/rfc/rfc9106> — xác minh 2026-10-13
- NIST SP 800-63B-4 Digital Identity Guidelines: Authentication and Authenticator Management (8/15 ký tự, ≥64, không composition rule, không rotation, blocklist, ≤100 lần thử): <https://pages.nist.gov/800-63-4/sp800-63b.html> — xác minh 2026-10-13
- OWASP Session Management Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Authentication Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Authorization Cheat Sheet (deny by default, ABAC/ReBAC, IDOR, test): <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Multifactor Authentication Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html> — xác minh 2026-10-13
- RFC 8725 JSON Web Token Best Current Practices (BCP 225): <https://www.rfc-editor.org/rfc/rfc8725> — xác minh 2026-10-13
- RFC 9700 Best Current Practice for OAuth 2.0 Security (BCP 240): <https://www.rfc-editor.org/rfc/rfc9700> — xác minh 2026-10-13
- OAuth 2.1 draft-ietf-oauth-v2-1-16 (03/09/2026, **vẫn là Internet-Draft**, chưa RFC): <https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/> — xác minh 2026-10-13
- W3C Web Authentication Level 3 — Recommendation 25/08/2026: <https://www.w3.org/TR/webauthn-3/> — xác minh 2026-10-13
- RFC 6238 TOTP (bước 30 giây, không chấp nhận OTP dùng lại): <https://www.rfc-editor.org/rfc/rfc6238> — xác minh 2026-10-13
- OWASP ASVS 5.0.0 chương V6 Authentication, V7 Session Management, V8 Authorization, V9 Self-contained Tokens, V10 OAuth and OIDC: <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13
- (chưa xác minh) OWASP Forgot Password Cheat Sheet — không fetch ngày 2026-10-13; nội dung mục 015 lấy theo NIST + Authentication Cheat Sheet.
- `research/2026-10-13-stored-catalog-extraction.md` §2.5 (IDOR, Server Action), §2.11 (prompt không phải cơ chế bảo mật); catalog `09-engineering-checklists` §1.3 mục 4.4; `23-own-repos-lessons` §4.1 (API phải `validateAuth()` + user_id từ token).
- Catalog `seeker19110/stored` 07 (Overmind: nhận lời mời theo email trùng với `email_verified=True` tự gán) — đọc 2026-10-16.
