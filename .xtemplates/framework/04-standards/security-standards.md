---
title: Tiêu chuẩn bảo mật (OWASP ASVS/MASVS/Top 10, NIST SSDF, CIS, ISO 27001)
kind: standard
prefix: STD-SEC
applies_to: [all]
updated: 2026-10-14
---

# Tiêu chuẩn bảo mật (OWASP ASVS/MASVS/Top 10, NIST SSDF, CIS, ISO 27001)

> Bảng **phiên bản hiện hành** của các chuẩn bảo mật, chọn chuẩn nào cho quy mô/ngành nào, và **cách chứng minh
> tuân thủ bằng bằng chứng máy**. File này không dạy kỹ thuật bảo mật — kỹ thuật ở [`../12-security/`](../12-security/README.md).

## Nguyên tắc

- **Ghim phiên bản chuẩn như ghim phiên bản thư viện.** "Theo OWASP" không kiểm được; "ASVS 5.0.0 mức L2" kiểm được.
- **Chuẩn là bộ yêu cầu, không phải chứng chỉ.** Tuân thủ = mỗi yêu cầu áp dụng có bằng chứng (test, scan, cấu hình); "tự khai" không tính (P1).
- **Một chuẩn làm xương sống, chuẩn khác bổ sung.** Ứng dụng web/API: ASVS là xương sống; Top 10 chỉ là danh sách nhận thức; mobile thêm MASVS; quy trình thêm SSDF; hạ tầng thêm CIS; tổ chức thêm ISO 27001.
- **Ánh xạ về blueprint.** Chuẩn không được ghép trực tiếp vào `BLUEPRINT.md`; nó ánh xạ sang mục của khung (chủ yếu `12-security/*`, `08-backend/authn-authz`) và được kiểm ở đó.

## Quyết định

| Tình huống | Chuẩn xương sống | Bổ sung | Không cần |
|---|---|---|---|
| S (prototype, không dữ liệu thật) | ASVS 5.0.0 **L1** | OWASP Top 10:2025 làm checklist nhận thức | SSDF map, CIS, ISO |
| M (production, người dùng thật) | ASVS 5.0.0 **L2** | API Security Top 10 2023 (nếu có API công khai); MASVS 2.1.0 **MAS-L1** (mobile); SSDF 1.1 bảng ánh xạ; CIS Level 1 cho hạ tầng mình vận hành | ISO 27001 chứng nhận |
| L (ngành bị quản lý, nhiều đội, dữ liệu nhạy cảm) | ASVS 5.0.0 **L3** cho thành phần nhạy cảm, L2 phần còn lại | MASVS **MAS-L2 + R** (mobile tài chính); SSDF đầy đủ + 800-218A nếu có GenAI; CIS Level 2; **ISO/IEC 27001:2022** SoA | — |
| Có LLM/agent trong sản phẩm | như trên theo quy mô | OWASP LLM Top 10 (2026) + Agentic Top 10 → xem [`ai-standards.md`](ai-standards.md) | — |
| Bán cho chính phủ/doanh nghiệp lớn | theo quy mô | Khách thường hỏi ISO 27001 hoặc SOC 2 — chuẩn bị SoA sớm | — |

Mặc định khuyến nghị: **ASVS 5.0.0 L2** cho mọi dự án M trở lên. Không dùng ASVS "Bleeding Edge"/`latest` làm mục tiêu (đổi liên tục, không tái lập được).

## Bảng phiên bản hiện hành (xác minh 2026-10-13)

