---
title: Cấu hình, biến môi trường và bí mật
kind: baseline
prefix: BASE-CFG
applies_to: [all]
updated: 2026-10-14
---

# Cấu hình, biến môi trường và bí mật

> Sàn cho mọi phần mềm: cấu hình tách khỏi mã (12-factor III), được **validate lúc khởi động**, có `.env.example` làm
> hợp đồng, và bí mật **không bao giờ** nằm trong repo/log/artefact. File này là **nhà của cấu hình** (schema env, validate
> lúc khởi động, `.env.example`, tiền tố biến công khai, tài liệu cấu hình). Bí mật (lưu trữ, xoay, phạm vi, quét, OIDC CI) là nhà của
> [`../12-security/secrets-management.md`](../12-security/secrets-management.md) — ở đây chỉ giữ phần thuộc cấu hình và trỏ; môi trường
> dev/staging/preview/prod, feature flag và gate deploy ở [`../10-workflow/environments-and-config.md`](../10-workflow/environments-and-config.md).

## Nguyên tắc

- **Cấu hình = thứ thay đổi giữa các lần triển khai** (URL CSDL, khoá dịch vụ, hostname, cờ tính năng); nội dung không
  đổi giữa deploy (routing, wiring) là mã, không phải cấu hình.
- **Thử nghiệm mã nguồn mở**: nếu mở repo ra công khai ngay bây giờ, không bí mật nào lộ — đó là tiêu chí "tách đúng".
- **Fail fast**: thiếu/sai cấu hình → không khởi động, báo đúng tên biến; không chạy với giá trị mặc định nguy hiểm.
- **Một schema cấu hình** là nguồn sự thật duy nhất; `.env.example`, tài liệu, CI đều sinh/đối chiếu từ nó.
- **Bí mật đi qua kênh riêng** (secret manager, CI secrets, file được inject) — không qua tham số dòng lệnh, không qua
  log, không qua image.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Nạp cấu hình từ đâu? | **Biến môi trường** cho mọi giá trị theo deploy; file `.env` chỉ cho máy dev (gitignore), nạp bằng `node --env-file`/`python-dotenv`/`godotenv`. | Cấu hình cây lớn (nhiều mức, danh sách) → file YAML/TOML **không bí mật** commit kèm; bí mật vẫn qua env/secret manager. |
| Validate bằng gì? | Schema runtime: Zod 4.x (`env.ts`), pydantic-settings 2.x, `envconfig`/`caarlos0/env` (Go), `IOptions` + DataAnnotations (.NET); parse **một lần** ở entrypoint thành object có kiểu. | Không đọc `process.env.X` rải rác trong mã. |
| Bí mật ở prod | Secret manager (cloud KMS/Secrets Manager, Vault, SOPS 3.13.x + age cho repo GitOps) inject vào env/file lúc chạy; không nướng vào image. | Dự án S nội bộ: env của nền tảng (PaaS secrets) là đủ, vẫn phải xoay được. |
| Cờ tính năng | Bắt đầu bằng env boolean; nhiều cờ/đối tượng → hệ feature flag (OpenFeature chuẩn mở). | Không dùng cờ để che lỗi cấu hình. |
| Nhiều môi trường | Mỗi biến quản lý độc lập theo deploy; **không** nhóm `config/production.yml` chứa bí mật. | — |

## Checklist

