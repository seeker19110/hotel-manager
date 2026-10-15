# SPEC-pwa — PWA: cài đặt, app shell, chạy online có báo mất mạng

| Trường | Giá trị |
|---|---|
| ID tính năng | F-009 (yêu cầu gốc: R-001…R-005 chạy trên thiết bị mục tiêu; kế hoạch §09, §10, §17; backlog T041, T042, T048) |
| Trạng thái | Draft — chờ duyệt |
| Phiên bản | 1 — thay đổi: xem cuối file |
| Chủ spec | (chưa gán) · Duyệt bởi (chưa) ngày (chưa) |
| Hồ sơ/quy mô | web-app / M |
| Ngày | 2026-10-15 |
| Phụ thuộc | ADR-0001 (Next.js 16.4.x, Serwist `@serwist/next` 9.5.x), ARCHITECTURE (luồng command, `GET /api/v1/commands/{command_id}`), SPEC-access-and-property (đăng xuất, đổi tổ chức), SPEC-portal |

## 1. User story
- Là **lễ tân/quản lý dùng điện thoại**, tôi muốn cài ứng dụng lên màn hình chính và mở nhanh như app, để thao tác tại phòng/quầy mà không cần tìm trang web.
- Là **người dùng bị mất mạng**, tôi muốn được báo rõ rằng thao tác chưa được gửi, để không tưởng nhầm đã thu tiền hay đã nhận phòng.
- Là **chủ cơ sở**, tôi muốn thiết bị không giữ lại ảnh CCCD hay thông tin thanh toán sau khi nhân viên đăng xuất, để giảm rủi ro lộ dữ liệu nhạy cảm (NĐ 356/2025).

**Pilot chỉ chạy online.** Offline nháp (F-014, T043) ngoài phạm vi; T042 chỉ là spike với dữ liệu giả — xem Phụ lục A. Web Push ngoài phạm vi pilot (Q-04).

## 2. Tiêu chí chấp nhận (Given/When/Then)

### S-001 Manifest hợp lệ
- Given bản build production
- When Playwright tải `/manifest.webmanifest`
- Then có `name`, `short_name`, `lang="vi"`, `start_url="/?source=pwa"`, `scope="/"`, `display="standalone"`, `theme_color`, `background_color`, icon 192×192 và 512×512 (có ít nhất một icon `purpose="maskable"`); trang có `<link rel="apple-touch-icon">` 180×180; Lighthouse mục "Installable" đạt

### S-002 Cài đặt trên Chrome Android / desktop
- Given Chrome Android hoặc Chrome/Edge desktop, người dùng đã đăng nhập
- When trình duyệt phát `beforeinstallprompt` và người dùng bấm "Cài ứng dụng" trong menu Thêm
- Then hiện hộp cài của trình duyệt; sau khi cài, mở từ biểu tượng chạy ở `display-mode: standalone` và vào đúng màn mặc định theo vai trò

### S-003 Hướng dẫn cài trên Safari iOS
- Given Safari iOS ≥ 16.4 (không có `beforeinstallprompt`)
- When mở menu Thêm → "Cài ứng dụng"
- Then hiện hướng dẫn chữ + hình "Chia sẻ → Thêm vào MH chính"; không hiện nút cài giả

### S-004 Mất mạng khi đang ở app shell
- Given ứng dụng đã mở và SW đã kích hoạt
- When thiết bị mất mạng (Playwright `context.setOffline(true)`) rồi điều hướng sang "Phòng"
- Then hiện app shell + trang `/offline` với tiêu đề "Không có kết nối mạng" và câu "Ứng dụng cần mạng để xem và lưu dữ liệu. Chưa có thao tác nào được gửi."; không hiển thị dữ liệu phòng cũ; banner trạng thái mạng có `role="status"`

### S-005 Không cache trang/ảnh chứa PII
- Given người dùng đã xem chi tiết khách có ảnh CCCD (URL ký) và trang phiếu thu
- When kiểm tra Cache Storage và HTTP cache sau đó
- Then không có entry nào cho route HTML ứng dụng, `/api/*`, URL object storage; mọi phản hồi `/api/*` và trang có dữ liệu có `Cache-Control: no-store`; Cache Storage chỉ chứa asset tĩnh có hash (JS/CSS/font/icon) và `/offline`

### S-006 Command bị chặn khi mất mạng
- Given đang mở form "Ghi nhận thanh toán" và mất mạng
- When bấm "Xác nhận"
- Then client không gửi request, hiện lỗi `OFFLINE` "Không có kết nối mạng. Thao tác chưa được gửi."; nút giữ trạng thái có thể bấm lại khi có mạng; không có toast "thành công"

