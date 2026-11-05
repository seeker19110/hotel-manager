---
title: Trích xuất phần mới của catalog seeker19110/stored (a1a1f51..9f87dd1)
kind: research
updated: 2026-10-28
---

# Trích xuất phần mới của catalog seeker19110/stored (đợt 2026-10-28)

Bổ sung cho [`2026-10-18-stored-delta-extraction.md`](2026-10-18-stored-delta-extraction.md) và
[`2026-10-19-stored-ui-7i.md`](2026-10-19-stored-ui-7i.md) (không sửa hai file đó). Ký hiệu `NN §x` là chuyên mục NN, mục x của catalog.

## 1. Phạm vi

- Khoảng commit nội dung của `seeker19110/stored`: `a1a1f51..9f87dd1` (17 commit, 18/10 → 28/10/2026). Phần UI 06 §7g–§7i đã có ở đợt
  2026-10-19, nên đợt này đọc phần còn lại: 06 §7j–§7l, 13 §6f, 19 §1e–§1f, 12 §3m–§3n, 05 (AI Agents A-Z), 08 §2h–§2i, 11 §1d, 20 §3i–§3j.
- Mỗi mục catalog đã được viết từ clone và đọc mã của repo gốc (ghi trong phần *Nguồn* của mục catalog); đợt này mở lại các mục đó trực tiếp.
- Nguồn ngoài xác minh lại ngày 2026-10-28: Claude Code docs *Create custom subagents* (`tools` bỏ trống thì thừa hưởng mọi tool; thứ tự ưu tiên
  `.claude/agents/` > `~/.claude/agents/`), văn bản MIT trên opensource.org. Tài liệu Google Search Central (*Using generative AI content*,
  *Spam policies*) xác minh 2026-10-25 trong catalog 08 §2h.

## 2. Bài học → ID (ba cột: đã có và sâu hơn · đã có nhưng nông hơn · chưa có)

