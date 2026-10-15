---
title: Unit test & chống lỗi logic: ca biên, null/0, race, thời gian, tiền
kind: module
prefix: QA-UNIT
applies_to: [all]
updated: 2026-10-14
---

# Unit test & chống lỗi logic: ca biên, null/0, race, thời gian, tiền

> Lỗi nguy hiểm nhất là code **biên dịch sạch, type đúng, nhưng làm sai việc**. Module này liệt kê các lớp ca biên
> phải có test và cách viết unit test để bắt chúng. Quy tắc nghiệp vụ về thời gian/tiền/đơn vị nằm ở
> [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md); đây là **cách test**.

## Nguyên tắc

- **Mỗi nhánh logic phức tạp có ≥ 1 test ca biên trước khi coi là xong.** Lỗi logic rẻ nhất khi unit test bắt, đắt nhất khi người dùng gặp.
- **Test hành vi, không test triển khai.** Đầu vào → đầu ra qua giao diện công khai; refactor không làm test đỏ.
- **Bảng ca biên là checklist review.** Rỗng/một/nhiều · null vs 0 · off-by-one · tiền · chia 0/tràn/làm tròn · UTC/DST · race/idempotency · thứ tự phản hồi · all-or-nothing.
- **Sinh ca thay vì liệt kê** khi miền đầu vào lớn: property-based test (fast-check, Hypothesis) tìm ca bạn không nghĩ tới.
- **Characterization test trước refactor.** Chưa có test → viết test mô tả hành vi hiện tại, rồi mới sửa (xem [`static-analysis-and-code-quality.md`](static-analysis-and-code-quality.md)).

## Quyết định

| Loại logic | Kỹ thuật test | Công cụ (xác minh 2026-10-13) | Khi nào không dùng |
|---|---|---|---|
| Hàm thuần, quy tắc nghiệp vụ | Table-driven/parameterized với bảng ca biên | Vitest 5.0.4 `test.each`, Jest 30.5.2, pytest 9.1.1 `parametrize`, Go table tests, JUnit 6 `@ParameterizedTest` | — |
| Miền đầu vào lớn (parser, tính toán, serializer) | Property-based: bất biến + round-trip + so với oracle chậm | fast-check 4.10.2 (MIT), Hypothesis 6.169.0 (MPL-2.0), Go `testing/quick` hoặc `rapid`, jqwik (Java) | Logic phụ thuộc I/O |
| Phụ thuộc thời gian | Fake clock tiêm vào, không `Date.now()` trực tiếp | `vi.useFakeTimers`, `jest.useFakeTimers`, `freezegun`/`time-machine` (Python, phiên bản **chưa xác minh**), Go `clock` interface | — |
| Ngẫu nhiên | Seed cố định tiêm vào | `seedrandom`, `random.Random(seed)`, `rand.New(rand.NewSource(1))` | — |
| Đồng thời/race | Test chạy 2 thao tác song song trên cùng tài nguyên; `-race` | Go `-race`, Node `Promise.all` + kiểm bất biến, pytest + `threading`/`anyio` | Logic đơn luồng thuần |
| Tiền/thập phân | Oracle bằng kiểu decimal; không float | `decimal.js`/`big.js`, Python `decimal`, Go `shopspring/decimal`, Java `BigDecimal` (phiên bản **chưa xác minh**) | — |

## Checklist

