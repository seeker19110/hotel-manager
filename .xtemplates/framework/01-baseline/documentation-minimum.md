---
title: Tài liệu tối thiểu (README · runbook · ADR · CHANGELOG)
kind: baseline
prefix: BASE-DOC
applies_to: [all]
updated: 2026-10-16
---

# Tài liệu tối thiểu (README · runbook · ADR · CHANGELOG)

> Bộ tài liệu **sàn** mà người mới (hoặc phiên agent mới) cần để chạy, kiểm, vận hành và hiểu "vì sao" của một phần mềm —
> nằm trong repo, tươi bằng máy. Quy trình docs-as-code và tài liệu sống là nhà của
> [`../10-workflow/documentation-workflow.md`](../10-workflow/documentation-workflow.md); ADR ở
> [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md); tài liệu cho AI agent ở
> [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md).

## Nguyên tắc

- **Tài liệu nằm cạnh mã** (docs-as-code): cùng repo, cùng PR, cùng review, cùng CI. Wiki ngoài repo là nợ.
- **Mã nói "cái gì", tài liệu nói "vì sao"**: ADR giữ lý do; README giữ cách chạy; runbook giữ cách cứu.
- **Tươi bằng máy, không bằng lời hứa**: lệnh trong README được CI chạy; link được kiểm; SHA/ngày trong file trạng thái
  phải là tổ tiên của HEAD.
- **Bốn nhu cầu, bốn loại** (Diátaxis): tutorial (học), how-to (làm việc cụ thể), reference (tra), explanation (hiểu).
  Không trộn bốn loại trong một trang.
- **Tối thiểu nhưng đủ**: một README tốt + CHANGELOG + ADR + runbook (nếu triển khai) hơn mười trang không ai cập nhật.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Ở đâu? | `README.md` gốc (cửa vào) + `docs/` (phần còn lại) + `docs/adr/` + `CHANGELOG.md`; mọi thứ Markdown. | Site docs riêng (MkDocs/Zensical, Starlight, Docusaurus, Sphinx) khi có người dùng ngoài; nguồn vẫn trong repo. |
| README dài bao nhiêu? | Trả lời trong ≤ 1 màn: cái gì, cho ai, chạy thế nào, kiểm thế nào, link tiếp. Chi tiết đẩy sang `docs/`. | README > 300 dòng → tách. |
| Runbook có cần không? | **Có** nếu phần mềm được triển khai/chạy định kỳ (server, job, bot, agent); mẫu [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md). | Thư viện/CLI thuần: thay bằng mục "Khắc phục sự cố" trong README. |
| Tài liệu API | Sinh từ nguồn sự thật: OpenAPI/AsyncAPI/proto từ mã hoặc mã từ spec; TypeDoc/Sphinx autodoc/`go doc`/DocFX. | Viết tay song song với mã → lệch. |
| Sơ đồ | Text (Mermaid/PlantUML/C4-PlantUML) commit cùng mã; render lúc build. | Ảnh PNG không có nguồn: chỉ chấp nhận khi là ảnh chụp thật (screenshot) có ngày. |

## Checklist