| Chuẩn | Phiên bản | Phát hành | URL | Áp dụng khi | Chứng minh tuân thủ (bằng chứng máy) |
|---|---|---|---|---|---|
| OWASP ASVS | **5.0.0** | 2025-05-30 (GitHub release) | <https://owasp.org/www-project-application-security-verification-standard/> | Mọi web/API/backend | File ánh xạ chương V1–V17 → mục blueprint/test; mỗi yêu cầu áp dụng có test hoặc scan |
| OWASP MASVS | **2.1.0** | 2026-01-18 (GitHub release; năm suy từ trang, chưa hiện rõ) | <https://mas.owasp.org/MASVS/> | Mobile native/cross-platform | Báo cáo kiểm thử theo MASTG, 8 nhóm STORAGE/CRYPTO/AUTH/NETWORK/PLATFORM/CODE/RESILIENCE/PRIVACY |
| OWASP Top 10 | **2025** (A01–A10:2025) | 2025 (trang không ghi ngày cụ thể) | <https://top10.owasp.org/2025> | Nhận thức + threat model web | Bảng A01..A10 → biện pháp trong `THREAT-MODEL.md`; scanner SARIF gắn CWE |
| OWASP API Security Top 10 | **2023** | 2023 (không có bản mới hơn) | <https://api-security.owasp.org/> | API công khai/đối tác | Test authz theo API1 (BOLA) và API5 (BFLA) chạy trong CI |
| OWASP LLM Top 10 | **2026** (mã đổi so với 2025) | 2026-08-04 (README repo GitHub chính chủ; genai.owasp.org trả 403) | <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> | Có LLM | Xem [`ai-standards.md`](ai-standards.md); bảng đổi mã ở [`../12-security/ai-security.md`](../12-security/ai-security.md) |
| OWASP Agentic Top 10 (ASI01–10) | 2026 (bản đầu) | 2025-12-09 (theo `research/2026-10-13-ai-agent-research.md` §5.1; trang gốc 403 hôm nay) | <https://genai.owasp.org/> | Agent có tool | Xem [`ai-standards.md`](ai-standards.md) |
| OWASP MCP Top 10 | MCP01–10:**2025**, dự án ở **Phase 3 (beta)** | chưa final | <https://owasp.org/www-project-mcp-top-10/> | Có MCP server/client | Xem [`ai-standards.md`](ai-standards.md); không ghim làm chuẩn final |
| NIST SP 800-218 SSDF | **1.1** | 2022-02-03 | <https://csrc.nist.gov/pubs/sp/800/218/final> | Quy trình phát triển (M+) | Bảng ánh xạ PO/PS/PW/RV → job CI có thật |
| NIST SP 800-218A | bản final | 2024-07-26 | <https://csrc.nist.gov/pubs/sp/800/218/a/final> | Dùng/huấn luyện GenAI, dual-use model | Thêm hàng vào bảng SSDF |
| CIS Benchmarks | theo từng sản phẩm (OS/K8s/cloud/DB) | cập nhật liên tục | <https://www.cisecurity.org/cis-benchmarks> | Hạ tầng mình vận hành | Báo cáo kube-bench/prowler/CIS-CAT Lite; PDF miễn phí, định dạng máy đọc cần SecureSuite |
| ISO/IEC 27001 | **2022** + Amd 1:2024 | 2022-10; Amd 1 2024-02 (theo nguồn thứ cấp — iso.org trả 403 ngày 2026-10-13) | <https://www.iso.org/standard/27001> | L, khách hàng đòi chứng nhận | Statement of Applicability (SoA) 93 kiểm soát Annex A, mỗi kiểm soát "áp dụng" có link bằng chứng |

Mọi phiên bản: **xác minh lại trước khi khai báo** vào `PROJECT.md` (P2).

## Checklist