### S-007 Đăng xuất / đổi tổ chức xoá cache
- Given người dùng đã dùng ứng dụng (runtime cache, IndexedDB `hm-*`, `sessionStorage` có dữ liệu)
- When bấm "Đăng xuất" hoặc đổi ngữ cảnh tổ chức
- Then client gửi `postMessage({type:"CLEAR_USER_DATA"})` tới SW; mọi cache trừ precache app shell bị xoá, IndexedDB `hm-*` bị xoá, `sessionStorage`/`localStorage` của ứng dụng bị xoá; server trả `Clear-Site-Data: "cache", "storage"` khi đăng xuất; nút Back không hiển thị lại trang có dữ liệu

### S-008 Có phiên bản SW mới khi đang nhập form
- Given SW v1 đang điều khiển trang, người dùng đang nhập dở form (form "bẩn")
- When SW v2 cài xong (`waiting`)
- Then **không** tự `skipWaiting`; hiện banner "Đã có phiên bản mới. Lưu xong thao tác rồi bấm Cập nhật."; dữ liệu đang nhập không mất; bấm "Cập nhật" → `skipWaiting` → tải lại trang

### S-009 Client quá cũ
- Given client v1 còn mở, server đã yêu cầu tối thiểu v2 (header `X-App-Version` thấp hơn mức tối thiểu)
- When client gửi command
- Then HTTP 426 `CLIENT_OUTDATED`; không ghi dữ liệu; UI hiện "Ứng dụng cần cập nhật để tiếp tục" + nút "Cập nhật"

### S-010 Timeout đúng lúc xác nhận
- Given client tạo `command_id=c1` (dùng làm `Idempotency-Key`), gửi "Nhận phòng"; server đã commit nhưng phản hồi bị mất (Playwright chặn response)
- When client hết thời gian chờ
- Then UI hiện "Đang kiểm tra kết quả…", gọi `GET /api/v1/commands/c1`; nhận `status=completed` → hiện kết quả thành công từ server; **không** có lần gửi command thứ hai; DB có đúng 1 lượt ở `in_house`

### S-011 Timeout và server chưa nhận lệnh
- Given như S-010 nhưng request chưa tới server
- When `GET /api/v1/commands/c1` trả 404 `COMMAND_NOT_FOUND`
- Then nút "Gửi lại" mới bật; gửi lại dùng **cùng** `c1`; kết quả có đúng 1 bản ghi

### S-012 Timeout và lệnh đang xử lý
- Given `GET /api/v1/commands/c1` trả `status=in_progress`
- When client hỏi lại theo backoff (1 s, 2 s, 4 s; tối đa 30 s — đề xuất)
- Then nút "Gửi lại" bị khoá suốt thời gian chờ; quá 30 s hiện "Chưa xác định được kết quả. Đừng thao tác lại; kiểm tra lịch sử hoặc liên hệ quản lý." kèm `command_id`

### S-013 Phiên hết hạn khi đang dùng
- Given phiên hết hạn trong khi form đang mở
- When người dùng bấm "Lưu"
- Then HTTP 401 `UNAUTHENTICATED`; hiện hộp đăng nhập lại; sau đăng nhập, nếu ngữ cảnh tổ chức giống trước thì cho gửi lại với **cùng** `command_id`, nếu khác thì huỷ form (`CONTEXT_CHANGED`)

### S-014 Năm điểm vào mobile
- Given viewport 390×844, vai trò `manager`, mẫu Hỗn hợp
- When mở ứng dụng
- Then thanh điều hướng dưới có đúng 5 mục theo thứ tự: Hôm nay · Phòng/Lịch · Thu tiền · Công việc · Thêm; vai trò `housekeeping` không thấy "Thu tiền" (menu theo vai trò, kế hoạch §09); cơ sở đang thao tác luôn hiện ở header

### S-015 Vùng chạm và tiếp cận
- Given các màn trong luồng R-001…R-005 và `/offline`
- When chạy axe trong Playwright và script đo kích thước phần tử tương tác
- Then 0 vi phạm WCAG 2.2 AA mức serious/critical; mọi phần tử tương tác ≥ 44 × 44 CSS px; không thao tác nào chỉ dùng hover hoặc kéo thả

### S-016 Ma trận thiết bị
- Given ma trận ở mục 7
- When chạy bộ E2E khói (đăng nhập, mở Hôm nay, một command, mất mạng, đăng xuất)
- Then xanh trên cả 5 cấu hình; cấu hình iOS và chế độ cài được kiểm tay trên thiết bị thật, kết quả ghi vào `docs/qa/` với ngày và phiên bản OS

