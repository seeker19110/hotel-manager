---
title: Giao thức: MCP, A2A, AG-UI, Agent Skills, AGENTS.md
kind: module
prefix: AI-PROTO
applies_to: [ai-agent, agentic-system, data-ml]
updated: 2026-11-01
---

# Giao thức: MCP, A2A, AG-UI, Agent Skills, AGENTS.md

> Module này quy định cách **dùng và xuất bản** các giao thức/quy ước agent: MCP (tool/resource cho model), A2A
> (agent gọi agent liên tổ chức), AG-UI (agent ↔ giao diện), Agent Skills (SKILL.md) và `AGENTS.md`. Trọng tâm:
> kiểm trước khi cài, OAuth cho MCP từ xa, Inspector trong CI, token không passthrough. Mối đe doạ MCP/supply chain
> ở [`../12-security/ai-security.md`](../12-security/ai-security.md) và [`../12-security/supply-chain.md`](../12-security/supply-chain.md); nội dung `AGENTS.md` ở [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md).

## Nguyên tắc

1. **MCP server là dependency chạy mã**: kiểm như thư viện (owner, repo còn sống, giấy phép, quyền nó cần) trước khi cài; ưu tiên server chính chủ hoặc tự host.
2. **Remote MCP = API có auth**: OAuth 2.1 + PKCE, resource indicator, audience validation; token của người dùng **không** chuyển tiếp (passthrough) sang dịch vụ sau.
3. **Tool list là hợp đồng**: `tools/list` tất định, tool có schema; thay đổi tool = thay đổi API → version + test.
4. **Agent gọi agent cần danh tính**: Agent Card có chữ ký, scheme auth rõ; dữ liệu agent khác trả về là untrusted.
5. **Skill là mã chạy trong ngữ cảnh**: SKILL.md và script đi kèm được review/audit như code; nạp theo tầng (progressive disclosure).
6. **`AGENTS.md` là quy ước, không phải schema**: ngắn, lệnh thật, link module; không nhét toàn bộ tài liệu.

## Quyết định

### Chọn giao thức theo nhu cầu

| Nhu cầu | Giao thức | Khi nào không |
|---|---|---|
| Cho model dùng tool/resource của dịch vụ nội bộ hoặc bên thứ ba | MCP (spec 2026-07-28) | Chỉ cần 1–2 hàm nội bộ → tool trực tiếp đơn giản hơn |
| Hai agent của hai tổ chức/nền tảng trao đổi task | A2A v1.0.1 | Nội bộ cùng hệ → queue/gọi hàm |
| Giao diện hiển thị trạng thái agent, stream sự kiện | AG-UI | Giao diện đơn giản → SSE/WebSocket tự định nghĩa |
| Đóng gói quy trình/kiến thức cho agent dùng lặp lại | Agent Skills (SKILL.md) | Luật toàn repo → `AGENTS.md` |
| Luật cho mọi agent trong repo | `AGENTS.md` (+ `CLAUDE.md` import) | — |

### Checklist trước khi cài MCP server

Owner là ai (tổ chức chính chủ của dịch vụ?) · repo còn maintain (commit/release gần, không archive) · giấy phép
· chạy local hay hosted (ai thấy dữ liệu?) · quyền tối thiểu (token scope) · pin phiên bản/SHA · chạy Inspector
để xem tool/tham số thật · ghi vào bảng dependency có ngày xác minh.

### SDK (xác minh 2026-10-13)

| Hệ | Gói | Phiên bản |
|---|---|---|
| MCP Python | `mcp` | 2.3.0 (PyPI 2026-10-02) |
| MCP TypeScript | `@modelcontextprotocol/server` · `@modelcontextprotocol/client` (dòng v2) | 2.3.1 (npm); tag `latest` của `@modelcontextprotocol/sdk` vẫn là 1.32.1 (dòng v1) — chọn có chủ đích |
| MCP Inspector | `@modelcontextprotocol/inspector` | 2.10.1 (npm) |
| A2A Python | `a2a-sdk` | 1.2.2 (PyPI 2026-10-05) |

### Remote MCP — yêu cầu auth (spec 2026-07-28, MUST của spec)