- [ ] `STD-SEC-001` **MUST** Khai báo chuẩn bảo mật nhắm tới kèm phiên bản và mức (vd `ASVS 5.0.0 L2`) trong `PROJECT.md`. → Kiểm: `grep -E "ASVS 5\.0\.0 L[123]" PROJECT.md` khớp. · Nguồn: ASVS 5.0.0 ch.1 (Assessment and Verification)
- [ ] `STD-SEC-002` **MUST@L** Có file ánh xạ ASVS (`docs/compliance/asvs-map.md`): mỗi chương V1–V17 → mục blueprint/test hoặc miễn trừ có lý do. → Kiểm: script đếm đủ 17 chương, không chương nào trống. · Nguồn: ASVS 5.0.0 V1–V17
- [ ] `STD-SEC-003` **MUST** Threat model web có bảng A01–A10:2025 → biện pháp hoặc "không áp dụng + lý do". → Kiểm: `grep -cE "A(0[1-9]|10):2025" THREAT-MODEL.md` ≥ 10. · Nguồn: OWASP Top 10:2025
- [ ] `STD-SEC-004` **MUST@M** API công khai có test authz đặt tên theo API1 (BOLA) và API5 (BFLA) chạy trong CI. → Kiểm: `grep -rE "api1-bola|api5-bfla" tests/` ≥ 2 và job CI chạy chúng. · Nguồn: OWASP API Security Top 10 2023 API1, API5
- [ ] `STD-SEC-005` **MUST@L** Ứng dụng mobile khai báo hồ sơ MASVS (`MAS-L1`, `MAS-L2`, `+R`) trong `PROJECT.md` và có báo cáo kiểm thử MASTG trước phát hành. → Kiểm: `grep -E "MASVS 2\.1\.0 MAS-L[12]" PROJECT.md`; báo cáo đính kèm `GO-NO-GO.md`. · Nguồn: MASVS 2.1.0
- [ ] `STD-SEC-006` **MUST@L** Bảng ánh xạ SSDF (`docs/compliance/ssdf-map.md`): mỗi thực hành PO/PS/PW/RV áp dụng → tên job CI có thật. → Kiểm: script đối chiếu tên job trong file với `.github/workflows/*.yml` (hoặc CI tương đương), không hàng nào trỏ job không tồn tại. · Nguồn: NIST SP 800-218 v1.1
- [ ] `STD-SEC-007` **MUST@M** Hạ tầng tự vận hành (OS, container, K8s, cloud account, DB) quét theo CIS Benchmark Level 1, 0 FAIL hoặc mỗi FAIL có miễn trừ ghi lý do. → Kiểm: job CI/cron chạy `kube-bench`/`prowler`/`docker-bench-security`, báo cáo lưu artifact. · Nguồn: CIS Benchmarks (Level 1)
- [ ] `STD-SEC-008` **MUST@L** Có Statement of Applicability ISO/IEC 27001:2022: mỗi kiểm soát Annex A "áp dụng" trỏ tới bằng chứng (chính sách, cấu hình, log). → Kiểm: `docs/compliance/soa.csv` có 93 hàng, cột `evidence` không trống ở hàng applicable. · Nguồn: ISO/IEC 27001:2022 Annex A
- [ ] `STD-SEC-009` **MUST@L** Kết quả SAST/DAST xuất SARIF có mã CWE để đối chiếu Top 10/ASVS. → Kiểm: `jq '.runs[].results[].ruleId' *.sarif` và taxonomy CWE trong `runs[].taxonomies`. · Nguồn: OWASP Top 10:2025 (ánh xạ CWE)
- [ ] `STD-SEC-010` **SHOULD** Không dùng ASVS "Bleeding Edge"/`latest` làm mục tiêu; ghim bản release. → Kiểm: `grep -iE "bleeding|latest" docs/compliance/asvs-map.md` không khớp.
- [ ] `STD-SEC-011` **SHOULD** Sản phẩm có LLM/agent/MCP ánh xạ thêm OWASP LLM Top 10 2026, Agentic Top 10 và MCP Top 10 (beta) theo [`ai-standards.md`](ai-standards.md) và [`../12-security/ai-security.md`](../12-security/ai-security.md). → Kiểm: `docs/compliance/ai-threats.md` tồn tại khi `PROJECT.md` khai báo có LLM.
- [ ] `STD-SEC-012` **SHOULD** Bảng phiên bản chuẩn trong repo có cột "ngày xác minh" và được rà lại ≤ 6 tháng. → Kiểm: script so ngày xác minh với ngày hiện tại, cảnh báo khi > 180 ngày.
- [ ] `STD-SEC-013` **MAY** Dùng NIST SP 800-218A khi dự án huấn luyện/fine-tune hoặc nhúng mô hình GenAI dual-use.
- [ ] `STD-SEC-014` **MAY** Chứng nhận ISO/IEC 27001 bởi tổ chức bên thứ ba khi khách hàng/ngành yêu cầu (L).

## Bẫy thường gặp

