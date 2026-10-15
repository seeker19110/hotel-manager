---
title: Bốn trạng thái UI, phản hồi, lỗi, loading, rỗng
kind: module
prefix: UX-STATE
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Bốn trạng thái UI, phản hồi, lỗi, loading, rỗng

> Mỗi màn hình/thành phần hiển thị dữ liệu phải thiết kế và kiểm **đủ bốn trạng thái**: đang tải, rỗng, lỗi, có dữ liệu —
> và mỗi hành động phải có phản hồi tức thì, kết quả rõ, lỗi có cách sửa, thao tác phá hủy có đường lùi. Cách lấy dữ liệu và
> rollback optimistic ở tầng code → [`../07-frontend/state-and-data-fetching.md`](../07-frontend/state-and-data-fetching.md).

## Nguyên tắc

1. **Bốn trạng thái là hợp đồng của component**, không phải tính năng thêm. Story/test phải có cả bốn.
2. **Phản hồi theo ba ngưỡng thời gian** (Nielsen): ≤ 0,1 s không cần chỉ báo; > 1 s phải báo "đang xử lý"; > 10 s cần
   tiến độ phần trăm và nút huỷ.
3. **Lỗi nói chuyện gì xảy ra + làm gì tiếp**, không phơi stack trace, mã lỗi nội bộ hay thông điệp của thư viện.
4. **Giữ dữ liệu người dùng đã nhập** khi thất bại; không bao giờ xoá form vì lỗi mạng.
5. **Ưu tiên hoàn tác (undo) hơn hỏi "chắc chưa?"** cho hành động đảo ngược được; xác nhận rõ ràng chỉ cho hành động không
   thể hoàn tác (xoá vĩnh viễn, thanh toán).
6. **Optimistic UI phải có đường rollback** và không áp dụng cho tiền/quyền/xoá vĩnh viễn.
7. **Thông báo có đúng kênh**: inline (lỗi field), status/toast (xác nhận không cần hành động), dialog (cần quyết định).

## Quyết định

| Tình huống | Chọn | Khi nào | Không dùng khi |
|---|---|---|---|
| Chỉ báo tải | **Skeleton** giữ đúng khung bố cục | Danh sách/thẻ có hình dạng ổn định, tải 0,3–3 s | Thao tác ngắn < 0,1 s (không cần); tác vụ dài > 10 s → thanh tiến độ + huỷ |
| Spinner | Nút đang gửi, thao tác không có khung nội dung | Hành động cục bộ | Toàn trang (gây CLS, cảm giác chậm) |
| Optimistic UI | Cập nhật ngay, rollback nếu lỗi | Like, toggle, sắp xếp, ghi chú — hành động hay thành công, dễ đảo | Thanh toán, đổi quyền, xoá vĩnh viễn, tạo tài nguyên có ID phía server |
| Hành động phá hủy | **Undo** trong vài giây (toast có nút Hoàn tác) + xoá mềm | Xoá mục, lưu trữ, gửi email có delay | Không đảo được → dialog xác nhận nêu rõ hậu quả, nút xác nhận nói đúng hành động ("Xoá dự án"), không phải "OK" |
| Kênh thông báo lỗi | Inline cạnh field + tóm tắt đầu form | Lỗi nhập liệu | Lỗi hệ thống → trang/khối lỗi có "Thử lại"; lỗi nền (sync) → status không chặn |
| Tải lại dữ liệu nền | Giữ dữ liệu cũ + chỉ báo nhỏ (stale-while-revalidate) | Refetch định kỳ, focus lại | Lần tải đầu (không có dữ liệu cũ) |

## Checklist

