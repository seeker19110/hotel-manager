# docs/autopilot/PLAN-harden-2026-11-06.md — Hotel Manager · Đợt 28 (pha harden, khung 3.30.1)

> Phiên chính tự duyệt 2026-11-06 (D-162). Nguồn việc: `xt.py loop next-step --objective harden-to-signoff` (nợ review #149 + phát hiện sổ audit), audit delta 2026-11-06 (4 nhóm, `reviewer-alt`), MUST mở làm được bằng mã. Mốc `main` `2f10e05`.

## Tóm tắt cổng duyệt
- Trả nợ 🟢 #149 bằng test đỏ-trước-xanh-sau: rào SEC-AI-002 (host LLM mới + base URL, quét lockfile, câu chữ OCR), ci-gates allowlist `if` cấp job, check-external-links đọc stream có trần byte, anchor cột `#L10C5`, fixture gộp anchor nhiều file.
- AUD-DOC-005: đính chính D-158 bằng quyết định mới (DECISIONS chỉ thêm).
- AUD-CI-004 (steward chỉ dispatch ci.yml): cách gỡ là `XT_STEWARD_TOKEN` (khoá chỉ chủ dự án có) → defer; phản hồi khung.
- AUD-HAR-001, AUD-HAR-004: quyết định của chủ dự án (miễn trừ/lịch sử) → defer.
- Phát hiện 🔴/🟠 của audit delta 2026-11-06 → task ngay sau khi xác minh đối kháng.
- MUST mở làm được bằng mã (BASE-SEC-010, OPS-OBS-008) sau nợ và phát hiện.
- Mỗi lát một PR ≤ 150 dòng; không nới cổng, không skip test; ngoại lệ cứng/`.github` → reviewer-alt rà trước PR, người merge theo merge-check.

## Ngân sách
- Một phiên; trần 12 giờ; timeout Gate 1800 giây; không đặt ngân sách token.

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Task
- [x] `T-2611` Rào SEC-AI-002 bắt host LLM mới (router.huggingface.co, aiplatform.googleapis.com, cognitiveservices/services.ai.azure.com, openrouter.ai, deepseek, x.ai, models.github.ai, perplexity, fireworks) và đường dẫn `/chat/completions`·`:generateContent`; Given mã có `fetch("https://openrouter.ai/api/v1/chat/completions")` When chạy rào Then đỏ; ca biên: repo hiện tại 0 khớp (files: scripts/no-ai-agent.test.mjs) — Gate: `pnpm vitest run --project unit scripts/no-ai-agent.test.mjs`
- [x] `T-2612` Rào SEC-AI-002 áp danh sách SDK lên mọi tên gói trong pnpm-lock.yaml (phụ thuộc gián tiếp); Given lockfile có `@google/genai` qua `@google/adk` When chạy rào Then đỏ; ca biên: 731 tên hiện tại 0 khớp (sau: T-2611; files: scripts/no-ai-agent.test.mjs) — Gate: `pnpm vitest run --project unit scripts/no-ai-agent.test.mjs`
- [x] `T-2613` Thu hẹp câu chữ SEC-AI-002 và chú thích rào về "OCR qua LLM/SDK trong danh sách", khớp mã (sau: T-2612; files: BLUEPRINT.md, scripts/no-ai-agent.test.mjs) — Gate: `pnpm vitest run --project unit scripts/no-ai-agent.test.mjs && python3 scripts/check-blueprint-evidence.py BLUEPRINT.md`
- [x] `T-2604` ci-gates: `if` cấp job của ci.yml chỉ được vắng hoặc đúng `${{ always() }}` (allowlist); Given job có `if: github.head_ref != ''` When chạy test Then đỏ (files: scripts/ci-gates.test.mjs) — Gate: `pnpm vitest run --project unit scripts/ci-gates.test.mjs`
- [x] `T-2606` check-external-links đọc body qua stream đếm byte, vượt trần thì cancel và trả null; Given trang 6 MB không content-length When kiểm anchor Then null, không đọc quá trần; ca biên: ký tự nhiều byte (files: scripts/check-external-links.mjs, scripts/check-external-links.test.mjs) — Gate: `pnpm vitest run --project unit scripts/check-external-links.test.mjs`
- [x] `T-2607` Bỏ qua anchor dòng/cột GitHub `#L10C5`, `#L10C5-L12C3`; Given link có anchor đó When extractUrls Then không có fragment (sau: T-2606; files: scripts/check-external-links.mjs, scripts/check-external-links.test.mjs) — Gate: `pnpm vitest run --project unit scripts/check-external-links.test.mjs`
- [x] `T-2614` Fixture hai file md cùng URL khác anchor: collectUrls gộp đủ anchor (sau: T-2607; files: scripts/check-external-links.test.mjs) — Gate: `pnpm vitest run --project unit scripts/check-external-links.test.mjs`
- [ ] `T-2608` Đính chính D-158 bằng quyết định mới: trigger tự động chạy nhánh mặc định, chạy tay workflow_dispatch cần quyền ghi; đánh dấu AUD-DOC-005 đã sửa (files: docs/autopilot/DECISIONS.md, docs/ops/AUDIT-STATUS.md) — Gate: `python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md && grep -q "AUD-DOC-005" docs/autopilot/DECISIONS.md`
- [ ] `T-2605` AUD-CI-004: workflow `push: main` ngoài ci.yml không chạy sau merge của steward — cần `XT_STEWARD_TOKEN` (chủ dự án) hoặc khung dispatch thêm; phản hồi khung (files: docs/xtemplates-feedback/) — Gate: `python3 .xtemplates/scripts/xt.py feedback list | grep -q "AUD-CI-004"`
- [ ] `T-2609` AUD-HAR-001: chủ dự án quyết miễn trừ XC-OSS-007 (repo public có Release) — mở lại MUST hay sửa lý do — Gate: `python3 .xtemplates/scripts/xt.py audit check --strict docs/ops/AUDIT-STATUS.md`
- [ ] `T-2610` AUD-HAR-004: chủ dự án quyết phạm vi lịch sử hợp lệ cho WF-GIT-001 (36 commit ngoài squash PR) — Gate: `node scripts/check-github-live.mjs squash-history`

## Điểm dừng bắt buộc về hành động
- T-2605, T-2609, T-2610 cần chủ dự án (khoá/token, quyết định miễn trừ và lịch sử) → `loop defer`.
- Không merge PR ngoại lệ cứng; không đọc secret; không deploy.
