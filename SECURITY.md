# Chính sách bảo mật — Hotel Manager

## Phiên bản được hỗ trợ

| Phiên bản | Nhận bản vá bảo mật |
|---|---|
| Bản phát hành mới nhất (`0.2.x`) và nhánh `main` | Có |
| Các bản cũ hơn | Không — nâng lên bản mới nhất |

## Báo lỗ hổng (riêng tư)

**Không** báo lỗ hổng qua issue, PR hay thảo luận công khai.

Báo riêng tư qua **GitHub Private Vulnerability Reporting**:
<https://github.com/seeker19110/hotel-manager/security/advisories/new>

Nên kèm: mô tả, phiên bản/commit, bước tái hiện tối thiểu, ảnh hưởng ước tính, và cách bạn muốn được ghi công.
Không đưa dữ liệu cá nhân thật của người dùng vào báo cáo; nếu buộc phải chứng minh truy cập dữ liệu, chỉ nêu loại dữ liệu.

## Cam kết phản hồi

| Mốc | Thời hạn |
|---|---|
| Xác nhận đã nhận báo cáo | ≤ 7 ngày |
| Đánh giá ban đầu (mức độ, có tái hiện được không) | ≤ 14 ngày |
| Bản vá lỗ hổng Critical/High đã xác nhận | theo `docs/ops/VULN-SLA.md` (Critical 7 ngày, High 14 ngày) |

## Công bố phối hợp

Chúng tôi công bố advisory sau khi có bản vá, hoặc chậm nhất **90 ngày** kể từ khi nhận báo cáo (sớm hơn nếu lỗ hổng đã bị khai
thác công khai), có thoả thuận ngày với người báo. Người báo được ghi công trong advisory nếu muốn.

## Phạm vi

Trong phạm vi: mã trong repository này và bản triển khai của nó. Ngoài phạm vi: tấn công từ chối dịch vụ khối lượng lớn, social
engineering, lỗ hổng của dịch vụ bên thứ ba (báo cho bên đó), báo cáo chỉ từ máy quét tự động chưa xác minh.

Vi phạm dữ liệu cá nhân được xử lý theo `docs/ops/runbooks/data-breach.md` (thông báo cơ quan và chủ thể trong thời hạn luật định).

---

**English (summary):** report vulnerabilities privately via GitHub Private Vulnerability Reporting (link above) — never in public
issues. We acknowledge within 7 days, assess within 14 days, and coordinate disclosure within 90 days. Supported: latest release and
`main`.
