---
title: Quyết định kiến trúc (ADR) và quản trị thay đổi kiến trúc
kind: module
prefix: ARC-ADR
applies_to: [all]
updated: 2026-10-14
---

# Quyết định kiến trúc (ADR) và quản trị thay đổi kiến trúc

> Cách ghi, duyệt, chỉ mục và **không bao giờ sửa** các quyết định kiến trúc, theo MADR 4.0.0, với hai cột tách bạch
> **Status** (quyết định) và **Implementation status** (đã làm tới đâu). ADR là cách duy nhất để người sau — kể cả
> một phiên AI mới — không lật ngược quyết định cũ mà không biết lý do. Mẫu điền sẵn ở [`../templates/ADR.md`](../templates/ADR.md).

## Nguyên tắc

1. **Mỗi quyết định khó đảo = một ADR**, đánh số tăng dần `docs/adr/NNNN-<slug>.md`. Không viết ADR cho việc nhỏ,
   đảo được trong một PR.
2. **ADR bất biến.** Đổi ý → ADR mới, ADR cũ đổi Status thành *superseded by ADR-NNNN*; không sửa nội dung cũ
   (ngoài dòng trạng thái và liên kết). Dấu vết sai lầm là tài sản (luật 12 trong
   [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md)).
3. **Phương án đã cân nhắc là phần quan trọng nhất**: ≥ 2 ứng viên thật, tiêu chí rõ, lý do loại từng ứng viên.
   Một ADR chỉ có một phương án là tuyên bố, không phải quyết định.
4. **Phiên bản/số liệu trong ADR có ngày xác minh và nguồn** (P2); không đoán theo trí nhớ. Khi ADR nói về trạng
   thái hiện tại của repo, dẫn commit/SHA (ADR-0003 khung cũ dẫn `main = 1b34ac3`).
5. **Tách Status và Implementation status.** *Accepted* không có nghĩa đã làm; chỉ mục ADR có cột riêng cho tiến độ
   thực thi, và "đã thực thi" phải trỏ bằng chứng (PR, test, cổng CI) — catalog 23 §6.4.
6. **Confirmation = cách kiểm bằng máy.** Mỗi ADR nêu quyết định được bảo vệ bởi cái gì: luật phụ thuộc, test kiến
   trúc, hook, mục blueprint. Không có gì bảo vệ → ghi rõ là nợ.
7. **Điều kiện đọc lại.** ADR ghi sự kiện nào thì phải xem lại (khách EU đầu tiên, tenant thứ hai, vượt một máy…).

## Quyết định

| Câu hỏi | Chọn | Ghi chú |
|---|---|---|
| Định dạng | **MADR 4.0.0** (2024-09-17): metadata `status/date/decision-makers/consulted/informed` → Context and Problem Statement → Decision Drivers → Considered Options → Decision Outcome (+ Consequences, Confirmation) → Pros and Cons of the Options → More Information | Mẫu tiếng Việt ở [`../templates/ADR.md`](../templates/ADR.md) giữ nguyên các mục này; ADR cũ theo mẫu khung cũ (`git show 1b80fe4:docs/adr/0000-template.md`) vẫn hợp lệ, không chuyển đổi |
| Khi nào bắt buộc ADR | Chọn stack/CSDL/auth/hạ tầng · tách/gộp dịch vụ · đổi schema phá vỡ hoặc hợp đồng API · chạm bảo mật/thanh toán/mật mã · chọn/đổi model AI, prompt chính · vi phạm nguyên tắc P1–P12 · thay đổi cổng chất lượng | Theo "làn kiến trúc" của khung cũ spec §B3 và catalog 23 §4.3 (`/hoc`: kiến trúc → ADR) |
| Ai duyệt | S: chủ dự án · M: tech lead + 1 reviewer · L: hội đồng kiến trúc/bảo mật cho ADR chạm bảo mật/dữ liệu | Trạng thái *proposed* → *accepted* chỉ sau duyệt ghi trong ADR (`decision-makers`) |
| Chỉ mục | `docs/adr/README.md` sinh bằng script từ frontmatter/heading, cột: ID · Tiêu đề · Status · Implementation status · Ngày · Thay thế bởi | Sinh tự động + cổng drift, không tay (catalog 23 §6.4) |
| ADR cho AI agent | `AGENTS.md`/`CLAUDE.md` của dự án trỏ đọc `docs/adr/` trước khi đề xuất thay đổi kiến trúc; bài học kiến trúc từ sự cố → ADR (thang `/hoc`) | Xem [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md) |
| Thay đổi khung X-Templates | ADR ở `docs/adr/` của repo khung, cùng luật | Xem conventions §8 |

