---
title: AppSec web/API: injection, XSS, CSRF, SSRF, IDOR, header, CSP
kind: module
prefix: SEC-WEB
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site]
updated: 2026-10-16
---

# AppSec web/API: injection, XSS, CSRF, SSRF, IDOR, header, CSP

> Các lớp lỗ hổng ứng dụng web/API theo OWASP Top 10:2025, API Security Top 10 (2023) và ASVS 5.0, kèm biện pháp kiểm được
> bằng máy (SAST/DAST/test). Xác thực, phiên, token, phân quyền là **nhà** của
> [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md) — ở đây chỉ nêu lớp lỗ hổng và trỏ sang.

## Nguyên tắc

- **Không tin đầu vào, ở mọi lớp** (P6): validate theo schema ở biên (kiểu, độ dài, định dạng, allowlist), rồi *tham số hoá* ở nơi dùng
  (SQL, shell, LDAP, template, URL). Validate không thay tham số hoá và ngược lại.
- **Mã hoá đầu ra theo ngữ cảnh** (HTML, attribute, JS, URL, CSS): framework hiện đại escape mặc định — lỗi nằm ở chỗ *tắt* escape
  (`dangerouslySetInnerHTML`, `|safe`, `v-html`, `innerHTML`). Grep các điểm này là cổng.
- **Quyền kiểm tại server theo từng đối tượng** (BOLA/IDOR, API1:2023 — rủi ro số 1 của API): id trong URL/body là *gợi ý*, không phải quyền.
- **Mặc định an toàn trong header và cookie**: CSP chặt, HSTS, `nosniff`, `SameSite`, `Secure`, `HttpOnly`. Thêm header dễ hơn gỡ lỗ hổng.
- **Ranh giới ra ngoài cũng là ranh giới**: SSRF, webhook, redirect — allowlist đích, chặn dải nội bộ, không theo redirect.
- **Cổng máy ba tầng**: SAST trên PR (CodeQL/Semgrep) · DAST trên staging (ZAP) · test quyền tự viết cho từng route.

## Quyết định

| Lớp lỗ hổng | Biện pháp mặc định | Khi nào thêm/khác |
|---|---|---|
| Injection (SQL/NoSQL/OS/LDAP) | Query tham số hoá / ORM với bind; không nối chuỗi; `subprocess` dạng mảng, không `shell=True` | Query động theo cột → allowlist tên cột; shell bắt buộc → `shlex.quote` + allowlist lệnh |
| XSS | Escape mặc định của framework + CSP nonce/hash + `strict-dynamic` | Cần HTML người dùng → sanitizer (DOMPurify / bleach / OWASP Java HTML Sanitizer) với allowlist thẻ |
| CSRF (**nhà**: `SEC-WEB-007`) | Cookie phiên `SameSite=Lax` (hoặc `Strict`) **+** một lớp chống CSRF cho mọi request đổi trạng thái: token (synchronizer hoặc signed double-submit) **hoặc** kiểm `Origin`/`Sec-Fetch-Site` từ chối cross-site | API chỉ dùng Bearer token trong header → CSRF không áp dụng nhưng CORS phải chặt, và API đó **không** nhận cookie phiên làm phương án dự phòng (nhận cả hai thì quay lại `SEC-WEB-007`); có subdomain không tin (nội dung người dùng) → chỉ nhận `Sec-Fetch-Site: same-origin` hoặc dùng token |
| SSRF | Allowlist host/IP; resolve DNS rồi kiểm IP; chặn `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`; tắt redirect; chỉ `http(s)` | Webhook người dùng tự nhập → không thể allowlist: dùng egress proxy riêng + IMDSv2 + chặn metadata |
| IDOR/BOLA | Kiểm quyền theo đối tượng trong service layer; id không đoán được (UUID v4/v7) chỉ là lớp phụ | Multi-tenant → tenant_id trong mọi query (RLS/scoped repository), xem [`../03-industries/saas-multitenant.md`](../03-industries/saas-multitenant.md) |
| Mass assignment | DTO/schema allowlist trường ghi được | ORM bind thẳng request → cấu hình `fillable`/`allowedFields`, không dùng blocklist |
| Deserialization | Chỉ JSON/XML "data-only" + schema; cấm `pickle`, `unserialize()`, `BinaryFormatter`, Java native serialization với dữ liệu ngoài | Bắt buộc native → allowlist class + ký dữ liệu trước khi deserialize |
| Upload | Allowlist phần mở rộng + kiểm nội dung thật, giới hạn kích thước, tên file do server sinh, lưu ngoài webroot/object storage, quét malware | Ảnh → re-encode và bỏ metadata; chi tiết lưu trữ ở [`../08-backend/files-and-media.md`](../08-backend/files-and-media.md) |
| CORS | Không `*` khi có credential; allowlist origin cụ thể; không phản chiếu `Origin` | Public API không credential → `*` chấp nhận được |
| Rate limit / abuse | Giới hạn theo IP + theo tài khoản + theo endpoint nhạy cảm (login, OTP, export); trả 429 + `Retry-After` | Lạm dụng luồng nghiệp vụ (API6:2023) → giới hạn theo hành vi, CAPTCHA có kiểm chứng a11y |
| SAST | CodeQL (miễn phí cho repo public; private cần GitHub Advanced Security) hoặc Semgrep CE (engine LGPL-2.1; **rule chính thức theo Semgrep Rules License, không OSI, chỉ dùng nội bộ**) | Cần rule OSI → Opengrep hoặc tự viết rule; Python thêm `bandit`; Go thêm `gosec` |
| DAST | OWASP ZAP (Apache-2.0) baseline scan trên staging mỗi PR/đêm | API có OpenAPI → ZAP API scan với spec; xác thực bằng tài khoản test riêng |