- [ ] `BASE-DOC-001` **MUST** `README.md` ở gốc có các mục: mô tả một đoạn (vấn đề + cho ai), yêu cầu môi trường (runtime + phiên bản), cách cài & chạy, cách chạy test, cấu hình cần đặt (trỏ `.env.example`), cách đóng góp/liên hệ, license. → Kiểm: script kiểm tồn tại heading theo danh sách (`check:readme`); lệnh cài/chạy/test trong README được CI thực thi (xem BASE-DOC-005). · Nguồn: OpenSSF Badge `documentation_basics`; GitHub community profile
- [ ] `BASE-DOC-002` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-REPO-007`](repo-and-versioning.md): `CHANGELOG.md` theo Keep a Changelog 1.1.0, ghi chú người đọc được cho mỗi bản phát hành, heading bản mới nhất khớp tag.
- [ ] `BASE-DOC-003` **MUST** Quyết định kiến trúc/công nghệ quan trọng có **ADR** trong `docs/adr/` theo mẫu [`../templates/ADR.md`](../templates/ADR.md) (MADR 4.0.0: bối cảnh, lựa chọn đã xét, quyết định, hệ quả); ADR cũ không sửa, đổi ý thì viết ADR mới "supersedes". → Kiểm: `ls docs/adr/*.md` ≥ 1 (ADR chọn stack); mỗi file có các heading bắt buộc; chi tiết [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md). · Nguồn: MADR 4.0.0; lifecycle.md G2
- [ ] `BASE-DOC-004` **MUST** Phần mềm được triển khai có **runbook**: cách deploy/rollback, lệnh chẩn đoán, cảnh báo nào nghĩa là gì, liên hệ trực, bí mật nằm ở đâu (không phải giá trị). → Kiểm: `docs/RUNBOOK.md` (hoặc `docs/ops/`) tồn tại theo mẫu; mỗi alert trong cấu hình alert có mục tương ứng trong runbook. · Nguồn: [`../15-operations/incident-response.md`](../15-operations/incident-response.md); OpenSSF Badge `documentation_basics`
- [ ] `BASE-DOC-005` **MUST** Lệnh "cài → chạy → test" trong README được **CI chạy thật** từ clone sạch (smoke) để tài liệu không lệch mã. → Kiểm: job CI `readme-smoke` thực thi đúng các lệnh (trích từ block ```bash có nhãn hoặc từ `xt.yaml`/`runtime.yaml`), exit 0. · Nguồn: P1; evidence-and-sources.md luật 5
- [ ] `BASE-DOC-006` **MUST** Liên kết nội bộ trong tài liệu trỏ tới file có thật; liên kết ngoài không chết. → Kiểm: `lychee --offline` (nội bộ, chặn merge) + `lychee` có mạng (cron, cảnh báo) = 0 lỗi. · Nguồn: conventions.md §7
- [ ] `BASE-DOC-007` **MUST** Tài liệu mô tả **giao diện bên ngoài** (API/CLI/SDK/định dạng file/sự kiện) được **sinh từ nguồn sự thật** (OpenAPI/proto/docstring/`--help`) hoặc kiểm khớp bằng test; không có bảng tham số viết tay riêng. → Kiểm: CI chạy generator tài liệu (OpenAPI, `--help`, typedoc…) rồi `git diff --exit-code` trên thư mục docs được sinh. · Nguồn: OpenSSF Badge `documentation_interface`; P5
- [ ] `BASE-DOC-008` **MUST@M** Có file trạng thái dự án (`PROGRESS.md` theo [`../templates/PROGRESS.md`](../templates/PROGRESS.md), ≤ 8 KB, 4 mục) để phiên sau tiếp tục; SHA/ngày ghi trong đó phải là tổ tiên của HEAD. → Kiểm: `xt.py progress-check` chạy trong CI. Mục sàn; luật đầy đủ ở nhà [`LOOP-HARNESS-004`/`005`](../11-autonomous-loop/harness-files.md). · Nguồn: catalog 21 §8 điểm 9, 23 §2.1
- [ ] `BASE-DOC-009` **SHOULD** Tài liệu phân loại theo Diátaxis: `docs/tutorials/`, `docs/how-to/`, `docs/reference/`, `docs/explanation/` (hoặc nhãn tương đương trong mục lục); mỗi trang thuộc một loại. → Kiểm: mục lục `docs/README.md` gắn loại cho mỗi trang. · Nguồn: Diátaxis
- [ ] `BASE-DOC-010` **SHOULD** Mỗi trang tài liệu có `updated: YYYY-MM-DD` (frontmatter) và/hoặc mốc phiên bản áp dụng; trang quá 12 tháng không cập nhật được đánh dấu "cần rà". → Kiểm: script liệt kê trang có `updated` cũ hơn 365 ngày, xuất cảnh báo trong CI. · Nguồn: [`../10-workflow/documentation-workflow.md`](../10-workflow/documentation-workflow.md)
- [ ] `BASE-DOC-011` **SHOULD** Thay đổi hành vi người dùng thấy, cấu hình, API hay lệnh vận hành phải **đi kèm cập nhật tài liệu trong cùng PR**; PR template có ô "Docs". → Kiểm: CI cảnh báo khi diff chạm `src/**/api|cli|config` mà không chạm `docs/**|README.md|CHANGELOG.md` (trừ nhãn `no-docs` có lý do). · Nguồn: Docs as Code (Write the Docs)
- [ ] `BASE-DOC-012` **SHOULD** Markdown qua lint (heading tuần tự, không link trần, code fence có ngôn ngữ) và định dạng thống nhất để máy (và agent) đọc chính xác. → Kiểm: `markdownlint-cli2 "**/*.md"` 0 lỗi trong CI. · Nguồn: catalog 16 §2 ("markdown sạch")
- [ ] `BASE-DOC-013` **SHOULD** Sơ đồ kiến trúc tối thiểu C4 mức 1 (hệ thống + người dùng + hệ ngoài) dạng text commit cùng mã. → Kiểm: `docs/architecture/*.md` có block `mermaid`/PlantUML render được trong CI. · Nguồn: lifecycle.md G4; C4 model
- [ ] `BASE-DOC-014` **SHOULD** Tài liệu không chứa bí mật, dữ liệu người dùng thật, hay thông tin nội bộ nhạy cảm (IP nội bộ, tên máy chủ) dù repo riêng tư. → Kiểm: gitleaks quét `docs/`; review checklist. · Nguồn: OWASP Logging CS (data to exclude) áp cho tài liệu
- [ ] `BASE-DOC-015` **MAY** Xuất bản docs bằng SSG (MkDocs/Zensical, Starlight, Docusaurus, Sphinx, mdBook) kèm `llms.txt` và bản `.md` cho mỗi trang (xem [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md)). → Kiểm: `curl -f <site>/llms.txt`. · Nguồn: llms.txt v2
- [ ] `BASE-DOC-016` **MAY** Giữ bằng chứng tách khỏi tuyên bố: `docs/evidence/<ngày>/` (hoặc `.autopilot/evidence/`) chứa output lệnh/báo cáo được trích dẫn trong tài liệu. → Kiểm: tài liệu "đã đạt X" link tới file bằng chứng. · Nguồn: catalog 23 §4.4; evidence-and-sources.md §2
- [ ] `BASE-DOC-017` **SHOULD** Mọi con số công bố (README, ghi chú phát hành, trang giới thiệu: hiệu năng, độ chính xác, benchmark) trỏ tới **file kết quả đã commit** kèm điều kiện đo (phần cứng, phiên bản, cỡ mẫu); có test so con số trong tài liệu với file đó, lệch thì CI đỏ. → Kiểm: test kiểu `test_readme_numbers.py` chạy trong CI. · Nguồn: `seeker19110/stored` 17 §2c.2 (AnyJev: `tests/test_readme_numbers.py` kiểm bảng README khớp JSON đã commit; đọc 2026-10-16)
- [ ] `BASE-DOC-018` **SHOULD** `docs/limitations.md` (hoặc mục "Giới hạn đã biết" trong README) ghi điều sản phẩm **không làm** và khi nào số liệu hết đúng; cập nhật khi đổi hành vi. → Kiểm: file tồn tại và README link tới nó. · Nguồn: `seeker19110/stored` 17 §2c.3 (AnyJev `docs/limitations.md`), 21 §10b (`SECURITY.md` tự khai giới hạn rõ); đọc 2026-10-16

