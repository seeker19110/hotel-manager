---
title: Blockchain / smart contract / dApp
kind: profile
slug: blockchain
prefix: PRF-CHAIN
modules: [04-standards/*, 05-architecture/*, 08-backend/*, 09-database/*, 10-workflow/*, 11-autonomous-loop/*, 12-security/*, 14-testing-quality/*, 15-operations/*, 16-compliance-privacy/*, 17-product-project/*, 18-cross-cutting/*]
updated: 2026-10-14
---

# Hồ sơ: Blockchain / smart contract / dApp

> Smart contract (EVM/Solana), ví, indexer và dApp. Đặc thù: **code bất biến sau deploy, lỗi = mất tiền thật, kẻ tấn
> công là mọi người trên mạng** → cổng cứng nhất của khung: test + fuzz + static analysis + audit độc lập, quản lý
> khoá, upgradeability có chủ đích, oracle và reentrancy. **Chỉ hỗ trợ dự án hợp pháp**; tại Việt Nam, tiền mã hoá
> **không phải phương tiện thanh toán hợp pháp** (xem cảnh báo pháp lý).

## Khi nào dùng

- Sản phẩm có smart contract giữ/chuyển giá trị, token, NFT, DAO, DeFi, định danh on-chain.
- dApp = frontend web + contract → chọn hồ sơ này cho contract, ghép thêm blueprint `web-app` cho frontend
  (module `07-frontend/*` không áp cho slug này, cố ý). dApp có giao diện web: ghép thêm bằng `xt.py compose --profile blockchain --add "07-frontend/*" --add "06-design-ux/*"` (bỏ lọc `applies_to` có chủ đích), hoặc tách blueprint `web-app` riêng cho frontend.
- **Không** dùng cho: ứng dụng chỉ đọc dữ liệu on-chain qua API bên thứ ba (→ `api-service`/`web-app`).
- **Từ chối** theo [`../00-method/principles.md`](../00-method/principles.md) "Ranh giới sử dụng": rug pull, mixer né
  AML, lừa đảo, sàn/ví vi phạm giấy phép, công cụ khai thác lỗ hổng không có uỷ quyền.

## Cảnh báo pháp lý Việt Nam (xác minh 2026-10-13 qua nguồn thứ cấp — đối chiếu bản gốc trước khi áp dụng)

| Vấn đề | Căn cứ | Hệ quả thiết kế |
|---|---|---|
| Tiền mã hoá **không** là phương tiện thanh toán hợp pháp | NĐ 52/2024/NĐ-CP Điều 3 khoản 10 (danh mục phương tiện thanh toán không dùng tiền mặt), Điều 6 khoản 6 (cấm phát hành/cung ứng/sử dụng phương tiện thanh toán không hợp pháp); BLHS 2015 (sđ 2017) Điều 206 | Không thiết kế luồng "thanh toán hàng hoá/dịch vụ bằng crypto" cho người dùng tại VN; ADR pháp lý bắt buộc |
| Thí điểm thị trường tài sản mã hoá | NQ 05/2025/NQ-CP (09/09/2025, hiệu lực ngay; thí điểm 5 năm — theo tin thứ cấp); chỉ tổ chức được **Bộ Tài chính cấp phép** mới vận hành sàn; giao dịch/thanh toán tài sản mã hoá **bằng Đồng Việt Nam** | Không xây sàn/dịch vụ giao dịch nếu không có giấy phép; không niêm yết bằng ngoại tệ/stablecoin cho người dùng VN |
| Khung "tài sản số/tài sản mã hoá" | Luật Công nghiệp công nghệ số số 71/2025/QH15 (thông qua 14/06/2025, hiệu lực 01/01/2026) — **điều khoản cụ thể chưa xác minh** (trang văn bản trả 403 ngày 2026-10-13) | Theo dõi nghị định hướng dẫn; ghi "(chưa xác minh)" trong ADR cho tới khi đọc bản gốc |
| EU | MiCA — Regulation (EU) 2023/1114 (áp dụng đầy đủ 30/12/2024; chuyển tiếp CASP tới 01/07/2026) | Cung cấp cho người dùng EU → cần CASP authorisation/white paper; xem [`../16-compliance-privacy/international-privacy.md`](../16-compliance-privacy/international-privacy.md) |

## Kiến trúc tham chiếu

```text
[dApp frontend (web-app)] ─ ví người dùng ký EIP-712 typed data · domain binding · không private key trong client
        │ RPC (provider có fallback) · viem/wagmi
        ▼
[Smart contracts (Solidity ≥ 0.8, pragma ghim)]  Ownable2Step/AccessControl · Pausable · ReentrancyGuard · events mọi state change
   │  admin = multisig + timelock · proxy (UUPS) chỉ khi ADR chấp nhận
   ├─► [Oracle: Chainlink/TWAP + staleness/bounds check]
   └─► [Indexer/subgraph → API (api-service)]  đọc event, không đọc storage trực tiếp từ frontend
[CI]  forge test · invariant/fuzz · slither · coverage · gas snapshot · verify source · deployments.json
[Vận hành]  monitor event bất thường · pause runbook · bug bounty · key trong HSM/hardware wallet
```

## Stack mặc định khuyến nghị

Phiên bản xác minh **2026-10-13** — **xác minh lại trước khi dùng**.

| Thành phần | Mặc định | Phiên bản (xác minh 2026-10-13) | Thay thế + điều kiện |
|---|---|---|---|
| Ngôn ngữ contract (EVM) | Solidity ≥ 0.8 (checked math), pragma ghim chính xác | (chưa xác minh — endoflife.date/solidity 404; kiểm <https://docs.soliditylang.org/>) | Vyper khi đội ưa Python-like; Rust/Anchor cho Solana |
| Toolchain | Foundry (forge/cast/anvil; fuzz + invariant sẵn) | v1.8.5 (2026-10-05) | Hardhat 3.19.0 (TS, plugin ecosystem) khi đội JS |
| Thư viện chuẩn | OpenZeppelin Contracts (ghim minor) | `@openzeppelin/contracts` 5.6.1 | — |
| Static analysis | Slither | slither-analyzer 0.11.6 (2026-07-28) | Aderyn, Semgrep rules Solidity |
| Fuzz/property | Foundry invariant tests · Echidna | Echidna 2.3.3 (2026-07-27) | Medusa; formal: halmos/Certora (MAY) |
| Solana | Anchor | v1.2.1 (2026-10-06) | — |
| Frontend chain | viem + wagmi | viem 2.57.5 · wagmi 4.2.1 | ethers.js |
| Oracle | Chainlink Data Feeds / Uniswap TWAP | — | Pyth |
| Ví admin | Safe (multisig) + timelock | — | — |
| Chuẩn kiểm thử/bảo mật | OWASP Smart Contract Top 10 (2025) · EEA EthTrust Security Levels v3 (03/2025) | — | — |

## Checklist

- [ ] `PRF-CHAIN-001` **MUST** Có ADR pháp lý trước khi code: sản phẩm thuộc loại gì (token/dịch vụ/sàn), thị trường nào, giấy phép cần, cam kết **không** dùng crypto làm phương tiện thanh toán cho người dùng VN; luật sư ký. → Kiểm: `docs/adr/*-legal.md` có mục cấm/giấy phép và chữ ký review; checklist [`../16-compliance-privacy/README.md`](../16-compliance-privacy/README.md). · Nguồn: NĐ 52/2024/NĐ-CP Đ.3 k.10, Đ.6 k.6; NQ 05/2025/NQ-CP; MiCA (EU) 2023/1114
- [ ] `PRF-CHAIN-002` **MUST** Mọi bất biến tiền tệ (tổng balance = totalSupply, không tạo tiền từ không, không rút quá ký quỹ) có **invariant/fuzz test**; unit test cho mọi nhánh revert; coverage theo ngưỡng ADR cho hàm chuyển giá trị. → Kiểm: `forge test` (gồm `invariant_*`) exit 0 trong CI; `forge coverage` báo cáo đạt ngưỡng; Echidna/Medusa chạy nightly không tìm được counterexample.
- [ ] `PRF-CHAIN-003` **MUST** Static analysis 0 phát hiện High/Medium chưa xử lý (mỗi triage có lý do ghi file). → Kiểm: `slither . --fail-medium` exit 0 trong CI; file `slither.config.json`/triage có lý do từng mục bỏ qua. · Nguồn: EthTrust v3 Level [S]
- [ ] `PRF-CHAIN-004` **MUST** Chống reentrancy: checks-effects-interactions, `ReentrancyGuard` cho hàm có external call, không gọi ra ngoài trước khi cập nhật state; không tin `msg.sender` là EOA. → Kiểm: detector `reentrancy-*` của Slither sạch; test contract tấn công re-enter → revert. · Nguồn: OWASP SC05 Reentrancy
- [ ] `PRF-CHAIN-005` **MUST** Access control tường minh (`Ownable2Step`/`AccessControl`); quyền admin là **multisig** + **timelock** cho nâng cấp/đổi tham số; không có hàm đặc quyền không bảo vệ. → Kiểm: test mọi hàm `onlyOwner/onlyRole` gọi từ tài khoản thường → revert; script deploy gán owner = địa chỉ Safe + timelock; Slither `unprotected-*` sạch. · Nguồn: OWASP SC01 Access Control
- [ ] `PRF-CHAIN-006` **MUST** Oracle: không dùng giá spot của AMM làm oracle; feed có kiểm **staleness** và **bounds**; fallback/pause khi oracle lỗi. → Kiểm: test feed trả giá cũ quá ngưỡng → revert/pause; test giá ngoài biên → revert. · Nguồn: OWASP SC02 Price Oracle Manipulation, SC07 Flash Loan
- [ ] `PRF-CHAIN-007` **MUST** Upgradeability là quyết định ADR: mặc định **bất biến**; nếu proxy (UUPS/transparent) thì storage layout được kiểm tự động, `initializer` bảo vệ, `_authorizeUpgrade` chỉ multisig+timelock. → Kiểm: `openzeppelin-upgrades` validate storage trong CI; test gọi `initialize` lần 2 → revert; test upgrade từ tài khoản thường → revert.
- [ ] `PRF-CHAIN-008` **MUST** Quản lý khoá: khoá deploy/admin trong hardware wallet/HSM/KMS; tách deployer và admin; không private key/mnemonic trong env, CI log, repo; ký qua signer service. → Kiểm: gitleaks full history sạch; CI không có biến `PRIVATE_KEY` (chỉ ARN/ID signer); runbook xoay khoá (chi tiết → [`../12-security/secrets-management.md`](../12-security/secrets-management.md)).
- [ ] `PRF-CHAIN-009` **MUST@M** Audit bảo mật **độc lập** trước khi deploy mainnet cho contract giữ giá trị; mọi phát hiện High/Critical đã sửa và được re-audit; báo cáo công khai cùng commit hash. → Kiểm: `audits/<ngày>-<hãng>.pdf` + bảng phát hiện → commit sửa; deploy script từ chối nếu commit ≠ commit đã audit.
- [ ] `PRF-CHAIN-010` **MUST** Gas: snapshot trong CI, regression vượt ngưỡng fail; không vòng lặp không giới hạn trên mảng do người dùng kiểm soát (DoS). → Kiểm: `forge snapshot --check` exit 0; Slither `calls-loop`/`costly-loop` sạch; test mảng lớn không vượt block gas limit. · Nguồn: OWASP SC10 DoS
- [ ] `PRF-CHAIN-011` **MUST** Số học: Solidity ≥ 0.8 checked; mọi khối `unchecked` có comment chứng minh an toàn và test biên; không ép kiểu thu hẹp im lặng. → Kiểm: lint/grep `unchecked` phải đi kèm `// SAFETY:`; test overflow biên. · Nguồn: OWASP SC08 Integer Overflow/Underflow
- [ ] `PRF-CHAIN-012` **MUST** Validate input mọi hàm public/external: zero address, amount > 0 và ≤ giới hạn, deadline, slippage; external call kiểm return value. → Kiểm: test từng hàm với địa chỉ 0/amount 0/deadline quá hạn → revert; Slither `unchecked-transfer`/`unused-return` sạch. · Nguồn: OWASP SC04, SC06
- [ ] `PRF-CHAIN-013` **MUST** Ngẫu nhiên không lấy từ `block.timestamp`/`blockhash`/`prevrandao` cho giá trị có thể bị khai thác; dùng VRF hoặc commit-reveal. → Kiểm: grep nguồn ngẫu nhiên on-chain trong contract có giá trị → 0 (ngoại lệ có ADR). · Nguồn: OWASP SC09 Insecure Randomness
- [ ] `PRF-CHAIN-014` **MUST** Deploy tái lập và minh bạch: script deploy trong repo, địa chỉ + chain id + commit ghi `deployments/<chain>.json`, source **verified** trên explorer, pragma ghim exact (`pragma solidity 0.8.x;`), phiên bản OZ ghim. → Kiểm: `forge verify-contract` thành công; CI fail khi pragma dùng `^`; `deployments.json` cập nhật trong cùng PR.
- [ ] `PRF-CHAIN-015` **MUST** Kế hoạch sự cố: cơ chế `pause` (circuit breaker) do multisig kích, giám sát event bất thường (rút lớn, đổi owner) có cảnh báo, bug bounty công bố, runbook theo [`../15-operations/incident-response.md`](../15-operations/incident-response.md). → Kiểm: test pause chặn mọi hàm chuyển giá trị; alert đã kích thử; `SECURITY.md` có bounty/liên hệ.
- [ ] `PRF-CHAIN-016` **MUST** dApp frontend: không private key/mnemonic trong client; ký bằng ví người dùng với EIP-712 typed data có `chainId` + `verifyingContract`; hiển thị rõ nội dung giao dịch trước khi ký; chống phishing (domain, approval không giới hạn cảnh báo). → Kiểm: test chữ ký replay chain khác → revert; UI test màn ký hiện số tiền/đích; scan bundle không chứa secret (frontend chung → ghép `web-app`).
- [ ] `PRF-CHAIN-017` **MUST@L** Dịch vụ tài sản mã hoá cho người dùng EU/VN (sàn, ví lưu ký): giấy phép CASP (MiCA) / giấy phép Bộ Tài chính (NQ 05/2025), KYC/AML, báo cáo giao dịch; không có → không ra mắt. → Kiểm: hồ sơ giấy phép trong `docs/compliance/`; luồng KYC có test; checklist [`../16-compliance-privacy/records-and-audit-readiness.md`](../16-compliance-privacy/records-and-audit-readiness.md). · Nguồn: MiCA (EU) 2023/1114; NQ 05/2025/NQ-CP
- [ ] `PRF-CHAIN-018` **SHOULD** Fork test mainnet (anvil `--fork-url`) cho tích hợp với protocol ngoài; mô phỏng kịch bản flash loan/MEV. → Kiểm: job CI `fork-test` xanh với RPC archive.
- [ ] `PRF-CHAIN-019` **SHOULD** Emit event cho mọi thay đổi state; NatSpec đầy đủ hàm public; indexer/subgraph đọc từ event. → Kiểm: Slither `events-*` sạch; `forge doc` không cảnh báo thiếu NatSpec.
- [ ] `PRF-CHAIN-020` **MAY** Formal verification (halmos/Certora) cho bất biến lõi; EthTrust Level [Q] cho contract giữ giá trị lớn. → Kiểm: báo cáo trong `audits/`.

## Cổng chất lượng tương đương

| Cổng chung | Tương đương blockchain | Công cụ / lệnh |
|---|---|---|
| Core Web Vitals | Gas per hàm (snapshot), chi phí deploy, độ trễ RPC/indexer | `forge snapshot --check` |
| E2E trình duyệt | Invariant/fuzz + fork test + kịch bản tấn công | `forge test`, Echidna, anvil fork |
| Type check | Slither + compiler warnings as errors + storage layout check | `slither --fail-medium`, OZ upgrades |
| Security scan | Audit độc lập + bug bounty + monitor on-chain | Báo cáo audit, alert |
| Rollback DB | `pause` + timelock + kế hoạch migrate (contract bất biến không rollback) | Test pause, runbook |
| Coverage | `forge coverage` trên hàm chuyển giá trị + tỷ lệ bất biến có invariant test | CI artifact |

## Bẫy

1. **Dùng giá spot AMM làm oracle** — flash loan bóp méo trong một block, rút sạch pool (SC02/SC07).
2. **Gọi external trước khi cập nhật state** — reentrancy cổ điển (SC05).
3. **Owner là EOA một người, không timelock** — mất khoá/ép buộc = mất toàn bộ; multisig + timelock (005).
4. **Proxy upgrade đổi thứ tự biến storage** — ghi đè dữ liệu người dùng; kiểm layout tự động (007).
5. **`pragma ^0.8.0`** — compile khác phiên bản đã audit; ghim exact (014).
6. **Audit một lần rồi sửa thêm code** — deploy commit chưa audit; script chặn (009).
7. **Private key trong `.env` của CI** — rò qua log/fork PR; dùng signer service (008).
8. **Thiết kế thanh toán bằng crypto cho người dùng VN** — vi phạm NĐ 52/2024, có thể bị xử lý hình sự (001).
9. **Tin `tx.origin`/`msg.sender` là người** — contract gọi được; không dùng `tx.origin` cho auth.
10. **Vòng lặp qua mảng người dùng thêm vào** — kẻ tấn công nhồi để hàm hết gas (SC10).

## Nguồn

- OWASP Smart Contract Top 10 (2025): <https://owasp.org/www-project-smart-contract-top-10/> — xác minh 2026-10-13
- EEA EthTrust Security Levels Specification v3 (03/2025, Level [S]/[M]/[Q]): <http://hub.entethalliance.org/wg-ethtrust-site/spec/v3/> — xác minh 2026-10-13
- MiCA Regulation (EU) 2023/1114 (áp dụng 30/12/2024; chuyển tiếp CASP tới 01/07/2026): <https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica> — xác minh 2026-10-13 (EUR-Lex trả trang trống)
- Nghị định 52/2024/NĐ-CP (thanh toán không dùng tiền mặt) Điều 3 k.10, Điều 6 k.6; BLHS Điều 206 — xác minh 2026-10-13 **qua nguồn thứ cấp** (luatvietan.vn, thuviennhadat.vn, baophapluat.vn); đối chiếu bản gốc vanban.chinhphu.vn; kiểm tra văn bản sửa đổi
- Nghị quyết 05/2025/NQ-CP (09/09/2025) thí điểm thị trường tài sản mã hoá: <https://luatvietnam.vn/tin-van-ban-moi/tai-toan-van-nghi-quyet-05-2025-nq-cp-ve-trien-khai-thi-diem-thi-truong-tai-san-ma-hoa-186-103979-article.html> — xác minh 2026-10-13 qua nguồn thứ cấp (thời hạn 5 năm: theo tin, chưa thấy trong trích dẫn văn bản)
- Luật Công nghiệp công nghệ số 71/2025/QH15 (hiệu lực 01/01/2026): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Luat-Cong-nghiep-cong-nghe-so-2025-so-71-2025-QH15-621341.aspx> — ngày/số hiệu xác minh qua tìm kiếm 2026-10-13; **điều khoản về tài sản mã hoá chưa xác minh** (trang trả 403)
- Phiên bản: <https://github.com/foundry-rs/foundry/releases/latest> v1.8.5; <https://registry.npmjs.org/hardhat/latest> 3.19.0; `@openzeppelin/contracts` 5.6.1; `viem` 2.57.5; `wagmi` 4.2.1; <https://pypi.org/project/slither-analyzer/> 0.11.6; <https://github.com/crytic/echidna/releases/latest> 2.3.3; <https://github.com/solana-foundation/anchor/releases/latest> v1.2.1 — xác minh 2026-10-13
- (chưa xác minh) Phiên bản Solidity hiện hành — endoflife.date không có sản phẩm Solidity (link gốc 404); tra tài liệu chính thức <https://docs.soliditylang.org/en/latest/> (HTTP 200, xác minh 2026-10-14) hoặc bản phát hành của trình biên dịch trước khi chốt.
- Khung cũ X-stored PHẦN C9 (commit `1b80fe4`).