## Checklist

- [ ] `SEC-WEB-001` **MUST** Mọi truy vấn CSDL/lệnh hệ thống dùng tham số hoá hoặc API mảng; không nối chuỗi từ đầu vào. → Kiểm: SAST (CodeQL `js/sql-injection`, `py/sql-injection`, Semgrep `sqli`/`subprocess-shell-true`) = 0 finding; grep `shell=True`, `exec(`, `${` trong câu SQL = 0 ngoài allowlist. · Nguồn: OWASP Top 10:2025 A05; ASVS 5.0 V1
- [ ] `SEC-WEB-002` **MUST@L** Mọi đầu vào (body, query, header, path, file) được validate theo schema ở biên trước khi vào logic; lỗi trả 400/422 có cấu trúc, không lộ stack. → Kiểm: test gửi payload sai kiểu/quá dài/thiếu trường cho mỗi endpoint → mã lỗi đúng; coverage schema = số route. · Nguồn: ASVS 5.0 V2
- [ ] `SEC-WEB-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BE-AUTH-010`](../08-backend/authn-authz.md): kiểm quyền theo đối tượng (BOLA/IDOR) cho mọi route có id, test "A gọi id của B".
- [ ] `SEC-WEB-004` **MUST** Output người dùng vào HTML qua escape mặc định; mọi điểm tắt escape có sanitizer allowlist và comment lý do. → Kiểm: grep `dangerouslySetInnerHTML|innerHTML|v-html|\|safe|mark_safe|raw\(` — mỗi điểm nằm trong allowlist file có review; DAST XSS = 0. · Nguồn: ASVS 5.0 V1, V3; Top 10:2025 A05
- [ ] `SEC-WEB-005` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`FE-SEC-003`](../07-frontend/client-security.md) (CSP strict nonce/hash + `strict-dynamic`) và [`FE-SEC-004`](../07-frontend/client-security.md) (Report-Only + `report-to` trước khi enforce).
- [ ] `SEC-WEB-006` **MUST@L** Header bảo mật tối thiểu: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` tắt tính năng không dùng; gỡ `Server`/`X-Powered-By`. → Kiểm: test đọc header trên mọi response HTML/API; ZAP baseline không cảnh báo thiếu header. · Nguồn: OWASP HTTP Headers CS; ASVS 5.0 V3, V12
- [ ] `SEC-WEB-007` **MUST** Request đổi trạng thái xác thực bằng cookie có chống CSRF: cookie phiên `SameSite=Lax|Strict` **và** một lớp chống CSRF — token (synchronizer / signed double-submit) **hoặc** kiểm `Origin`/`Sec-Fetch-Site` từ chối cross-site — cho mọi request đổi trạng thái; không dùng GET để đổi trạng thái. Đây là nhà của CSRF (`BE-AUTH-019`, `FE-SEC-016` trỏ về đây). → Kiểm: test POST/PUT/PATCH/DELETE giả cross-site (thiếu token, hoặc `Origin` lạ / `Sec-Fetch-Site: cross-site`) → 403; grep route GET có side-effect = 0; test đọc `Set-Cookie` có `SameSite`. · Nguồn: OWASP CSRF Prevention CS; ASVS 5.0 V3
- [ ] `SEC-WEB-008` **MUST** Mọi URL do người dùng cung cấp mà server sẽ gọi (webhook, import, avatar URL, preview) đi qua bộ kiểm SSRF: scheme allowlist, resolve DNS → kiểm IP không thuộc dải nội bộ/metadata, tắt redirect, timeout. → Kiểm: unit test với `http://169.254.169.254/`, `http://127.0.0.1:…`, `http://[::1]`, hostname trỏ IP nội bộ, redirect 302 sang nội bộ → bị chặn. · Nguồn: OWASP SSRF CS; API Top 10 2023 API7
- [ ] `SEC-WEB-009` **MUST@L** Ghi dữ liệu từ request vào model qua DTO/schema allowlist trường; không bind toàn bộ body. → Kiểm: test gửi thêm trường `role`/`is_admin`/`balance` → bị bỏ qua hoặc 400; SAST rule mass-assignment = 0. · Nguồn: OWASP Mass Assignment CS; API Top 10 2023 API3
- [ ] `SEC-WEB-010` **MUST@L** Không deserialize native dữ liệu không tin (`pickle`, `yaml.load` không safe, `unserialize`, `BinaryFormatter`, `ObjectInputStream` không filter). → Kiểm: SAST (Semgrep `avoid-pickle`, CodeQL `unsafe-deserialization`) = 0; grep các API trên = 0 ngoài allowlist. · Nguồn: OWASP Deserialization CS; Top 10:2025 A08
- [ ] `SEC-WEB-011` **MUST@L** Upload: allowlist phần mở rộng + kiểm magic bytes, giới hạn kích thước (và sau giải nén), tên file do server sinh, lưu ngoài webroot/object storage với Content-Type cố định. → Kiểm: test upload `.html`, `.svg` có script, file đổi đuôi, zip bomb → bị từ chối hoặc phục vụ với `Content-Disposition: attachment` + `nosniff`. · Nguồn: OWASP File Upload CS; ASVS 5.0 V5
- [ ] `SEC-WEB-012` **MUST@L** Rate limit cho endpoint nhạy cảm (login, OTP, reset, export, AI/LLM) theo IP và theo tài khoản, trả 429 kèm `Retry-After`. → Kiểm: test tải nhỏ vượt ngưỡng → 429; cấu hình ngưỡng lưu trong code/IaC, không chỉ ở dashboard. · Nguồn: API Top 10 2023 API4; ASVS 5.0 V2
- [ ] `SEC-WEB-013` **MUST@L** CORS: không `Access-Control-Allow-Origin: *` cùng credential; allowlist origin cụ thể từ cấu hình; không phản chiếu `Origin`. → Kiểm: test preflight với origin lạ → không có header allow; grep cấu hình CORS. · Nguồn: ASVS 5.0 V3, V4
- [ ] `SEC-WEB-014` **MUST@L** Production không chạy ở chế độ debug của framework (`DEBUG`, `FLASK_DEBUG`, `NODE_ENV≠production`, trang lỗi chi tiết, console debug): ứng dụng kiểm lúc khởi động và từ chối chạy khi `env=production` mà debug bật. Nguyên tắc phản hồi lỗi không lộ chi tiết: xem [`BASE-ERR-003`](../01-baseline/errors-and-logging.md). → Kiểm: test khởi động với `env=production` + debug bật → thoát mã ≠ 0; DAST không thấy trang lỗi debug. · Nguồn: Top 10:2025 A02, A10; ASVS 5.0 V16
- [ ] `SEC-WEB-015` **MUST@L** SAST chạy trên mỗi PR (CodeQL hoặc Semgrep CE với rule tự chọn) và chặn merge khi có finding mức high/critical mới. → Kiểm: workflow SAST là required check; baseline finding cũ được ghi và giảm dần. · Nguồn: NIST SSDF PW.7; Top 10:2025 A06
- [ ] `SEC-WEB-016` **MUST@L** DAST (ZAP baseline/API scan) chạy trên staging theo lịch (≥ 1 lần/tuần) và trước phát hành, với tài khoản test; cảnh báo High = chặn phát hành. → Kiểm: báo cáo ZAP lưu artifact CI; GO/NO-GO trỏ báo cáo gần nhất ≤ 7 ngày. · Nguồn: NIST SSDF PW.8; OWASP ZAP docs
- [ ] `SEC-WEB-017` **SHOULD** Redirect sau login/logout chỉ tới đường dẫn tương đối hoặc allowlist host; không `redirect(request.GET['next'])` thô. → Kiểm: test `?next=https://evil.example` → về trang mặc định. · Nguồn: ASVS 5.0 V3 (open redirect)
- [ ] `SEC-WEB-018` **SHOULD** Phân trang/lọc có giới hạn trên (`limit` tối đa, độ sâu lọc) để tránh cạn tài nguyên; truy vấn nặng có timeout. → Kiểm: test `limit=1000000` → bị cắt về tối đa; timeout CSDL cấu hình. · Nguồn: API Top 10 2023 API4
- [ ] `SEC-WEB-019` **SHOULD** Có inventory API (OpenAPI) sinh từ code hoặc kiểm khớp code; endpoint không có trong spec hoặc endpoint debug/cũ không được phục vụ ở production. → Kiểm: test so route runtime với spec; route `/debug`, `/v0` = 0 ở production. · Nguồn: API Top 10 2023 API9; [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `SEC-WEB-020` **SHOULD** Phản hồi từ API bên thứ ba được validate như đầu vào người dùng (schema, kích thước, timeout), không tin "vì là đối tác". → Kiểm: client wrapper có schema + timeout; test với phản hồi dị dạng. · Nguồn: API Top 10 2023 API10
- [ ] `SEC-WEB-021` **SHOULD** HTML/SVG do người dùng tải lên được phục vụ từ origin riêng (sandbox domain) hoặc với `Content-Disposition: attachment`. → Kiểm: cấu hình storage/CDN; test tải `.svg` → không chạy script trên origin chính. · Nguồn: OWASP File Upload CS
- [ ] `SEC-WEB-022` **SHOULD** Có test bảo mật tự viết cho luồng chính (quyền theo route, CSRF, header) chạy cùng bộ test thường — không chỉ dựa vào scanner. → Kiểm: thư mục `tests/security/` tồn tại, chạy trong job test. · Nguồn: ASVS 5.0 (xác minh bằng test); P9
- [ ] `SEC-WEB-023` **SHOULD** Cookie phiên: `Secure`, `HttpOnly`, `SameSite`, prefix `__Host-` khi có thể (chi tiết vòng đời phiên ở [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md)). → Kiểm: test đọc `Set-Cookie`. · Nguồn: ASVS 5.0 V7
- [ ] `SEC-WEB-024` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`FE-SEC-012`](../07-frontend/client-security.md) (Trusted Types, MUST@M).
- [ ] `SEC-WEB-025` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-SEC-018`](../01-baseline/security-minimum.md) (`security.txt` RFC 9116) và [`BASE-SEC-009`](../01-baseline/security-minimum.md) (`SECURITY.md`, kênh báo lỗ hổng).
- [ ] `SEC-WEB-026` **MAY** Fuzz endpoint parse dữ liệu phức tạp (file, XML, JSON lồng) bằng bộ fuzz của ngôn ngữ (go-fuzz, atheris, jazzer). → Kiểm: job fuzz theo lịch, corpus trong repo. · Nguồn: OpenSSF Scorecard check Fuzzing
- [ ] `SEC-WEB-027` **MUST@L** Xuất CSV/XLSX vô hiệu hoá công thức: ô chuỗi do người dùng/đối tác cung cấp mà bắt đầu bằng `=`, `+`, `-`, `@`, tab (`\t`) hoặc CR (`\r`) được thêm tiền tố `'` (hoặc ghi kiểu text/chuỗi, không phải công thức) ở **một hàm xuất dùng chung**; OWASP nay liệt kê thêm LF và biến thể full-width (`＝ ＋ － ＠`). Số do hệ thống tính ghi bằng kiểu số, không đi qua nhánh chuỗi. → Kiểm: test xuất bản ghi có tên `=HYPERLINK("http://evil.example","x")` → ô trong file có `'=` (CSV) hoặc kiểu text (XLSX); test các ký tự đầu còn lại; test số âm thật không bị biến thành chuỗi. · Nguồn: OWASP CSV Injection; `seeker19110/stored` 23 §4.4, 12 §3 (Dhcb-Tools `SECURITY.md`: chặn CSV formula injection; đọc 2026-10-16)

## Bẫy thường gặp

1. **"ORM nên an toàn"** rồi dùng `raw()`/`$queryRaw`/`text()` nối chuỗi cho sắp xếp/lọc động. Tránh: allowlist tên cột, bind giá trị; SAST bắt `raw`.
2. **CSP có `unsafe-inline`** để "cho chạy đã" và không bao giờ gỡ. Tránh: bắt đầu bằng Report-Only + nonce từ ngày đầu; CI đọc header (`FE-SEC-003/004`).
3. **SameSite là đủ**: `Lax` vẫn gửi cookie cho top-level GET và không chặn subdomain anh em (cùng site); thiếu lớp thứ hai → CSRF qua GET có side-effect hoặc từ subdomain. Tránh: `SEC-WEB-007` (token hoặc kiểm `Origin`/`Sec-Fetch-Site`; chấp nhận `same-site` chỉ khi mọi subdomain đều tin được).
4. **Chặn SSRF bằng blocklist chuỗi** (`startswith("127.")`) → bypass bằng `0x7f000001`, `127.1`, DNS rebinding, redirect. Tránh: resolve rồi kiểm IP tại thời điểm kết nối; tắt redirect.
5. **Kiểm quyền ở middleware theo route** nhưng không theo *đối tượng* → IDOR. Tránh: test "A gọi id của B" cho mọi route (`BE-AUTH-010`).
6. **Trả 404 cho tài nguyên không tồn tại và 403 cho không có quyền** → lộ sự tồn tại. Thống nhất một mã (thường 404) cho cả hai với tài nguyên riêng tư.
7. **Scanner xanh = an toàn.** ZAP/CodeQL không hiểu nghiệp vụ (API6 lạm dụng luồng, logic quyền). Tránh: test bảo mật tự viết + threat model.
8. **Rule Semgrep "miễn phí"** nhưng license cấm phân phối/host lại; dùng trong CI nội bộ thì được, đóng gói vào sản phẩm/skill công khai thì không. Tránh: ghi license rule vào SBOM/license gate ([`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)).
9. **Server Action/RPC là POST công khai**: framework fullstack (Next.js Server Actions, tRPC) vẫn cần auth + validate như REST (catalog 09 §1.4).
10. **Mất header khi đổi tầng** (CDN/proxy mới ghi đè hoặc bỏ header). Tránh: test header chạy trên URL production sau mỗi deploy (smoke).
11. **Xuất CSV/XLSX từ dữ liệu người dùng như văn bản trơn** → mở trong Excel/LibreOffice, ô `=HYPERLINK(…)` hoặc công thức DDE chạy thật (rò dữ liệu, mở liên kết); tiền tố `'` đơn lẻ có thể mất tác dụng khi Excel lưu lại file. Tránh: hàm xuất dùng chung theo `SEC-WEB-027`; file cho người xem trong Excel dùng thêm tab đầu ô; test payload.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| SAST | CodeQL (GitHub; miễn phí repo public) | `github/codeql-action` ghim SHA, `queries: security-extended` | CI mỗi PR + lịch tuần | high/critical mới = đỏ |
| SAST đa ngôn ngữ | Semgrep CE (LGPL-2.1; rule registry không OSI) / Opengrep | `semgrep ci` hoặc `semgrep --config p/owasp-top-ten --error` | pre-commit (nhanh) + CI | ERROR = đỏ; WARNING ghi báo cáo |
| Python | bandit (Apache-2.0) | `bandit -r src -ll -ii` | CI | medium+ = đỏ |
| Go | gosec (Apache-2.0) | `gosec ./...` | CI | high = đỏ |
| DAST | OWASP ZAP (Apache-2.0) | `zap-baseline.py -t https://staging… -r report.html` hoặc `zap-api-scan.py -t openapi.json` | CI đêm + trước release | High = chặn; Medium = ticket |
| Header/cookie | test HTTP tự viết (pytest/vitest/supertest) | đọc header trang chính + API | job test + smoke sau deploy | thiếu header = đỏ |
| Quyền theo route | cổng route-perms tự viết (liệt kê route ↔ test quyền) | script đối chiếu router với `tests/security/` | CI | route thiếu test = đỏ |
| Điểm tắt escape | grep allowlist | `rg "dangerouslySetInnerHTML\|innerHTML\|mark_safe"` so với `security/allowlist.txt` | pre-commit | điểm mới ngoài allowlist = đỏ |
| CSV/XLSX injection | test tự viết (pytest/vitest) | xuất bản ghi có tên `=HYPERLINK(…)`, `+1+1`, `-2+3`, `@SUM(1)`, ô bắt đầu bằng tab/CR rồi đọc lại file | job test | ô công thức không bị vô hiệu = đỏ |

