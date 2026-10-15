---
title: Bảo mật
kind: index
updated: 2026-10-13
---

# 12 — Bảo mật

> Bảy module phòng thủ: bắt đầu bằng **threat model** ở G4 để biết tài sản và ranh giới, rồi ghép đúng module theo ranh giới có thật
> (web/API, bí mật, chuỗi cung ứng, hạ tầng, AI). Mọi mục đều kiểm được bằng máy (SAST/DAST/scanner/test/cấu hình); scanner xanh
> không thay test quyền tự viết. Xác thực/phân quyền ở `08-backend/authn-authz.md`; sự cố vận hành ở `15-operations/incident-response.md`;
> luật và quyền riêng tư ở `16-compliance-privacy/`.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`threat-modeling.md`](threat-modeling.md) | Threat model (STRIDE), tài sản, ranh giới tin cậy, biện pháp | G4 thiết kế; mỗi khi thêm tích hợp/ranh giới mới; sau sự cố bảo mật |
| [`appsec-web.md`](appsec-web.md) | AppSec web/API: injection, XSS, CSRF, SSRF, IDOR, header, CSP, upload, SAST/DAST | Dự án có HTTP endpoint (web, API, agent có web UI); G5 dựng cổng SAST/DAST; G7 trước phát hành |
| [`secrets-management.md`](secrets-management.md) | Quản lý bí mật: lưu, xoay, quét, phạm vi | G5 dựng nền (gitleaks, kho bí mật); khi thêm tích hợp cần khoá; khi lộ khoá |
| [`supply-chain.md`](supply-chain.md) | Chuỗi cung ứng: ghim SHA/digest, lockfile, SBOM, chữ ký, SLSA, Scorecard, Dependabot, CI có AI, skill/MCP | G5 viết CI; khi thêm dependency/action/skill; release |
| [`infrastructure-and-network.md`](infrastructure-and-network.md) | Hạ tầng & mạng: IAM tối thiểu, egress allowlist, TLS, container, sandbox, WAF | G5–G7 khi dựng hạ tầng; khi chạy code không tin (agent, plugin) |
| [`ai-security.md`](ai-security.md) | Bảo mật AI: prompt injection, tool allowlist, HITL, kill switch, OWASP LLM/ASI/MCP | Hồ sơ ai-agent/agentic-system; bất kỳ tính năng gọi LLM/tool/MCP |
| [`logging-audit-and-incident.md`](logging-audit-and-incident.md) | Log bảo mật, audit trail HMAC, phát hiện, nối sang ứng phó | G5 dựng logging; G8 vận hành; trước audit/kiểm toán |
