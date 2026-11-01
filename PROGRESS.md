# PROGRESS.md — Hotel Manager
## Đang làm
- 2026-11-01 đợt 25 (D-139…D-153), theo yêu cầu cập nhật main và hoàn thiện dự án. Đã fetch lại: main vẫn3e41782, PR140 tại81d1c3b chưa merge; nối nhánh từ PR140, không sửa checkout gốc. Chủ dự án xác nhận chưa có VPS/tên miền, hoàn tất mã và PR trước.
- Vá glob/minimatch/fast-uri, Node24.22.2/pnpm12.16.1; gỡ4ignore npm không gia hạn. Web chuyển Next standalone sau khi full image scan bắt compiler/devtools trong runtime; giữ LICENSE/notices/PWA, scan/runtime evidence ngày01-11. Dev/compiler builder vẫn có rủi ro đã ghi, không khai sạch toàn bộ.
- Migration0076: audit DSAR theo tài khoản, append-only/RLS/cùng transaction, URL issuance30lần/giờ.0077: chặn blind UPDATE persons khi actor không tồn tại, giữ INSERT bootstrap.0078: dọn lời mời không liên kết90ngày và auth lockout/bucket7ngày, giữ liên kết/chứng cứ và mọi cửa sổ còn hiệu lực. Không sửa migration đã áp.
- Tách config runtime/edge/build/client và CLI migration dùng URL/owner riêng, kiểm quyền trước DDL. Kiểm image bắt regression NEXT_RUNTIME do accessor raw env làm mất define của Next; đã sửa literal reads trong module config, có test compiled hook đỏ cũ/xanh mới và SIGTERM exit0.
- Công cụ vận hành: backup full/diff timer, runner có timeout/lock/metric; promote cùng digest, smoke/version/header, rollback và lịch sử nguyên tử. Chỉ kiểm cục bộ bằng dữ liệu giả; không triển khai thật.
- Blueprint hiện369 đạt /59 miễn /73 mở. Tick BASE-CFG-002 và DB-SEC-002 bằng code/test; FE-BUILD-005 vẫn mở do yêu cầu kiểm build thiếu env, trong khi build chủ đích không nhận secret runtime. Mẫu .env.example cần người sửa theo guard.

## Tiếp theo
1. Các lát mã ở PR141 dependency/CI, PR142 DSAR/retention và PR143 config/ops; xem docs/autopilot/PLAN.md, .autopilot/verified.json và CI trên đúng head. PR auth/dữ liệu do người merge theo AGENTS§7; merge FIFO từ PR140 rồi các nhánh phụ thuộc.
2. Khi có hạ tầng: theo docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md; còn73MUST về pháp lý, kho log/offsite/DR, GitHub review, thiết bị thật và chứng cứ triển khai. Không bật production purge (D-125).
3. Dùng docs/ops/runbooks/database-migrations.md và operations-tools.md khi thiết lập. Migration owner phải BYPASSRLS/ownership/CREATE và SET ROLE app_worker; không cấp BYPASSRLS cho runtime/worker. Down0074 từ chối khi còn claim; down0076 từ chối khi có audit, rollback ứng dụng và giữ schema.
4. Theo dõi zod3/Lighthouse hạn11-08, compiler native7.0.2 chưa có bản vá upstream và dev audit còn cảnh báo. LGPL sharp hạn12-31, parse-cache-control hạn2027-04-18. Không mặc định gia hạn. Release-please từng lỗi token từ#93: xác minh quyền khi tiếp tục phát hành, không đọc secret trong phiên này.

## Quyết định
- ADR-0001/0002: modular monolith TypeScript/Postgres17, tự host; quyền/tiền kiểm ở DB và app. Stack theo manifest/pins; không thêm dịch vụ trả phí. Lịch sử D-001…D-138 và quyết định sản phẩm xem docs/autopilot/DECISIONS.md, archive/PROGRESS-dot-24.md.
- D-139: hoàn tất phần mã còn làm được, không gán mọi MUST cho người. D-140/142: bỏ npm khỏi base và nâng pnpm vá bootstrap. D-141: retention vận hành bảo thủ, giữ lời mời liên kết. D-143: hạn mức URL DSAR. D-144: standalone bỏ compiler khỏi runtime, giữ scan/license và ghi rủi ro builder.
- D-145: SBOM image kiểm theo phạm vi CI gồm hệ điều hành, không dùng allowlist npm cho OS; không đổi ngưỡng license. D-146: format cả file staged/new trước commit, không nới cổng. D-147: đủ11workflow chạy trên mọi base PR, có negative guard; giữ event/permissions/jobs. D-148: flatten rootfs base để bỏ layer npm đã xoá, giữ285MB. D-149: promote phải chờ đúng worker boot đang chạy trước smoke/history. D-150: go-jose/v4 vá4.1.6; v3 Caddy chưa có patch, theo dõi riêng. D-151: vá thêm x/net0.62 và chi5.4 theo full scan.
- D-152: test hạn mức dùng cửa sổ an toàn và org riêng/limit cố định, giữ regression hàng lịch sử. D-153: test worker chờ PostgreSQL xác nhận đóng backend trong5s rồi vẫn assert0, giữ kiểm exit0/marker và ngưỡng coverage.
- Không force-push/rewrite main, không tự merge ngoại lệ cứng, không hạ ngưỡng/skip test. Bằng chứng phải khớp cây cuối; số đo ở evidence/CI, không dùng bản test cũ để kết luận.

## Bàn giao phiên
- Mốc main `3e41782`, công việc nối từ PR140; SHA chốt và CI nằm trên các PR đợt25.
- Làm tại /home/liend/repos/hotel-manager-autopilot. Checkout gốc /home/liend/repos/hotel-manager giữ nhánh audit và PROGRESS chưa commit của người dùng.
- Cổng tích hợp292tệp/4446test qua; lượt kiểm lại đầu9Gate+33lệnh blueprint và224E2E qua/1skip. Coverage bắt race quan sát backend, đã bổ sung điều phối test; kết quả cây cuối ở verified.json/CI. Cổng chuẩn scripts/commit-gated.sh và .xtemplates/scripts/dev-task.sh gate. PG_BIN=/home/liend/repos/hotel-manager-autopilot/work/pg-bin (server17, psql client cục bộ); browserlibs qua LD_LIBRARY_PATH=.../work/browser-libs/usr/lib/x86_64-linux-gnu. E2E_PORT3371; không chạy E2E cùng build/test khác.
- Task image cần Docker Linux, syft/grype trên PATH và DB scanner mới; phiên này có tools đã kiểm checksum tại work/security-tools. Đường tạm, log/raw scanner report không commit. Mã mẫu chỉ dữ liệu giả, không đọc secret thật.
- Doctor khung0lỗi, cảnh báo3.15.1cũ hơn bản mới; chưa nâng khung/hook trong đợt này. G7 vẫn NO-GO khi73MUST chưa có bằng chứng thật.
