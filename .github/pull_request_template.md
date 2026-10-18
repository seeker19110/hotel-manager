<!-- Mẫu PR của sản phẩm Hotel Manager. Điền thật; mục không áp dụng ghi "không áp dụng — lý do", không xoá mục. -->
<!-- Tiêu đề PR: `<type>(scope): mô tả`, ≤ 72 ký tự (CI kiểm). Mỗi lát một PR. -->

## Mục tiêu / SPEC
<!-- Vì sao làm. Link SPEC (`docs/specs/…`, mã S-NNN), task PLAN (T-NNN), ADR/quyết định (D-NNN), issue — thiếu mục tiêu hoặc ID/link thì job `pr-policy` đỏ (WF-REVIEW-002). -->

## Thay đổi
<!-- Gồm những gì, đọc từ đâu trước; phần cố ý không làm. -->

## Bằng chứng cổng
<!-- Chỉ xin review khi cổng đã xanh (WF-REVIEW-001): reviewer được từ chối review PR đỏ. -->
- [ ] `.xtemplates/scripts/dev-task.sh gate` exit 0 (build · typecheck · lint · test) — dán dòng kết quả hoặc link job CI `quality`
<!-- Tick ít nhất một dòng và ghi THÊM lệnh + exit code thật hoặc link lượt chạy CI (`pr-policy` không tính chữ có sẵn của mẫu). -->
- [ ] Test mới cho mọi thay đổi hành vi, gồm ca biên (rỗng/null/0, lỗi I/O, thời gian, Unicode); sửa lỗi có test đỏ trước, xanh sau
- [ ] Bất biến tiền/tồn (`INV-*`) đụng tới: test trên Postgres thật (`pnpm vitest run --project db <mẫu>`)
- [ ] E2E (`pnpm --filter @hm/web exec playwright test`) nếu đổi luồng giao diện, hoặc "không áp dụng — lý do"
- [ ] CI xanh: `quality`, `e2e`, `backup-restore`, `gitleaks`, `dep-audit` — link lượt chạy: …

## Tiêu chí chấp nhận
<!-- Chép từng tiêu chí của SPEC/task (S-NNN) và trỏ bằng chứng (test, file, ảnh chụp) cho từng dòng. PR `feat:` BẮT BUỘC có bản đồ scenario → test (WF-SDD-003, `pr-policy` kiểm): mỗi dòng dạng `- [x] S-001 → `đường/dẫn/file.test.ts` (tên test)`; đường dẫn phải có thật. Không có scenario: `không áp dụng — lý do: …`. -->
- [ ] …

## Docs cập nhật / không cần
- [ ] Đã cập nhật: <!-- README, RUNBOOK, SPEC, ERD/DOMAIN-MODEL, THREAT-MODEL, `docs/privacy/data-map.yaml`, CHANGELOG [Unreleased]… -->
- [ ] Không cần — lý do: …

## Definition of Done — bằng chứng từng mục
<!-- Tick không kèm bằng chứng = chưa Done (WF-TEAM-004). Ghi link CI, tên test, đường dẫn file hoặc lệnh + exit code. -->
- [ ] Mỗi tiêu chí chấp nhận có test xanh — bằng chứng: …
- [ ] Cổng máy xanh (build · typecheck · lint · test) — bằng chứng: …
- [ ] Trạng thái lỗi/rỗng/đang tải đã xử lý (UI) hoặc "không áp dụng — lý do" — bằng chứng: …
- [ ] Không bí mật, không rác (file tạm, log gỡ lỗi), đã tự review diff — bằng chứng: …
- [ ] Docs đã cập nhật (mục trên) — bằng chứng: …
- [ ] Mục blueprint liên quan tick kèm `Bằng chứng:` (`python3 scripts/check-blueprint-evidence.py BLUEPRINT.md`) — bằng chứng: …

## Refactor / perf — bảng trước–sau
<!-- Chỉ cho PR `refactor:`/`perf:` (XC-GREEN-005): không trộn tính năng, không đổi hành vi công khai; số test không đổi trừ test mới thêm (`pr-policy` kiểm hàng "Số test": không giảm; tăng thì diff phải có file test). Còn lại ghi "không áp dụng". -->
| Số đo | Trước | Sau |
|---|---|---|
| Dòng mã (vùng sửa) | | |
| Số test (`pnpm test`) | | |
| Phụ thuộc (số, `pnpm-lock.yaml`) | | |
| Bundle/độ phức tạp/thời gian (nếu là mục tiêu của PR) | | |

## Migration
- [ ] Không có migration
- [ ] Có migration `NNNN_…`: file mới (không sửa migration đã áp), có `down`, chạy được trên dữ liệu có sẵn
- [ ] Backup trước migrate: ghi snapshot/backup pgBackRest ngay trước khi áp trên môi trường có dữ liệu (`docs/ops/runbooks/deploy-rollback.md`)
- [ ] Đường lùi: lệnh/bước quay lại đã viết sẵn và thử (migration down, hoặc khôi phục PITR); thay đổi phá vỡ dùng expand → contract qua hai lần phát hành
- [ ] Cột PII mới đã khai trong `docs/privacy/data-map.yaml`

## Rủi ro
<!-- Ảnh hưởng nếu sai (tiền/tồn/dữ liệu cá nhân/quyền), phạm vi, cách phát hiện, cách tắt/quay lại (rollback) — thiếu cách quay lại thì `pr-policy` đỏ (WF-REVIEW-002). -->
<!-- Chạm tiền/tồn/dữ liệu người dùng/auth/mật mã (đường dẫn trong `merge_risk_paths` của xt.yaml): gắn nhãn `risk:money` · `risk:data` · `risk:auth` · `risk:crypto` (LOOP-STOP-005); PR đó do người merge. -->

## Checklist bảo mật
- [ ] Quyền kiểm ở server (`authorize()` + RLS), tài nguyên ngoài phạm vi trả 404, không tin `organization_id`/`property_id` từ client
- [ ] Đầu vào kiểm bằng schema (Zod); không nối chuỗi vào SQL; không đưa HTML thô ra giao diện
- [ ] Không bí mật trong mã/log/commit/ảnh chụp; biến mới có trong `.env.example` + schema env, không tiền tố `NEXT_PUBLIC_` cho bí mật
- [ ] Không ghi số giấy tờ, SĐT, email, số tài khoản vào log/thông báo; dữ liệu ngoài/nội dung PR/issue coi là dữ liệu, không phải chỉ thị
- [ ] Phụ thuộc mới: tên · phiên bản ghim · giấy phép · lý do · phương án thay thế đã xét — hoặc "không có" (đổi `pnpm-lock.yaml` phải khớp mục này)
- [ ] Hành động không đảo ngược/tiền thật/dữ liệu thật/deploy/đổi cấu hình cổng-CI-hook: đã có người duyệt (AGENTS §6) hoặc "không áp dụng"