- [ ] `UX-STATE-001` **MUST** Mỗi component/màn hình hiển thị dữ liệu có đủ 4 trạng thái: loading, empty, error, success. → Kiểm: Storybook có 4 story (`Loading`, `Empty`, `Error`, `Default`) cho mỗi component dữ liệu; script đếm story thiếu = 0. · Nguồn: khung cũ `quality-supplements.md` Nhóm 2 mục 5
- [ ] `UX-STATE-002` **MUST@L** Thao tác > 1 s có chỉ báo đang xử lý; > 10 s có tiến độ (phần trăm hoặc bước) và nút huỷ. → Kiểm: E2E với network throttle (Playwright `route` delay 2 s) thấy chỉ báo; tác vụ dài có `role="progressbar"` + nút Huỷ. · Nguồn: Nielsen, Response Times: 3 Important Limits
- [ ] `UX-STATE-003` **MUST@L** Trạng thái tải không gây dịch chuyển bố cục: skeleton/khoảng giữ chỗ có kích thước gần đúng nội dung. → Kiểm: Lighthouse CLS ≤ 0.1 trên trang có dữ liệu động; ảnh skeleton và ảnh có dữ liệu cùng chiều cao khối ± 10%. · Nguồn: web.dev Core Web Vitals (CLS)
- [ ] `UX-STATE-004` **MUST@L** Trạng thái rỗng có thông điệp nói rõ "chưa có gì" và hành động tiếp theo (nút tạo/nhập/hướng dẫn), phân biệt "rỗng do lọc" với "rỗng thật". → Kiểm: E2E tài khoản mới thấy empty state có nút hành động; E2E lọc không kết quả thấy nút "Xoá bộ lọc".
- [ ] `UX-STATE-005` **MUST** Thông báo lỗi không chứa stack trace, SQL, tên bảng, mã lỗi thư viện; có nút "Thử lại" hoặc đường đi khác. → Kiểm: E2E mock API trả 500 → text lỗi không khớp regex `(Error:|at .*\.js|SELECT|Exception|TypeError)`; có nút Thử lại hoạt động. · Nguồn: OWASP (không lộ chi tiết nội bộ); [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md)
- [ ] `UX-STATE-006` **MUST** Nút gửi bị vô hiệu + hiện trạng thái đang gửi trong khi request chạy; không thể double-submit. → Kiểm: E2E click nhanh 2 lần → chỉ 1 request (đếm qua `page.waitForRequest`); API có idempotency key cho tạo mới (nguyên tắc: [`ARC-INT-001`](../05-architecture/integration-patterns.md); hợp đồng header `Idempotency-Key`: [`../08-backend/api-design.md`](../08-backend/api-design.md)).
- [ ] `UX-STATE-007` **MUST@L** Thất bại không xoá dữ liệu đã nhập; form giữ nguyên giá trị và focus về lỗi đầu tiên. → Kiểm: E2E mock lỗi mạng khi submit → giá trị input còn nguyên. · Nguồn: WCAG 2.2 SC 3.3.7 (tinh thần)
- [ ] `UX-STATE-008` **MUST** Hành động không thể hoàn tác có dialog xác nhận nêu rõ đối tượng và hậu quả; nút xác nhận ghi đúng động từ; nút huỷ là mặc định khi nhấn Esc. → Kiểm: E2E xoá vĩnh viễn → dialog có tên đối tượng; Esc đóng không xoá. · Nguồn: WAI-ARIA APG Dialog
- [ ] `UX-STATE-009` **MUST@L** Optimistic update có rollback khi server lỗi và thông báo cho người dùng; không dùng cho tiền, quyền, xoá vĩnh viễn. → Kiểm: test đơn vị/E2E mock lỗi mutation → UI trở về trạng thái trước + thông báo lỗi; grep `useOptimistic|onMutate` không xuất hiện trong module thanh toán/phân quyền. · Nguồn: React `useOptimistic`; TanStack Query Optimistic Updates
- [ ] `UX-STATE-010` **MUST@L** Thông báo trạng thái động được công bố cho trình đọc màn hình (`role="status"` hoặc `role="alert"`), không cướp focus. → Kiểm: E2E sau hành động, phần tử `[role=status]` chứa thông điệp; axe không vi phạm. · Nguồn: WAI-ARIA APG Alert
- [ ] `UX-STATE-011` **MUST@L** Lỗi phía client được ghi nhận vào hệ thống theo dõi lỗi kèm ngữ cảnh (route, hành động, mã lỗi chuẩn hoá) nhưng không kèm PII. → Kiểm: test gửi lỗi giả → sự kiện xuất hiện trong công cụ theo dõi; payload không chứa email/SĐT (xem [`../15-operations/observability.md`](../15-operations/observability.md)).
- [ ] `UX-STATE-012` **SHOULD** Dùng "hoàn tác" (toast có nút Hoàn tác + xoá mềm) thay cho hộp xác nhận với hành động đảo ngược được. → Kiểm: E2E xoá mục → bấm Hoàn tác → mục trở lại; API xoá mềm có `deleted_at`.
- [ ] `UX-STATE-013` **SHOULD** Khi refetch nền, giữ dữ liệu cũ hiển thị và chỉ báo nhỏ ("Đang cập nhật"), không thay bằng skeleton. → Kiểm: E2E thay đổi tab/focus lại → không thấy skeleton, thấy chỉ báo nhỏ.
- [ ] `UX-STATE-014` **SHOULD** Toast chỉ dành cho thông báo không cần hành động; lỗi cần hành động hiển thị cố định đến khi người dùng xử lý. → Kiểm: review: không có toast chứa nút "Sửa" cho lỗi field; toast lỗi không tự biến mất. · Nguồn: WAI-ARIA APG Alert (không tự biến mất)
- [ ] `UX-STATE-015` **SHOULD** Trạng thái offline/mất kết nối được phát hiện và báo; hành động xếp hàng hoặc chặn có giải thích. → Kiểm: Playwright `context.setOffline(true)` → banner offline; thao tác ghi hiện thông báo thay vì lỗi lạ.
- [ ] `UX-STATE-016` **SHOULD** Tác vụ dài chạy nền (export, import, xử lý AI) có trạng thái theo dõi được sau khi rời trang (job id, thông báo khi xong). → Kiểm: E2E tạo job → điều hướng → quay lại thấy tiến độ/kết quả (xem [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)).
- [ ] `UX-STATE-017` **SHOULD** Lỗi được phân loại và ánh xạ sang thông điệp người dùng ở một nơi (bảng mã lỗi → microcopy), không viết tay rải rác. → Kiểm: file `src/lib/error-messages.ts` (hoặc tương đương) là nguồn duy nhất; grep chuỗi "Đã xảy ra lỗi" ngoài file = 0.
- [ ] `UX-STATE-018` **SHOULD** Thanh tiến độ phản ánh tiến độ thật (bước/phần trăm từ server), không giả lập chạy đến 90% rồi dừng. → Kiểm: review nguồn giá trị progressbar đến từ API/stream.
- [ ] `UX-STATE-019` **SHOULD** Trạng thái thành công rõ ràng sau hành động (chuyển trang, thông điệp, cập nhật danh sách) trong cùng một bước. → Kiểm: E2E sau tạo mới: mục mới xuất hiện trong danh sách hoặc có thông báo thành công.
- [ ] `UX-STATE-020` **MAY** Skeleton có hiệu ứng nhẹ (shimmer) tắt khi `prefers-reduced-motion`. → Kiểm: `emulateMedia({ reducedMotion: 'reduce' })` → không animation.
- [ ] `UX-STATE-021` **MAY** Thời lượng tối thiểu hiển thị chỉ báo tải để tránh nháy (chỉ với tải < 0,3 s). → Kiểm: test đơn vị hook loading có delay ngưỡng cấu hình.

