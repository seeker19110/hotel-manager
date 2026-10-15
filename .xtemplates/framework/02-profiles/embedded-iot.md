---
title: Nhúng / IoT / firmware
kind: profile
slug: embedded-iot
prefix: PRF-IOT
modules: [04-standards/*, 05-architecture/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-13
---

# Hồ sơ: Nhúng / IoT / firmware

> Firmware cho MCU/SoC, thiết bị IoT có kết nối, gateway, thiết bị có phần mềm nhúng Linux. Đặc thù: **thiết bị
> nằm ngoài tầm tay sau khi bán, cập nhật khó, lỗi có thể gây hại vật lý**. Cổng chất lượng: **secure boot + ký
> firmware + OTA có rollback, không mật khẩu mặc định, MISRA/CERT C bằng máy, watchdog và trạng thái an toàn, ngân
> sách điện năng/flash, test trên mô phỏng + hardware-in-the-loop, SBOM và quy trình công bố lỗ hổng** (ETSI EN 303 645,
> EU CRA, PSA Certified, IEC 62443-4-1/4-2 cho công nghiệp).

## Khi nào dùng

- Code chạy trên thiết bị (MCU bare-metal/RTOS, Linux nhúng), có hoặc không kết nối mạng.
- Có cloud/backend đi kèm → ghép thêm blueprint `api-service` cho phần server (fleet, OTA server, telemetry).
- Có app điều khiển → ghép `mobile-app`.
- **Không** dùng cho: phần mềm desktop điều khiển thiết bị qua USB (→ `desktop-app`). Hệ **an toàn chức năng**
  (y tế, ô tô, công nghiệp có rủi ro tính mạng) cần thêm chuẩn ngành (IEC 61508/ISO 26262/IEC 62304) **ngoài phạm vi** khung — ghi ADR.

## Kiến trúc tham chiếu

```text
[Thiết bị]
  ROM bootloader ──verify chữ ký──► [Bootloader (MCUboot/U-Boot)] ──verify + anti-rollback──► [App slot A | slot B]
                                        │ health check sau boot → không OK → tự quay về slot cũ
  [RTOS/Linux] · watchdog · trạng thái an toàn khi lỗi/mất mạng · secure element/TrustZone giữ khoá
  [Giao diện ngoài: UART/BLE/Wi-Fi/LoRa] → parser có fuzz · TLS/DTLS mutual auth (cert theo thiết bị)
        │
        ▼ (mạng)
[Cloud/gateway (api-service)]  OTA server (manifest ký) · device identity/revocation · telemetry tối thiểu · fleet kill/quarantine
[Pipeline]  build tái lập → ký (khoá trong HSM/KMS) → SBOM → test host + Renode/QEMU → HIL board thật → release
```

## Stack mặc định khuyến nghị

Phiên bản xác minh **2026-10-13** — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| RTOS (MCU) | Zephyr (Apache-2.0; MCUboot, net stack, west) | **LTS 3.7.0** (2024-07-26, EOL 2029-07-27) cho sản phẩm; 4.4.x (4.4.0 2026-04-14; 4.4.2 2026-08-07) cho dự án mới ngắn vòng đời | FreeRTOS kernel V11.3.1 (2026-08-21) khi chip vendor chỉ hỗ trợ FreeRTOS |
| ESP32 | ESP-IDF | v6.1 (2026-08-27) | PlatformIO 6.2.0 (2026-09-05) làm build/quản lý nhiều board |
| Linux nhúng | Yocto/Buildroot + OTA framework | — | — |
| OTA (Linux) | RAUC (A/B, ký) | v1.15.2 (2026-03-27) | Mender 5.1.0 (2026-05-12; có server fleet); SWUpdate 2026.05.1 (2026-06-22) |
| OTA (MCU) | MCUboot (đi kèm Zephyr) | theo Zephyr LTS | Bootloader vendor có ký + anti-rollback |
| Ngôn ngữ | C (MISRA/CERT) · C++ (subset) | — | Rust (`no_std`) cho parser/giao thức khi toolchain hỗ trợ |
| Static analysis | cppcheck (`--addon=misra`) · clang-tidy (`cert-*`, `bugprone-*`) | cppcheck 2.22.0 (2026-09-19) · LLVM 23.1.3 (2026-10-06) | Công cụ thương mại có chứng nhận MISRA khi cần bằng chứng pháp lý |
| Test host | Unity/Ceedling (C) · GoogleTest (C++) · Zephyr Twister | — | — |
| Mô phỏng | Renode (đa board, chạy CI) | 1.17.0 (2026-09-07) | QEMU |
| HIL | Board thật trên CI runner tự host (pytest + serial/JTAG) | — | LAVA, pytest-embedded |
| Fuzz | libFuzzer/AFL++ trên parser build host | — | — |
| Bảo mật thiết bị | ETSI EN 303 645 V3.1.3 (2024-09) · PSA Certified (Level 1–3) · NIST IR 8259A (05/2020) | — | IEC 62443-4-1:2018 / 4-2:2019 cho công nghiệp |
| Cloud | MQTT/TLS (mutual) → [`api-service.md`](api-service.md) | — | — |

## Checklist

- [ ] `PRF-IOT-001` **MUST** Secure boot: chuỗi tin cậy từ ROM/bootloader; mọi image (bootloader, app) được **ký**; thiết bị từ chối boot image không hợp lệ; khoá ký giữ trong HSM/KMS, không trong repo/CI. → Kiểm: test flash image sửa 1 byte hoặc ký bằng khoá dev → không boot, log lý do; CI ký qua KMS (không có file khoá); gitleaks full history sạch. · Nguồn: ETSI EN 303 645 prov 5.7 (software integrity); PSA Certified Level 1
- [ ] `PRF-IOT-002` **MUST** OTA an toàn: manifest + image ký, số phiên bản **đơn điệu** chống rollback, cập nhật A/B hoặc slot phục hồi, tự quay về bản trước khi boot/health check thất bại, tiếp tục được sau mất điện giữa chừng. → Kiểm: test ngắt điện giữa khi ghi → boot bản cũ; test image phiên bản thấp hơn → từ chối; test image hỏng sau ghi → tự rollback trong N lần boot. · Nguồn: ETSI EN 303 645 prov 5.3 (keep software updated); EU CRA Annex I
- [ ] `PRF-IOT-003` **MUST** Không mật khẩu mặc định/dùng chung; mỗi thiết bị có credential/cert **riêng** cấp lúc sản xuất hoặc lần đầu (provisioning), đổi được, chống brute-force. → Kiểm: script provisioning sinh khoá riêng theo serial; test đăng nhập bằng mật khẩu mặc định của vendor → thất bại; rate limit đăng nhập có test. · Nguồn: ETSI EN 303 645 prov 5.1-1, 5.1-2
- [ ] `PRF-IOT-004` **MUST** Mỗi bản firmware có **SBOM** (CycloneDX/SPDX), theo dõi CVE của thành phần, chính sách và thời hạn hỗ trợ cập nhật công bố cho người dùng. → Kiểm: artifact SBOM đính kèm release; job quét CVE theo SBOM; trang/README nêu thời hạn hỗ trợ (chi tiết chuỗi cung ứng → [`../12-security/supply-chain.md`](../12-security/supply-chain.md)). · Nguồn: EU CRA Reg. (EU) 2024/2847 (nghĩa vụ chính từ 2027-12-11); ETSI 5.3-13
- [ ] `PRF-IOT-005` **MUST** Secret/khoá trên thiết bị nằm trong secure element/TrustZone/PSA ITS hoặc vùng mã hoá; không hard-code khoá trong firmware; debug port (JTAG/SWD/UART shell) tắt hoặc xác thực ở bản production. → Kiểm: `strings firmware.bin` + scanner không lộ khoá/chuỗi API key; build production có flag khoá debug; đo trên board: SWD bị từ chối. · Nguồn: ETSI 5.4 (securely store parameters), 5.6-4 (debug interfaces); PSA Certified
- [ ] `PRF-IOT-006` **MUST** Giao tiếp mạng: TLS 1.2+/DTLS, xác thực chứng chỉ server, **mutual auth** thiết bị↔cloud bằng cert theo thiết bị; thu hồi được từng thiết bị. → Kiểm: test MITM với cert tự ký → kết nối thất bại; test cert thiết bị bị thu hồi → cloud từ chối. · Nguồn: ETSI 5.5 (communicate securely)
- [ ] `PRF-IOT-007` **MUST** Watchdog phần cứng bật, mọi task quan trọng "feed" có điều kiện (không feed trong ngắt vô điều kiện); brown-out detect; lỗi không phục hồi → **trạng thái an toàn** (đầu ra về mức an toàn) rồi reset, lý do reset được ghi. → Kiểm: test treo một task → reset trong ≤ timeout, reset reason = watchdog trong log; test cắt điện dần → không ghi flash hỏng.
- [ ] `PRF-IOT-008` **MUST** Thiết bị mất kết nối cloud vẫn **an toàn và dùng được cơ bản**: chức năng an toàn không phụ thuộc cloud; hết hạn token không làm thiết bị "chết"; operator quan sát và dừng được khi có điều khiển từ xa/AI. → Kiểm: test cắt mạng 24 giờ → chức năng cục bộ hoạt động, không reboot loop; nút/lệnh dừng cục bộ ưu tiên hơn lệnh từ xa (test). · Nguồn: Anthropic Usage Policy 2026 (phần cứng vật lý — hiệu lực 2026-11-12) khi có AI điều khiển
- [ ] `PRF-IOT-009` **MUST** Code C/C++ theo MISRA C:2023/2025 hoặc SEI CERT C qua công cụ: 0 vi phạm Mandatory/Required (MISRA) hoặc rule L1 (CERT) chưa xử lý; mỗi deviation có hồ sơ lý do. → Kiểm: CI `cppcheck --addon=misra --error-exitcode=1` hoặc `clang-tidy -checks=cert-*` exit 0; file `deviations.md` có ID rule + lý do + người duyệt. · Nguồn: MISRA C:2025 (misra.org.uk); SEI CERT C (2016 Edition)
- [ ] `PRF-IOT-010` **MUST** Build nghiêm: `-Wall -Wextra -Werror` (hoặc tương đương), phân tích stack (`-fstack-usage`) có ngân sách từng task, không cấp phát động sau khởi tạo (hoặc có giới hạn và test), kích thước flash/RAM có ngân sách. → Kiểm: build fail khi warning; báo cáo stack usage ≤ ngân sách; `size` của image ≤ ngân sách ghi trong CI; lint cấm `malloc` ngoài init.
- [ ] `PRF-IOT-011` **MUST** Kim tự tháp test: unit trên host (logic tách HAL) + mô phỏng (Renode/QEMU) trong CI mỗi PR + **HIL trên board thật** nightly cho luồng quan trọng (boot, OTA, giao tiếp, nguồn). → Kiểm: 3 job CI `unit`, `sim`, `hil` có artifact log; HIL chạy trên runner có board, kết quả theo commit (chi tiến lược → [`../14-testing-quality/test-strategy.md`](../14-testing-quality/test-strategy.md)).
- [ ] `PRF-IOT-012` **MUST** Điện năng: ngân sách dòng điện theo chế độ (sleep/idle/active/radio) và thời lượng pin ghi trong `PROJECT.md`; đo mỗi release trên board. → Kiểm: báo cáo đo (power profiler) đính kèm release, lệch > ngưỡng → fail.
- [ ] `PRF-IOT-013` **MUST** Validate mọi đầu vào từ giao diện ngoài (UART, BLE, mạng, cảm biến, file cấu hình): kiểm độ dài/biên; parser được **fuzz**; không `sprintf`/`strcpy` không giới hạn. → Kiểm: job libFuzzer/AFL++ cho mỗi parser chạy ≥ thời gian ADR không crash; cppcheck/CERT STR/ARR rules sạch. · Nguồn: ETSI 5.13 (validate input data); CERT C STR, ARR
- [ ] `PRF-IOT-014` **MUST** Chính sách công bố lỗ hổng công khai (liên hệ, thời hạn phản hồi) và quy trình xử lý; cập nhật bảo mật kịp thời. → Kiểm: `SECURITY.md`/trang web có liên hệ + SLA; log xử lý báo cáo. · Nguồn: ETSI 5.2 (vulnerability disclosure); EU CRA (báo cáo lỗ hổng khai thác từ 2026-09-11)
- [ ] `PRF-IOT-015` **MUST** Dữ liệu cá nhân: thu tối thiểu, có consent, người dùng xoá được; **factory reset xoá sạch** dữ liệu cá nhân và credential; telemetry tắt được. → Kiểm: test factory reset → vùng lưu trữ người dùng về mặc định (đọc flash); danh sách dữ liệu thu thập trong tài liệu; checklist [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md). · Nguồn: ETSI 5.8, 5.11, 5.12
- [ ] `PRF-IOT-016` **MUST@M** Fleet: mỗi thiết bị có identity duy nhất + cert; cloud thu hồi/cách ly (quarantine) được thiết bị; OTA theo nhóm/canary với tỷ lệ lỗi dừng tự động. → Kiểm: diễn tập OTA canary 1 % → lỗi giả → rollout dừng; test thu hồi cert một thiết bị.
- [ ] `PRF-IOT-017` **MUST@M** Log/diagnostics trên thiết bị có giới hạn tốc độ và bộ đệm offline, thời gian đồng bộ (NTP/RTC), không ghi PII thô; lý do reset và phiên bản firmware gửi về cloud. → Kiểm: test mất mạng → log đệm rồi gửi khi có mạng; trường `fw_version`, `reset_reason` trong telemetry.
- [ ] `PRF-IOT-018` **SHOULD** Build tái lập bit-for-bit (cùng commit → cùng hash image) với toolchain ghim trong container. → Kiểm: hai lần build trên hai máy → cùng SHA-256.
- [ ] `PRF-IOT-019` **SHOULD** Cách ly bộ nhớ (MPU/TrustZone) giữa tác vụ tin cậy và parser/giao thức; dùng Rust `no_std` cho parser khi khả thi. → Kiểm: cấu hình MPU bật; test ghi ngoài vùng → fault được xử lý.
- [ ] `PRF-IOT-020` **MAY** Metadata cập nhật theo TUF/Uptane; chứng nhận PSA Certified Level 2–3 hoặc IEC 62443-4-2 khi khách hàng yêu cầu; Matter cho thiết bị nhà thông minh. → Kiểm: ADR ghi lựa chọn.
- [ ] `PRF-IOT-021` **MUST@L** Thiết bị công nghiệp (IACS): quy trình phát triển theo IEC 62443-4-1 (8 practice: quản lý bảo mật, yêu cầu, thiết kế, hiện thực, V&V, quản lý lỗi, cập nhật, hướng dẫn) và yêu cầu kỹ thuật thành phần IEC 62443-4-2; bằng chứng từng practice. → Kiểm: ma trận practice → artifact (threat model, test V&V, quy trình vá) được review độc lập. · Nguồn: IEC 62443-4-1:2018, IEC 62443-4-2:2019 (chưa xác minh trên webstore IEC — qua nguồn thứ cấp)

## Cổng chất lượng tương đương

| Cổng chung (web) | Tương đương nhúng/IoT | Công cụ |
|---|---|---|
| Core Web Vitals | Thời gian boot, độ trễ phản hồi lệnh, điện năng theo chế độ, kích thước flash/RAM | Đo trên board, power profiler, `size` |
| E2E trình duyệt | HIL trên board thật + mô phỏng Renode trong CI | pytest + serial/JTAG, Renode |
| Type check | MISRA/CERT static analysis + `-Werror` + stack analysis | cppcheck, clang-tidy |
| Security scan | SBOM + CVE scan + fuzz parser + kiểm image (strings, debug port) | CycloneDX, OSV, libFuzzer |
| Rollback deploy | OTA A/B + anti-rollback + canary fleet | Test ngắt điện, diễn tập canary |
| A11y | Tài liệu người dùng + chỉ báo trạng thái thiết bị (LED/âm) rõ ràng, factory reset dễ | Checklist sản phẩm |

## Bẫy

1. **Khoá ký firmware trong repo/CI để "tiện"** — lộ khoá là mất toàn bộ chuỗi tin cậy, không thu hồi được trên thiết bị đã bán (001).
2. **OTA không anti-rollback** — kẻ tấn công cài lại bản cũ có lỗ hổng đã biết (002).
3. **Mật khẩu mặc định `admin/admin`** — botnet hàng loạt; cấm theo ETSI 5.1-1 (003).
4. **Feed watchdog trong ISR timer** — watchdog vô dụng, task chết vẫn "sống" (007).
5. **Thiết bị "chết" khi cloud down hoặc token hết hạn** — mất chức năng cơ bản; thiết kế offline-first (008).
6. **Chỉ test trên board dev, không HIL/sim trong CI** — lỗi timing/nguồn chỉ lộ ở hiện trường (011).
7. **`sprintf` vào buffer cố định từ dữ liệu BLE** — overflow kinh điển; fuzz parser (013).
8. **Debug UART shell còn mở ở bản bán ra** — root trong 1 phút (005).
9. **Telemetry gửi serial + vị trí mặc định** — vi phạm quyền riêng tư; tối thiểu + consent (015).
10. **Bỏ qua CRA vì "chỉ bán ở VN"** — bán qua EU marketplace vẫn chịu CRA từ 2027-12-11; SBOM và disclosure chuẩn bị từ đầu (004, 014).

## Nguồn

- ETSI EN 303 645 V3.1.3 (2024-09) Cyber Security for Consumer IoT: <https://www.etsi.org/deliver/etsi_en/303600_303699/303645/> — xác minh 2026-10-13 (danh sách phiên bản; số provision theo cấu trúc chuẩn)
- EU Cyber Resilience Act, Regulation (EU) 2024/2847 (hiệu lực 2024-12-10; báo cáo từ 2026-09-11; nghĩa vụ chính 2027-12-11): <https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act> — xác minh 2026-10-13
- PSA Certified (GlobalPlatform; Level 1–3 badge): <https://www.psacertified.org/> — xác minh 2026-10-13
- NIST IR 8259A IoT Device Cybersecurity Capability Core Baseline (05/2020): <https://csrc.nist.gov/pubs/ir/8259/a/final> — xác minh 2026-10-13
- MISRA C:2023 / C:2025 (danh mục ấn phẩm): <https://misra.org.uk/publications/> — xác minh 2026-10-13 (ngày phát hành bản gốc không hiện trên trang)
- SEI CERT C Coding Standard (2016 Edition): <https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/> — xác minh 2026-10-13
- IEC 62443-4-1:2018, IEC 62443-4-2:2019 — (chưa xác minh trên webstore IEC; ngày/ấn bản theo evs.ee và nguồn thứ cấp, 2026-10-13)
- Zephyr releases (LTS 3.7.0, 4.4.0): <https://docs.zephyrproject.org/latest/releases/index.html>; <https://github.com/zephyrproject-rtos/zephyr/releases/latest> v4.4.2 — xác minh 2026-10-13
- Phiên bản khác: <https://github.com/espressif/esp-idf/releases/latest> v6.1; <https://pypi.org/project/platformio/> 6.2.0; <https://github.com/FreeRTOS/FreeRTOS-Kernel/releases/latest> V11.3.1; <https://github.com/rauc/rauc/releases/latest> v1.15.2; <https://github.com/mendersoftware/mender/releases/latest> 5.1.0; <https://github.com/sbabic/swupdate/releases/latest> 2026.05.1; <https://github.com/renode/renode/releases/latest> 1.17.0; <https://github.com/danmar/cppcheck/releases/latest> 2.22.0; <https://github.com/llvm/llvm-project/releases/latest> 23.1.3 — xác minh 2026-10-13 (GitHub không hiện năm; suy ra 2026 vì là bản "latest")
- TUF (CNCF graduated): <https://theupdateframework.io/> — xác minh 2026-10-13
- Anthropic Usage Policy 2026 (phần cứng vật lý): `research/2026-10-13-ai-agent-research.md` §1.4 — xác minh 2026-10-13
- `research/2026-10-13-stored-catalog-extraction.md` §6 (catalog không bao phủ embedded/IoT — hồ sơ này viết mới từ chuẩn).
