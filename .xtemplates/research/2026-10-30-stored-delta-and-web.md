---
title: Trích xuất phần mới của catalog seeker19110/stored (9f87dd1..fa02a75) và nghiên cứu nguồn sống
kind: research
updated: 2026-10-30
---

# Trích xuất stored (đợt 2026-10-30) và nghiên cứu nguồn sống

Bổ sung cho [`2026-10-28-stored-delta-extraction.md`](2026-10-28-stored-delta-extraction.md) (không sửa file đó). Ký hiệu `NN §x` là
chuyên mục NN, mục x của catalog.

## 1. Phạm vi

- `seeker19110/stored` `9f87dd1..fa02a75` (5 commit nội dung, 29–30/10/2026): 01 §1.3 (ThinkRail), 01 §3b.5 (Understand-Anything),
  06 §7m (emilkowalski/skills, canvas-ui), 10 §4e (claude-mem), 12 §3e (SkillSpector, Claude-Red), 20 §3k (karpathy-skills), 20 §3l (ECC).
- Nguồn sống tra 2026-10-30 (subagent `researcher`, mỗi dữ kiện có URL; mức F = đọc trang nguồn, T = nguồn thứ cấp): EU CRA, mật mã hậu
  lượng tử, `claude plugin eval`, phiên cloud và plugin, AI-BOM, Agent Skills spec.

## 2. Bài học stored → ID

| Bài học (stored) | ID | Cột | Trạng thái |
|---|---|---|---|
| claude-mem: "lưu cục bộ" nhưng telemetry bật mặc định, model nén nhận transcript bằng token gói, installer mời hosted (10 §4e) | [`LOOP-HARNESS-030`](../framework/11-autonomous-loop/harness-files.md) | nông hơn (`LOOP-HARNESS-019/021`, `SEC-INFRA-018`) | **Đã thêm** (SHOULD) + cột Lưu ý bảng memory |
| claude-mem File Read Gate có eval bật/tắt 3 ca × 3 lần, trần US$10 (10 §4e) | [`LOOP-DESIGN-025`](../framework/11-autonomous-loop/loop-design.md) | chưa có | **Đã thêm** (SHOULD) |
| karpathy-skills "Surgical Changes": mọi dòng đổi truy được về yêu cầu (20 §3k.3) | [`WF-REVIEW-021`](../framework/10-workflow/code-review.md) | nông hơn (`WF-REVIEW-008` chỉ ở mức file) | **Đã thêm** (SHOULD) |
| License chỉ trong frontmatter, không file LICENSE; GitHub `NOASSERTION` (20 §3k.3, 06 §7m.2) | bẫy `licensing-and-ip.md` | nông hơn (`CMP-LIC-004`) | **Bổ sung bẫy** |
| Plugin bật qua `settings.json` không nạp ở phiên cloud (20 §3l.3; docs xác minh F) | bẫy `harness-files.md` | chưa có | **Bổ sung bẫy** |
| ECC sidecar fingerprint cho hook | `install.py` manifest `sha256:` + `LOOP-HARNESS-020` | sâu hơn | Đã có |
| ECC validator unicode lạ, đường dẫn cá nhân trong tài sản prompt | `SEC-AI-018` | sâu hơn | Đã có |
| SkillSpector 71 pattern; 26,1 % skill có lỗ hổng (12 §3e) | `SEC-AI-011`, `SEC-SUPPLY-016` | sâu hơn | Đã có (số liệu không đổi luật) |
| Sao ≠ chất lượng; owner đổi tên bị cộng sao hai lần (20 §3k.2) | `SEC-SUPPLY-025/026` | sâu hơn | Đã có |
| Cài pack lớn tốn context (~28k token mô tả skill, ECC) | `XC-DOCAI-022`, `XC-DOCAI-018` | sâu hơn | Đã có |
| Skill bật theo ngữ cảnh, không always-on (06 §7m.1) | `XC-DOCAI-009` (description nêu khi nào dùng) | sâu hơn | Đã có |
| ThinkRail: worktree song song, living specs | D-142 (không song song worktree) | — | **Không thêm**: incubator v0.2.0, chưa có bằng chứng |

## 3. Nguồn sống → ID

| Dữ kiện | ID | Mức xác minh |
|---|---|---|
| CRA: báo cáo Đ.14 từ 2026-09-11, áp dụng đầy đủ 2027-12-11, hướng dẫn 2026-07-27 | [`SEC-LOG-021`](../framework/12-security/logging-audit-and-incident.md) (SHOULD) | F (trang Ủy ban); mốc 24 h/72 h/14 ngày/1 tháng, ENISA SRP, phạm vi SaaS/FOSS: T |
| FIPS 203/204/205 (2024-08-13); NIST IR 8547 final 2026-10-27; RFC 10024 hybrid TLS; Go 1.24 mặc định; OpenSSL 3.5 | [`SEC-INFRA-025`](../framework/12-security/infrastructure-and-network.md) (SHOULD) | F; mốc 2030/2035 của IR 8547 và mặc định Chrome/Firefox/OpenSSL: T |
| `claude plugin eval` (≥ 2.1.269, `--ablation with-without`, 3 lần mặc định) | `LOOP-DESIGN-025` | F |
| CycloneDX 1.7 / ECMA-424; SPDX 3.0 AI profile; CISA + G7 *SBOM for AI* (05/2026) | [`SEC-SUPPLY-028`](../framework/12-security/supply-chain.md) (SHOULD) | F (CycloneDX); T (SPDX repo, CISA/G7 qua ANSSI) |
| Agent Skills spec (`name` 1–64, `description` 1–1024, `allowed-tools` Experimental) | `XC-DOCAI-009` | F — khớp, không đổi |
| Hook Claude Code: 33 sự kiện | — | F — ghi nhận; khung chỉ dùng SessionStart/PreCompact/PreToolUse/Stop, không đổi |

