---
title: Code review: người + AI, checklist, SLA, ranh giới
kind: module
prefix: WF-REVIEW
applies_to: [all]
updated: 2026-10-16
---

# Code review: người + AI, checklist, SLA, ranh giới

> Review là cổng cuối trước khi mã vào trunk, nơi máy không kiểm được: ý định, thiết kế, ca biên nghiệp vụ, rủi
> ro. AI review là **một claim cần verify**, không phải approval; reviewer AI phải **khác model** với implementer;
> người giữ quyền merge. SLA 24 giờ, quá hạn leo thang chứ không tự pass.

## Nguyên tắc

1. **Máy trước, người sau (P9).** Lint/format/type/test/scan xanh rồi mới xin review; reviewer không tốn thời
   gian vào thứ máy bắt được.
2. **Review để tìm lỗi, không để chứng nhận.** Mỗi review trả lời: đúng spec? ca biên? bảo mật? đảo ngược được?
   test có chứng minh? — có checklist, có bằng chứng (lệnh đã chạy), không "LGTM" trần.
3. **AI review là claim.** Kết quả của model (kể cả `/review`) phải được người xác nhận hoặc máy chứng minh
   (test tái hiện); AI không có quyền approve; reviewer và implementer khác model để tránh tự chứng nhận.
4. **Nhỏ và nhanh.** PR ≤ 400 dòng, review ≤ 60 phút/lượt, phản hồi đầu ≤ 24 giờ; quá hạn → leo thang người
   khác, không bao giờ tự merge vì "hết giờ".
5. **Tôn trọng, cụ thể, có mức.** Nhận xét gắn nhãn `blocker` / `should` / `nit`; blocker phải nêu lý do và
   cách sửa; tác giả không tự resolve blocker của người khác.

## Quyết định

| Tình huống | Chọn | Ghi chú |
|---|---|---|
| Ai review | Người có hiểu biết miền + 1 reviewer AI (model khác implementer) chạy trước để lọc | Reviewer AI không thay người ở vùng nhạy cảm |
| Vùng nhạy cảm (auth, payment, migration, CI/hook/ruleset, secrets, crypto) | **Luôn người review**, ≥ 1 code owner, không fast-lane | Tự động merge chỉ cho thay đổi rủi ro thấp (docs, deps patch có test xanh) |
| Fast-lane (auto-merge khi CI xanh) | Chỉ khi **đủ 5 điều kiện máy kiểm**: diff chỉ trong vùng rủi ro thấp · ≤ N dòng · không chạm schema/CI/auth · có test tăng hoặc giữ coverage · bộ test gồm test viết từ spec (không chỉ test agent sinh từ diff) | Thiếu một điều kiện → làn chuẩn |
| PR lớn không chia được (sinh mã, refactor tự động) | Review theo diff ngữ nghĩa + chạy script sinh lại để so khớp (`git diff` sau regen = rỗng) | Đọc tay 5.000 dòng |
| Bất đồng | Người có thẩm quyền miền quyết; ghi ADR nếu là quyết định kiến trúc | Kéo dài > 2 vòng không có người quyết |
| Review đồng bộ (pairing) hay bất đồng bộ | Bất đồng bộ mặc định; đồng bộ cho thay đổi phức tạp hoặc onboarding | — |

## Checklist