| Bài học (stored) | ID | Cột | Trạng thái |
|---|---|---|---|
| Fork MIT thay dòng copyright của tác giả gốc, chỉ ghi credit trong README (19 §1f) | [`CMP-LIC-023`](../framework/16-compliance-privacy/licensing-and-ip.md) | chưa có | **Đã thêm** (SHOULD) |
| Font hệ điều hành (Segoe UI, "Microsoft supplied font") commit vào repo (19 §1f) | bẫy trong `licensing-and-ip.md` | nông hơn | **Bổ sung bẫy**; nhà vẫn là dòng "Font/icon/ảnh" ở bảng *Quyết định* |
| Agent trình duyệt chỉ coi `submitForm`/Enter là "gửi"; `click` lên nút JS "Mua"/"Gửi" không qua duyệt (11 §1d) | [`AI-AGENT-025`](../framework/13-ai-engineering/agents-and-tools.md) | nông hơn | **Đã thêm** (SHOULD); nền là `AI-AGENTIC-008` (HITL cho T3–T4) — mục mới nói cách *xếp* mức T |
| Sản phẩm gọi CLI agent của người dùng: allowlist tool qua cờ CLI, chặn cờ bỏ quyền, env tối thiểu, runner không khoá được (11 §1d) | [`PRF-AGENT-023`](../framework/02-profiles/ai-agent.md) | chưa có | **Đã thêm** (SHOULD); liền kề `PRF-AGENT-022` (thư mục cấu hình riêng) |
| Bộ 283 persona subagent, 266 không khai `tools:`, installer chép vào `~/.claude/agents/` (20 §3j) | [`XC-DOCAI-022`](../framework/18-cross-cutting/docs-for-ai-agents.md) | nông hơn | **Đã thêm** (SHOULD); `LOOP-ORCH-003` chỉ áp cho harness của vòng lặp, không cho agent bên thứ ba cài vào dự án |
| Skill/automation do model sinh tổng quát hoá ra "mọi mục", không đòi xác nhận (20 §3i) | `XC-DOCAI-023` | chưa có | **Đã thêm** (SHOULD) |
| Bước phụ (dựng skill) gửi dữ liệu cho model mà không qua bộ che, dù bước chính có che (20 §3i) | [`CMP-PRIV-023`](../framework/16-compliance-privacy/privacy-by-design.md) | nông hơn | **Đã thêm** (SHOULD); bảng *Quyết định* đã có "che PII trước khi gửi" nhưng không nói mọi đường gửi |
| Nội dung AI sinh hàng loạt cho SEO/kênh video, không người kiểm sự thật (08 §2h, 05, 19 §1f) | [`IND-MEDIA-023`](../framework/03-industries/media-content.md) | nông hơn | **Đã thêm** (SHOULD); `IND-MEDIA-005` chỉ nói nhãn nội dung AI |
| Audit bảo mật bằng agent: người xác minh khác người tìm, schema phát hiện (12 §3m) | `.claude/skills/audit/SKILL.md` §3–§4 | sâu hơn | **Đã có**: `/audit` giao 🔴/🟠 cho `reviewer` khác agent đã tìm, model khác nếu được |
| Nội dung repo/trang được audit hoặc agent đọc là dữ liệu, kể cả ghi chú do máy sinh (12 §3m, 11 §1d) | `SEC-AI-001`, `SEC-AI-013` | sâu hơn | **Đã có** |
| Terminal từ xa chỉ lọc IP tailnet, bind `0.0.0.0`, không auth ứng dụng (13 §6f) | `SEC-INFRA-011` + nguyên tắc zero trust | sâu hơn | **Đã có** |
| Repo đổi chỗ (chuyển hướng), sao cao nhưng lượt tải thấp, repo đứng yên (08 §2i, 12 §3n) | `SEC-SUPPLY-025`/`026` + bảng *Quyết định* của `supply-chain.md` | sâu hơn | **Đã có** ("archive/đổi tên/không license → không thêm"; sao không phải bằng chứng) |
| Trọng số FLUX [dev] non-commercial; license Remotion theo số nhân viên (19 §1e–§1f, 05) | `CMP-LIC-020` + bẫy "Model open nhưng cấm thương mại" | sâu hơn | **Đã có** |
| Font/ảnh tải từ CDN bên thứ ba lúc người xem mở trang (06 §7l) | `FE-SEC-008`, bảng font của `performance-web-vitals.md` (self-host) | sâu hơn | **Đã có** |
| Agent chép tay số đo vào mã nên lệch khi đo lại (19 §1f) | — | — | **Không thêm**: ca riêng của một repo; luật chung "số công bố trỏ file kết quả" là `BASE-DOC-017` |
| Chia theme bằng thuật toán tất định để agent không lặp phong cách (06 §7l) | — | — | **Không thêm**: kỹ thuật thiết kế tuỳ chọn, chưa có bằng chứng hiệu quả ngoài eval tự chấm của repo |

## 3. Chưa xác minh / lưu ý

- `XC-DOCAI-022` không ghi con số token cho việc cài nhiều subagent: catalog 20 §3j chỉ ước lượng (~15k token) từ độ dài `description`, chưa đo trong phiên.
- Tên cờ bỏ quyền ở `PRF-AGENT-023` lấy từ danh sách chặn trong mã repo catalog 11 §1d; chưa đối chiếu tài liệu chính thức của từng CLI ngoài Claude Code.
- Mục mới đều là SHOULD: bốn module đích (`licensing-and-ip`, `agents-and-tools`, `docs-for-ai-agents`, `privacy-by-design`) đã đủ trần 4 mục MUST ở quy mô M (ADR-0004); hồ sơ `ai-agent.md` và gói ngành `media-content.md` không bị trần nhưng giữ SHOULD vì bài học đến từ một vài repo, chưa đủ để buộc mọi dự án.
- `PROGRESS.md` không ghi đợt này (file còn ~70 byte tới trần 8 KB); dấu vết nằm ở file này và `CHANGELOG.md`.