## Bẫy thường gặp

- **README mô tả lệnh đã đổi tên.** Không ai chạy lại. Cổng `readme-smoke` chạy lệnh thật.
- **Wiki ngoài repo** "để dễ sửa" → không review, không versioning, lệch mã sau một quý. Docs-as-code.
- **ADR sửa tại chỗ khi đổi ý** → mất lịch sử vì sao. Viết ADR mới, đánh dấu cái cũ "superseded".
- **Tài liệu API viết tay cạnh OpenAPI.** Hai nguồn sự thật. Sinh một chiều.
- **PROGRESS.md thành nhật ký 400 dòng** (khung cũ từng mắc) → tốn ngữ cảnh, không ai đọc. Giữ ≤ 8 KB, 4 mục; lịch sử sang CHANGELOG.
- **Runbook viết trước sự cố và không bao giờ chạy thử.** Mỗi alert → một mục runbook đã diễn tập (xem [`../15-operations/incident-response.md`](../15-operations/incident-response.md)).
- **Trộn tutorial với reference** → người học bị ngợp bảng tham số, người tra bị kể chuyện. Tách theo Diátaxis.
- **Dán URL staging/IP nội bộ/khoá thử vào docs** — docs là nơi bí mật rò rỉ ít bị quét nhất. Quét docs như quét mã.
- **Con số trong README không ai kiểm** (hiệu năng, độ chính xác) → trôi khỏi file kết quả sau vài lần đo lại. Test so số với file đã commit (`BASE-DOC-017`).
- **Chỉ nói sản phẩm làm được gì**, không nói không làm gì và số liệu hết đúng khi nào → người dùng áp sai ngữ cảnh. `docs/limitations.md` (`BASE-DOC-018`).

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Link | lychee v0.24.2 (MIT/Apache-2.0) | `lychee --offline "**/*.md"` (chặn) · `lychee "**/*.md"` (cron) | CI | 0 lỗi nội bộ |
| Markdown lint | markdownlint-cli2 (MIT) | `markdownlint-cli2 "**/*.md" "#node_modules"` | hook + CI | 0 |
| README heading bắt buộc | script repo | `check:readme` | CI | đủ heading |
| README smoke | job CI | thực thi lệnh cài/chạy/test từ clone sạch | CI (tuần + khi README đổi) | exit 0 |
| Docs ↔ mã | script `docs-required` | diff `src/**` chạm API/CLI/config ⇒ diff `docs/**` | CI | cảnh báo/chặn theo nhãn |
| Tươi | `xt.py progress-check`, `updated` > 365 ngày | `git merge-base --is-ancestor` | CI | lệch = đỏ / cảnh báo |
| Sinh tài liệu API | OpenAPI generator / TypeDoc / Sphinx autodoc / `go doc` | generator + `git diff --exit-code` | CI | 0 diff |
| Sơ đồ render | Mermaid CLI (MIT) / PlantUML (GPL/MIT tuỳ bản) | `mmdc -i … -o /dev/null` | CI | 0 lỗi |
| Số công bố ↔ kết quả | test tự viết | `test_readme_numbers.py`: so con số trong README/ghi chú phát hành với file kết quả đã commit | CI | lệch = đỏ |
| Giới hạn đã biết | script repo | kiểm `docs/limitations.md` tồn tại và README link tới nó | CI | thiếu = cảnh báo |