- [ ] `WF-REVIEW-001` **MUST** PR chỉ được xin review khi cổng máy đã xanh (lint, format, type, test, scan); reviewer được phép từ chối review PR đỏ. → Kiểm: job `quality` là required check; PR template có mục "CI xanh". · Nguồn: P9
- [ ] `WF-REVIEW-002` **MUST** Mỗi PR có mô tả: mục tiêu, link spec/issue, **cách đã xác minh** (lệnh + kết quả/exit code hoặc link CI), rủi ro và cách rollback; thiếu → chưa đủ điều kiện review. → Kiểm: `pr-policy` job kiểm các mục bắt buộc trong body. · Nguồn: catalog 23 §2.5 (mục bắt buộc Summary/Validation/Risk)
- [ ] `WF-REVIEW-003` **MUST@L** Reviewer dùng checklist review (đúng spec/tiêu chí chấp nhận; ca biên null/rỗng/race/UTC/tiền; bảo mật: input validate, quyền server, không secret; test chứng minh thay đổi; đảo ngược được; không nới cổng); kết luận có bằng chứng, không "LGTM" trần cho PR có code. → Kiểm: comment approve chứa mục checklist hoặc skill `/review` xuất báo cáo; mẫu checklist trong PR template. · Nguồn: [`../14-testing-quality/unit-and-logic-edge-cases.md`](../14-testing-quality/unit-and-logic-edge-cases.md)
- [ ] `WF-REVIEW-004` **MUST@L** AI review (nếu dùng) chạy bằng model/tool **khác** với model/tool đã viết code; kết quả gắn nhãn là claim; chỉ người hoặc test tái hiện mới đóng được finding; AI không có quyền approve/merge. → Kiểm: cấu hình reviewer agent khác model implementer (vd `.claude/agents/reviewer.md`); token bot không có quyền approve trong ruleset. · Nguồn: catalog 23 §2.3 (reviewer khác model), AGENTS.md §8
- [ ] `WF-REVIEW-005` **MUST** Finding mức `blocker` phải được sửa hoặc bác bỏ có lý do trước merge; `required_review_thread_resolution` bật; tác giả không tự resolve thread blocker của người khác. → Kiểm: ruleset có `required_review_thread_resolution: true`; review log. · Nguồn: GitHub Rulesets
- [ ] `WF-REVIEW-006` **MUST@L** SLA: phản hồi đầu tiên ≤ 24 giờ làm việc; nhắc ở 12 giờ; quá 24 giờ → leo thang reviewer khác/người quản lý; **không tự merge vì quá hạn**. → Kiểm: job cron đánh dấu PR chờ review > 24h (nhãn `review-overdue` + thông báo); không có cơ chế auto-approve theo thời gian. · Nguồn: catalog 23 §2.6 (gate timeout 24h leo thang, nhắc 12h)
- [ ] `WF-REVIEW-007` **MUST** Vùng nhạy cảm (auth, payment, migration, `.github/`, hook, ruleset, secrets, crypto, PII) luôn có người review là code owner; không fast-lane; không auto-merge — trừ khi chủ dự án chọn `merge_autonomy: L3` (mở PR là bật auto-merge, ADR-0015 của repo khung): khi đó miễn cho `.github/`, hook, ruleset, migration (ghi `[~] — Miễn:` kèm lý do); auth, payment, secrets, crypto, PII vẫn người review và merge ở mọi mức (`LOOP-STOP-005`, ADR-0016). → Kiểm: CODEOWNERS có mục; `require_code_owner_review` hoặc guard kiểm đường dẫn ↔ reviewer. · Nguồn: catalog 23 §2.6 (auth/payment/crypto luôn lane kiến trúc)
- [ ] `WF-REVIEW-008` **MUST@L** Tác giả tự review diff trước khi xin review (đọc lại từng hunk, xoá debug/console.log, không file ngoài phạm vi, không thay đổi cấu hình cổng không lý do). → Kiểm: PR template có mục "đã tự review"; `pr-policy` cảnh báo khi diff chạm `eslint.config`/`tsconfig`/coverage threshold/CI mà body không có mục "Thay đổi cổng: lý do". · Nguồn: AGENTS.md §3
- [ ] `WF-REVIEW-009` **MUST@L** Thay đổi sửa bug có test tái hiện (đỏ trước, xanh sau) được chỉ ra trong PR; reviewer kiểm test thực sự fail khi revert fix. → Kiểm: PR `fix:` link test; CI job "mutation nhẹ": revert fix tạm → test phải đỏ (hoặc reviewer ghi đã kiểm). · Nguồn: `evidence-and-sources.md` §2
- [ ] `WF-REVIEW-010` **MUST@L** Fast-lane/auto-merge chỉ bật khi vị từ máy kiểm đủ 5 điều kiện (vùng rủi ro thấp, kích thước, không chạm schema/CI/auth, coverage, test từ spec); mọi điều kiện không đánh giá được tính là trượt (fail-closed); có đường lùi: một lỗi lọt nghiêm trọng → tắt fast-lane đến khi rà xong. → Kiểm: script `fast-lane-predicate` trong CI xuất `true/false` có lý do; nhật ký bật/tắt. · Nguồn: khung cũ spec §B3.1a (chốt 2026-09-05)
- [ ] `WF-REVIEW-011` **MUST@L** Four-eyes cho vùng nhạy cảm: 2 approval từ 2 người khác tác giả; review bảo mật độc lập theo lịch cho module auth/payment. → Kiểm: ruleset theo path hoặc guard; lịch review trong `docs/ops/`. · Nguồn: lifecycle quy mô L
- [ ] `WF-REVIEW-012` **SHOULD** Nhận xét gắn mức `blocker`/`should`/`nit` và nêu cách sửa; review tập trung đúng/an toàn/đơn giản trước, phong cách để máy (formatter). → Kiểm: hướng dẫn review trong `CONTRIBUTING.md`; mẫu comment.
- [ ] `WF-REVIEW-013` **SHOULD** Luật review máy đọc theo đường dẫn (vd migration phải idempotent, API phải gọi `validateAuth`, đổi prompt phải kèm golden snapshot) nằm trong repo và chạy như reviewer tự động góp ý. → Kiểm: `.opencodereview/rule.json` hoặc Semgrep rule theo glob; CI chỉ góp ý, không chặn. · Nguồn: catalog 23 §4.1, §4.3 (open-code-review, first-match-wins)
- [ ] `WF-REVIEW-014` **SHOULD** Đo và xem lại hàng tháng: thời gian chờ review p50/p95, số PR mở > 24h, tỉ lệ PR qua cổng lần đầu (`first_pass_gate_rate`), số lỗi lọt sau merge; hành động khi p95 > 48h. → Kiểm: báo cáo tháng trong `docs/ops/` hoặc dashboard. · Nguồn: DORA metrics (change lead time)
- [ ] `WF-REVIEW-015` **SHOULD** Reviewer chạy thật: checkout nhánh/preview env và bấm luồng chính cho thay đổi UI/luồng người dùng; ghi lại đã chạy gì. → Kiểm: comment review có "đã chạy: …"; preview URL trong PR ([`environments-and-config.md`](environments-and-config.md)).
- [ ] `WF-REVIEW-016` **SHOULD** Bài học lặp ≥ 2 lần từ review → hàng rào mới (lint rule, test, hook, mục checklist), không chỉ nhắc miệng (P12). → Kiểm: `TRAPS.md`/CHANGELOG ghi hàng rào mới kèm link PR gốc.
- [ ] `WF-REVIEW-017` **MAY** Hai reviewer AI độc lập cùng rubric, cả hai phải pass trước khi người xem (giảm nhiễu); vẫn là claim. → Kiểm: cấu hình pipeline; nhãn kết quả. · Nguồn: catalog 23 §4.3 (`ecc-santa-method`)
- [ ] `WF-REVIEW-018` **MAY** Spot-check: review ngẫu nhiên ≥ 10% PR fast-lane đã merge để hiệu chuẩn vị từ. → Kiểm: nhật ký spot-check hàng tuần. · Nguồn: khung cũ spec L2 (review mẫu ≥ 10%)
- [ ] `WF-REVIEW-019` **SHOULD** PR template có mục bắt buộc **"Hỗ trợ AI"**: phần nào do AI sinh, phần nào người đã tự kiểm và kiểm thế nào, phần nào chỉ AI kiểm; không cần (và theo [`XC-DOCAI-005`](../18-cross-cutting/docs-for-ai-agents.md) không ghi) tên model/phiên. → Kiểm: `pull_request_template.md` có mục; `pr-policy` job kiểm mục không rỗng. · Nguồn: `seeker19110/stored` 13 §6d (PR template của Homebrew/BrewUI)
- [ ] `WF-REVIEW-020` **SHOULD** PR `fix:` có mục **"Rà cùng khuôn"** trong body: lệnh `rg`/Semgrep đã chạy để tìm cùng mẫu lỗi ở nơi khác, số chỗ trùng tìm thấy, cách xử lý từng chỗ (sửa trong PR / issue / không áp dụng kèm lý do); lỗi lặp còn ghi hàng rào mới theo `WF-REVIEW-016`. → Kiểm: `pr-policy` cảnh báo (không chặn) khi PR `fix:` thiếu mục hoặc mục rỗng. · Nguồn: `seeker19110/stored` 23 §4.5 (Sales-Hunter: template `TRAPS.md` cứng có mục "rà cả họ"; đọc 2026-10-16)

