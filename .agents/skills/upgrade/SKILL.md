---
name: upgrade
description: Nâng nền phần mềm lên bản ỔN ĐỊNH mới nhất có bằng chứng — kiểm kê runtime, gói, action CI, base image; tra bản stable từ nguồn sống (không alpha/beta/rc); nâng theo nhóm nhỏ, đọc changelog/hướng dẫn migration cho major, sửa breaking change, Gate xanh, ghi đường lùi. Dùng khi có PR Dependabot/Renovate, runtime sắp hết hỗ trợ, quét lỗ hổng báo bản vá, định kỳ bảo trì, khi người dùng nói "nâng cấp", "update dependencies", "lên bản mới nhất", hoặc gõ /upgrade.
argument-hint: "[all | <gói/runtime/action> | PR <N>]"
---

# /upgrade — bản ổn định mới nhất, từng nhóm nhỏ, có đường lùi

`<FW>` = `.xtemplates/framework` ở dự án đích, `framework` ở repo khung. Luật: `<FW>/01-baseline/dependencies.md` (`BASE-DEP-003`
runtime còn hỗ trợ, `007` cập nhật tự động, `008` ghim SHA/digest, `011` kiểm toàn vẹn, `012` major, `016` cooldown, `019` chỉ bản ổn định +
toolchain, `020` major tự làm khi L3), `<FW>/12-security/supply-chain.md`. Phiên bản lấy từ **nguồn sống**, ghi ngày (`/research`).

## 1. Kiểm kê
1. Liệt kê: runtime (`.python-version`, `.nvmrc`/`engines`, `go`, `rust-toolchain`), gói (manifest + lockfile), action CI (`uses:`),
   base image (`FROM`), công cụ ghim (requirements có hash, pre-commit). Ghi bản hiện tại.
2. Tra bản **ổn định mới nhất** từ registry/trang phát hành chính thức (PyPI, npm, endoflife.date, GitHub Releases không đánh dấu
   pre-release). Loại alpha/beta/rc/canary/nightly/`-dev`. Ghi ngày phát hành; bản ra < `cooldown` ngày (mặc định 3) thì chờ.
3. Ghi bảng: thành phần · hiện tại · ổn định mới nhất · loại (patch/minor/major) · nguồn + ngày.

## 2. Nâng theo nhóm nhỏ (mỗi nhóm một PR)
4. Thứ tự: bản vá bảo mật → patch/minor gom theo hệ sinh thái → từng major một PR riêng → runtime sau cùng.
5. Đổi bản bằng công cụ của hệ sinh thái (`npm install x@ver`, `uv lock --upgrade-package`, `pip-compile --generate-hashes`…),
   **cập nhật lockfile và hash**; action/image ghim lại theo SHA/digest của bản mới (`BASE-DEP-008`), comment ghi tag.
6. **Major:** đọc changelog/hướng dẫn migration của upstream từ bản hiện tại tới bản đích; liệt kê breaking change chạm repo
   (`grep` API bị bỏ/đổi); sửa code; thêm test cho hành vi đổi. Link changelog vào PR.
7. Chạy cổng đầy đủ (`/gate`): build · typecheck · lint · test (+ e2e khi chạm UI). Đỏ do breaking change → sửa; đỏ không giải thích được
   → `/debug`; không hạ ngưỡng, không ghim ngược lặng lẽ.

## 3. Quyết và merge
8. `xt.py loop decide` ghi D-NNN cho mỗi major: rủi ro · cách kiểm · **đường lùi** (revert PR; với runtime: giữ bản cũ trong CI một vòng).
9. Merge theo làn (`xt.py pr next`). Tự chủ (`BASE-DEP-020`): khi `merge_autonomy: L3` + `merge_hard_exceptions: auto`, autopilot làm
   trọn PR major có reviewer năng lực cao hơn duyệt ở head; runtime, engine CSDL, thư viện auth/mật mã vẫn theo `BASE-DEP-012`.
10. Bản cần mà chỉ có pre-release: không dùng, trừ khi ADR nêu lý do và ngày bỏ (`BASE-DEP-019`).

## Báo cáo
Bảng kiểm kê · nhóm đã nâng (PR) · breaking change đã xử lý · lệnh cổng + exit code · thành phần giữ lại và lý do · lần rà kế tiếp.