- [ ] `QA-UNIT-001` **MUST@L** Mỗi hàm xử lý tập hợp có test với danh sách rỗng, đúng 1 phần tử, nhiều phần tử. → Kiểm: test parameterized có 3 ca `[]`, `[x]`, `[x..n]` (grep tên ca `empty|single|many`).
- [ ] `QA-UNIT-002` **MUST@L** Phân biệt "không có" (`null`/`undefined`/`None`) với `0`/`""`/`false` — có test cho cả hai. → Kiểm: test truyền `null` và `0` cho cùng hàm, kỳ vọng khác nhau; lint `??` thay `||` cho giá trị số/chuỗi (`@typescript-eslint/prefer-nullish-coalescing`).
- [ ] `QA-UNIT-003` **MUST@L** Off-by-one: phân trang, cắt chuỗi, khoảng ngày có test ở biên (0, 1, n−1, n, n+1). → Kiểm: test phân trang với `pageSize` = tổng số, tổng+1, tổng−1; TS bật `noUncheckedIndexedAccess`.
- [ ] `QA-UNIT-004` **MUST** Tiền và số lượng không dùng float: test `0.1 + 0.2` tương đương trả đúng bằng kiểu số nguyên nhỏ nhất/decimal; làm tròn theo quy tắc ghi rõ (half-even/half-up). → Kiểm: test tổng 3 × 0.1 = 0.3 bằng decimal; lint cấm `number` cho field tiền (schema `string`/`bigint`). · Nguồn: [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md)
- [ ] `QA-UNIT-005` **MUST@L** Chia cho 0, tràn số, số âm, giá trị cực đại có test và hành vi định nghĩa (lỗi hay giá trị mặc định). → Kiểm: test với `0`, `-1`, `Number.MAX_SAFE_INTEGER`/`sys.maxsize`.
- [ ] `QA-UNIT-006` **MUST@L** Thời gian lưu/tính bằng UTC; test ca chuyển ngày, cuối tháng (31→28/29), năm nhuận, và DST ở ít nhất một múi giờ có DST. → Kiểm: test với clock giả `2024-02-29T23:59:59Z` và múi `Europe/Berlin`/`America/New_York` tại ngày đổi giờ.
- [ ] `QA-UNIT-007` **MUST** Thao tác ghi có idempotency: gửi lại cùng yêu cầu (cùng key) không tạo bản ghi/tính tiền hai lần. → Kiểm: test gọi 2 lần cùng `idempotency_key`, đếm bản ghi = 1.
- [ ] `QA-UNIT-008` **MUST** Race: hai thao tác đồng thời trên cùng tài nguyên (hai click, hai request) giữ bất biến (số dư không âm, tồn kho không âm). → Kiểm: test `Promise.all([op, op])`/`go test -race`/thread pool, assert bất biến; xem [`../09-database/transactions-and-consistency.md`](../09-database/transactions-and-consistency.md).
- [ ] `QA-UNIT-009` **MUST@L** Phản hồi về muộn không ghi đè dữ liệu mới (stale response/closure). → Kiểm: test mô phỏng 2 request, request 1 trả sau request 2, state cuối = kết quả request 2.
- [ ] `QA-UNIT-010` **MUST** Thao tác nhiều bước là all-or-nothing: lỗi ở bước giữa → không còn trạng thái nửa vời. → Kiểm: test ném lỗi ở bước 2, assert bước 1 đã rollback.
- [ ] `QA-UNIT-011` **MUST@L** Không promise/future "trôi": mọi `async` được `await` hoặc xử lý. → Kiểm: lint `@typescript-eslint/no-floating-promises`; Python `RUF006` (ruff) / `asyncio` debug mode trong test.
- [ ] `QA-UNIT-012` **MUST@L** Unit test không chạm mạng, đĩa ngoài thư mục tạm, hay thời gian thật. → Kiểm: `pytest-socket`/`vi.stubGlobal('fetch')` bật; test xanh khi tắt mạng.
- [ ] `QA-UNIT-013` **SHOULD** Logic có miền đầu vào lớn (parser, chuyển đổi, tính toán) có property-based test với bất biến hoặc round-trip. → Kiểm: file test import `fast-check`/`hypothesis`; ≥ 1 property cho mỗi module parser/serializer.
- [ ] `QA-UNIT-014` **SHOULD** Chuỗi: test Unicode (dấu tiếng Việt tổ hợp vs dựng sẵn — NFC/NFD), emoji, chuỗi rất dài, khoảng trắng đầu/cuối. → Kiểm: ca test chứa `"Tiếng Việt"` dạng NFD và NFC cho so sánh/tìm kiếm.
- [ ] `QA-UNIT-015` **SHOULD** Tên test mô tả hành vi và ca (`rejects_withdraw_when_balance_insufficient`), một khái niệm mỗi test. → Kiểm: lint tên test (regex `^(should|when|rejects|returns|…)` hoặc quy ước repo).
- [ ] `QA-UNIT-016` **SHOULD** Không logic điều kiện/vòng lặp trong thân test; dùng bảng ca. → Kiểm: lint `no-conditional-in-test` (eslint-plugin-vitest/jest) hoặc review.
- [ ] `QA-UNIT-017` **SHOULD** Trước refactor vùng chưa có test: viết characterization test ghi hành vi hiện tại (kể cả hành vi "lạ"). → Kiểm: PR `refactor:` không giảm số test; coverage vùng sửa không giảm.
- [ ] `QA-UNIT-018` **SHOULD** Đầu vào bên ngoài được validate ở biên bằng schema và có test cho payload sai kiểu/thiếu trường/thừa trường. → Kiểm: test gửi payload thiếu trường bắt buộc → lỗi validate, không phải 500. · Nguồn: P6
- [ ] `QA-UNIT-019` **SHOULD** Mutation test xác nhận bộ unit test bắt được thay đổi logic (xem [`coverage-and-mutation.md`](coverage-and-mutation.md)). → Kiểm: mutation score vùng logic nghiệp vụ ≥ ngưỡng của module đó.
- [ ] `QA-UNIT-020` **MAY** Snapshot/golden cho output ổn định (CLI, báo cáo), review diff như code.
- [ ] `QA-UNIT-021` **MAY** Fuzz tích hợp runtime (`go test -fuzz`, `cargo fuzz`, libFuzzer) cho parser nhận dữ liệu không tin cậy.

