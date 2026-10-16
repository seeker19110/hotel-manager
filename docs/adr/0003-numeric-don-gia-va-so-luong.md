---
status: accepted
implementation-status: done
date: 2026-10-16
decision-makers: phiên chính tự duyệt theo AGENTS §5 (đảo ngược được: chỉ là cách ghi nhận kiểu cột đã có)
consulted: docs/design/DOMAIN-MODEL.md INV-G3; docs/design/ERD.md; packages/domain/src/money/money.ts
informed: đội phát triển
---

# ADR-0003: Đơn giá và số lượng dùng `numeric` scale cố định; số tiền luôn `bigint` đồng

Bổ sung cho [ADR-0001](0001-modular-monolith-typescript-postgres.md); ghi lý do cho các cột `numeric` mà blueprint (`DB-MODEL-002`, `XC-UNITS-005`, `BASE-DATA-005`) đòi có ADR.

## Bối cảnh và vấn đề
Tiền VND lưu `bigint` đồng kèm `currency char(3)`. Nhưng đơn giá điện/nước/dịch vụ có thể lẻ (ví dụ 3.500,5 đ/kWh) và lượng tiêu thụ là số thập phân (chỉ số công tơ 3 chữ số lẻ). Số nguyên đồng không biểu diễn được đơn giá dưới 1 đồng, còn `float/double` làm sai tiền (0,1 + 0,2).

## Yếu tố quyết định
- Không bao giờ float/double ở bất kỳ tầng nào (CSDL, API, UI tính toán).
- Một hàm làm tròn duy nhất (`packages/domain/src/money`), làm tròn một lần cho mỗi dòng.
- Kết quả tái lập được từ snapshot trên chứng từ.

## Các phương án đã cân nhắc
1. **`numeric(p,s)` scale cố định cho đơn giá/lượng/chỉ số; thành tiền `bigint`.**
2. Lưu đơn giá theo đơn vị nhỏ hơn đồng (ví dụ 1/10.000 đồng) bằng `bigint`.
3. `double precision` cho đơn giá.

## Quyết định
Chọn 1. Danh sách cột `numeric` được phép (mọi cột `numeric` khác cần ADR mới):

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `unit_price` (bảng đơn giá, dòng phiếu, dòng phí, `charges`) | `numeric(18,4)` | Đơn giá, tối đa 4 chữ số lẻ; snapshot trên chứng từ, không đọc lại từ bảng giá |
| `quantity` | `numeric(18,4)` | Lượng |
| chỉ số công tơ (`initial_value`, `value`, `old_final_value`, `new_initial_value`) | `numeric(14,3)` | Chỉ số 3 chữ số lẻ |

Quy tắc đi kèm:
- Thành tiền = `lineAmount(quantity, unitPrice, rule)` làm tròn bằng `BigInt` (không qua số thực) về đồng; mọi cột tiền là `bigint`.
- Ở TypeScript, `numeric` đi qua lại dạng **chuỗi** thập phân; chỉ hiển thị mới đổi sang số (`formatVndUnitPrice`), không bao giờ dùng để tính tiền.
- Định dạng hiển thị qua `Intl` (`formatVnd`, `formatVndNumber`, `formatVndUnitPrice` ở `packages/domain/src/format/intl.ts`); tiền VND hiển thị "1.430.000 đ" theo SPEC.
- Ca kiểm chứng: 10,001 đ/đơn vị × 1 → 10 đ (`HALF_UP_1`); xem `packages/domain/src/money/money.test.ts`.

### Hệ quả
- Tốt: đơn giá lẻ chính xác; tiền luôn nguyên đồng; kiểm máy được.
- Xấu: cần nhớ chuyển chuỗi ↔ số đúng chỗ; thêm cột `numeric` mới phải sửa ADR này.

### Xác nhận
`packages/app/src/units-guards.test.ts` cấm `parseFloat`/`toFixed`/`Math.round`/`float` ở mã tiền, và đối chiếu mọi cột `numeric` trong migration với bảng trên.

## Thông tin thêm
Đảo ngược: đổi sang phương án 2 cần migration đổi kiểu (expand-contract) — chưa có lý do.