### S-017 Bộ nhớ thiết bị đầy / bị thu hồi
- Given Cache Storage bị trình duyệt xoá (mô phỏng xoá cache)
- When mở lại ứng dụng khi có mạng
- Then ứng dụng tải bình thường từ mạng, SW cài lại precache; không lỗi trắng trang

## 3. Ca biên (8 nhóm)
| Nhóm | Ca cụ thể | Hành vi mong đợi | Scenario |
|---|---|---|---|
| Rỗng/null | Chưa có SW (lần đầu, trình duyệt chặn SW); cache rỗng | Ứng dụng chạy như web thường; trang offline chỉ có sau lần tải đầu | S-017 |
| Cực đại/độ dài | Quota storage đầy; precache quá lớn | Precache chỉ asset app shell (ngân sách đề xuất ≤ 5 MB, Q-05); lỗi quota không chặn ứng dụng online | S-017 |
| Trùng lặp/idempotency | Gửi lại sau timeout; bấm hai lần | Cùng `command_id`; nút khoá khi đang gửi; server trả kết quả cũ | S-010, S-011 |
| Song song | Hai tab, một tab cập nhật SW; hai tab khác tổ chức | SW mới chờ đến khi người dùng đồng ý; khác ngữ cảnh → `CONTEXT_CHANGED` (SPEC-portal S-013) | S-008 |
| Mất mạng giữa chừng | Mất mạng trước khi gửi / sau khi gửi trước khi nhận | Trước: `OFFLINE`, không gửi. Sau: truy vấn `command_id` khi có mạng | S-006, S-010 |
| Thời gian/múi giờ | Giờ thiết bị sai lệch | Hạn phiên, hạn liên kết, thời gian chờ tính theo server; hiển thị theo `properties.timezone` | S-013 |
| Quyền | Chuyển tài khoản trên cùng thiết bị; người dùng khác mở PWA đã cài | Xoá dữ liệu người dùng cũ khi đăng xuất/đổi ngữ cảnh; không hiển thị trang cũ qua Back | S-007 |
| Tiền/đơn vị | Xác nhận thu tiền khi mạng chập chờn | Không bao giờ báo "đã thu" trước phản hồi server; không cache số dư | S-006, S-010 |

## 4. Dữ liệu
| Thực thể | Trường | Kiểu | Ràng buộc | Ai đọc/ghi |
|---|---|---|---|---|
| `idempotency_keys` (có sẵn, INV-G5) | `key` = `command_id`, `status`, `response`, `expires_at` | | unique `(organization_id, key)` | Server; client đọc qua `GET /api/v1/commands/{id}` (chỉ lệnh của chính mình) |
| Cache Storage (trình duyệt) | `hm-precache-<build>` | asset có hash, `/offline`, manifest, icon | **Không** HTML có dữ liệu, `/api/*`, URL file | SW |
| IndexedDB | Pilot: không dùng cho dữ liệu nghiệp vụ | | Xoá khi đăng xuất | — |

- Không thay đổi schema DB ngoài việc đảm bảo `GET /api/v1/commands/{command_id}` lọc theo `organization_id` + người gửi.

## 5. Giao diện / API
| Loại | Tên | Mô tả |
|---|---|---|
| Query | `commands.getStatus` (`GET /api/v1/commands/{command_id}`) | `completed` (kèm kết quả) \| `in_progress` \| 404 `COMMAND_NOT_FOUND` |
| Query | `app.getVersion` (`GET /api/version`) | Phiên bản build + phiên bản client tối thiểu |
| Command | `session.logout` | Thu hồi phiên, trả `Clear-Site-Data` |

- Cấu hình Serwist (đề xuất cho T041): precache manifest do `@serwist/next` sinh; runtime: điều hướng `NetworkOnly` + fallback `/offline`; `/api/*` và miền object storage `NetworkOnly` (không đăng ký route cache); không bật `skipWaiting`/`clientsClaim` tự động; `navigationPreload` bật.
- Trạng thái UI:

| Trạng thái | Biểu hiện |
|---|---|
| Đang tải | khung xương; nút command có spinner và bị khoá |
| Mất mạng | banner trên cùng "Mất kết nối — thao tác chưa được gửi" (`role="status"`, chữ + icon, không chỉ màu); nút command bị khoá |
| Đang kiểm tra kết quả | hộp thoại "Đang kiểm tra kết quả…" + `command_id` rút gọn |
| Lỗi | thông điệp theo mã ở mục 6 + hướng sửa |
| Thành công | chỉ sau phản hồi 2xx hoặc `completed` từ server |
| Có bản mới | banner "Đã có phiên bản mới" + nút "Cập nhật" |