## Bẫy thường gặp

- **"LGTM" trong 30 giây cho PR 800 dòng.** Không phải review, là chữ ký. PR nhỏ + checklist + bằng chứng đã chạy.
- **AI viết code, cùng AI đó review, rồi auto-merge.** Tự chứng nhận vòng tròn (khung cũ spec §B10). Reviewer khác model + test viết từ spec + người giữ merge.
- **Review phong cách thay vì logic.** 40 nit về dấu chấm phẩy, bỏ qua race condition. Formatter lo phong cách; người lo đúng/an toàn.
- **Quá hạn thì tự pass.** "Không ai phản đối trong 24h = đồng ý" biến SLA thành lỗ hổng. Leo thang người.
- **Tác giả resolve blocker của reviewer.** Thread biến mất, lỗi vào trunk. Chỉ người nêu (hoặc code owner) resolve.
- **Làm cổng xanh bằng cách nới cấu hình trong cùng PR.** Hạ coverage threshold, `skip` test, `continue-on-error`. Hook hỏi + reviewer từ chối nếu không có lý do (`protect-config`, catalog 23 §4.3).
- **Review không chạy code.** Diff đọc "đúng" nhưng app crash khi mở. Preview env + bấm luồng chính.
- **Bài học chỉ nói trong comment.** Lỗi lặp lại tháng sau. Mỗi lỗi lặp → một hàng rào máy.
- **Mâu thuẫn nguồn:** SmartBear khuyến nghị ≤ 60 phút/lượt và ≤ 500 LOC/giờ; nhiều đội coi review 5 phút là đủ cho PR nhỏ — không mâu thuẫn: ngưỡng là *trần*, PR nhỏ review nhanh là mục tiêu.
- **Sửa đúng một chỗ.** Cùng khuôn lỗi còn ở N chỗ khác và tái diễn vài tuần sau. Mục "Rà cùng khuôn" (`WF-REVIEW-020`): lệnh `rg`/Semgrep + số chỗ trùng + cách xử lý.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| pr-policy | script kiểm body có mục Summary/Spec/Validation/Risk-rollback/DoD; `feat` link spec; cảnh báo khi chạm cấu hình cổng không lý do | CI | Đỏ khi thiếu mục |
| Thread resolution | ruleset `required_review_thread_resolution: true` | GitHub | Chặn merge |
| Reviewer AI | skill `/review` hoặc action review với model khác implementer; output gắn nhãn claim | CI (góp ý) | Không chặn, không approve |
| Luật theo đường dẫn | alibaba/open-code-review (Apache-2.0) `ocr delegate`; Semgrep rule theo glob | CI (góp ý) | — |
| SLA | cron: `gh pr list --json createdAt,reviews` → nhãn `review-overdue` > 24h, nhắc 12h | CI schedule | Thông báo + leo thang |
| Fast-lane predicate | script xuất `fast_lane: true/false` + lý do; auto-merge chỉ khi true | CI | Fail-closed |
| Metric | script tháng: p50/p95 thời gian chờ review, `first_pass_gate_rate` | CI schedule | Báo cáo |
| Rà cùng khuôn | `pr-policy`: PR `fix:` có mục "Rà cùng khuôn" không rỗng | CI | Cảnh báo (không chặn) |

