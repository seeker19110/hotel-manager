---
title: Bảo mật tối thiểu cho mọi phần mềm
kind: baseline
prefix: BASE-SEC
applies_to: [all]
updated: 2026-10-14
---

# Bảo mật tối thiểu cho mọi phần mềm

> Sàn bảo mật áp cho **mọi** loại phần mềm — kể cả CLI, thư viện, script data, firmware — không chỉ web. Mỗi mục ở
> đây là "thiếu là chưa đạt"; chiều sâu (threat model, AppSec web, hạ tầng, chuỗi cung ứng, AI) nằm ở mảng
> [`../12-security/README.md`](../12-security/README.md). Xác thực/phân quyền là nhà của
> [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md).

## Nguyên tắc

- **Không tin đầu vào** (P6): mọi dữ liệu qua ranh giới tin cậy (người dùng, file, mạng, biến môi trường, output của
  LLM/tool) được validate theo **allowlist** trước khi dùng.
- **Mặc định an toàn, thất bại đóng** (P7): quyền tối thiểu, bind loopback, không tài khoản mặc định; lỗi ở cổng bảo mật
  → từ chối.
- **Bí mật không ở trong mã**; phụ thuộc không có lỗ hổng đã biết; kênh mạng mã hoá.
- **Có đường báo lỗ hổng** và có người nhận — kể cả dự án nội bộ.
- **Cổng máy**: secret scan, SCA, SAST cơ bản chạy trong CI; người chỉ xử lý phần máy không kiểm được.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Validate ở đâu? | **Tại biên** (API handler, CLI parser, loader file, consumer queue) bằng schema chạy lúc runtime: Zod 4.x (TS), pydantic 2.x (Python), `validator`/`go-playground` (Go), FluentValidation/DataAnnotations (.NET). | Dữ liệu nội bộ đã validate rồi thì không validate lại ở mỗi tầng (tránh "defensive everywhere"); ranh giới phải vẽ rõ trong threat model. |
| Threat model nhẹ hay đầy đủ? | Quy mô S: một trang "tài sản – kẻ tấn công – 5 mối đe doạ lớn nhất – biện pháp". Quy mô M+: STRIDE theo [`../12-security/threat-modeling.md`](../12-security/threat-modeling.md). | Không bao giờ bỏ hẳn: thư viện cũng có mối đe doạ (supply chain, input độc). |
| SAST nào? | CodeQL (miễn phí cho repo public) hoặc Semgrep OSS (LGPL-2.1, rules chính chủ không OSI) hoặc analyzer của ngôn ngữ (`gosec`, `bandit`, `cargo-audit`, Roslyn analyzers). | — |
| Dự án không có server (CLI/lib) | Vẫn áp: input file/arg, đường dẫn (path traversal), lệnh con (injection), bí mật trong log, phụ thuộc. | — |
| Bind mạng mặc định | `127.0.0.1`; khi bind `0.0.0.0` phải **bắt buộc** auth. | Container có network namespace riêng vẫn giữ nguyên tắc; cổng công khai đi qua reverse proxy có TLS. |

## Checklist