- Tiếp cận: WCAG 2.2 AA (kế hoạch §09, [S26]); vùng chạm ≥ 44 CSS px; banner thông báo bằng `aria-live="polite"`, lỗi chặn bằng `role="alert"`; focus về tiêu đề hộp thoại khi mở; hỗ trợ zoom 200% không mất chức năng; tôn trọng `prefers-reduced-motion`.

## 6. Lỗi
| Mã lỗi | Khi nào | HTTP | Thông điệp cho người dùng | Scenario |
|---|---|---|---|---|
| `OFFLINE` | Client phát hiện mất mạng trước khi gửi | — (client) | Không có kết nối mạng. Thao tác chưa được gửi. | S-006 |
| `NETWORK_TIMEOUT` | Hết thời gian chờ phản hồi | — (client) | Chưa nhận được phản hồi. Đang kiểm tra kết quả… | S-010 |
| `RESULT_UNKNOWN` | Hỏi `command_id` quá thời gian chờ | — (client) | Chưa xác định được kết quả. Đừng thao tác lại; kiểm tra lịch sử hoặc liên hệ quản lý. | S-012 |
| `COMMAND_NOT_FOUND` | Server chưa nhận `command_id` | 404 | (nội bộ) — bật nút "Gửi lại" | S-011 |
| `UNAUTHENTICATED` | Phiên hết hạn | 401 | Phiên đăng nhập đã hết. Vui lòng đăng nhập lại. | S-013 |
| `CONTEXT_CHANGED` | Ngữ cảnh tổ chức khác với lúc mở form | 409 | Bạn vừa chuyển sang cơ sở khác. Tải lại để tiếp tục. | S-013 |
| `CLIENT_OUTDATED` | Phiên bản client thấp hơn mức tối thiểu | 426 | Ứng dụng cần cập nhật để tiếp tục. | S-009 |
| `IDEMPOTENCY_CONFLICT` | Cùng `command_id`, khác thân | 409 | Yêu cầu bị trùng mã thao tác. Vui lòng tải lại. | — |

## 7. Yêu cầu phi chức năng của tính năng
| Thuộc tính | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| LCP | p75 < 2,5 s trên thiết bị/mạng mục tiêu | PROJECT §5, kế hoạch §17 | Lighthouse CI (mobile, throttling) + RUM |
| Cài đặt | Lighthouse "Installable" đạt | kế hoạch §10 | Lighthouse CI |
| PII trên máy | 0 entry PII trong Cache Storage/IndexedDB sau mỗi E2E | kế hoạch §10, §15 | test Playwright đọc `caches.keys()` + IndexedDB |
| Tiếp cận | WCAG 2.2 AA; vùng chạm ≥ 44 px | kế hoạch §09 | axe + kiểm tay |

Ma trận thiết bị (kế hoạch §10, PROJECT §5):

| # | Cấu hình | Tự động (Playwright) | Thiết bị thật |
|---|---|---|---|
| 1 | Safari iOS ≥ 16.4 (trình duyệt) | WebKit project (gần đúng) | iPhone, kiểm tay |
| 2 | Safari iOS ≥ 16.4, đã thêm vào MH chính | không | iPhone, kiểm tay |
| 3 | Chrome Android | Chromium + mobile emulation | Android, kiểm tay |
| 4 | Chrome Android, PWA đã cài | không | Android, kiểm tay |
| 5 | Chrome/Edge desktop (trình duyệt và đã cài) | Chromium (+ channel `msedge` nếu CI có) | kiểm tay mỗi bản phát hành |

Kịch bản QA trên mọi cấu hình (T048): mất mạng, đóng/mở app, phiên hết hạn, cập nhật phiên bản, dung lượng đầy, chuyển tài khoản, timeout đúng lúc xác nhận, mạng yếu (throttling 3G).

## 8. Hành vi AI
Không áp dụng — tính năng không dùng model.

## 9. Đo lường
- `pwa.installed` (sự kiện `appinstalled`), `pwa.launched_standalone`, `pwa.offline_shown`, `pwa.sw_update_applied`, `command.timeout_resolved` (thuộc tính `outcome=completed|not_found|unknown`) → M-02 (tự hoàn thành tác vụ), M-05 (dùng hằng tuần). Không gửi PII trong sự kiện.