## Nguồn

- Diátaxis (bốn loại tài liệu): <https://diataxis.fr/> — xác minh 2026-10-13
- Keep a Changelog 1.1.0: <https://keepachangelog.com/en/1.1.0/> — xác minh 2026-10-13
- MADR 4.0.0 (2024-09-17, MIT OR CC0-1.0): <https://adr.github.io/madr/> — xác minh 2026-10-13; adr.github.io: <https://adr.github.io/> — xác minh 2026-10-13
- OpenSSF Best Practices Badge (`documentation_basics`, `documentation_interface`, `release_notes`): <https://www.bestpractices.dev/en/criteria/0> — xác minh 2026-10-13
- GitHub community profile (README, CoC, CONTRIBUTING, LICENSE, issue templates): <https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories> — xác minh 2026-10-13
- Write the Docs — Docs as Code: <https://www.writethedocs.org/guide/docs-as-code/> — xác minh 2026-10-13
- C4 model: <https://c4model.com/> — xác minh 2026-10-13 (theo lifecycle.md)
- llms.txt v2 (cập nhật 2026-08-10): <https://llmstxt.org/> — xác minh 2026-10-13
- lychee v0.24.2: <https://github.com/lycheeverse/lychee/releases/latest> — xác minh 2026-10-13; markdownlint-cli2 (MIT): <https://github.com/DavidAnson/markdownlint-cli2> — không có trang release ngày 2026-10-13, phiên bản **(chưa xác minh)**
- Catalog `seeker19110/stored` 16 §2 (tài liệu tốt cho AI = tài liệu tốt cho người + markdown sạch), 21 §8 điểm 9 và 23 §2.1/§4.4 (PROGRESS ≤ 8 KB, freshness, bằng chứng tách khỏi tuyên bố), đọc 2026-10-13; khung cũ X-stored `project-completion.md`, `PROGRESS.md` (bài học nhật ký 376 dòng) commit `1b80fe4` theo [`../../research/2026-10-13-old-framework-analysis.md`](../../research/2026-10-13-old-framework-analysis.md).
- Catalog `seeker19110/stored` 17 §2c.2–§2c.3 (AnyJev: `test_readme_numbers.py`, `docs/limitations.md`), 21 §10b (`SECURITY.md` tự khai giới hạn) — đọc 2026-10-16.
