# Nghiên cứu G2 — phiên bản stack và văn bản pháp lý (xác minh 2026-10-15)

> Mức bằng chứng:
> - **[F]** fetch trực tiếp từ nguồn chính thức (registry npm, endoflife.date, postgresql.org, docs/pricing của nhà cung cấp).
> - **[T]** nguồn thứ cấp (báo, hãng luật, trang tổng hợp).
> - **[X]** chưa xác minh.
>
> Bảng này chỉ ghi dữ kiện. Quyết định nằm ở `docs/adr/0001-*.md`. **Không dùng phần pháp lý làm căn cứ** khi chưa đối chiếu văn bản gốc trên Công báo hoặc vbpl.vn; người phụ trách pháp lý phải đối chiếu trước khi dùng dữ liệu thật.

## A. Phiên bản

| Mục | Giá trị | Nguồn | Mức |
|---|---|---|---|
| Node.js 24 LTS | 24.22.0; Active tới 2026-10-20, sau đó Maintenance; EOL 2028-04-30 | https://endoflife.date/api/nodejs.json | F |
| Node.js 26 | 26.12.0; thành LTS 2026-10-28; EOL 2029-04-30 | như trên | F |
| Node.js 22 | Maintenance; EOL 2027-04-30. Node 20 đã EOL 2026-04-30 | như trên | F |
| Next.js | 16.4.1 (14/10/2026), MIT, node ≥ 20.9 | https://registry.npmjs.org/next | F |
| React | 19.3.1, MIT | https://registry.npmjs.org/react | F |
| TypeScript | 7.0.2 (08/07/2026), Apache-2.0. Tương thích với Next 16: X | https://registry.npmjs.org/typescript | F |
| PostgreSQL | 18.6 mới nhất; 17.11 (EOL 2029-11-08); 14 EOL 2026-11-12 | https://www.postgresql.org/support/versioning/ | F |
| Supabase hosted | Mặc định Postgres 17 (theo changelog self-host 5/2026); PG14 deprecated từ 2026-07-01 | https://supabase.com/changelog | T |
| Supabase CLI | 2.121.0, MIT · supabase-js 2.117.3 (node ≥ 22) | registry npm | F |
| Supabase giá | Pro $25/tháng + $10 credit; compute Small $15; PITR 7 ngày $100 (cần ≥ Small; bật PITR thì daily backup dừng) | https://supabase.com/pricing · https://supabase.com/docs/guides/platform/backups | F |
| pg-boss | 12.38.0 (13/10/2026), MIT, node ≥ 22.12 | registry npm | F |
| Graphile Worker | 0.18.0 (08/09/2026), MIT, node ≥ 22.18 | registry npm | F |
| Kysely | 0.29.6 (16/09/2026), MIT, node ≥ 22 | registry npm | F |
| Drizzle ORM / kit | 0.45.4 / 0.31.11; có `pgPolicy` cho RLS; tstzrange/EXCLUDE: X | registry npm · https://orm.drizzle.team/docs/rls | F/X |
| Prisma | tag `latest` = 8.0.0-rc.23 (rc); kiểu không hỗ trợ phải dùng `Unsupported` | registry npm · docs Prisma | F |
| Serwist `@serwist/next` (mã dùng `@serwist/turbopack` cùng phiên bản — ADR-0005, 2026-10-21) | 9.5.13 (04/10/2026), MIT; next-pwa dừng ở 5.6.0 (2022) | registry npm | F |
| Vitest | 5.0.4, MIT | registry npm | F |
| Playwright | 1.64.1, Apache-2.0 | registry npm | F |
| fast-check | 4.10.2, MIT | registry npm | F |
| Testcontainers (Node) | 12.2.1, MIT, node ≥ 22.22 | registry npm | F |
| pnpm | 12.11.2, MIT | registry npm | F |
| Biome | 2.5.15, MIT OR Apache-2.0 | registry npm | F |
| Hosting vùng Singapore | Render (có worker chạy liên tục) [F]; Fly.io `sin` [F, worker X]; Railway SEA [F, worker X]; Cloud Run `asia-southeast1` (instance idle có thể bị tắt) [F] | docs từng hãng | F/X |

Chưa xác minh: trạng thái repo GitHub (archived/đổi license) của các gói trên (bị chặn 403); telemetry mặc định của Next.js, Supabase CLI.

## B. Pháp lý Việt Nam (toàn bộ là nguồn thứ cấp — cần đối chiếu bản gốc)

| Văn bản | Dữ kiện | Nguồn | Mức |
|---|---|---|---|
| Luật BVDLCN 91/2025/QH15 | Hiệu lực 01/01/2026 | lsvn.vn; tài liệu Bộ Tư pháp | T |
| NĐ 356/2025/NĐ-CP | Ban hành 31/12/2025, hiệu lực 01/01/2026; thay NĐ 13/2023 (điều khoản chuyển tiếp: X) | PwC, EY (1/2026) | T |
| NĐ 330/2026/NĐ-CP | Xử phạt VPHC về an ninh mạng và BVDLCN, hiệu lực 19/08/2026 | luatvietnam.vn (tóm tắt) | T, độ tin thấp |
| NĐ 254/2026/NĐ-CP + TT 91/2026/TT-BTC | Hoá đơn và chứng từ điện tử, hiệu lực 01/07/2026. Thay văn bản nào: các nguồn mâu thuẫn (NĐ 123/2020?) | Forvis Mazars | T / X |
| Luật Cư trú 68/2020/QH14 Đ.30 | Sửa bởi Luật 118/2025/QH15, hiệu lực 01/07/2026. Hạn thông báo lưu trú: trước 23 giờ ngày bắt đầu; khách đến sau 23 giờ thì trước 8 giờ sáng hôm sau | thuvienphapluat (trích tìm kiếm) | T |
| Tạm trú người nước ngoài (Luật 47/2014 sđ) | Khai trong 12 giờ (vùng sâu vùng xa 24 giờ) qua trang xuatnhapcanh của tỉnh hoặc phiếu NA17 | plo.vn | T |
| Luật An ninh mạng 116/2025/QH15 | Hiệu lực 01/07/2026 | thuvienphapluat, apolatlegal | T |
| Giá điện cho người thuê nhà | TT 16/2014/TT-BCT Đ.10 k.4, sửa bởi TT 25/2018 và TT 09/2023. Áp bậc 2 hay bậc 3 khi không kê khai đủ người: **các nguồn mâu thuẫn**. Thu cao hơn quy định bị phạt (NĐ 133/2026, độ tin thấp) | accgroup, moit.gov.vn, vnbusiness | T |

Hệ quả cho thiết kế, áp dụng dù chi tiết luật còn chưa chắc:
- Biểu giá điện/nước do từng cơ sở cấu hình, có ngày hiệu lực và ghi căn cứ. Sản phẩm **không** tự đưa ra "mức đúng luật".
- Thông báo lưu trú là nhắc hạn kèm xuất mẫu, không tự động nộp. Hạn 23 giờ/8 giờ và 12 giờ để ở dạng cấu hình.
- Hồ sơ thuế (tax profile) có phiên bản theo thời kỳ; tính năng hoá đơn điện tử chờ người phụ trách pháp lý/kế toán xác nhận diện áp dụng.

## C. URL trích trong kế hoạch gốc
`postgresql.org/docs/current/rangetypes.html`, `supabase.com/docs/guides/platform/backups`, `developers.booking.com/connectivity/docs/going_live` và `webkit.org/blog/13878/...` đều trả HTTP 200 ngày 2026-10-15.