## Nguồn

- Google Engineering Practices — Code Review Developer Guide / Small CLs: <https://google.github.io/eng-practices/review/developer/small-cls.html> — xác minh 2026-10-13
- SmartBear — Best Practices for Peer Code Review (Cisco study): <https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/> — xác minh 2026-10-13
- GitHub — About protected branches / rulesets (`required_review_thread_resolution`, code owner review, dismiss stale): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches> · <https://docs.github.com/en/rest/repos/rules> — xác minh 2026-10-13
- GitHub — Managing auto-merge: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository> — xác minh 2026-10-13
- DORA — Metrics (change lead time, change fail rate, rework rate): <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13
- Khung cũ X-stored commit `1b80fe4`: `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` §B3.1a (vị từ làn nhanh 5 điều kiện, fail-closed), §B10 (auto-merge tự chứng nhận vòng tròn), ASC-FR-14 (gate 24h leo thang).
- `research/2026-10-13-stored-catalog-extraction.md` §2.11 (reviewer khác model; human gate 24h leo thang; `/hoc` thang mức bền), §4; catalog `23-own-repos-lessons` §2.3, §2.5, §2.6, §4.1, §4.3; `13-dev-stack-devops` §6 (AI code review, open-code-review).
- Catalog `seeker19110/stored` 13 §6d (Homebrew/BrewUI: PR template có mục bắt buộc "AI assistance", tách phần người kiểm và phần AI kiểm) — đọc 2026-10-15.
- Catalog `seeker19110/stored` 23 §4.5 (Sales-Hunter: `TRAPS.md` có template triệu chứng / nguyên nhân / bằng chứng đỏ-xanh / rà cả họ / lần sau) — đọc 2026-10-16.