- **Chép bảng ánh xạ ASVS 4.0.3 sang 5.0.0.** ASVS 5.0 đánh số lại chương (vd V6 Authentication, V8 Authorization) và bỏ/gộp nhiều yêu cầu. Cách tránh: làm map mới từ bản 5.0.0, không tìm-thay số.
- **Top 10 2021 trong tài liệu mới.** 2025 đổi tên/thêm hạng mục (A03 Software Supply Chain Failures, A10 Mishandling of Exceptional Conditions). Cách tránh: grep `:2021` trong docs → cập nhật.
- **"Tuân thủ OWASP Top 10" không bằng chứng.** Top 10 là danh sách nhận thức, không có mức kiểm. Cách tránh: tuyên bố theo ASVS mức L, kèm map + test.
- **Ghim MCP Top 10 như chuẩn final.** Dự án còn beta (Phase 3), ID `MCP0x:2025` có thể đổi. Cách tránh: ghi "beta, xác minh lại", không viết ID vào test name.
- **Tin aggregator về phiên bản.** Nhiều blog ghi "ASVS 5.0" với ngày khác nhau; chỉ GitHub release/trang chuẩn là nguồn. Cách tránh: cột URL trong bảng trên.
- **CIS Benchmark "đã quét" nhưng dùng profile sai.** Level 2 làm vỡ môi trường dev; Level 1 mới là mặc định. Cách tránh: ghi rõ profile trong lệnh quét.
- **Chép nguyên văn ISO vào repo.** Văn bản ISO có bản quyền, phải mua. Cách tránh: SoA chỉ ghi mã kiểm soát + bằng chứng, không chép nội dung.
- **genai.owasp.org chặn bot** (403 ngày 2026-10-13) nên agent dễ "đoán" phiên bản. Cách tránh: xác minh qua repo GitHub chính chủ của OWASP, ghi rõ nguồn thay thế.

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| grep khai báo chuẩn | `grep -E "ASVS 5\.0\.0 L[123]" PROJECT.md` | CI job `gate` | khớp ≥ 1 |
| Script kiểm map | `python3 scripts/check-standards-map.py docs/compliance/asvs-map.md --chapters 17` (tự viết, ~30 dòng) | CI | 0 chương trống |
| Semgrep (OSS engine LGPL; **bộ rule chính thức không OSI**) / CodeQL (miễn phí cho OSS; license GitHub cho private) | `semgrep --config p/owasp-top-ten --sarif` · `codeql database analyze … --format=sarif-latest` | CI, PR | 0 finding mức high; SARIF có CWE |
| OWASP ZAP baseline (DAST, Apache-2.0) | `zap-baseline.py -t https://staging… -J report.json` | CI nightly | 0 alert mức High |
| kube-bench (Apache-2.0) / prowler (Apache-2.0) | `kube-bench run --benchmark cis-1.x` · `prowler aws --compliance cis_2.0_aws` | cron tuần | 0 FAIL Level 1 chưa miễn trừ |
| SoA/ssdf-map đối chiếu CI | script đọc `.github/workflows/*.yml`, so tên job | CI | 0 hàng trỏ job không tồn tại |

Cấu hình cụ thể của scanner (SAST/DAST/SCA) thuộc [`../12-security/appsec-web.md`](../12-security/appsec-web.md) và [`../12-security/supply-chain.md`](../12-security/supply-chain.md).

## Nguồn

- OWASP ASVS 5.0.0: <https://owasp.org/www-project-application-security-verification-standard/> · release: <https://github.com/OWASP/ASVS/releases> (v5.0.0_release 30/05/2025) — xác minh 2026-10-13
- OWASP MASVS 2.1.0: <https://mas.owasp.org/MASVS/> · <https://github.com/OWASP/owasp-masvs/releases> — xác minh 2026-10-13 (trang release không hiện năm)
- OWASP Top 10:2025: <https://top10.owasp.org/2025> — xác minh 2026-10-13
- OWASP API Security Top 10 2023: <https://api-security.owasp.org/> — xác minh 2026-10-13
- OWASP Top 10 for LLM Applications 2026 (công bố 04/08/2026): <https://github.com/GenAI-Security-Project/GenAI-LLM-Top10> (README "Current release: 2026") — xác minh 2026-10-14; repo cũ `OWASP/www-project-top-10-for-large-language-model-applications` nay là lưu trữ. **Đính chính**: `research/2026-10-13-ai-agent-research.md` §5.1 ghi "chưa có bản 2026" — sai; mã LLM01–10 đổi theo bảng ở [`../12-security/ai-security.md`](../12-security/ai-security.md)
- OWASP MCP Top 10 (beta): <https://owasp.org/www-project-mcp-top-10/> — xác minh 2026-10-13
- NIST SP 800-218 v1.1: <https://csrc.nist.gov/pubs/sp/800/218/final> · SP 800-218A: <https://csrc.nist.gov/pubs/sp/800/218/a/final> — xác minh 2026-10-13
- CIS Benchmarks: <https://www.cisecurity.org/cis-benchmarks> — xác minh 2026-10-13
- ISO/IEC 27001:2022 (+Amd 1:2024): <https://www.iso.org/standard/27001> — **(chưa xác minh trực tiếp — iso.org trả 403 ngày 2026-10-13; năm theo nguồn thứ cấp)**
- Catalog `seeker19110/stored` mục 09 (evidence or FAIL), mục 12 §1 — đọc 2026-10-13; `research/2026-10-13-stored-catalog-extraction.md` §2.5–2.6.