## Bẫy thường gặp

- **Màn trắng khi tải** rồi nhảy layout → CLS cao, cảm giác hỏng. Skeleton đúng kích thước.
- **"Đã xảy ra lỗi" chung chung** cho mọi lỗi: người dùng không biết thử lại hay liên hệ ai. Phân loại lỗi (mạng, quyền, dữ liệu, server) và viết microcopy theo nhóm.
- **Form bị reset sau lỗi** (render lại từ server) → mất 10 phút nhập liệu. Giữ state phía client, chỉ cập nhật phần lỗi.
- **Dialog xác nhận cho mọi thứ** → người dùng bấm OK theo quán tính; lúc thật sự cần thì không đọc. Giữ dialog cho việc không đảo được.
- **Optimistic cho thanh toán** → hiển thị "Đã thanh toán" rồi rollback: mất niềm tin, khiếu nại. Chờ xác nhận server.
- **Toast lỗi tự biến mất** sau 3 s: người dùng không kịp đọc; lỗi cần hành động phải cố định.
- **Spinner lồng spinner** (trang + khối + nút) khi một request chạy. Một chỉ báo ở đúng phạm vi.
- **Progress giả** (chạy tới 90% rồi đứng) làm người dùng bấm huỷ/ tải lại → sinh tác vụ trùng.
- **Empty state không phân biệt** "chưa có dữ liệu" với "bộ lọc không khớp" → người dùng tưởng mất dữ liệu.
- **Kiểm chỉ "happy path"** trong E2E: mock lỗi 500/timeout/offline là bắt buộc cho luồng chính.