- [ ] `BASE-CFG-001` **MUST** Mọi giá trị thay đổi theo môi trường (URL, cổng, khoá, cờ) đọc từ **biến môi trường** (hoặc file được inject lúc chạy), không hard-code trong mã hay commit vào repo. → Kiểm: grep mã không có URL CSDL/host nội bộ/khoá dạng literal; app chạy được chỉ với env + mã. · Nguồn: 12-factor III
- [ ] `BASE-CFG-002` **MUST** Cấu hình được **validate lúc khởi động** bằng schema (kiểu, bắt buộc/tuỳ chọn, phạm vi, định dạng URL); thiếu hoặc sai → thoát với mã ≠ 0 và thông báo nêu **tên biến** (không in giá trị). → Kiểm: khởi động với env trống → exit ≠ 0, stderr liệt kê biến thiếu; test đơn vị cho schema; grep `process.env.`/`os.environ[` ngoài module env = 0. · Nguồn: catalog 09 §1.4 (validate env bằng zod); ASVS 5.0 V13; 12-factor III
- [ ] `BASE-CFG-003` **MUST** Có `.env.example` (hoặc file tương đương) commit, liệt kê **mọi** biến với mô tả và giá trị giả; `.env`, `.env.*.local`, `*.pem`, `*.key` nằm trong `.gitignore`. → Kiểm: CI so khớp tập khoá trong `.env.example` với schema (lệch = đỏ); `git ls-files .env` rỗng; `git check-ignore .env` trả `.env`. · Nguồn: 12-factor III; OWASP Secrets Management CS
- [ ] `BASE-CFG-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-001`](../12-security/secrets-management.md): không bí mật trong repo, lịch sử git, Dockerfile/image, workflow CI, artefact (sàn mọi quy mô giữ ở [`BASE-SEC-002`](security-minimum.md)).
- [ ] `BASE-CFG-005` **MUST** Object cấu hình khi in/dump (`--print-config`, log khởi động, trang debug, `repr`/`toString`) **che trường bí mật**; schema đánh dấu trường nào là bí mật. Nguyên tắc "bí mật không vào log/lỗi/URL": xem [`SEC-SECRET-007`](../12-security/secrets-management.md) và [`BASE-ERR-007`](errors-and-logging.md). → Kiểm: test `JSON.stringify(config)`/`repr(settings)` cho `***` ở mọi trường bí mật. · Nguồn: OWASP Logging CS
- [ ] `BASE-CFG-006` **MUST** Bí mật không truyền qua **tham số dòng lệnh** (lộ trong `ps`, lịch sử shell); nhận qua env, file (`--token-file`), hoặc stdin. → Kiểm: CLI không có cờ `--password <value>`; tài liệu nêu cách truyền an toàn. · Nguồn: clig.dev (Secrets); OWASP Secrets Management CS
- [ ] `BASE-CFG-007` **MUST** Phần mềm có tuỳ chọn mạng/bảo mật (dịch vụ, ứng dụng, CLI gọi mạng): giá trị mặc định của các tuỳ chọn đó là **an toàn**: `DEBUG` tắt, bind `127.0.0.1`, TLS verify bật, CORS đóng, không khoá mặc định; prod không phụ thuộc "ai đó nhớ đổi". → Kiểm: khởi động không đặt biến tuỳ chọn → cấu hình hiệu lực được in (đã che) khớp bảng mặc định an toàn trong tài liệu. · Nguồn: P7; catalog 12 §3i
- [ ] `BASE-CFG-008` **MUST** Ứng dụng có bundle phía client (web/mobile/desktop): biến môi trường được **phân loại** hai lớp: công khai (được nhúng vào client/bundle, vd tiền tố `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`/`EXPO_PUBLIC_`) và bí mật (chỉ server); không bí mật nào (service key, secret, token, mật khẩu) có tiền tố công khai. → Kiểm: schema env tách `client`/`server` (vd `@t3-oss/env-nextjs`) làm build đỏ khi lệch; lint tên: tiền tố công khai + tên chứa `SECRET|KEY|TOKEN|PASSWORD` (trừ allowlist) → đỏ; quét bundle `dist/`/`.next/static` bằng gitleaks/pattern (`sk_live|service_role|AKIA|-----BEGIN`) = 0. · Nguồn: catalog 09 §1.4; Next.js env docs; Vite env docs
- [ ] `BASE-CFG-009` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-005`](../12-security/secrets-management.md): bí mật prod ở kho tập trung, mỗi dịch vụ × môi trường credential riêng (`SEC-SECRET-006`).
- [ ] `BASE-CFG-010` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-008`](../12-security/secrets-management.md): bí mật có chủ, lịch xoay, quy trình xoay đã diễn tập (inventory ở `SEC-SECRET-006`, lộ → `SEC-SECRET-011`).
- [ ] `BASE-CFG-011` **SHOULD** Cấu hình theo môi trường **không nhóm** thành bộ `development/test/production` cố định; mỗi deploy (review app, staging, prod, máy dev) tự khai biến riêng từ cùng schema. → Kiểm: không có file `config/<env>.json` chứa giá trị theo deploy; cùng image chạy ở staging và prod chỉ khác env. · Nguồn: 12-factor III, V (build/release/run)
- [ ] `BASE-CFG-012` **SHOULD** Tài liệu cấu hình sinh từ schema (bảng biến: tên, kiểu, bắt buộc, mặc định, mô tả) để không lệch; thay schema mà không cập nhật `.env.example`/docs → CI đỏ. → Kiểm: script sinh `docs/CONFIG.md` chạy trong CI, `git diff --exit-code`. · Nguồn: P5
- [ ] `BASE-CFG-013` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-010`](../12-security/secrets-management.md): secret CI gắn environment có người duyệt, PR từ fork không nhận secret.
- [ ] `BASE-CFG-014` **SHOULD** Cấu hình **hiệu lực** (effective config, đã che bí mật) được ghi log một lần lúc khởi động và/hoặc xuất qua lệnh `--print-config` để chẩn đoán. → Kiểm: log khởi động có bản ghi `config.loaded` với các khoá và nguồn (env/file/default). · Nguồn: clig.dev; P10
- [ ] `BASE-CFG-015` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-002`](../12-security/secrets-management.md): pre-commit chặn commit chứa bí mật, CI quét lại toàn lịch sử.
- [ ] `BASE-CFG-016` **MAY** Dùng OpenFeature (chuẩn mở, CNCF) cho feature flag khi số cờ > ~10 hoặc cần bật theo đối tượng; cờ có ngày hết hạn và chủ sở hữu. → Kiểm: danh sách cờ trong repo có `owner`, `expires`; cổng CI cảnh báo cờ quá hạn. · Nguồn: P8 (feature flag cho thay đổi rủi ro)
- [ ] `BASE-CFG-017` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-009`](../12-security/secrets-management.md): CI/CD dùng OIDC/workload identity thay khoá tĩnh dài hạn.

## Bẫy thường gặp

- **`.env` commit "cho tiện", rồi `.gitignore` thêm sau.** File đã vào lịch sử. Quét toàn lịch sử, xoay khoá.
- **`process.env.X ?? 'default'` rải khắp mã.** Không ai biết tổng cộng có bao nhiêu biến; `.env.example` lệch. Một schema, một lần parse.
- **Bí mật có tiền tố `NEXT_PUBLIC_`/`VITE_`.** Bị nhúng vào bundle gửi cho mọi trình duyệt. Lint tiền tố.
- **Mặc định "tiện dev" chạy lên prod**: `DEBUG=true`, `CORS=*`, `0.0.0.0`. Mặc định phải an toàn; dev tự bật.
- **Dump cấu hình để debug** in cả chuỗi kết nối có mật khẩu lên log. Che ở `toString`/`repr`.
- **Bí mật trong Dockerfile `ARG`/`ENV`** nằm trong layer image kể cả khi xoá ở layer sau. Dùng BuildKit `--mount=type=secret`.
- **Một "big secret" dùng chung mọi nơi** → lộ một chỗ, mất tất cả, và không xoay được. Tách theo dịch vụ/môi trường.
- **Agent/LLM đọc `.env`** để "hiểu dự án" rồi đưa giá trị vào chat/commit. Hook `deny` đọc `.env*` (xem `.claude/settings.json` của khung).
- **Cùng tên biến, nghĩa khác nhau giữa dịch vụ** (`DATABASE_URL` của app A trỏ CSDL của app B khi chạy chung máy). Đặt tiền tố theo dịch vụ (`BILLING_DATABASE_URL`) và schema riêng từng tiến trình.
- **Bí mật dán vào ticket/chat/PR để "chia sẻ nhanh"** — kênh đó không xoá được. Chỉ chia sẻ qua secret manager có quyền; dán rồi thì coi như lộ, xoay.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Schema env | Zod 4.6.x (MIT) · pydantic-settings (MIT) · `caarlos0/env` (MIT) | chạy entrypoint với env test | test đơn vị + smoke start | thiếu biến = exit ≠ 0 |
| `.env.example` ↔ schema | script repo (`check:env-example`) | so khoá trong `.env.example` với schema | CI | lệch = đỏ |
| Bí mật trong repo | gitleaks v8.30.1 (MIT) · detect-secrets (Apache-2.0) | `gitleaks git --log-opts=--all` · `gitleaks protect --staged` | pre-commit + CI | 0 |
| Bí mật trong image | Trivy (Apache-2.0, ghim SHA) `--scanners secret` · `docker history` | `trivy image --scanners secret <img>` | CI build | 0 |
| Tiền tố công khai | script/lint | grep schema cho `NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_` ∩ danh sách bí mật | CI | ∅ |
| Mã hoá file cấu hình GitOps | SOPS v3.13.3 (MPL-2.0) + age | `sops --decrypt` chỉ trong CD với KMS/OIDC | CD | file `*.enc.yaml` không bao giờ plaintext trong repo |
| Hook đọc `.env` | Claude Code `permissions.deny: Read(./.env*)` | — | `.claude/settings.json` | chặn |

## Nguồn

- The Twelve-Factor App III Config, V Build/Release/Run: <https://12factor.net/config> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Secrets Management: <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP ASVS 5.0.0 V13 Configuration: <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13
- GitHub Actions security hardening (secrets, mask, environments): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13
- Command Line Interface Guidelines (không nhận bí mật qua flag): <https://clig.dev/> — xác minh 2026-10-13
- SOPS v3.13.3: <https://github.com/getsops/sops/releases/latest> — xác minh 2026-10-13; gitleaks v8.30.1: <https://github.com/gitleaks/gitleaks/releases/latest> — xác minh 2026-10-13; Yelp/detect-secrets (Apache-2.0): <https://github.com/Yelp/detect-secrets> — xác minh 2026-10-13
- Zod 4.6.7, pydantic 2.14.1 (registry, xác minh 2026-10-13). OpenFeature: <https://openfeature.dev/> **(chưa xác minh phiên bản ngày 2026-10-13)**
- Khung cũ X-stored `quality-supplements.md` N1 §1 (`lib/env.ts` validate bằng Zod), commit `1b80fe4`; catalog `seeker19110/stored` 09 §1.4 (`NEXT_PUBLIC_`, validate env), 12 §3i, 07 Overmind (API từ chối khởi động khi thiếu key), đọc 2026-10-13.