## Checklist

- [ ] `ARC-ADR-001` **MUST** Repo có thư mục `docs/adr/` với mẫu và ≥ 1 ADR chọn stack (G2) trước khi dựng nền (G5). → Kiểm: `ls docs/adr/0001-*.md`; ADR có heading "Phương án đã cân nhắc"/"Considered Options" với ≥ 2 mục. · Nguồn: [`../00-method/lifecycle.md`](../00-method/lifecycle.md) G2 · MADR 4.0.0
- [ ] `ARC-ADR-002` **MUST** ADR đánh số tăng dần 4 chữ số, không trùng, không tái sử dụng số; tên file `NNNN-<slug-kebab>.md`. → Kiểm: script liệt kê số và báo trùng/khoảng trống bất thường; regex tên file trong CI. · Nguồn: khung cũ `.claude/commands/adr.md` (`git show 1b80fe4:.claude/commands/adr.md`)
- [ ] `ARC-ADR-003` **MUST** Mỗi ADR có đủ: Status · Date · Context and Problem Statement · Considered Options (≥ 2) · Decision Outcome · Consequences. → Kiểm: script lint heading (grep) chạy trong CI; 0 file thiếu. · Nguồn: MADR 4.0.0 (required: Context, Considered Options, Decision Outcome)
- [ ] `ARC-ADR-004` **MUST** ADR đã *accepted* không bị sửa nội dung; thay đổi chỉ được ở dòng Status/liên kết "superseded by". → Kiểm: CI so diff file `docs/adr/*.md` đã accepted ở nhánh gốc — chỉ cho phép thay đổi dòng Status/links; hook `ask` khi sửa file ADR có `status: accepted`. · Nguồn: khung cũ ADR template ("KHÔNG sửa ADR cũ") · evidence-and-sources luật 12
- [ ] `ARC-ADR-005` **MUST@L** Đổi ý → ADR mới trỏ ADR cũ, ADR cũ chuyển Status `superseded by ADR-NNNN`; hai chiều liên kết. → Kiểm: script kiểm mọi "superseded by X" có file X tồn tại và X tham chiếu ngược. · Nguồn: MADR 4.0.0 (status superseded)
- [ ] `ARC-ADR-006` **MUST@L** Phiên bản, số liệu, văn bản luật trong ADR kèm ngày xác minh + URL; không xác minh được → "(chưa xác minh)". → Kiểm: grep mỗi chuỗi phiên bản (`\d+\.\d+`) trong ADR có "xác minh"/"(chưa xác minh)" cùng đoạn; review checklist. · Nguồn: P2 · [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md)
- [ ] `ARC-ADR-007` **MUST@L** Chỉ mục `docs/adr/README.md` tách cột **Status** và **Implementation status** (not started / partial / done + link bằng chứng). → Kiểm: bảng chỉ mục có hai cột đó; mỗi "done" có link PR/CI/test. · Nguồn: catalog 23 §6.4 (reveser `docs/adr/README.md`)
- [ ] `ARC-ADR-008` **MUST@L** Chỉ mục ADR sinh tự động từ file, có cổng drift trong CI (sinh lại và so khớp). → Kiểm: `python3 scripts/adr-index.py --check` exit 0; CI đỏ khi lệch. · Nguồn: catalog 23 §6.4 (catalog sinh từ mã + cổng drift)
- [ ] `ARC-ADR-009` **MUST@L** ADR thuộc làn kiến trúc (schema phá vỡ, hợp đồng API, bảo mật/thanh toán/mật mã, đổi model AI) được duyệt bởi người có vai trò ghi trong `decision-makers` trước khi merge code liên quan. → Kiểm: PR có nhãn `architecture` phải link ADR ở trạng thái accepted; rule CI kiểm thân PR. · Nguồn: khung cũ spec §B3 (làn kiến trúc) · catalog 23 §4 (`pr-policy.yml` feat phải link spec)
- [ ] `ARC-ADR-010` **SHOULD** Mỗi ADR có mục Confirmation nêu hàng rào máy kiểm (luật phụ thuộc, test, hook, mục blueprint) hoặc ghi "chưa có hàng rào — nợ". → Kiểm: heading "Confirmation"/"Xác nhận" có trong ADR; nợ ghi vào `PROGRESS.md`. · Nguồn: MADR 4.0.0 (Confirmation)
- [ ] `ARC-ADR-011` **SHOULD** ADR có mục "Điều kiện đọc lại" (trigger) và chủ sở hữu theo dõi. → Kiểm: heading tồn tại; điều kiện kiểm được (sự kiện/ngưỡng), không mơ hồ. · Nguồn: khung cũ ADR-0003 (điều kiện đọc lại)
- [ ] `ARC-ADR-012` **SHOULD** Khi ADR mô tả hiện trạng repo, dẫn SHA/commit và file đã đọc; khi hiện trạng mâu thuẫn tài liệu, ghi bảng "giả định vs thực tế". → Kiểm: ADR có SHA 7+ ký tự hoặc link commit; bảng đối chiếu khi có mâu thuẫn. · Nguồn: khung cũ ADR-0003 (bảng ADR-0002 giả định vs thực tế)
- [ ] `ARC-ADR-013` **SHOULD** `AGENTS.md`/`CLAUDE.md` của dự án yêu cầu đọc `docs/adr/` trước khi đề xuất thay đổi kiến trúc; bài học kiến trúc từ sự cố/post-mortem thành ADR. → Kiểm: grep `docs/adr` trong `AGENTS.md`; post-mortem SEV1/2 có mục "ADR phát sinh" (xem [`../15-operations/incident-response.md`](../15-operations/incident-response.md)). · Nguồn: P12 · catalog 23 §4.3 (`/hoc`)
- [ ] `ARC-ADR-014` **SHOULD** ADR ngắn: tối đa ~2 trang; chi tiết kỹ thuật dài đặt ở spec/tài liệu và link. → Kiểm: `wc -l` ≤ ngưỡng đội chọn (ghi trong `docs/adr/README.md`); lint cảnh báo. · Nguồn: MADR (minimal/full template)
- [ ] `ARC-ADR-015` **SHOULD** Liên kết trong ADR (nội bộ + ngoài) được kiểm hỏng định kỳ. → Kiểm: `lychee docs/adr` (0.24.2, Apache-2.0/MIT) hoặc `scripts/check-links.py` trong CI. · Nguồn: [`../10-workflow/documentation-workflow.md`](../10-workflow/documentation-workflow.md)
- [ ] `ARC-ADR-016` **MAY** Dùng `consulted`/`informed` trong metadata để ghi ai đã được hỏi/báo; ADR chạm nhiều đội gửi cho đội bị ảnh hưởng trước khi accepted. → Kiểm: metadata có hai trường; PR ADR tag đội liên quan.
- [ ] `ARC-ADR-017` **MAY** ADR nhỏ cho quyết định phạm vi hẹp ("micro-ADR" trong thư mục module) khi đội muốn, nhưng vẫn đánh số và vào chỉ mục. → Kiểm: script chỉ mục quét cả `src/**/adr/`.

