---
title: Quản lý bí mật: lưu, xoay, quét, phạm vi
kind: module
prefix: SEC-SECRET
applies_to: [all]
updated: 2026-10-16
---

# Quản lý bí mật: lưu, xoay, quét, phạm vi

> **Nhà** của chủ đề bí mật (API key, mật khẩu CSDL, khoá ký, token CI, khoá mã hoá): lưu ở đâu, cấp phạm vi thế nào, xoay ra sao,
> quét rò rỉ bằng gì và làm gì khi lộ. [`../01-baseline/configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md)
> chỉ giữ mức tối thiểu và trỏ về đây. Mật khẩu *người dùng* (băm, chính sách) thuộc [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md).

## Nguyên tắc

- **Bí mật không bao giờ nằm trong code, repo, image, log, prompt, trace** — kể cả lịch sử git và branch đã xoá. Một lần commit = coi như lộ → xoay.
- **Một nguồn sự thật**: kho bí mật tập trung (managed secrets của cloud hoặc vault tự host); ứng dụng *lấy lúc chạy*, không chép tay vào nhiều nơi.
- **Phạm vi hẹp, thời hạn ngắn**: mỗi dịch vụ/môi trường một credential riêng, quyền tối thiểu; ưu tiên **dynamic secrets** / token ngắn hạn
  (OIDC workload identity) hơn khoá tĩnh dài hạn. Restart ứng dụng không thu hồi được khoá đã lộ — chỉ backend cấp khoá mới làm được.
- **Xoay được là điều kiện tiên quyết**: khoá nào không thể xoay trong < 1 giờ (vì hard-code ở nhiều nơi) là nợ bảo mật phải trả trước khi lên production.
- **Quét ở ba chỗ**: pre-commit (chặn trước khi vào lịch sử), CI toàn bộ lịch sử (bắt thứ lọt qua `--no-verify`), và kho/registry theo lịch.
- **Lộ là sự cố**: thu hồi → xoay → tìm phạm vi dùng → đối chiếu log truy cập → post-mortem; không "xoá commit là xong".

## Quyết định

| Tình huống | Lựa chọn mặc định | Thay thế + điều kiện |
|---|---|---|
| Chạy trên cloud (AWS/GCP/Azure) | Managed secrets của cloud (Secrets Manager/Parameter Store, Secret Manager, Key Vault) + IAM theo workload | Vault tự host khi đa cloud/on-prem và có đội vận hành; **HashiCorp Vault là BSL 1.1**, bản cộng đồng **OpenBao** (MPL-2.0, Linux Foundation) — xác minh lại trước khi chọn |
| Kubernetes | External Secrets Operator đồng bộ từ kho cloud → Secret; hoặc CSI Secrets Store; Secret ở etcd phải mã hoá at-rest | SOPS (MPL-2.0) + age/KMS cho file mã hoá trong git khi đội nhỏ và GitOps |
| CI/CD | Secret của nền tảng CI theo *environment* có người duyệt; **OIDC** để lấy token cloud ngắn hạn thay khoá tĩnh | Khoá tĩnh chỉ khi nhà cung cấp không hỗ trợ OIDC → xoay ≤ 90 ngày, ghi ngày xoay |
| Local dev | `.env` **chỉ local**, gitignore, giá trị dev riêng; `.env.example` không có giá trị thật | direnv/1Password CLI/`op run` khi cần bí mật thật ở local — vẫn không ghi file |
| Khoá ký/mã hoá (JWT, webhook HMAC, at-rest) | KMS/HSM quản lý, ứng dụng chỉ gọi ký/giải mã; có `kid` để xoay chồng khoá | Khoá trong vault khi không có KMS; **không** khoá trong env ở production với dự án L |
| Quét rò rỉ | **gitleaks** (MIT) pre-commit + CI full history | **TruffleHog** (AGPL-3.0, có xác minh khoá còn sống) bổ sung ở CI/định kỳ; GitHub secret scanning + push protection nếu dùng GitHub |
| Bí mật cho AI agent/tool | Broker thay credential **tại thời điểm gọi** (egress proxy/vault agent); model không bao giờ thấy giá trị | Nếu bắt buộc đưa vào env của tool → scope riêng, TTL ngắn, log mọi lần dùng; chi tiết [`ai-security.md`](ai-security.md) |

## Checklist

- [ ] `SEC-SECRET-001` **MUST** Không có bí mật trong repo, kể cả lịch sử: quét toàn bộ lịch sử git bằng gitleaks ở CI; phát hiện = đỏ. → Kiểm: job `gitleaks detect --source . --log-opts="--all" --redact --exit-code 1` với `fetch-depth: 0`; báo cáo = 0 finding (false positive ghi `.gitleaksignore` có lý do). · Nguồn: OWASP Secrets Mgmt CS §Detection; Top 10:2025 A02
- [ ] `SEC-SECRET-002` **MUST@L** Hook pre-commit chặn commit chứa bí mật (gitleaks protect) — và CI chạy lại vì hook có thể bị `--no-verify`. → Kiểm: `.pre-commit-config.yaml`/husky có gitleaks; test cố commit chuỗi `AKIA…` giả → bị chặn. · Nguồn: OWASP Secrets Mgmt CS §Detection
- [ ] `SEC-SECRET-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-CFG-003`](../01-baseline/configuration-and-secrets.md): `.env*` trong `.gitignore`, `.env.example` liệt kê mọi biến với giá trị giả.
- [ ] `SEC-SECRET-004` **MUST@L** Ứng dụng từ chối khởi động khi thiếu bí mật bắt buộc (fail-closed), không dùng giá trị mặc định rỗng/"changeme". → Kiểm: test khởi động không có biến → exit ≠ 0 với thông báo tên biến; grep default `SECRET_KEY = "..."` = 0. · Nguồn: P7; catalog stored 23 §8.1 (ai-gateway fail-open)
- [ ] `SEC-SECRET-005` **MUST** Production lấy bí mật từ kho tập trung (managed secrets/vault) lúc chạy, không từ file trong image hay biến hard-code trong IaC. → Kiểm: `docker history`/`dive` image không có bí mật; IaC không có giá trị thật (checkov `CKV_SECRET_*` = 0); cấu hình runtime trỏ ARN/đường dẫn vault. · Nguồn: OWASP Secrets Mgmt CS §Centralization; NIST SSDF PS.1
- [ ] `SEC-SECRET-006` **MUST@L** Mỗi dịch vụ × môi trường có credential riêng, quyền tối thiểu; không dùng chung một khoá admin cho mọi thứ. → Kiểm: danh sách credential trong `docs/security/secrets-inventory.md` (tên, chủ, phạm vi, ngày xoay, TTL) khớp kho; không có khoá "shared". · Nguồn: OWASP Secrets Mgmt CS §Least privilege; ASVS 5.0 V13
- [ ] `SEC-SECRET-007` **MUST** Bí mật không xuất hiện trong log, trace, thông báo lỗi, URL, prompt/transcript của AI. → Kiểm: logger có bộ che (redact) theo tên trường + regex khoá; test ghi log object chứa `password`/`token` → output `[REDACTED]`; gitleaks quét artifact log CI. · Nguồn: OWASP Logging CS (dữ liệu không được log); [`logging-audit-and-incident.md`](logging-audit-and-incident.md)
- [ ] `SEC-SECRET-008` **MUST@L** Mọi bí mật xoay được mà không downtime: khoá ký có `kid`/song song 2 khoá; mật khẩu CSDL có user kép hoặc dynamic credential; quy trình xoay viết trong RUNBOOK. → Kiểm: diễn tập xoay 1 khoá trên staging, ghi thời gian (< 60 phút) vào `docs/security/rotation-log.md`. · Nguồn: OWASP Secrets Mgmt CS §Rotation
- [ ] `SEC-SECRET-009` **MUST@L** CI/CD dùng OIDC/workload identity lấy token ngắn hạn thay khoá tĩnh khi nhà cung cấp hỗ trợ; khoá tĩnh còn lại có ngày xoay ≤ 90 ngày. → Kiểm: workflow có `id-token: write` + role assume; inventory không có khoá tĩnh quá 90 ngày (script so ngày). · Nguồn: OWASP Secrets Mgmt CS §CI/CD; GitHub Actions security hardening
- [ ] `SEC-SECRET-010` **MUST@L** Secret CI gắn với *environment* có người duyệt cho production; PR từ fork không nhận secret. → Kiểm: cấu hình environment `production` có required reviewers; workflow `pull_request` (không `pull_request_target`) cho fork. · Nguồn: GitHub Actions security hardening; catalog stored 12 (CI có AI)
- [ ] `SEC-SECRET-011` **MUST** Khi phát hiện rò rỉ: thu hồi ngay, xoay, rà log dùng khoá trong khoảng lộ, ghi incident theo [`../15-operations/incident-response.md`](../15-operations/incident-response.md); không chỉ xoá commit. → Kiểm: RUNBOOK có mục "Lộ bí mật" với lệnh thu hồi cho từng loại khoá; post-mortem cho mọi vụ lộ. · Nguồn: OWASP Secrets Mgmt CS §Incident response
- [ ] `SEC-SECRET-012` **MUST@L** Kho bí mật ghi audit log mọi lần đọc/ghi/xoá, log bất biến, có cảnh báo khi đọc bất thường (ngoài giờ, từ identity lạ). → Kiểm: audit log kho bật; cảnh báo đã thử kích hoạt 1 lần. · Nguồn: OWASP Secrets Mgmt CS §Auditing
- [ ] `SEC-SECRET-013` **MUST@L** Khoá mã hoá/ký ở production nằm trong KMS/HSM; ứng dụng gọi ký/giải mã qua API, không giữ khoá riêng trong bộ nhớ lâu dài. → Kiểm: cấu hình trỏ KMS key id; không có PEM private key trong env/vault ứng dụng. · Nguồn: ASVS 5.0 V11; NIST SP 800-57 (quản lý khoá)
- [ ] `SEC-SECRET-014` **MUST@L** Bí mật dùng chung giữa nhiều đội có chủ sở hữu, quy trình cấp/thu hồi có phê duyệt, và review quyền truy cập ≥ 1 lần/quý. → Kiểm: biên bản review quý lưu `docs/security/`; inventory có cột chủ. · Nguồn: OWASP Secrets Mgmt CS §Least privilege; ISO/IEC 27001:2022 A.5.17 (chưa xác minh số mục)
- [ ] `SEC-SECRET-015` **SHOULD** Dùng TruffleHog (hoặc tính năng xác minh tương đương) định kỳ để biết khoá lộ còn sống hay đã thu hồi. → Kiểm: job tuần `trufflehog git file://. --only-verified`; kết quả lưu artifact. · Nguồn: TruffleHog docs
- [ ] `SEC-SECRET-016` **SHOULD** Bật secret scanning + push protection của nền tảng git (GitHub/GitLab) nếu có; coi là lớp phụ, không thay gitleaks. → Kiểm: cài đặt repo bật; thử push chuỗi test → bị chặn. · Nguồn: GitHub docs secret scanning
- [ ] `SEC-SECRET-017` **SHOULD** Bí mật cho AI agent được broker thay thế tại egress (proxy/vault agent); model và transcript không chứa giá trị. → Kiểm: grep transcript/trace mẫu = 0 khoá; cấu hình proxy. · Nguồn: khung cũ spec C5-FR-03; OWASP MCP Top 10 MCP01
- [ ] `SEC-SECRET-018` **SHOULD** Mã hoá at-rest cho secret của orchestrator (etcd encryption, sealed state) và state IaC chứa output nhạy cảm. → Kiểm: `EncryptionConfiguration` của cluster; backend state IaC mã hoá + ACL (xem [`../15-operations/infrastructure-as-code.md`](../15-operations/infrastructure-as-code.md)). · Nguồn: NIST SP 800-190 §4; Terraform docs (state chứa secret)
- [ ] `SEC-SECRET-019` **SHOULD** Webhook nhận từ bên ngoài có secret HMAC riêng cho từng đối tác và so sánh hằng thời gian. → Kiểm: test chữ ký sai → 401; dùng `hmac.compare_digest`/`crypto.timingSafeEqual`. · Nguồn: [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md)
- [ ] `SEC-SECRET-020` **MAY** Mã hoá file bí mật trong git bằng SOPS + age/KMS cho GitOps đội nhỏ; khoá giải mã vẫn ở KMS. → Kiểm: file `*.enc.yaml` giải mã được trong CI qua OIDC; không có bản rõ trong repo. · Nguồn: SOPS docs (MPL-2.0)
- [ ] `SEC-SECRET-021` **MAY** Canary token (khoá giả có cảnh báo khi bị dùng) đặt trong repo/`.env.example`/image để phát hiện kẻ quét. → Kiểm: canary đã kích hoạt thử 1 lần. · Nguồn: kinh nghiệm vận hành (không có chuẩn)
- [ ] `SEC-SECRET-022` **SHOULD** Secret trong cấu hình tích hợp do người dùng/tenant nhập (webhook, SMTP, ngân hàng, kênh thông báo) là **write-only**: API chỉ trả placeholder đã che (`has_secret: true`/`••••`), không bao giờ trả giá trị; khi request đổi host/URL/đích mà vẫn giữ placeholder thì server bỏ secret cũ và trả 422 buộc nhập lại, để người sửa được cấu hình không chuyển secret đã lưu sang đích do mình kiểm soát. → Kiểm: test PATCH đổi URL webhook (hoặc host SMTP) giữ nguyên placeholder → 422 và secret cũ không còn được dùng cho đích mới; GET không chứa giá trị secret. · Nguồn: `seeker19110/stored` 12 §3k (CHANGELOG v0.3.15 của ARTEX: vá lỗi che credential bị bypass — đổi địa chỉ giữ nguyên credential làm rò khoá; đọc 2026-10-16)

## Bẫy thường gặp

1. **Xoá commit chứa khoá rồi coi như xong** — khoá đã bị crawler lấy trong vài phút; fork/clone/CI cache vẫn giữ. Luôn thu hồi + xoay.
2. **`.env` trong Docker image** (`COPY . .` không có `.dockerignore`) → bí mật nằm trong layer, ai pull image là đọc được. Tránh: `.dockerignore` có `.env*`; `SEC-SECRET-005`.
3. **Một khoá admin dùng cho mọi service** → lộ một nơi mất tất cả; xoay phải dừng toàn hệ thống. Tránh: `SEC-SECRET-006`.
4. **Fail-open khi thiếu token** (chỉ cảnh báo rồi chạy tiếp) — ví dụ thật: gateway mở `/mcp`, `/metrics` cho mọi người khi không đặt `GATEWAY_API_KEY` (catalog 23 §8.1). Tránh: `SEC-SECRET-004`.
5. **Bí mật trong URL** (`?api_key=`) → nằm trong access log, lịch sử trình duyệt, `Referer`. Dùng header `Authorization`.
6. **Log object nguyên khối** (`logger.info(user)`) → mật khẩu băm, token vào log. Tránh: redact theo tên trường + regex (`SEC-SECRET-007`).
7. **`pull_request_target` checkout code fork** → PR lạ chạy với secret của repo. Tránh: không dùng trừ khi hiểu rõ; không checkout `head.sha` của fork (GitHub hardening).
8. **Prompt chứa khoá** ("dùng API key sau để gọi…") → khoá vào transcript, trace, cache; prompt injection lấy được. Tránh: broker tại egress (`SEC-SECRET-017`).
9. **Vault tự host không có đội vận hành** → unseal thủ công, không backup khoá unseal, Vault sập = toàn hệ sập. Dùng managed secrets khi chưa có năng lực.
10. **Nhầm "mã hoá" với "quản lý"**: file mã hoá trong git (SOPS) vẫn cần xoay, inventory, audit; mất khoá giải mã = mất tất cả → sao lưu khoá KMS.
11. **Cho đổi URL/host của tích hợp mà giữ secret đã lưu** (client gửi lại placeholder đã che) → người có quyền sửa cấu hình trỏ webhook/SMTP sang máy chủ của mình và nhận secret cũ. Tránh: `SEC-SECRET-022` (write-only; đổi đích thì bỏ secret, 422).

## Cổng tự động

| Việc | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Chặn commit có bí mật | gitleaks v8.30.1 (MIT) | `gitleaks protect --staged --redact` | pre-commit | finding > 0 = chặn |
| Quét toàn bộ lịch sử | gitleaks | `gitleaks detect --source . --log-opts="--all" --redact --exit-code 1` (checkout `fetch-depth: 0`) | CI mỗi PR + lịch tuần | finding > 0 = đỏ |
| Khoá còn sống? | TruffleHog v3.99.2 (AGPL-3.0) | `trufflehog git file://. --only-verified --fail` | CI lịch tuần | verified > 0 = sự cố |
| Bí mật trong IaC/K8s manifest | checkov 3.3.28 (Apache-2.0) | `checkov -d infra --check CKV_SECRET_*` | CI | finding > 0 = đỏ |
| Bí mật trong image | gitleaks trên filesystem đã `docker save`/`dive` | `gitleaks detect --no-git -s rootfs/` | CI build image | finding > 0 = đỏ |
| Khởi động fail-closed | test tích hợp | chạy app thiếu từng biến bắt buộc | job test | exit 0 khi thiếu = đỏ |
| Redact log | unit test logger | log object chứa `password`, `token`, `authorization` | job test | giá trị thô xuất hiện = đỏ |
| Khoá tĩnh quá hạn | script đọc inventory | so `last_rotated` + TTL với hôm nay | CI lịch tuần | quá hạn = cảnh báo → ticket |
| Push protection | GitHub/GitLab secret scanning | cài đặt repo | nền tảng | bật |
| Secret tích hợp write-only | test API tự viết | GET không trả giá trị secret; PATCH đổi URL/host giữ placeholder | job test | trả giá trị thô hoặc không phải 422 = đỏ |

## Nguồn

- OWASP Secrets Management Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> — xác minh 2026-10-13 (tập trung, xoay, dynamic secrets, least privilege, audit, CI/CD, detection, incident).
- OWASP Top 10:2025 A02 Security Misconfiguration: <https://top10.owasp.org/2025> — xác minh 2026-10-13.
- OWASP ASVS 5.0.0 V11 Cryptography, V13 Configuration: <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13.
- GitHub Docs — Security hardening for GitHub Actions (OIDC, `pull_request_target`, GITHUB_TOKEN tối thiểu): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13.
- gitleaks v8.30.1 (MIT): <https://github.com/gitleaks/gitleaks/releases/latest> — tag + license xác minh 2026-10-13 (trang không hiện năm phát hành).
- TruffleHog v3.99.2 (AGPL-3.0): <https://github.com/trufflesecurity/trufflehog/releases/latest> — tag + license xác minh 2026-10-13.
- checkov 3.3.28 (Apache-2.0): <https://pypi.org/pypi/checkov/json> — xác minh 2026-10-13.
- NIST SP 800-218 SSDF v1.1 PS.1 (bảo vệ mã nguồn và bí mật): <https://csrc.nist.gov/pubs/sp/800/218/final> — xác minh 2026-10-13.
- (chưa xác minh) HashiCorp Vault BSL 1.1 / OpenBao MPL-2.0, SOPS MPL-2.0, NIST SP 800-57, ISO/IEC 27001:2022 A.5.17 — chưa fetch lại ngày 2026-10-13; xác minh trước khi dẫn.
- Catalog `seeker19110/stored` 12 §3 (quản lý secret, CI có AI), 23 §8.1 (ai-gateway fail-open), đọc 2026-10-13.
- Catalog `seeker19110/stored` 12 §3k (ARTEX: bypass che credential khi đổi địa chỉ — chỉ lấy cơ chế phòng thủ, không dùng công cụ; hồ sơ cảnh báo dual-use), đọc 2026-10-16.