## Nguồn

- OWASP Top 10:2025 (A01 Broken Access Control … A10 Mishandling of Exceptional Conditions): <https://top10.owasp.org/2025> — xác minh 2026-10-13.
- OWASP API Security Top 10 (2023, API1–API10): <https://api-security.owasp.org/> — xác minh 2026-10-13.
- OWASP ASVS 5.0.0 (05/2025), chương V1–V17 (V1 Encoding & Sanitization, V2 Validation, V3 Web Frontend, V4 API, V5 File Handling, V12 Secure Communication, V16 Logging & Error Handling): <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13.
- OWASP Cheat Sheet Series — HTTP Headers, CSP, CSRF Prevention, SSRF Prevention, File Upload, Mass Assignment, Deserialization: <https://cheatsheetseries.owasp.org/> — xác minh 2026-10-13.
- OWASP ZAP v2.17.0 (Apache-2.0): <https://github.com/zaproxy/zaproxy/releases/latest> — tag xác minh 2026-10-13 (trang không hiện năm phát hành).
- Semgrep v1.180.0 (engine LGPL-2.1) và Semgrep Rules License (chỉ dùng nội bộ, không phân phối): <https://semgrep.dev/legal/rules-license> — xác minh 2026-10-13; phiên bản theo catalog `seeker19110/stored` 12 §3d (2026-10-12).
- NIST SP 800-218 SSDF v1.1, PW.7 (review code), PW.8 (test): <https://csrc.nist.gov/pubs/sp/800/218/final> — xác minh 2026-10-13.
- RFC 9116 `security.txt`: <https://www.rfc-editor.org/rfc/rfc9116> — (chưa fetch lại ngày 2026-10-13; số RFC theo kiến thức nền, xác minh trước khi dùng).
- Catalog `seeker19110/stored` mục 09 §1.3–1.4 (base checklist Web: CSP/HSTS/CORS/SSRF; Next.js Server Action phải kiểm auth), đọc 2026-10-13.
- OWASP CSV Injection: <https://owasp.org/www-community/attacks/CSV_Injection> — xác minh 2026-10-16 (danh sách ký tự đầu ô gồm `= + - @` tab CR LF và biến thể full-width; cảnh báo `'` có thể mất tác dụng khi Excel lưu lại; biện pháp bền với Excel: tab đầu ô trong trường có nháy kép). Catalog `seeker19110/stored` 23 §4.4, 12 §3 (đọc 2026-10-16).
