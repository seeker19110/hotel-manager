# Đóng góp cho Hotel Manager

Repository này là mã **độc quyền** (xem `LICENSE`). Đóng góp chỉ nhận từ người được chủ sở hữu mời; khi gửi đóng góp, bạn đồng ý
chuyển giao/cấp quyền cho chủ sở hữu sử dụng phần đóng góp theo cùng điều khoản.

## Quy trình

1. Đọc `AGENTS.md` (luật vận hành, áp dụng cho cả người và AI agent) và `PROJECT.md`.
2. Tạo nhánh `<type>/<mô-tả>` từ `main`; mỗi lát thay đổi một PR nhỏ, đảo ngược được.
3. Dựng môi trường: `scripts/dev-env-setup.sh` rồi `pnpm dev:up` (Postgres 17 + SeaweedFS tự host, không cần Docker — ADR-0002).
4. Commit qua `scripts/commit-gated.sh "<type>(<scope>): <mô tả>"` — chạy cổng chất lượng trước khi commit; thông điệp theo
   Conventional Commits (kiểm bởi `commit-lint`).
5. Trước khi mở PR: `.xtemplates/scripts/dev-task.sh gate` (= CI). Điền đủ mục của `.github/pull_request_template.md`
   (bằng chứng cổng, rủi ro, cách quay lại); nâng major dùng `.github/PULL_REQUEST_TEMPLATE/major-upgrade.md`.
6. PR cần CI xanh (28 required check) và review; PR chạm tiền/lưu trú/auth/dữ liệu cá nhân do người merge.

## Quy ước

- Thuật ngữ và tên bảng theo `docs/design/DOMAIN-MODEL.md`; tiền là số nguyên VND; thời gian lưu UTC.
- Chuỗi người dùng thấy đi qua tệp tài nguyên (`messages/vi.json`, XC-I18N-001).
- Bất biến tiền/tồn có test trên Postgres thật; không thay constraint CSDL bằng kiểm tra ở app.
- Không bí mật, dữ liệu người dùng thật hay tên model AI trong mã, log, commit.

## Báo lỗi và bảo mật

- Lỗi thường: mở issue theo mẫu trong `.github/ISSUE_TEMPLATE/`.
- Lỗ hổng bảo mật: **không** mở issue — làm theo `SECURITY.md`.

Mọi người tham gia tuân theo `CODE_OF_CONDUCT.md`.