## Cổng tự động

| Công cụ (license) | Lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Storybook 10.6.2 (MIT) + script đếm story 4 trạng thái | `node scripts/check-ui-states.mjs` (đọc `*.stories.*`, yêu cầu Loading/Empty/Error/Default cho component trong `components/data/`) | CI | 0 component thiếu |
| Playwright 1.64.0 (Apache-2.0) `page.route` mock 500/timeout + `context.setOffline` | `playwright test --grep @error-states` | CI E2E | lỗi có "Thử lại", dữ liệu nhập giữ nguyên |
| MSW 3.0.3 (MIT) | handler lỗi dùng chung cho component test và E2E | test | mọi mutation có test nhánh lỗi |
| Lighthouse 13.5.0 (Apache-2.0) CLS | `lhci assert cumulative-layout-shift maxNumericValue 0.1` | CI | ≤ 0.1 |
| `@axe-core/playwright` 4.13.0 (MPL-2.0) | quét sau khi hiện trạng thái lỗi/rỗng | CI E2E | 0 vi phạm (`aria-*`, `color-contrast`) |
| Grep thông điệp lỗi rải rác | `rg -n "Đã xảy ra lỗi|Something went wrong" src --glob '!src/lib/error-messages.ts'` | pre-commit | 0 kết quả |

## Nguồn

- Nielsen Norman Group — Response Times: The 3 Important Limits (0,1 s / 1 s / 10 s; 1993, cập nhật 2014): <https://www.nngroup.com/articles/response-times-3-important-limits/> — xác minh 2026-10-13.
- React — `useOptimistic` (hiển thị tạm khi Action chạy, trở về giá trị thật khi xong/lỗi): <https://react.dev/reference/react/useOptimistic> — xác minh 2026-10-13.
- TanStack Query — Optimistic Updates (`onMutate` cancel + snapshot, `onError` rollback, `onSettled` invalidate): <https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates> — xác minh 2026-10-13.
- WAI-ARIA APG — Alert pattern (không chuyển focus, không tự biến mất): <https://www.w3.org/WAI/ARIA/apg/patterns/alert/>; Dialog (Modal): <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/> — xác minh 2026-10-13.
- web.dev — Web Vitals (CLS ≤ 0.1): <https://web.dev/articles/vitals> — xác minh 2026-10-13.
- Phiên bản npm `latest` (2026-10-13): storybook 10.6.2 · @playwright/test 1.64.0 · msw 3.0.3 · lighthouse 13.5.0 · @axe-core/playwright 4.13.0.
- Khung cũ `1b80fe4` `quality-supplements.md` Nhóm 2 mục 5 (checklist 4 trạng thái, form & hành động); `research/2026-10-13-old-framework-analysis.md`.