## 10. Câu hỏi mở (0 câu [chặn] trước khi Approved)
- [ ] Q-01 Ngưỡng timeout client cho command (đề xuất 15 s) và thời gian tối đa hỏi `command_id` (đề xuất 30 s) — [không chặn] — hỏi: Tech Lead — **đề xuất:** như trên, cấu hình được, chỉnh theo số đo T079.
- [ ] Q-02 Có bắt buộc cập nhật khi server đổi API không tương thích không? — [không chặn] — hỏi: Tech Lead — **đề xuất:** có, qua `CLIENT_OUTDATED` (426) + mức tối thiểu ở `/api/version`.
- [ ] Q-03 Có cho xem bản tối thiểu được cache khi mất mạng (kế hoạch §10 dòng "Xem việc và phòng") trong pilot không? — [không chặn] — hỏi: PO — **đề xuất:** không trong pilot (chỉ app shell, đúng T048); xem lại cùng F-014.
- [ ] Q-04 Web Push (iOS ≥ 16.4 chỉ khi đã cài, xin quyền sau thao tác [S05]) có vào pilot không? — [không chặn] — hỏi: PO — **đề xuất:** không; pilot dùng thông báo trong app + email (SPEC-notifications).
- [ ] Q-05 Ngân sách precache — [không chặn] — hỏi: Tech Lead — **đề xuất:** ≤ 5 MB, kiểm trong CI.
- [ ] Q-06 Thiết bị thật cho ma trận (model, phiên bản OS) và ai giữ — [không chặn, chặn T048] — hỏi: PO/QA — **đề xuất:** 1 iPhone iOS 16.x/17+ đời thấp, 1 Android tầm trung, ghi danh sách vào `docs/qa/`.

## 11. DoR / DoD
- DoR: spec Approved · 0 câu hỏi chặn · luồng `GET /api/v1/commands/{id}` có trong OpenAPI · mỗi task có Gate.
- DoD: mọi S-NNN có test xanh (S-002/S-003/S-016 phần thiết bị thật có biên bản kiểm tay) · ca biên có test · không PII trong cache sau E2E · cổng commit/merge xanh · blueprint tick có bằng chứng.

## 12. Truy vết
| Task | PR | Bằng chứng (CI/evidence) |
|---|---|---|
| T041 (manifest, icon, cài, app shell) | — | — |
| T042 (spike offline, chính sách cache, hợp đồng đồng bộ — Phụ lục A) | — | — |
| T048 (QA PWA online trên thiết bị) | — | — |

## Phụ lục A — Spike hợp đồng đồng bộ offline (T042, KHÔNG phát hành trong pilot)
Mục tiêu: chứng minh khả thi bằng **dữ liệu giả**, làm đầu vào cho F-014/T043. Không gắn vào luồng nghiệp vụ pilot (kế hoạch §10, T042).

IndexedDB `hm-drafts`, object store `commands` (keyPath `command_id`):

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `schema_version` | number | tăng khi đổi cấu trúc; bản cũ phải migrate hoặc báo người dùng |
| `organization_id` | string (uuid) | nháp chỉ hiện trong đúng ngữ cảnh tổ chức |
| `person_id` | string (uuid) | người tạo nháp |
| `device_id` | string (uuid) | sinh một lần mỗi cài đặt |
| `command_id` | string (uuid v7) | dùng làm `Idempotency-Key` khi gửi |
| `command_type` | string | chỉ: nháp chỉ số công tơ, phiếu việc, buồng phòng (T043) |
| `payload` | object | không chứa ảnh CCCD/thông tin thanh toán |
| `base_version` | number | phiên bản bản ghi gốc khi tạo nháp, để phát hiện xung đột |
| `status` | `draft` \| `pending` \| `synced` \| `conflict` | Nháp / Chờ gửi / Đã đồng bộ / Xung đột (kế hoạch §10) |
| `attempts`, `last_error`, `created_at`, `updated_at` | | backoff; không phụ thuộc Background Sync [S06] |

Index: `[organization_id, status]`, `[organization_id, created_at]`. Câu hỏi spike phải trả lời: storage bị thu hồi trên Safari [S07]; xử lý `conflict` (giữ bản mâu thuẫn để chọn); đăng xuất khi còn nháp chưa gửi (cảnh báo, không xoá âm thầm — kế hoạch §10); server xác thực lại quyền hiện tại khi replay. Kết quả spike ghi vào ADR mới, không sửa ADR-0001.

## Thay đổi
| Phiên bản | Ngày | Gì | Vì sao | Duyệt |
|---|---|---|---|---|
| 1 | 2026-10-15 | tạo | G3 cho F-009 | (chưa) |