## Bẫy thường gặp

- **Sửa ADR cũ cho khớp hiện tại** → mất lịch sử "tại sao"; người sau tưởng chưa từng có lý do khác. Tránh: ARC-ADR-004/005.
- **Accepted = đã làm.** ADR chấp nhận 6 tháng, code chưa đụng; đọc chỉ mục tưởng hệ đã có. Tránh: ARC-ADR-007/008.
- **ADR một phương án** ("Chúng ta dùng X") — không thể biết đã cân nhắc gì. Tránh: ARC-ADR-003.
- **Phiên bản theo trí nhớ** trong ADR (khung cũ ghi "Postgres 16/17" trong khi 18 là major hiện hành; tên/giá
  model AI lệch giữa hai tài liệu — `research/2026-10-13-old-framework-analysis.md`). Tránh: ARC-ADR-006.
- **ADR mô tả hệ nhiều máy khi repo chạy một máy** (ADR-0002 vs thực tế SQLite). Tránh: ARC-ADR-012 (bảng giả định vs thực tế).
- **ADR nằm ngoài repo** (wiki/Slack) → agent và người mới không thấy. Tránh: ARC-ADR-001 (`docs/adr/` trong repo).
- **Mẫu dài, không ai điền** → không có ADR nào. Tránh: ARC-ADR-014, mẫu tối thiểu ở [`../templates/ADR.md`](../templates/ADR.md).
- **Không có hàng rào** cho quyết định ("domain không import infra" chỉ nằm trong ADR) → trôi sau vài PR. Tránh: ARC-ADR-010 + [`boundaries-and-modularity.md`](boundaries-and-modularity.md).

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Heading bắt buộc, số thứ tự, tên file | script tự viết `scripts/adr-lint.py` (stdlib) | `python3 scripts/adr-lint.py docs/adr` | pre-commit + CI | 0 lỗi |
| Chỉ mục không drift | `scripts/adr-index.py --check` (sinh README từ ADR) | như trên | CI | diff = 0 |
| Markdown chuẩn | markdownlint-cli2 0.23.3 · MIT | `markdownlint-cli2 "docs/adr/**/*.md"` | pre-commit | 0 lỗi |
| Liên kết hỏng | lychee 0.24.2 · Apache-2.0/MIT, hoặc `check-links.py` của khung (`.xtemplates/scripts/check-links.py` ở dự án đích) | `lychee --offline docs/adr` (nội bộ) · online theo lịch | CI | 0 link hỏng |
| ADR accepted bị sửa | script diff theo nhánh gốc + hook `ask` (xem [`../11-autonomous-loop/harness-files.md`](../11-autonomous-loop/harness-files.md)) | `git diff origin/main -- docs/adr` lọc file accepted | PR CI + PreToolUse hook | chỉ dòng Status/link thay đổi |
| PR làn kiến trúc phải link ADR | rule CI đọc thân PR (như `pr-policy.yml`) | `gh pr view --json body` + regex `ADR-\d{4}` | CI (PR) | có link, ADR accepted |

