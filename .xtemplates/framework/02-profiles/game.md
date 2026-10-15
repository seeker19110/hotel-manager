---
title: Game (client, server, live-ops)
kind: profile
slug: game
prefix: PRF-GAME
modules: [04-standards/*, 05-architecture/*, 06-design-ux/*, 07-frontend/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-13
---

# Hồ sơ: Game (client, server, live-ops)

> Game 2D/3D trên PC, console, mobile hoặc web: vòng lặp game, engine, asset pipeline, netcode, kinh tế trong game,
> phát hành lên store và vận hành sau ra mắt (live-ops). Cổng chất lượng thay CWV/a11y web bằng **frame-time budget,
> thời gian tải, kích thước build, server authoritative, playtest có kịch bản, minh bạch monetization và bảo vệ trẻ em**.

## Khi nào dùng

- Sản phẩm là game (kể cả game giáo dục, serious game, gamified app có vòng lặp game thật).
- Có backend online (matchmaking, leaderboard, inventory, thanh toán) → ghép thêm blueprint `api-service` cho server.
- Web game nhúng vào site → vẫn dùng hồ sơ này; cổng web (CWV) áp cho trang chứa, không cho canvas.
- **Không** dùng cho: app có hoạt ảnh/gamification nhẹ (→ `web-app`/`mobile-app`).

## Kiến trúc tham chiếu

```text
[Client (engine)]  game loop: input → fixed-step update (deterministic) → render (interpolate)
   │  asset bundle (LFS/CDN) · save versioned · crash reporter · remote config/flags
   │  dự đoán cục bộ (prediction) · reconcile theo server
   ▼ (online)
[Game server authoritative]  state quan trọng (vị trí, tiền, inventory, kết quả) · anti-cheat validate · tick rate cố định
   │
   ├─► [Meta services (api-service)]  auth · matchmaking · leaderboard · IAP verify (receipt server-side) · telemetry
   ├─► [Live-ops]  remote config · sự kiện · nội dung mới không cần client update · kill switch tính năng
   └─► [Observability]  crash + symbol · p95 frame time theo thiết bị · retention/economy metrics (có consent)
[Store]  IARC/ESRB/PEGI rating · odds loot box · policy trẻ em (Apple 1.3, Google Families) · VN: phân loại tuổi + giấy phép G1
```

## Stack mặc định khuyến nghị

Phiên bản xác minh **2026-10-13** — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Engine mã nguồn mở | Godot (MIT; 2D rất tốt, 3D ổn) | 4.7.2 (2026-08-16); 4.6.x còn hỗ trợ đầy đủ; 3.6 LTS | Bevy 0.20.0 (2026-10-08; Rust, ECS, còn 0.x) cho đội Rust |
| Engine thương mại | Unity 6 (C#) | 6.3 LTS (6000.3.x, hỗ trợ tới 12/2027) cho production; 6000.6.5f1 (2026-10-08) là Supported Update | Unreal Engine 5.8 (ngày phát hành chưa xác minh) cho 3D AAA/C++ |
| Web game | Phaser (2D) · PixiJS (render) · Three.js (3D) | phaser 4.2.1 · pixi.js 8.22.0 | Godot export web |
| Game server | Nakama (open-source, Go) | v3.41.0 (2026-09-18) | Tự viết trên Go/Node + WebSocket/UDP; Colyseus (TS) |
| Meta backend | Theo hồ sơ [`api-service.md`](api-service.md) (PostgreSQL 18.6, Valkey 9.1.2) | — | — |
| Asset lớn | Git LFS + CDN; manifest asset có license | — | Perforce khi asset rất lớn/đội art |
| Crash/metrics | Sentry/Crashlytics (upload symbol mỗi build) | — | Backtrace |
| Test | Unit cho logic (GUT/GdUnit4 cho Godot, Unity Test Framework, cargo test) + playtest kịch bản headless | — | — |
| Netcode test | Mô phỏng latency/packet loss (`tc netem` / tích hợp engine) | — | clumsy (Windows) |

## Checklist

- [ ] `PRF-GAME-001` **MUST** Logic game chạy ở **fixed timestep** tách khỏi render; kết quả không phụ thuộc frame rate; RNG seed được. → Kiểm: test chạy mô phỏng N bước với dt khác nhau và cùng seed → trạng thái cuối giống nhau (hash); replay từ seed + input log tái tạo đúng.
- [ ] `PRF-GAME-002` **MUST** Ngân sách hiệu năng ghi trong `PROJECT.md`: frame time p95 ≤ 16,7 ms (60 fps) hoặc 33,3 ms (30 fps) trên thiết bị min-spec, thời gian tải màn chính, RAM/VRAM, kích thước build; đo tự động mỗi build. → Kiểm: job nightly chạy benchmark scene trên min-spec (thiết bị/CI runner cấu hình ghi rõ) xuất p95 frame time, fail khi vượt ngân sách (phương pháp → [`../18-cross-cutting/performance-engineering.md`](../18-cross-cutting/performance-engineering.md)).
- [ ] `PRF-GAME-003` **MUST** Multiplayer: server **authoritative** cho mọi state có giá trị (vị trí, HP, tiền, inventory, kết quả trận); client chỉ gửi input/ý định và dự đoán cục bộ. → Kiểm: test client gửi gói "tăng tiền"/"teleport" → server từ chối, state không đổi, sự kiện bị ghi log.
- [ ] `PRF-GAME-004` **MUST** Anti-cheat có **ranh giới** trong threat model: validate server-side (tốc độ, cooldown, giới hạn vật lý, rate limit), phát hiện bất thường theo thống kê; obfuscation client không tính là bảo mật; không cài kernel driver khi chưa có ADR + rà pháp lý. → Kiểm: threat model ([`../12-security/threat-modeling.md`](../12-security/threat-modeling.md)) liệt kê gian lận theo mức; test speedhack/macro giả → bị chặn hoặc gắn cờ.
- [ ] `PRF-GAME-005` **MUST** Asset pipeline tái lập: nguồn asset trong LFS/CDN (không binary lớn trong git thường), build asset bằng script, mỗi asset có license/ghi công trong manifest. → Kiểm: `git lfs ls-files` bao phủ mọi binary > ngưỡng; CI fail khi asset thiếu dòng license; build asset từ sạch cho cùng hash.
- [ ] `PRF-GAME-006` **MUST** Save/progress: schema có phiên bản + migration, ghi atomic (tạm → rename), có bản dự phòng; không mất tiến độ khi crash giữa lúc lưu. → Kiểm: test kill tiến trình giữa save → file save trước đó còn nguyên và nạp được; test nạp save phiên bản cũ → migrate đúng.
- [ ] `PRF-GAME-007` **MUST** Monetization minh bạch: loot box/vật phẩm ngẫu nhiên hiển thị **xác suất từng loại trước khi mua**; IAP ghi rõ tiền thật hay tiền ảo; không dark pattern (đếm ngược giả, nút mua giả). → Kiểm: UI test màn mua hiện bảng odds; mọi IAP có nhãn giá tiền thật; checklist review store trước submit. · Nguồn: Apple App Store Review Guidelines 3.1.1; Google Play Payments policy §7 (loot box odds)
- [ ] `PRF-GAME-008` **MUST** Phân loại độ tuổi đúng (IARC/ESRB/PEGI; VN: 03+/07+/12+/16+/18+ hiển thị liên tục khi giới thiệu, quảng cáo, phát hành); trả lời bảng hỏi store trung thực; không mô tả sai. → Kiểm: kết quả phân loại hiển thị ở màn hình đầu và store listing; bản ghi bảng hỏi IARC trong repo. · Nguồn: NĐ 147/2024/NĐ-CP Điều 38, 39(1)(g) (hiệu lực 25/12/2024 — kiểm tra văn bản sửa đổi)
- [ ] `PRF-GAME-009` **MUST** Nếu có trẻ em (< 18 VN; < 13 COPPA): không quảng cáo cá nhân hoá, không thu thập PII/định danh thiết bị, parental gate trước mua/link ngoài, chỉ SDK được chứng nhận cho trẻ em; VN với game G1: hệ thống giới hạn người < 18 tuổi ≤ 60 phút/game và ≤ 180 phút/ngày, cảnh báo sức khoẻ mỗi 30 phút. → Kiểm: feature flag giới hạn thời gian có test (giả lập tài khoản < 18 → chặn sau ngưỡng, cảnh báo đúng chu kỳ); audit SDK trong build; checklist [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md). · Nguồn: NĐ 147/2024/NĐ-CP Điều 39(1)(e),(g); Apple 1.3 Kids Category; Google Play Families policy
- [ ] `PRF-GAME-010` **MUST** Game online nhiều người chơi tại Việt Nam (G1) cần giấy phép cung cấp dịch vụ; G2–G4 cần thông báo/đăng ký theo quy định; ghi rõ trong kế hoạch phát hành trước khi build. → Kiểm: mục pháp lý trong `PROJECT.md` nêu loại G1–G4 và hồ sơ cần; ngày nộp/nhận ghi ở PROGRESS. · Nguồn: NĐ 147/2024/NĐ-CP Điều 37 (phân loại G1–G4) — kiểm tra văn bản sửa đổi; dự thảo sửa đổi 2026 chưa ban hành (chưa xác minh)
- [ ] `PRF-GAME-011` **MUST** Crash reporting bật mọi nền tảng, symbol/dSYM/PDB upload tự động mỗi build; crash-free rate là chỉ số release. → Kiểm: bước CI upload symbol; dashboard crash-free theo phiên bản; ngưỡng GO/NO-GO ghi ở [`../templates/GO-NO-GO.md`](../templates/GO-NO-GO.md).
- [ ] `PRF-GAME-012` **MUST** Build pipeline CI theo từng nền tảng, tái lập (cùng commit → cùng build id), ký số đúng chuẩn store, metadata/screenshot tự động. → Kiểm: job build mỗi nền tảng xanh; artifact có hash + ký; submit bằng script (không tay).
- [ ] `PRF-GAME-013` **MUST** Live-ops: remote config/feature flag có **kill switch** cho tính năng/sự kiện, rollback không cần client update; thay đổi config qua review. → Kiểm: test tắt flag → tính năng ẩn trong ≤ chu kỳ fetch; lịch sử config trong git/console có người duyệt.
- [ ] `PRF-GAME-014` **MUST** Kinh tế trong game: tiền/vật phẩm là số nguyên, mọi giao dịch có sổ cái server-side, chống nhân bản (duplication) và race khi giao dịch đồng thời; IAP xác minh receipt ở server. → Kiểm: test hai yêu cầu trao đổi đồng thời cùng vật phẩm → chỉ một thành công; test receipt giả → từ chối; lint cấm float cho tiền ([`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md)).
- [ ] `PRF-GAME-015` **MUST** Netcode kiểm thử dưới mạng xấu (latency 100–300 ms, packet loss, jitter giả lập): có interpolation/lag compensation, không desync, không lợi thế cho người ping cao. → Kiểm: job test với `netem` hoặc mô phỏng engine: hai client cùng kịch bản → trạng thái server nhất quán; số liệu desync = 0.
- [ ] `PRF-GAME-016` **MUST@M** Telemetry/analytics chỉ sau consent (trừ dữ liệu kỹ thuật tối thiểu), có thể tắt, không gắn ID quảng cáo với trẻ em; tuân [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md). → Kiểm: test chưa consent → không có gói analytics gửi đi (proxy ghi lại).
- [ ] `PRF-GAME-017` **MUST** Accessibility tối thiểu: điều khiển gán lại được, phụ đề, tuỳ chọn mù màu, cỡ chữ, tắt rung/nhấp nháy mạnh; cảnh báo động kinh ảnh nếu có hiệu ứng nhấp nháy. → Kiểm: checklist a11y game trong repo đánh dấu từng mục có bằng chứng (ảnh/màn hình); test tự động cỡ chữ và phím gán lại. · Nguồn: Game Accessibility Guidelines (gameaccessibilityguidelines.com — chưa xác minh phiên bản ngày 2026-10-13); nguyên tắc chung → [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md)
- [ ] `PRF-GAME-018` **SHOULD** Playtest tự động mỗi build: bot chạy headless qua tutorial/màn đầu (smoke), ghi lại lỗi và frame time. → Kiểm: job CI `playtest-smoke` xanh với video/log artifact.
- [ ] `PRF-GAME-019` **SHOULD** Soak test ≥ 1 giờ nightly đo rò rỉ bộ nhớ và tăng trưởng heap. → Kiểm: báo cáo bộ nhớ đầu/cuối, chênh ≤ ngưỡng ADR.
- [ ] `PRF-GAME-020` **SHOULD** Localization pipeline: chuỗi tách khỏi code, font hỗ trợ mọi ngôn ngữ đích (tiếng Việt có dấu), kiểm tràn text tự động. → Kiểm: test screenshot UI với ngôn ngữ dài nhất không tràn; xem [`../18-cross-cutting/i18n-and-l10n.md`](../18-cross-cutting/i18n-and-l10n.md).
- [ ] `PRF-GAME-021` **SHOULD** Mô phỏng cân bằng kinh tế (nguồn/bể tiền) trước khi đổi giá/drop rate; thay đổi có A/B và rollback. → Kiểm: script mô phỏng + báo cáo trong PR đổi tham số kinh tế.
- [ ] `PRF-GAME-022` **MAY** Cloud save đồng bộ có giải quyết xung đột; cross-play; mod support với sandbox script. → Kiểm: ADR ghi lựa chọn.

## Cổng chất lượng tương đương

| Cổng chung (web) | Tương đương game | Công cụ |
|---|---|---|
| Core Web Vitals | Frame time p95, thời gian tải, kích thước build, crash-free rate | Profiler engine, benchmark scene, crash dashboard |
| E2E trình duyệt | Playtest kịch bản headless + netcode test dưới mạng xấu | Bot playtest, netem |
| A11y WCAG | Checklist a11y game (điều khiển, phụ đề, mù màu, nhấp nháy) | Checklist có bằng chứng |
| Theme/tokens | Style guide art + UI scale theo độ phân giải | Review art |
| Security scan | Server authoritative test + economy race test + receipt verify | Test integration server |
| Lighthouse CI | Benchmark nightly so baseline theo commit | CI artifact |

## Bẫy

1. **Logic gắn vào `delta time` render** — máy nhanh chạy khác máy chậm, replay không tái tạo được (PRF-GAME-001).
2. **Client tự tính tiền/kết quả rồi báo server** — gian lận chỉ cần sửa gói tin (003, 014).
3. **Asset binary commit thẳng git** — repo phình, clone hàng giờ; LFS + CDN (005).
4. **Ghi đè file save trực tiếp** — crash giữa chừng mất toàn bộ tiến độ (006).
5. **Odds loot box "trong điều khoản"** thay vì trên màn mua — vi phạm Apple 3.1.1/Google Payments §7 → bị từ chối review (007).
6. **Game có trẻ em dùng SDK quảng cáo thường** — thu ID quảng cáo trẻ em; bị gỡ khỏi store (009).
7. **Phát hành game online VN mà chưa xác định G1–G4** — thiếu giấy phép (010).
8. **Đo fps trên máy dev** — min-spec mới là cổng (002).
9. **Kinh tế dùng float** — làm tròn tích luỹ tạo tiền từ không khí (014).
10. **Thay drop rate trực tiếp production không A/B/rollback** — sập kinh tế, mất người chơi (013, 021).

## Nguồn

- Godot release policy (4.7/4.6 hỗ trợ đầy đủ, 3.6 LTS): <https://docs.godotengine.org/en/stable/about/release_policy.html>; phiên bản: <https://endoflife.date/api/godot.json> — xác minh 2026-10-13
- Unity 6 (6.3 LTS tới 12/2027; 6.0 LTS tới 10/2026): <https://unity.com/releases/unity-6>; 6000.6.5f1: <https://endoflife.date/api/unity.json>, <https://unity.com/releases/editor/whats-new/6000.6.5> — xác minh 2026-10-13 (hai trang lệch nhau về dòng mới nhất; `unity.com/releases/unity-6` có thể là cache cũ)
- Unreal Engine 5.8 release notes: <https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5.8-release-notes> — trang tồn tại, **ngày phát hành chưa xác minh** (2026-10-13)
- Phiên bản khác: <https://registry.npmjs.org/phaser/latest> 4.2.1; `pixi.js` 8.22.0; <https://github.com/bevyengine/bevy/releases/latest> 0.20.0; <https://github.com/heroiclabs/nakama/releases/latest> v3.41.0 — xác minh 2026-10-13
- Apple App Store Review Guidelines 3.1.1 (loot box odds), 1.3 (Kids Category): <https://developer.apple.com/app-store/review/guidelines/> — xác minh 2026-10-13
- Google Play Payments policy §7 (odds vật phẩm ngẫu nhiên): <https://support.google.com/googleplay/android-developer/answer/9858738>; Families policy: <https://support.google.com/googleplay/android-developer/answer/9893335> — xác minh 2026-10-13
- Nghị định 147/2024/NĐ-CP (09/11/2024, hiệu lực 25/12/2024) Điều 37–39: bản dịch/tra cứu <https://hethongphapluat.com/decree-no-147-2024-nd-cp-dated-november-9-2024-on-management-provision-and-use-of-internet-services-and-cyber-information/dieu-39> và tóm tắt <https://luatvietnam.vn/linh-vuc-khac/kinh-doanh-tro-choi-dien-tu-tren-mang-883-100134-article.html> — xác minh 2026-10-13 qua nguồn thứ cấp; **đối chiếu bản gốc trên vanban.chinhphu.vn và kiểm tra văn bản sửa đổi trước khi áp dụng** (dự thảo 2026 giảm còn 60 phút/ngày cho < 16 tuổi — chưa ban hành, chưa xác minh)
- COPPA (15 U.S.C. §6501–6506) — (chưa xác minh — không fetch ngày 2026-10-13); chi tiết → [`../16-compliance-privacy/international-privacy.md`](../16-compliance-privacy/international-privacy.md)
- Khung cũ X-stored PHẦN C8 (commit `1b80fe4`); `research/2026-10-13-stored-catalog-extraction.md` §6 (catalog không bao phủ game).
