# Chính sách xử lý lỗ hổng phụ thuộc và image (SLA)

> OPS-MAINT-004, BASE-DEP-009, SEC-SUPPLY-006. Cơ chế quét: `.github/workflows/supply-chain.yml` (SBOM npm + 4 image, grype),
> `.github/workflows/dep-audit.yml` (`pnpm audit --prod`), `.github/workflows/eol-check.yml` (hết hạn hỗ trợ). Mọi workflow
> chạy mỗi PR/push `main` **và hằng tuần** (thứ Hai, quét lại với cơ sở dữ liệu lỗ hổng mới).

## SLA theo mức

Tính từ lúc lỗ hổng xuất hiện trên một lượt quét (CI đỏ hoặc báo cáo tuần), **chỉ với lỗ hổng đã có bản sửa** (`only-fixed`):

| Mức | CI | Thời hạn xử lý (nâng bản, thay gói, hoặc ngoại lệ có hạn) |
|---|---|---|
| Critical | đỏ, chặn merge | 7 ngày |
| High | đỏ, chặn merge | 14 ngày |
| Medium | `pnpm audit` đỏ từ mức moderate cho phụ thuộc production; image: báo cáo, không chặn | 60 ngày |
| Low | báo cáo | 180 ngày hoặc đợt nâng phụ thuộc kế tiếp |

- CI đỏ vì critical/high chặn merge ngay: nhánh tính năng không được vào `main` khi còn lỗ hổng high/critical có bản sửa. SLA 7/14 ngày áp cho
  lỗ hổng mới công bố ở **lượt quét tuần** trên `main` (không có PR nào để chặn): người trực mở PR nâng bản trong hạn.
- Lỗ hổng **chưa có bản sửa**: không chặn build; ghi vào mục "Theo dõi" dưới đây, kiểm lại mỗi tuần; có bản sửa thì SLA bắt đầu tính.
- **Ngoại lệ** (chưa nâng được): ghi `docs/autopilot/DECISIONS.md` (D-NNN) với lý do, biện pháp giảm nhẹ, ngày hết hạn ≤ 30 ngày; hết hạn thì xử lý lại.
  Với image dùng tệp bỏ qua của grype thì phải ghi cùng D-NNN ở comment dòng đó (không có ngoại lệ ngầm).
- Nâng bản do lỗ hổng không chờ nhịp Dependabot hằng tuần (cập nhật bảo mật của Dependabot không chịu `cooldown`).

## Review tháng

Đầu mỗi tháng người duyệt: (1) mở lượt chạy `Supply chain` mới nhất trên `main` và `Dependency audit`, tải artifact `sbom-*` (báo cáo `*.grype.json`);
(2) đếm số lỗ hổng đã có bản sửa **quá SLA**; (3) ghi một dòng vào bảng dưới. Mục tiêu: quá SLA = 0; khác 0 thì mở việc ngay và nêu trong báo cáo tháng.

| Tháng | Nguồn | Critical | High | Medium | Quá SLA | Ghi chú |
|---|---|---|---|---|---|---|
| 2026-10 | `pnpm audit` (cục bộ, 2026-10-18, mọi gói kể cả dev) | 0 | 0 | 0 | 0 | "No known vulnerabilities found". Quét image/SBOM bằng grype chạy lần đầu trên CI của PR T-802 — kết quả ghi bổ sung khi PR xanh |

## Theo dõi (lỗ hổng chưa có bản sửa)

_Không có._
