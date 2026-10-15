---
title: Ứng dụng di động (iOS/Android, native & cross-platform)
kind: profile
slug: mobile-app
prefix: PRF-MOB
modules: [04-standards/*, 05-architecture/*, 06-design-ux/*, 07-frontend/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Ứng dụng di động (iOS/Android, native & cross-platform)

> App cài qua App Store/Google Play. Khác web ở chỗ **không kiểm soát được thời điểm người dùng cập nhật**,
> phải qua **cửa hàng** (chính sách, ký, kích thước, quyền) và phải chạy tốt **offline**. Cổng chất lượng
> thay CWV bằng thời gian khởi động, crash/ANR rate, kích thước tải và a11y theo guideline nền tảng.

## Khi nào dùng

- Cần API thiết bị mà web không có hoặc không ổn định: push notification, camera/sensor nền, offline dài, biometrics, Bluetooth, widget, background sync.
- Người dùng mong đợi "app" trên màn hình chính; kênh phân phối là store.
- Không dùng khi web responsive (+ PWA) đã đủ → [`web-app.md`](web-app.md). Backend của app → ghép thêm blueprint [`api-service.md`](api-service.md). Web + mobile + API chung repo → [`monorepo.md`](monorepo.md).

## Kiến trúc tham chiếu (C4 mức 1)

```text
[App iOS/Android]
  UI (native/RN/Flutter) → State/Domain → Data layer
     Data layer = API client (retry, idempotency key) + Local DB (SQLite) + Secure storage (Keychain/Keystore)
        |                              |                       |
   [Backend API]              [Push: APNs / FCM]      [OTA update server: chỉ JS/asset, có ký]
        |
   [Crash & perf: Sentry/Crashlytics + Android vitals + MetricKit]
Phân phối: CI (EAS/Fastlane) → TestFlight / Play internal → staged rollout → production
```

- Ranh giới tin cậy: thiết bị **không tin cậy** (root/jailbreak, proxy); mọi quyết định nghiệp vụ và phân quyền ở server; app chỉ giữ token ngắn hạn.
- Offline-first khi nghiệp vụ cần: đọc từ cache, ghi vào hàng đợi với idempotency key, đồng bộ khi có mạng (xem [`../08-backend/reliability-and-errors.md`](../08-backend/reliability-and-errors.md)).

## Stack mặc định khuyến nghị

Xác minh ngày **2026-10-13** — **xác minh lại trước khi dùng**; mốc chính sách store đổi theo năm.

| Thành phần | Mặc định | Phiên bản / mốc (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Khung đa nền tảng | React Native + Expo (TS `strict`) | `react-native` 0.87.1; `expo` SDK 57.0.28; `expo-updates` 57.0.26 | Flutter 3.47 (docs chính thức, không ghi ngày) khi UI tùy biến/đồ họa nặng; Kotlin Multiplatform (Kotlin 2.4.21) khi chia logic nhưng giữ UI native; native thuần (Swift 6.4.1 / Kotlin) khi tích hợp nền tảng sâu hoặc đội có sẵn |
| Ngôn ngữ | TypeScript | 7.0.2 | Dart/Swift/Kotlin theo khung |
| Toolchain iOS | Xcode + Swift | Xcode 27.x (27.1 RC 2026-10-05); Apple yêu cầu build bằng **Xcode 26+/SDK 26** từ 2026-04-28; deployment target ≥ iOS 13 từ 2026-09-09; iOS mới nhất 27.0.1 | — |
| Toolchain Android | AGP + Gradle + Kotlin | AGP 9.4.0 (09/2026) + Gradle 9.6.0; Play yêu cầu **targetSdk ≥ 36** (Android 16) từ 2026-08-31 (gia hạn tới 2026-11-01); hỗ trợ **16 KB page** bắt buộc từ 2027-02-01 | — |
| State/data | TanStack Query + storage bảo mật | 5.104.2; `expo-secure-store`/Keychain/Keystore (chưa xác minh phiên bản) | Zustand/Redux khi state client phức tạp (chưa xác minh phiên bản) |
| Local DB | SQLite (`expo-sqlite`, Room, GRDB) | chưa xác minh phiên bản | WatermelonDB/Realm khi đồng bộ offline lớn (chưa xác minh) |
| Unit test | Jest (RN mặc định) | 30.5.2 | Vitest 5.0.4 cho logic thuần không phụ thuộc RN |
| E2E thiết bị | Maestro (YAML, đa khung) | CLI 2.11.0 (GitHub release 29/09, năm không hiển thị) | Detox 20.51.4 (gray-box RN); XCUITest/Espresso cho native |
| Build/ký/phát hành | EAS Build + Submit (Expo) hoặc Fastlane | Fastlane 2.241.0 (`match`, `gym`, `pilot`, `supply`); CLI `@react-native-community/cli` 20.2.0 | Codemagic/Bitrise (chưa xác minh) |
| OTA | EAS Update + code signing | expo-updates 57.0.26; code signing chỉ ở gói EAS Production/Enterprise | Tự host `expo-updates` server; Shorebird cho Flutter (chưa xác minh) |
| Crash/perf | Sentry React Native | 8.30.0 | Firebase Crashlytics (chưa xác minh phiên bản); luôn kèm Android vitals + Xcode Organizer/MetricKit |
| Push | APNs + FCM | — | Expo Notifications bọc cả hai (chưa xác minh phiên bản) |
| Web view/hybrid | Capacitor | `@capacitor/core` 8.5.3 | Chỉ khi web app có sẵn và cần phát hành store nhanh; vẫn phải qua PRF-MOB-001…006 |
| Runtime CI | Node 24 LTS | 24.21.0 | xem [`web-app.md`](web-app.md) |

## Checklist

- [ ] `PRF-MOB-001` **MUST** Ký release bằng khóa phát hành riêng: Android dùng **Play App Signing** + upload key (keystore và `key.properties` ngoài git); iOS dùng Developer ID/App Store cert + provisioning profile quản lý bằng `fastlane match` hoặc EAS credentials. → Kiểm: `git ls-files | grep -Ei '\.(jks|keystore|p12|mobileprovision)$|key\.properties'` rỗng; gitleaks quét full history; `apksigner verify --print-certs` trên AAB/APK release khớp cert đăng ký. · Nguồn: Android app-signing; Flutter deployment/android
- [ ] `PRF-MOB-002` **MUST** Android `targetSdk ≥ 36` (hạn Play 2026-08-31) và mọi thư viện native (.so) hỗ trợ 16 KB page size (hạn 2027-02-01). → Kiểm: `grep targetSdk android/app/build.gradle*`; `bundletool`/script kiểm ELF alignment trên AAB; CI fail khi có .so chưa 16 KB. · Nguồn: Play target-sdk; Android page-sizes
- [ ] `PRF-MOB-003` **MUST** iOS build bằng Xcode 26+ (SDK 26) và deployment target ≥ iOS 13; phiên bản Xcode ghim trong repo (`.xcode-version`) và CI. → Kiểm: `xcodebuild -showBuildSettings | grep -E 'IPHONEOS_DEPLOYMENT_TARGET|SDK_VERSION'`; workflow chọn Xcode đúng file. · Nguồn: Apple upcoming requirements
- [ ] `PRF-MOB-004` **MUST** Khai báo quyền riêng tư khớp mã thật: iOS `PrivacyInfo.xcprivacy` (required-reason API, kể cả SDK bên thứ ba); Play Data safety khớp SDK thực dùng; privacy policy URL có trong store và trong app. → Kiểm: file manifest tồn tại; script liệt kê SDK (`pod list`/`gradle dependencies`) đối chiếu bảng khai báo; link policy trả 200. · Nguồn: Apple upcoming requirements (2024-05-01); App Store 5.1.1(i)
- [ ] `PRF-MOB-005` **MUST** Chỉ xin quyền thiết bị khi tính năng thật sự cần, xin **đúng lúc dùng**, purpose string cụ thể; người dùng từ chối vẫn dùng được phần còn lại. → Kiểm: diff danh sách permission trong `AndroidManifest.xml`/`Info.plist` với bản đồ tính năng; `Info.plist` không có usage string rỗng/chung chung; E2E ca "từ chối quyền" vẫn qua luồng chính. · Nguồn: App Store 5.1.1(ii)(iii)(iv); MASVS-PLATFORM
- [ ] `PRF-MOB-006` **MUST** Token/bí mật lưu trong Keychain/Keystore (không AsyncStorage/SharedPreferences thường); cấm cleartext HTTP (`usesCleartextTraffic=false`, ATS bật, không ngoại lệ domain). → Kiểm: grep manifest/`Info.plist`; test MASTG nhóm STORAGE/NETWORK; proxy bắt gói không thấy HTTP. · Nguồn: MASVS-STORAGE, MASVS-NETWORK
- [ ] `PRF-MOB-007` **MUST** Không tải/thực thi mã native hoặc đổi tính năng cốt lõi ngoài store; OTA chỉ cập nhật JS/asset, **có ký** (EAS code signing hoặc tương đương) và gắn `runtimeVersion` khớp native. → Kiểm: `app.json` có `updates.codeSigningCertificate`; CI chặn lệnh OTA khi `runtimeVersion` đổi mà chưa có bản store mới. · Nguồn: App Store 2.5.2; Play Device and Network Abuse; Expo EAS Update code signing
- [ ] `PRF-MOB-008` **MUST@M** Crash reporting bật từ bản đầu, symbol (dSYM, ProGuard/R8 mapping, Hermes sourcemap) upload tự động trong CI; crash thử nghiệm hiện stack trace đọc được. → Kiểm: bước CI upload symbol; sự kiện crash test được symbolicate.
- [ ] `PRF-MOB-009` **MUST@M** Theo dõi và cảnh báo theo ngưỡng Android vitals: user-perceived crash rate ≤ 1.09 %, ANR rate ≤ 0.47 %; iOS theo Xcode Organizer/MetricKit. → Kiểm: dashboard + rule cảnh báo; GO/NO-GO phát hành có số này. · Nguồn: Android vitals
- [ ] `PRF-MOB-010` **MUST** Pin toolchain: Gradle wrapper có `distributionSha256Sum`, JDK và Node ghim; lockfile (`pnpm-lock`, `Podfile.lock`, `gradle.lockfile`) commit. → Kiểm: `gradle/wrapper/gradle-wrapper.properties` có checksum; lockfile trong `git ls-files`.
- [ ] `PRF-MOB-011` **MUST** A11y theo nền tảng: VoiceOver/TalkBack đi hết luồng chính; mọi control tương tác có label; vùng chạm ≥ 48 dp (Android) và ≥ 44 pt (iOS, Apple HIG Buttons) theo [`UX-A11Y-006`](../06-design-ux/accessibility.md); font scale 200 % không cắt chữ/chồng layout. → Kiểm: Accessibility Scanner (Android) và Xcode Accessibility Inspector 0 lỗi trên màn hình chính; E2E Maestro chạy với font scale lớn. · Nguồn: Android accessibility apps; Apple HIG Buttons (44×44 pt — xác minh 2026-10-14 qua developer.apple.com); nguyên tắc ở [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)
- [ ] `PRF-MOB-012` **SHOULD** Offline: màn hình chính đọc được từ cache khi mất mạng; thao tác ghi xếp hàng với idempotency key và retry; UI hiện trạng thái offline/đang đồng bộ. → Kiểm: E2E tắt mạng (`adb shell svc wifi disable`/`svc data disable`) rồi bật lại, không mất và không nhân đôi bản ghi.
- [ ] `PRF-MOB-013` **SHOULD** Push: token đăng ký/huỷ ở server theo đăng nhập/đăng xuất; payload không chứa dữ liệu nhạy cảm (chỉ id); deep link từ notification có test; xin quyền push sau khi người dùng thấy giá trị. → Kiểm: test API vòng đời token; test deep link mở đúng màn hình.
- [ ] `PRF-MOB-014` **SHOULD** Kích thước tải có ngân sách trong `PROJECT.md`; bật R8/ProGuard + resource shrinking + AAB; CI in kích thước AAB/IPA mỗi bản và đỏ khi vượt ngân sách; không vượt giới hạn store (Play: base module 500 MB, tổng 4 GB; iOS: 4 GB, `__TEXT` 500 MB). → Kiểm: bước CI đo size + so ngân sách. · Nguồn: Play size limits; App Store Connect max build sizes
- [ ] `PRF-MOB-015` **SHOULD** Pipeline phát hành tự động: build → test → ký → upload TestFlight/Play internal → staged rollout; không build phát hành từ máy cá nhân. → Kiểm: workflow `release` tồn tại; lịch sử build store đến từ CI.
- [ ] `PRF-MOB-016` **SHOULD** Cơ chế min-version/force-update: app hỏi server phiên bản tối thiểu khi khởi động; API trả mã lỗi riêng khi client quá cũ; UI chặn nhẹ với link store. → Kiểm: test với version giả nhỏ hơn min.
- [ ] `PRF-MOB-017` **SHOULD** Store listing đúng và cập nhật: screenshot thật (không chỉ splash/login), mô tả khớp tính năng, age rating trả lời bộ câu hỏi mới (Apple hạn 2026-01-31), "What's New" mô tả thay đổi thật. → Kiểm: checklist trước submit trong `RELEASE-NOTES`. · Nguồn: App Store 2.3, 2.3.3, 2.3.12
- [ ] `PRF-MOB-018` **SHOULD** Có đăng ký tài khoản trong app thì có **xoá tài khoản trong app**; không bắt đăng nhập khi không cần. → Kiểm: E2E luồng xoá tài khoản → server xác nhận xoá/ẩn danh. · Nguồn: App Store 5.1.1(v); quyền người dùng ở [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `PRF-MOB-019` **SHOULD** Thời gian khởi động lạnh đo bằng TTID/TTFD (Android `Displayed`/`reportFullyDrawn`) và MetricKit; ngân sách ghi trong `PROJECT.md`; theo dõi hồi quy mỗi bản. → Kiểm: script benchmark trên emulator/device trong CI, lưu số đo theo commit.
- [ ] `PRF-MOB-020` **MAY** Chạy E2E trên device farm thật (Firebase Test Lab/BrowserStack) với ma trận OS/thiết bị tối thiểu trước phát hành. → Kiểm: báo cáo chạy đính kèm GO/NO-GO.
- [ ] `PRF-MOB-021` **MAY** Phát hiện root/jailbreak, chống tamper, certificate pinning (MASVS-RESILIENCE) — chỉ với app tài chính/dữ liệu nhạy cảm và có kế hoạch xoay chứng chỉ. → Kiểm: MASTG test nhóm RESILIENCE; ghi ADR vì sao bật.

## Cổng chất lượng tương đương

| Cổng chung (web) | Cổng của mobile-app | Ngưỡng | Công cụ / nơi đặt |
|---|---|---|---|
| Core Web Vitals | Khởi động lạnh (TTID/TTFD), jank khung hình, pin | Ngân sách dự án đặt; theo dõi hồi quy mỗi bản; (gợi ý Apple ≈ 400 ms launch — chưa xác minh 2026-10-13) | Android `Displayed` log, Macrobenchmark; Xcode Instruments App Launch, MetricKit |
| Lighthouse score | Android vitals + Xcode Organizer | Crash ≤ 1.09 %, ANR ≤ 0.47 % (ngưỡng Play) | Play Console vitals; App Store Connect; Sentry/Crashlytics |
| axe/WCAG | Accessibility Scanner + Accessibility Inspector; TalkBack/VoiceOver thủ công luồng chính | 0 lỗi scanner; vùng chạm ≥ 48 dp / 44 pt; font scale 200 % | Accessibility Scanner, Xcode Accessibility Inspector, Maestro |
| E2E Playwright | E2E trên emulator/simulator + device farm | Luồng chính xanh trên 1 iOS + 1 Android tối thiểu | Maestro/Detox trong CI; Firebase Test Lab (MAY) |
| Security headers/CSP | MASVS 8 nhóm + ATS/Network Security Config | 0 phát hiện mức high trong MASTG test đã chọn; không cleartext | MASTG tests, `apksigner`, Frida/objection (chỉ trên app của mình) |
| Bundle budget | Download size + DEX optimization | Ngân sách dự án; Play yêu cầu shrink/obfuscate ≥ 25 % khi DEX > 10 MB | CI đo AAB/IPA; R8; `--obfuscate --split-debug-info` (Flutter) |
| Preview deployment | TestFlight / Play internal testing track | Mỗi RC có bản nội bộ trước staged rollout | EAS Submit / Fastlane `pilot`, `supply` |
| Rollback | Staged rollout + halt; OTA rollback | Rollout bắt đầu ≤ 10 % (dự án đặt), có nút halt; OTA đẩy lại bản cũ ≤ 1 lệnh | Play staged rollout; App Store phased release; EAS Update republish |

## Bẫy

- **Mất keystore/ký sai key** → không thể cập nhật app cũ. Hàng rào: Play App Signing (Google giữ app signing key), upload key tách riêng, khóa hạn sau 2033-10-22, lưu ở secret manager (xem [`../12-security/secrets-management.md`](../12-security/secrets-management.md)).
- **OTA để "lách review"** (đổi tính năng, tải mã native) → bị gỡ app. Hàng rào: OTA chỉ JS/asset, có ký, gắn `runtimeVersion`; thay đổi native đi qua store.
- **Xin mọi quyền lúc mở app** → tỷ lệ từ chối cao, vi phạm 5.1.1. Hàng rào: just-in-time + purpose string cụ thể + E2E ca từ chối.
- **Để hạn targetSdk/SDK Xcode đến phút chót** → không upload được bản vá khẩn. Hàng rào: lịch nâng toolchain mỗi quý trong [`../15-operations/maintenance-and-lifecycle.md`](../15-operations/maintenance-and-lifecycle.md).
- **Crash không symbolicate** vì quên upload dSYM/mapping → crash report vô dụng. Hàng rào: PRF-MOB-008 trong CI, không làm tay.
- **Thư viện native chưa hỗ trợ 16 KB page** → bản cập nhật bị từ chối sau 2027-02-01. Hàng rào: PRF-MOB-002 kiểm ELF alignment trong CI.
- **Lưu token trong AsyncStorage/SharedPreferences** vì tiện → đọc được trên máy root. Hàng rào: PRF-MOB-006 + MASTG test.
- **Test chỉ trên simulator** → quyền, push, biometrics, mạng chập chờn không được kiểm. Hàng rào: ít nhất một thiết bị thật mỗi nền tảng trước RC.
- **Store listing lệch tính năng** (screenshot cũ, age rating chưa trả lời) → bị chặn submit đúng ngày phát hành. Hàng rào: PRF-MOB-017 trong checklist RC.

## Nguồn

- Google Play target API level (API 36 từ 2026-08-31): <https://developer.android.com/google/play/requirements/target-sdk> — xác minh 2026-10-13.
- 16 KB page size (bắt buộc 2027-02-01): <https://developer.android.com/guide/practices/page-sizes> — xác minh 2026-10-13.
- Play App Signing, keystore: <https://developer.android.com/studio/publish/app-signing> — xác minh 2026-10-13.
- Play size limits: <https://support.google.com/googleplay/android-developer/answer/9859372> — xác minh 2026-10-13.
- Play Device and Network Abuse (tải mã thực thi): <https://support.google.com/googleplay/android-developer/answer/9888379> — xác minh 2026-10-13.
- Android vitals ngưỡng: <https://developer.android.com/topic/performance/vitals> — xác minh 2026-10-13. Android a11y (48 dp, contentDescription): <https://developer.android.com/guide/topics/ui/accessibility/apps> — xác minh 2026-10-13.
- AGP 9.4.0 / Gradle 9.6.0: <https://developer.android.com/build/releases/gradle-plugin> — xác minh 2026-10-13.
- Apple upcoming requirements (Xcode 26 từ 2026-04-28; iOS 13 từ 2026-09-09; privacy manifest; notarytool): <https://developer.apple.com/news/upcoming-requirements/> — xác minh 2026-10-13. Xcode/iOS releases: <https://developer.apple.com/news/releases/> — xác minh 2026-10-13.
- App Store Review Guidelines 2.3, 2.5.2, 5.1.1: <https://developer.apple.com/app-store/review/guidelines/> — xác minh 2026-10-13. Max build sizes: <https://developer.apple.com/help/app-store-connect/reference/maximum-build-file-sizes> — xác minh 2026-10-13.
- OWASP MASVS v2.1.0 (8 nhóm): <https://mas.owasp.org/MASVS/> và <https://github.com/OWASP/owasp-masvs/releases/latest> — xác minh 2026-10-13; MASTG: <https://mas.owasp.org/MASTG/> — xác minh 2026-10-13.
- Expo EAS Update và code signing: <https://docs.expo.dev/eas-update/introduction/>, <https://docs.expo.dev/eas-update/code-signing/> — xác minh 2026-10-13. Flutter Android deployment: <https://docs.flutter.dev/deployment/android> — xác minh 2026-10-13; Flutter 3.47: <https://docs.flutter.dev/release/release-notes> — xác minh 2026-10-13.
- Phiên bản: npm (`react-native`, `expo`, `expo-updates`, `detox`, `jest`, `@sentry/react-native`, `@react-native-community/cli`, `@capacitor/core`, `@tanstack/react-query`), RubyGems `fastlane`, endoflife.date `kotlin`/`ios`/`android`, swift.org (6.4.1), GitHub releases Maestro — xác minh 2026-10-13.
- Apple HIG Buttons — vùng chạm ≥ 44×44 pt: <https://developer.apple.com/design/human-interface-guidelines/buttons> — xác minh 2026-10-14 (đọc qua dữ liệu JSON của trang; đính chính: bản trước ghi "chưa xác minh").
- (chưa xác minh) Apple launch time 400 ms; ngưỡng cold start Android vitals (5 s); phiên bản Crashlytics, expo-secure-store, Zustand, WatermelonDB, Shorebird, Codemagic.
- Catalog: 09 (mục Mobile: release key, Keystore, permission, cleartext), 13 §3 — `research/2026-10-13-stored-catalog-extraction.md`; khung cũ KHUNG-3 C2 (commit `1b80fe4`).