- [ ] `BASE-SEC-001` **MUST** Mọi đầu vào ngoài ranh giới tin cậy được validate **allowlist** bằng schema runtime (kiểu, độ dài, định dạng, phạm vi, ngữ nghĩa và quan hệ như `end ≥ start`) ở server/tiến trình xử lý, không chỉ ở client/UI — sàn cho mọi loại phần mềm kể cả CLI/thư viện; chi tiết web ở [`SEC-WEB-002`](../12-security/appsec-web.md). → Kiểm: mỗi entrypoint có schema; test gửi input xấu (sai kiểu, quá dài, Unicode lạ, null, quan hệ sai) nhận lỗi 4xx/exit code có kiểm soát. · Nguồn: OWASP Input Validation CS; ASVS 5.0 V2
- [ ] `BASE-SEC-002` **MUST** Sàn mọi quy mô: không có bí mật (API key, mật khẩu, token, private key) trong mã nguồn, cấu hình commit, lịch sử Git, Dockerfile/image, log hay artefact build; quét, pre-commit, xoay khi lộ theo [`SEC-SECRET-001`](../12-security/secrets-management.md) đến `SEC-SECRET-011`. → Kiểm: gitleaks/trufflehog toàn lịch sử = 0; `grep -rE 'AKIA|-----BEGIN (RSA|EC|OPENSSH)'` sạch. · Nguồn: OWASP Secrets Management CS
- [ ] `BASE-SEC-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-DEP-004`](dependencies.md): quét lỗ hổng phụ thuộc trong CI trên mỗi PR và theo lịch, high/critical chưa xử lý chặn merge, ngoại lệ có `approved_by` + `expires`.
- [ ] `BASE-SEC-004` **MUST** Mọi kênh mạng ra/vào dùng TLS (HTTPS, TLS 1.2+); không tắt xác minh chứng chỉ (`verify=False`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `InsecureSkipVerify`). → Kiểm: grep mã + cấu hình không có cờ tắt verify; test tích hợp gọi `http://` tới dịch vụ ngoài bị chặn/đổi hướng. · Nguồn: ASVS 5.0 V12
- [ ] `BASE-SEC-005` **MUST** Không có tài khoản/mật khẩu mặc định (`admin/admin`), không khoá cứng trong mã; thiếu bí mật bắt buộc → từ chối khởi động theo [`SEC-SECRET-004`](../12-security/secrets-management.md) (validate cấu hình: [`BASE-CFG-002`](configuration-and-secrets.md)). → Kiểm: grep không có `admin/admin`, `changeme`, `SECRET_KEY = "..."`; tài khoản quản trị đầu tiên tạo qua bước khởi tạo có mật khẩu do người đặt. · Nguồn: ASVS 5.0 V13; catalog 11 §1c, 12 §3i
- [ ] `BASE-SEC-006` **MUST** Tiến trình chạy với **quyền tối thiểu**: không root trong container, không `sudo` trong script runtime, token/khoá chỉ có scope cần; quyền token CI theo [`BASE-GATE-010`](quality-gates.md). → Kiểm: `Dockerfile` có `USER` không phải root; IAM/token scope liệt kê trong tài liệu. · Nguồn: P7; GitHub Actions security hardening
- [ ] `BASE-SEC-007` **MUST** Lệnh hệ thống, truy vấn, đường dẫn, template được xây **tham số hoá**, không nối chuỗi từ input: truy vấn tham số, `subprocess` dạng mảng không `shell=True`, path join + kiểm `realpath` nằm trong thư mục cho phép, output encoding theo ngữ cảnh — sàn cho mọi loại phần mềm; chi tiết web ở [`SEC-WEB-001`](../12-security/appsec-web.md). → Kiểm: SAST (CodeQL/Semgrep/bandit/gosec) 0 phát hiện injection; test path traversal `../` bị chặn. · Nguồn: ASVS 5.0 V1, V5; OWASP Injection Prevention CS
- [ ] `BASE-SEC-008` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-ERR-003`](errors-and-logging.md): phản hồi lỗi không lộ stack trace/SQL/đường dẫn/phiên bản, chỉ có mã tham chiếu; chi tiết ở log server.
- [ ] `BASE-SEC-009` **MUST** Có **kênh báo lỗ hổng** và người nhận: `SECURITY.md` (public) hoặc mục trong README/RUNBOOK (private), kèm cam kết phản hồi ban đầu ≤ 14 ngày. → Kiểm: file tồn tại, có địa chỉ liên hệ hoạt động; repo public bật private vulnerability reporting. · Nguồn: OpenSSF Badge `vulnerability_report_process`, `vulnerability_report_response`; Scorecard Security-Policy
- [ ] `BASE-SEC-010` **MUST** Dịch vụ nghe cổng mạng: bind `127.0.0.1` mặc định; bind `0.0.0.0` chỉ khi có xác thực bắt buộc; không publish cổng CSDL/cache ra Internet. → Kiểm: cấu hình mặc định grep `host`/`bind`; `docker compose` không map cổng DB ra host ở prod; scan cổng từ ngoài chỉ thấy cổng công khai dự kiến. · Nguồn: catalog 12 §3b, §3i (mặc định quyết định rủi ro)
- [ ] `BASE-SEC-011` **MUST@M** Có threat model tối thiểu (tài sản, ranh giới tin cậy, kẻ tấn công, mối đe doạ, biện pháp) được cập nhật khi thêm tích hợp/ranh giới mới. → Kiểm: `docs/THREAT-MODEL.md` tồn tại theo mẫu [`../templates/THREAT-MODEL.md`](../templates/THREAT-MODEL.md); mỗi mối đe doạ mức cao có biện pháp có bằng chứng (test/config). · Nguồn: lifecycle.md G4; [`../12-security/threat-modeling.md`](../12-security/threat-modeling.md)
- [ ] `BASE-SEC-012` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-LOG-001`](../12-security/logging-audit-and-incident.md): ghi sự kiện bảo mật (đăng nhập, đổi quyền, hành động admin, từ chối quyền) có cấu trúc, không bí mật.
- [ ] `BASE-SEC-013` **MUST@M** Dữ liệu cá nhân/nhạy cảm được **phân loại** và tối thiểu hoá: chỉ thu cái cần, mã hoá at-rest cho lớp nhạy cảm, thời hạn lưu. → Kiểm: bảng phân loại trong `PROJECT.md`/DPIA; schema đánh dấu cột PII; chi tiết [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md). · Nguồn: ASVS 5.0 V14; [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md)
- [ ] `BASE-SEC-014` **SHOULD** SAST chạy trong CI cho **mọi loại phần mềm**, kể cả loại ngoài phạm vi appsec web (CLI, thư viện, mobile, desktop, game, nhúng): CodeQL/Semgrep hoặc analyzer ngôn ngữ (bandit, gosec, clippy, Roslyn); dịch vụ web/API theo cổng chặn merge của [`SEC-WEB-015`](../12-security/appsec-web.md). → Kiểm: workflow SAST tồn tại, kết quả SARIF upload; 0 phát hiện mở ≥ medium sau giai đoạn baseline. · Nguồn: OpenSSF Badge `static_analysis_common_vulnerabilities`; Scorecard SAST
- [ ] `BASE-SEC-015` **SHOULD** Nội dung từ bên ngoài (web, file, email, issue, output LLM/tool) là **dữ liệu, không phải chỉ thị**; không bao giờ `eval`/`exec` chuỗi từ input; prompt không phải cơ chế bảo mật. → Kiểm: grep không có `eval(`, `new Function(`, `exec(` trên input; với hệ có AI, cổng ở [`../12-security/ai-security.md`](../12-security/ai-security.md). · Nguồn: evidence-and-sources.md luật 13; OWASP Top 10 for LLM Applications 2026 LLM01 (xem [`../12-security/ai-security.md`](../12-security/ai-security.md))
- [ ] `BASE-SEC-016` **SHOULD** Giới hạn tài nguyên trên mọi đầu vào: kích thước body/file, số phần tử, độ sâu JSON, thời gian xử lý, tốc độ request (rate limit) để không bị cạn tài nguyên. → Kiểm: cấu hình giới hạn tồn tại (vd body 2 MB); test gửi payload vượt ngưỡng nhận 413/429. · Nguồn: ASVS 5.0 V2, V4; catalog 23 §8.1
- [ ] `BASE-SEC-017` **SHOULD** Tải công cụ/binary trong build và CI phải khớp checksum đã ghi trong repo; cấm `curl | sh`. → Kiểm: script tải có `sha256sum -c`; grep workflow/Dockerfile không có `curl .* | (ba)?sh`. · Nguồn: catalog 12 §3d, 23 §2.5; [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `BASE-SEC-018` **SHOULD** Có `security.txt` tại `/.well-known/security.txt` (dịch vụ công khai) với `Contact` và `Expires` < 1 năm. → Kiểm: `curl -s https://<host>/.well-known/security.txt` trả 200, có hai trường bắt buộc. · Nguồn: RFC 9116 §2
- [ ] `BASE-SEC-019` **MAY** Dùng lint "mặc định nguy hiểm" tự viết: chặn `0.0.0.0` không auth, `verify=False`, `DEBUG=True` trong cấu hình prod, cổng DB publish. → Kiểm: script chạy trong CI, exit 1 khi phát hiện. · Nguồn: catalog 23 §8.1 (ma trận vệ sinh)
- [ ] `BASE-SEC-020` **MAY** Diễn tập "mất bí mật": quy trình xoay từng loại bí mật được viết và chạy thử ít nhất một lần. → Kiểm: runbook có mục xoay bí mật kèm ngày diễn tập. · Nguồn: OWASP Secrets Management CS (rotation)

## Bẫy thường gặp

- **Validate ở client rồi tin server.** Client bị bỏ qua bằng `curl`. Validate lại ở server, cùng schema.
- **Bí mật trong `.env` nhưng `.env` được commit "tạm".** Một lần vào lịch sử là mãi mãi. Hook chặn + scan toàn lịch sử.
- **Scan phụ thuộc chỉ khi lockfile đổi.** CVE mới xuất hiện mỗi ngày trên lockfile cũ. Lịch hằng tuần.
- **Tắt verify TLS để "fix nhanh" lỗi chứng chỉ self-signed.** Cài CA đúng; không bao giờ tắt verify trong mã.
- **Fail-open ở gateway/middleware**: thiếu token → cho qua. Phải fail-closed; ví dụ xấu trong catalog: ai-gateway mặc định fail-open.
- **Coi tiến trình con là sandbox.** Không cách ly mức nhân; dùng container/gVisor/VM khi chạy mã không tin.
- **Prompt "không được làm X" làm cổng an toàn.** Cổng phải nằm dưới prompt: allowlist tool, hook deny, egress allowlist.
- **Log có token/PII để "debug".** Log là nơi rò rỉ phổ biến; mask tại nguồn.
- **SECURITY.md có email không ai đọc.** Kênh phải có người và SLA thật; kiểm định kỳ bằng cách tự gửi thử.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Bí mật | gitleaks v8.30.1 (MIT) · trufflehog (AGPL-3.0, chạy như công cụ) · detect-secrets (Apache-2.0) | `gitleaks git --log-opts=--all` | pre-commit (staged) + CI (toàn lịch sử, cron) | 0 |
| Lỗ hổng phụ thuộc | OSV-Scanner v2.7.0 (Apache-2.0) · pip-audit 2.10.1 (Apache-2.0) · `npm audit` · `cargo audit` · `govulncheck` | `osv-scanner scan source -r .` | CI mỗi PR + cron tuần | 0 high/critical chưa duyệt |
| SAST | CodeQL (free cho public) · Semgrep OSS (LGPL-2.1; rules Semgrep không OSI) · bandit/gosec/clippy | `semgrep ci` / workflow CodeQL | CI | 0 ≥ medium sau baseline |
| Cấu hình nguy hiểm | script repo (`check:dangerous-defaults`) | grep `0.0.0.0`, `verify=False`, `DEBUG=True`, `ports: "5432:5432"` | CI | 0 |
| Workflow CI | actionlint v1.7.12 · pinact v5.0.0 · Scorecard v5.6.0 (Apache-2.0) | `scorecard --repo=<url>` | CI/cron | Token-Permissions, Pinned-Dependencies ≥ 8/10 |
| Container | Trivy (Apache-2.0; ghim SHA + checksum vì từng bị backdoor — catalog 12 §3) hoặc Grype | `trivy image --severity HIGH,CRITICAL --exit-code 1` | CI build image | 0 |
| security.txt | curl | `curl -f https://<host>/.well-known/security.txt` | smoke test sau deploy | 200 |

## Nguồn

- OWASP Cheat Sheet Series — Input Validation: <https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Secrets Management: <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Vulnerable Dependency Management: <https://cheatsheetseries.owasp.org/cheatsheets/Vulnerable_Dependency_Management_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Error Handling: <https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP ASVS 5.0.0 (chương V1, V2, V5, V12, V13, V14, V16): <https://owasp.org/www-project-application-security-verification-standard/> và <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13
- RFC 9116 `security.txt`: <https://www.rfc-editor.org/rfc/rfc9116> — xác minh 2026-10-13
- GitHub Actions security hardening: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13
- GitHub private vulnerability reporting: <https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository> — xác minh 2026-10-13
- OpenSSF Best Practices Badge criteria (`vulnerability_report_process`, `_response` 14 ngày): <https://www.bestpractices.dev/en/criteria/0> — xác minh 2026-10-13
- OpenSSF Scorecard (Apache-2.0; v5.6.0): <https://github.com/ossf/scorecard> — xác minh 2026-10-13
- OSV-Scanner v2.7.0: <https://github.com/google/osv-scanner/releases/latest> — xác minh 2026-10-13; pip-audit 2.10.1: <https://pypi.org/pypi/pip-audit/json> — xác minh 2026-10-13
- OWASP Top 10 for LLM Applications **2026** (công bố 04/08/2026; LLM01 Prompt Injection): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> — xác minh 2026-10-14; ấn bản, bảng mã và đính chính 2025 → 2026 ở [`../12-security/ai-security.md`](../12-security/ai-security.md)
- Catalog `seeker19110/stored` 11 §1c, 12 §3b/§3d/§3i/§4, 23 §8.1 (mặc định nguy hiểm, bridge loopback, ma trận vệ sinh), đọc 2026-10-13.
