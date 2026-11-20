---
title: Diễn tập bàn giao và theo dõi bản phát hành
kind: template
updated: 2026-11-19
---

# Từ bản dev được xác nhận đến bàn giao vận hành

Trong dự án sản phẩm, `XT=.xtemplates/scripts/xt.py`. Trong repo X-Templates, dùng `XT=scripts/xt.py`. Các lệnh dưới đây dùng Python đúng phiên bản repo. Chạy chúng trong checkout của sản phẩm.

## Diễn tập trên bản dev

Giữ bản dev đang chạy. Với dự án mới cài gói `web-api-ts`, dùng các lệnh sau. Dự án đã có ứng dụng dùng quy trình build và triển khai dev hiện có của dự án. Dự án cần có `release_artifacts`, biên nhận schema 1 trong `docs/ops/DEPLOYS.json`, và `url_dev` trùng URL trong biên nhận. Điểm kiểm dev dùng HTTP trên IP loopback và trả `{"status":"ok","digest":"<64 hex>"}` tại `/healthz`.

```sh
XT=.xtemplates/scripts/xt.py
pnpm build
python3 "$XT" deploy run --env dev
python3 "$XT" rollout-drill --env prod --json
```

`dev_verified: true` xác nhận nội dung cây, digest của các artifact đã đọc trên đĩa, receipt và digest ứng dụng đang phục vụ cùng khớp. `handoff: pending` cho biết dự án còn việc cần làm trước khi gửi ứng viên cho pipeline đích. Một lần diễn tập thành công có thể có đồng thời cả hai kết quả này. Công cụ kiểm đúng URL trong cấu hình, bỏ qua proxy, không gửi thông tin xác thực và không đi theo redirect.

## Thiết lập của chủ dự án

```sh
python3 "$XT" admin-plan --out docs/ops/SETUP-ONCE.md
python3 "$XT" admin-plan --json
```

Bảng nêu việc cần làm, lý do và cách kiểm. Lệnh chỉ xuất nội dung script khi thêm `--script`. Chủ repo tự kiểm và thực hiện từng thao tác bằng quyền của mình. Khi sửa repo, commit checklist trước lúc build và nghiệm thu ứng viên cuối cùng. Máy kiểm REST của GitHub.com bằng GET qua `gh`. Mất quyền đọc hoặc remote khác GitHub.com được báo trong kết quả. `worker-launcher` nhận workflow `.github/workflows/worker.yml`; lịch chạy ở dịch vụ ngoài cần người xác nhận. Các đề nghị mở rộng quyền cần được hỗ trợ bởi phiên bản khung đang chạy.

Chủ dự án cấp đích triển khai trong tài khoản hạ tầng, quyền của pipeline và secret tại đúng nơi chạy. Trên nhánh mặc định, khai các lệnh riêng cho môi trường (`deploy_prod`, `smoke_prod`, `digest_prod`, `rollback_prod`), thêm `prod` vào `deploy_envs`, và khai tên secret repo GitHub mà pipeline cần trong `deploy_secrets`. Người có thẩm quyền duyệt dòng `- grant: deploy | env=prod` trong `docs/autopilot/PLAN.md`. Chủ dự án chịu trách nhiệm cấu hình TLS, database, backup, đích quan sát, chính sách lưu artifact và luồng kiểm rollback phù hợp.

## Chuyển đúng ứng viên cho pipeline của dự án

Chạy trong checkout sạch, trên commit đã có mặt trong lịch sử nhánh mặc định. Ghi các file đầu ra của job vào thư mục tạm ngoài checkout. Luồng thực tế dùng báo cáo từ job release và artifact từ kho bất biến của dự án.

```sh
evidence_dir=$(mktemp -d)
python3 "$XT" release-check --json > "$evidence_dir/release.json"
python3 "$XT" rollout-drill --env prod --release "$evidence_dir/release.json" \
  --require-ready --json > "$evidence_dir/handoff.json"
```

`--require-ready` trả 1 nếu thiếu một điều kiện. Kiểm gồm lệnh đích, tên secret, grant và HEAD trên nhánh mặc định, checkout sạch, báo cáo GO cùng ứng viên và xác nhận GO-NO-GO đã ký đúng subject trên nhánh được bảo vệ. `ready_for_pipeline_review` đưa ứng viên đến bước kiểm của pipeline sở hữu đích. `deployed_to_target` luôn là `false` trong diễn tập. JSON có thể dùng làm đầu vào đối chiếu `subject.digest`; đây là báo cáo cục bộ, chưa chứng thực nguồn CI.

Pipeline được chủ dự án ủy quyền xác minh lại quyền, chữ ký, commit và digest ngay trước khi thay đổi môi trường. Nó lấy đúng artifact đã nghiệm thu, triển khai, smoke nghiệp vụ rồi đọc danh tính của ứng dụng từ đích bằng một phép kiểm riêng. Nếu phải quay lui, pipeline khôi phục artifact đã giữ và kiểm lại digest được phục vụ. Lưu receipt cùng URL lần chạy trong sổ của dự án theo ADR-0077. Nếu pipeline chưa xuất được receipt tương ứng, chưa thể đánh giá cửa sổ production bằng `ops-check`. Khung hiện cung cấp adapter cho dev của gói web; việc cấp quyền và kích hoạt pipeline production do dự án sở hữu.

## Phản hồi vận hành

Hệ đo của môi trường xuất một object JSON, gồm nhãn `source` tối đa 64 ký tự (chữ, số, gạch ngang, gạch dưới hoặc dấu chấm). Các mốc thời gian dùng UTC có múi giờ. Ví dụ dưới đây minh họa định dạng. Thay digest, số liệu và thời gian bằng dữ liệu thực của hệ đo.

```json
{
  "source": "prometheus",
  "env": "prod",
  "digest": "<digest 64 ký tự của môi trường>",
  "started": "2026-11-19T10:00:00Z",
  "finished": "2026-11-19T10:15:00Z",
  "exported_at": "2026-11-19T10:16:00Z",
  "requests": 1200,
  "errors": 2,
  "p95_ms": 84
}
```

```sh
python3 "$XT" ops-check --env prod --field "$evidence_dir/field.json" \
  --max-error-pct 1 --max-p95-ms 150 --max-age-hours 24 --json
```

Chọn hai ngưỡng từ SLO đã duyệt của sản phẩm. Công cụ khớp môi trường và digest với receipt, kiểm cửa sổ đo sau lần xác nhận triển khai hoặc quay lui gần nhất và tuổi tối đa nếu có yêu cầu. Exit 0 tương ứng với `pass`; exit 1 với `regression` hoặc `invalid_evidence`. Job vận hành có thể dùng `breaches`, digest và cửa sổ UTC để mở một sự cố, thêm ca hồi quy tái hiện được, rồi chạy lại trên bản sửa. Lệnh chỉ đánh giá số đã xuất. Nguồn và tính toàn vẹn của tệp do pipeline đo lường bảo đảm. Chỉ các trường số liệu tổng hợp hợp lệ được đưa vào kết quả.