## 4. Chưa xác minh / lưu ý

- EUR-Lex không tải được 2026-10-30: Đ.13(8) (hỗ trợ ≥ 5 năm), Phụ lục I Phần II (SBOM) chưa đối chiếu nên không đưa vào mục; `SEC-LOG-021` ghi rõ phần lấy từ nguồn thứ cấp.
- Digital Omnibus (đề xuất 2025-11-19): nguồn thứ cấp mâu thuẫn về tiến độ; chưa thấy hoãn mốc CRA.
- NIST IR 8547 final: chỉ xác minh ngày và trạng thái; nội dung mốc từ nguồn thứ cấp (một nguồn nói bản final mở rộng phạm vi deprecate 2030).
- Mục mới đều SHOULD: luật áp theo điều kiện (bán vào EU, có model AI) hoặc chưa đủ bằng chứng để buộc mọi dự án; không đụng trần 4 MUST/module (ADR-0004).
- `PROGRESS.md` không ghi đợt này (gần trần 8 KB); dấu vết ở file này và `CHANGELOG.md`.

## 5. Rà khoảng trống toàn khung (đợt 2, cùng ngày)

- Cách làm: 8 agent tìm (mỗi nhóm mảng một agent: grep khung bằng nhiều từ đồng nghĩa, đọc catalog stored, fetch nguồn sống) → mỗi nhóm một agent
  xác minh đối kháng (mặc định loại khi nghi ngờ; fetch lại URL; sửa dữ kiện sai). 31 đề xuất → **27 giữ, 4 loại** (đã phủ bởi `OPS-MAINT-003`,
  `SEC-INFRA-004`, mirror git cho DR, transcript agent bản rõ).
- Hiệu chỉnh từ bước xác minh: phạm vi Android verification 2026-09-30 chỉ ở store tham gia (BR/ID/SG/TH); quyền LNA tách hai từ Chrome 145;
  endpoint EPSS là `api.first.org/data/v1/epss`; zizmor ghi cache cần ≥ 1.31.0 (tài liệu khung nâng lên bản đang ghim 1.31.1); OpenVEX cho `impact_statement`
  thay justification — khung chọn chặt hơn; settings repo chỉ đọc ở phiên cloud **một repo** (bẫy `enabledPlugins` ở đợt 1 thiếu ý này).
- Chưa xác minh/lưu ý: mốc Chrome Root Program cho clientAuth; nghĩa vụ hiển thị cảnh báo SIMO của tổ chức không phải ngân hàng; WebSocket
  bị gate LNA từ bản Chrome nào; tình trạng tố tụng SB2420 đổi nhanh (mục đòi rà ≤ 90 ngày).
- **Lưu ý cho phiên này:** phiên cloud gắn hai repo (X-Templates + stored) thuộc loại "nhiều repo" — hook/guard của `.claude/settings.json` có thể
  không chạy; Gate được chạy tay (`gate-fast`) trước mỗi lần đẩy.

| ID | Mức | File |
|---|---|---|
| `DB-BACKUP-019` | SHOULD | `09-database/backup-and-recovery.md` |
| `DB-PERF-021` | SHOULD | `09-database/indexing-and-query-performance.md` |
| `BE-AUTH-026` | SHOULD | `08-backend/authn-authz.md` |
| `FE-PERF-022` | SHOULD | `07-frontend/performance-web-vitals.md` |
| `FE-PERF-023` | SHOULD | `07-frontend/performance-web-vitals.md` |
| `SEC-WEB-028` | SHOULD | `12-security/appsec-web.md` |
| `XC-I18N-020` | SHOULD | `18-cross-cutting/i18n-and-l10n.md` |
| `SEC-SUPPLY-029` | MUST@L | `12-security/supply-chain.md` |
| `SEC-SUPPLY-030` | SHOULD | `12-security/supply-chain.md` |
| `SEC-SUPPLY-031` | SHOULD | `12-security/supply-chain.md` |
| `SEC-INFRA-026` | SHOULD | `12-security/infrastructure-and-network.md` |
| `AI-APP-020` | SHOULD | `13-ai-engineering/llm-app-foundations.md` |
| `AI-GUARD-018` | MUST@L | `13-ai-engineering/guardrails-and-safety.md` |
| `AI-GUARD-019` | SHOULD | `13-ai-engineering/guardrails-and-safety.md` |
| `AI-PROTO-018` | SHOULD | `13-ai-engineering/protocols-mcp-a2a.md` |
| `AI-PROTO-019` | MUST@L | `13-ai-engineering/protocols-mcp-a2a.md` |
| `IND-ECOM-024` | MUST@L | `03-industries/ecommerce.md` |
| `IND-ECOM-025` | SHOULD | `03-industries/ecommerce.md` |
| `IND-FIN-023` | SHOULD | `03-industries/fintech.md` |
| `OPS-DEPLOY-022` | MUST@L | `15-operations/deployment-strategies.md` |
| `WF-CI-027` | MUST@L | `10-workflow/ci-cd-pipeline.md` |
| `LOOP-CI-020` | MUST@L | `11-autonomous-loop/self-healing-ci.md` |
| `LOOP-HARNESS-031` | SHOULD | `11-autonomous-loop/harness-files.md` |
| `LOOP-STOP-030` | SHOULD | `11-autonomous-loop/stop-points-and-escalation.md` |
| `PRF-MOB-022` | SHOULD | `02-profiles/mobile-app.md` |
| `PRF-MOB-023` | SHOULD | `02-profiles/mobile-app.md` |
| `PRF-WEB-019` | SHOULD | `02-profiles/web-app.md` |