## Bẫy thường gặp

- **`||` làm mất số 0** (`qty || 1` biến 0 thành 1). Cách tránh: `??` + QA-UNIT-002.
- **Test thời gian bằng `Date.now()` thật** → đỏ vào nửa đêm/DST/29-02. Cách tránh: fake clock tiêm vào; QA-UNIT-006.
- **Float cho tiền** `0.1 + 0.2 !== 0.3`; làm tròn ở nhiều nơi khác nhau. Cách tránh: một hàm `Money` dùng chung; schema tiền là chuỗi/integer.
- **Mock quá sâu** → test khẳng định mock gọi mock. Cách tránh: mock chỉ ở biên I/O; logic thuần test thật.
- **Property test không có bất biến thật** (chỉ "không ném lỗi"). Cách tránh: round-trip (`decode(encode(x)) == x`), so với oracle, bất biến nghiệp vụ.
- **Race test "xanh ngẫu nhiên"** vì chạy tuần tự. Cách tránh: ép xen kẽ (barrier/`-race`), lặp ≥ 100 lần ở nightly.
- **Idempotency key chỉ ở client**. Cách tránh: test gọi thẳng service hai lần cùng key.
- **Sửa test cho khớp code sai** khi test đỏ sau refactor. Cách tránh: characterization test trước (QA-UNIT-017); đọc kỳ vọng trước khi đổi.

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Vitest 5.0.4 / Jest 30.5.2 | `vitest run --coverage` · `jest --ci` | pre-commit (file liên quan) + CI | 0 fail |
| pytest 9.1.1 + `pytest-xdist` 3.8.0 + `pytest-socket` | `pytest -q -n auto -p randomly --disable-socket` | CI | 0 fail |
| `go test` (Go 1.27) | `go test ./... -race -shuffle=on -count=1` | CI | 0 fail, 0 race |
| JUnit 6.1.3 | `mvn -q test` / `gradle test` | CI | 0 fail |
| fast-check 4.10.2 / Hypothesis 6.169.0 | trong bộ unit; `numRuns`/`max_examples` ≥ 100 ở CI, ≥ 1000 nightly | CI + nightly | 0 counterexample |
| ESLint rules | `@typescript-eslint/no-floating-promises`, `prefer-nullish-coalescing`, `eslint-plugin-vitest` `no-conditional-in-test` | CI lint | 0 error |
| ruff 0.17.0 | `ruff check --select RUF006,B,ASYNC` | CI lint | 0 error |

## Nguồn

- Phiên bản công cụ (registry, xác minh 2026-10-13): npm `vitest` 5.0.4, `jest` 30.5.2, `fast-check` 4.10.2; PyPI `pytest` 9.1.1, `hypothesis` 6.169.0 (2026-10-11), `pytest-xdist` 3.8.0, `ruff` 0.17.0; Go 1.27 (<https://endoflife.date/api/go.json>); JUnit 6.1.3 (<https://github.com/junit-team/junit-framework/releases>).
- fast-check: <https://fast-check.dev/> · Hypothesis: <https://hypothesis.readthedocs.io/> — tra cứu 2026-10-13 (phiên bản từ registry).
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 6 "Chống lỗi logic" (bảng ca biên: rỗng, null vs 0, off-by-one, tiền, chia 0, UTC/DST, race, idempotency, stale response, all-or-nothing), commit `1b80fe4` — đọc 2026-10-13.
- Catalog `seeker19110/stored` 13 §4b (fast-check trong quality gate stack của REA) — đọc 2026-10-13.