## Nguồn

- MADR 4.0.0 (2024-09-17) — template và các mục: <https://adr.github.io/madr/>, changelog <https://raw.githubusercontent.com/adr/madr/main/CHANGELOG.md> — xác minh 2026-10-13 (không có bản 4.x mới hơn trong changelog ngày đó).
- Khung cũ X-stored: `docs/adr/0000-template.md` (quy ước không sửa ADR cũ), `docs/adr/0003-thu-hep-ve-boi-canh-cuc-bo.md` (bảng giả định vs thực tế, điều kiện đọc lại), `.claude/commands/adr.md` (đánh số, research-first), spec §B3 (làn kiến trúc) — commit `1b80fe4`.
- Catalog `seeker19110/stored` 23 §6.4 (reveser: `docs/adr/README.md` tách Status và Implementation status; catalog sinh từ mã + cổng drift), 23 §4.3 (`/hoc`: kiến trúc → ADR), 23 §4 (`pr-policy.yml`), đọc 2026-10-13.
- `research/2026-10-13-old-framework-analysis.md` (lệch phiên bản giữa tài liệu khung cũ), `research/2026-10-13-stored-catalog-extraction.md` (§ ADR tách cột).
- markdownlint-cli2 0.23.3 MIT: <https://registry.npmjs.org/markdownlint-cli2/latest>; lychee 0.24.2: <https://crates.io/api/v1/crates/lychee> — xác minh 2026-10-13.