Protected Resource Metadata (RFC 9728) · resource indicators (RFC 8707) · PKCE · audience validation · không token
passthrough · scope tối thiểu. Server phát `WWW-Authenticate` chuẩn; client kiểm `iss` (RFC 9207) khi có.

## Checklist

- [ ] `AI-PROTO-001` **MUST** Mỗi MCP server trước khi cài có bản ghi: owner, trạng thái repo (không archive, release ≤ 12 tháng), giấy phép, local/hosted, quyền cần, phiên bản pin, ngày xác minh. → Kiểm: bảng trong `docs/` hoặc ADR; thiếu → không cài. · Nguồn: [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `AI-PROTO-002` **MUST** MCP server từ xa (HTTP) dùng OAuth 2.1 + PKCE, PRM (RFC 9728), resource indicator (RFC 8707), kiểm audience; không dùng API key tĩnh trong URL. → Kiểm: test token sai audience bị từ chối; metadata endpoint trả PRM. · Nguồn: MCP spec Authorization
- [ ] `AI-PROTO-003` **MUST** Token người dùng nhận ở MCP server không chuyển tiếp sang dịch vụ sau (no passthrough); server đổi lấy token riêng với scope tối thiểu. → Kiểm: review code; test upstream nhận token khác token client. · Nguồn: MCP spec Security Best Practices
- [ ] `AI-PROTO-004` **MUST** Tool/resource từ MCP đi qua allowlist tool + policy validator của ứng dụng như tool nội bộ; mô tả tool từ server là untrusted (tool poisoning). → Kiểm: test server trả mô tả tool chứa chỉ thị → không thay đổi hành vi. · Nguồn: [`agents-and-tools.md`](agents-and-tools.md)
- [ ] `AI-PROTO-005` **MUST@L** `tools/list` của server tự xuất bản là tất định và có phiên bản; thay đổi schema tool là breaking change có changelog. → Kiểm: test snapshot `tools/list`; CI chạy Inspector/CLI so snapshot. · Nguồn: MCP spec 2026-07-28
- [ ] `AI-PROTO-006` **MUST@L** Server MCP tự xuất bản kiểm tham số lúc chạy (schema + quyền) và không tin client; log có `traceparent` từ `_meta` khi có. → Kiểm: test tham số sai bị từ chối; trace nối được.
- [ ] `AI-PROTO-007` **MUST@L** A2A: Agent Card có chữ ký kiểm được, auth scheme khai rõ; task/artefact từ agent ngoài là untrusted và qua guardrail trước khi dùng. → Kiểm: test card chữ ký sai bị từ chối. · Nguồn: A2A v1.0.1 spec
- [ ] `AI-PROTO-008` **MUST@L** Skill (SKILL.md + script) được review như code, có chủ sở hữu, không nạp từ nguồn không kiểm; script không được cấp quyền rộng hơn agent. → Kiểm: skill nằm trong repo, có PR review; không `curl | sh` trong skill. · Nguồn: Agent Skills spec
- [ ] `AI-PROTO-009` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-006`](../18-cross-cutting/docs-for-ai-agents.md) (`AGENTS.md` ≤ 200 dòng), `XC-DOCAI-002` (`CLAUDE.md` import `@AGENTS.md`) và `XC-DOCAI-003` (lệnh trong file máy đọc).
- [ ] `AI-PROTO-010` **SHOULD** Chạy MCP Inspector (2.10.1) trong CI/pre-merge cho server tự xuất bản: liệt kê tool, gọi thử với tham số biên, so snapshot. · Nguồn: MCP Inspector
- [ ] `AI-PROTO-011` **SHOULD** Chọn dòng SDK có chủ đích (TS: `@modelcontextprotocol/server`/`client` 2.x hay `sdk` 1.x) và ghi ADR; không để `latest` quyết.
- [ ] `AI-PROTO-012` **SHOULD** Server MCP từ xa là stateless theo spec mới (handle thay vì session dài), hỗ trợ `CacheableResult` khi phù hợp; eval lại khi nâng spec. · Nguồn: MCP spec 2026-07-28
- [ ] `AI-PROTO-013` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`XC-DOCAI-009`](../18-cross-cutting/docs-for-ai-agents.md): cấu trúc `SKILL.md` theo Agent Skills spec (`name`, `description`, body < 500 dòng, tài liệu phụ theo tầng).
- [ ] `AI-PROTO-014` **SHOULD** AG-UI hoặc giao thức sự kiện riêng: sự kiện có `run_id`, trạng thái bước, lý do dừng; giao diện hiển thị theo [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md).
- [ ] `AI-PROTO-015` **SHOULD** Giới hạn số MCP server bật đồng thời (mỗi server thêm tool vào context); đo token của `tools/list` tổng. · Nguồn: [`../11-autonomous-loop/context-and-token-budget.md`](../11-autonomous-loop/context-and-token-budget.md)
- [ ] `AI-PROTO-016` **MAY** Xuất bản MCP server của sản phẩm cho khách: kèm PRM, tài liệu scope, rate limit, changelog tool; coi như API công khai. · Nguồn: [`../08-backend/api-design.md`](../08-backend/api-design.md)
- [ ] `AI-PROTO-017` **MAY** Dùng A2A giữa các team nội bộ chỉ khi ranh giới tổ chức/nền tảng thật sự khác; không dùng để thay queue nội bộ.
- [ ] `AI-PROTO-018` **SHOULD** Server/client MCP không dùng cho code mới các tính năng nằm trong sổ Deprecated của spec đang ghim. Với 2026-07-28 gồm: Roots, Sampling (kể cả `includeContext: thisServer/allServers`), Logging, Dynamic Client Registration, transport HTTP+SSE. Code cũ có ADR di trú trước mốc gỡ sớm nhất ghi trong sổ: tham số tool/URI resource, gọi thẳng API nhà cung cấp, stderr/OTel, Client ID Metadata Documents, Streamable HTTP. Mốc gỡ sớm nhất: bản phát hành từ 2027-07-28 cho 4 tính năng đầu; 3 tháng sau khi SEP-2596 Final cho HTTP+SSE. → Kiểm: lint/grep trong CI: `roots/list`, `sampling/createMessage`, `logging/setLevel`, `notifications/message`, endpoint đăng ký client động, transport SSE cũ → đỏ trừ khi file nằm trong allowlist có ADR di trú kèm ngày. · Nguồn: MCP spec 2026-07-28 *Deprecated features* (SEP-2577, SEP-2596)
- [ ] `AI-PROTO-019` **MUST@L** Khi server/client MCP dùng elicitation: server không xin mật khẩu/API key/access token/thông tin thanh toán qua form mode mà dùng URL mode. URL không chứa thông tin nhạy cảm/PII của người dùng và không được tiền xác thực. Server bảo đảm người mở và hoàn tất URL chính là người khởi tạo elicitation, vd so `sub` của phiên đăng nhập với `sub` từ MCP authorization; không tin định danh do client khai. Client hiển thị server nào đang hỏi và URL đầy đủ (làm nổi domain), xin đồng ý trước khi mở, không tự prefetch, và mở trong trình duyệt/view mà client và LLM không đọc được nội dung. → Kiểm: test server: lint schema form tách tên/tiêu đề trường thành từ (snake/camel) rồi so **theo từ, cả số nhiều** với danh sách từ cấm (`password`, `passwd`, `pass`, `passcode`, `passphrase`, `pwd`, `pin`, `secret`, `token`, `apikey`/`api key`, `card` — gồm `cardNo`, `creditCard`, `card_num` —, `cvv`, `cvc`, `iban`) → bị từ chối, allowlist có lý do cho trường hợp lệ (`max_tokens`, `passenger_count`, `card_title`); test URL elicitation mở bởi user khác `sub` → bị từ chối; test client: không có request mạng tới URL trước khi người dùng đồng ý, UI hiển thị domain và tên server. · Nguồn: MCP spec 2026-07-28 *Client — Elicitation* (MUST/MUST NOT)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Cài MCP server từ repo lạ "có nhiều sao" | Mã chạy với token của bạn | Checklist trước khi cài, pin SHA |
| API key tĩnh trong URL server từ xa | Lộ key qua log/proxy | OAuth 2.1 + PKCE |
| Passthrough token người dùng | Confused deputy, vượt scope | Đổi token riêng |
| Tin mô tả tool của server | Tool poisoning đổi hành vi | Mô tả là untrusted; allowlist |
| `npm i @modelcontextprotocol/sdk@latest` nghĩ là mới nhất | Dòng 1.x, API khác 2.x | Chọn dòng có chủ đích |
| 15 MCP server bật cùng lúc | Context đầy tool, chọn sai | Giới hạn; nạp theo ngữ cảnh |
| Skill tải từ internet lúc chạy | Supply chain | Skill trong repo, review |
| `AGENTS.md` 800 dòng | Agent bỏ qua, tốn token | ≤ 200 dòng, link (`XC-DOCAI-006`) |

## Cổng tự động

| Việc | Công cụ → lệnh | Đặt ở đâu | Ngưỡng |
|---|---|---|---|
| Snapshot tool | `npx @modelcontextprotocol/inspector --cli <server> --method tools/list` so snapshot | CI | Diff = 0 hoặc có changelog |
| Auth remote MCP | Test PRM endpoint, token sai audience | CI | Từ chối đúng |
| Dependency MCP | Bảng server có ngày xác minh; pin SHA | Review PR | Thiếu → đỏ |
| AGENTS.md | `wc -l AGENTS.md` ≤ 200; lệnh khớp `xt.yaml` (theo [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md)) | Cổng commit | Xanh |
| Skill | Review PR + lint không có tải mã lúc chạy | Repo | Bắt buộc |

## Nguồn

- MCP specification 2026-07-28 (stateless, handles, `tools/list` tất định, `_meta.traceparent`, `CacheableResult`): <https://modelcontextprotocol.io/specification/2026-07-28> · Authorization (OAuth 2.1, PRM RFC 9728, RFC 8707, PKCE, RFC 9207): <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> · Security Best Practices (no token passthrough): <https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §4).
- SDK: `mcp` 2.3.0 <https://pypi.org/project/mcp/> · `@modelcontextprotocol/server` 2.3.1 <https://www.npmjs.com/package/@modelcontextprotocol/server> · `@modelcontextprotocol/client` 2.3.1 · `@modelcontextprotocol/sdk` latest 1.32.1 <https://www.npmjs.com/package/@modelcontextprotocol/sdk> · `@modelcontextprotocol/inspector` 2.10.1 <https://www.npmjs.com/package/@modelcontextprotocol/inspector> · `a2a-sdk` 1.2.2 <https://pypi.org/project/a2a-sdk/> — xác minh 2026-10-13.
- A2A protocol v1.0.1 (Agent Card có chữ ký, task states, auth schemes): <https://a2a-protocol.org/latest/specification/> — xác minh 2026-10-13 (`research/2026-10-13-ai-agent-research.md` §4).
- AG-UI (bản release/2026-10-12): <https://docs.ag-ui.com/> — xác minh 2026-10-13 theo research; số phiên bản gói (chưa xác minh).
- Agent Skills spec (SKILL.md `name`/`description`, progressive disclosure, < 500 dòng): <https://agentskills.io/specification> · AGENTS.md (quy ước, > 60k dự án): <https://agents.md/> — xác minh 2026-10-13.
- Roots/Sampling/Logging (SEP-2577) và Dynamic Client Registration (PR #2858) deprecated ở 2026-07-28, gỡ sớm nhất ở bản phát hành từ 2027-07-28; includeContext thisServer/allServers deprecated 2025-11-25; HTTP+SSE deprecated 2025-03-26, gỡ sớm nhất 3 tháng sau khi SEP-2596 Final; 'new implementations SHOULD NOT adopt it, existing implementations SHOULD migrate' (`AI-PROTO-018`): <https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md> — xác minh 2026-10-30.
- Spec latest = 2026-07-28 (`AI-PROTO-018`): <https://modelcontextprotocol.io/specification/latest> — chưa đọc trọn trang 2026-10-30 (chưa xác minh trọn).
- Servers MUST NOT dùng form mode cho mật khẩu, API key, access token, thông tin thanh toán và MUST dùng URL mode; URL MUST NOT chứa thông tin nhạy cảm/PII và MUST NOT tiền xác thực; client MUST NOT prefetch, MUST NOT mở khi chưa đồng ý, MUST hiện URL đầy đủ, MUST mở sao cho client/LLM không xem được; server MUST bảo đảm người hoàn tất trùng người khởi tạo (so `sub` là ví dụ không chuẩn tắc); URL mode có từ 2025-11-25 (`AI-PROTO-019`): <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation> — xác minh 2026-10-30.
