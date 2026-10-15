---
title: Kỹ thuật AI
kind: index
updated: 2026-10-13
---

# 13 — Kỹ thuật AI

> Mảng này áp cho mọi dự án **xây tính năng/sản phẩm có LLM** — từ một lời gọi tóm tắt trong web app tới hệ đa agent
> có tác dụng phụ thật. Thứ tự đọc: `llm-app-foundations` (mọi dự án có LLM) → `rag-and-knowledge`/`agents-and-tools`
> theo tính năng → `agentic-systems` khi có nhiều bước/tác dụng phụ; `evaluation`, `guardrails-and-safety`,
> `observability-and-cost` là ba cổng bắt buộc trước production. Mối đe doạ AI ở
> [`../12-security/ai-security.md`](../12-security/ai-security.md); luật/quy định AI ở
> [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md); vòng lặp **phát triển** tự động
> (agent viết code) ở [`../11-autonomous-loop/README.md`](../11-autonomous-loop/README.md). Hồ sơ không phải AI vẫn có thể ghép
> từng module bằng `xt.py compose --add 13-ai-engineering/<module>`.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`llm-app-foundations.md`](llm-app-foundations.md) | Nền ứng dụng LLM: chọn model, prompt-as-code, structured output, chi phí | Mọi dự án có bất kỳ lời gọi LLM nào; trước khi viết prompt đầu tiên; khi chọn model/định dạng đầu ra |
| [`rag-and-knowledge.md`](rag-and-knowledge.md) | RAG & tri thức: chunking, hybrid search, rerank, quyền, eval | Khi trả lời dựa trên tài liệu/tri thức nội bộ; khi thiết kế index, quyền truy cập tài liệu |
| [`agents-and-tools.md`](agents-and-tools.md) | Agent & tool: ACI, allowlist, schema, HITL, memory | Khi model được gọi tool/hành động; khi thiết kế tool, allowlist, duyệt hành động, memory |
| [`agentic-systems.md`](agentic-systems.md) | Hệ agentic: đa agent, durable execution, outbox, ranh giới ủy quyền | Khi có nhiều bước/nhiều agent với tác dụng phụ thật; khi chọn runtime durable, outbox, kill switch |
| [`evaluation.md`](evaluation.md) | Eval: offline/online, pass^k, negative control, record/replay, judge | Trước khi đưa tính năng LLM vào CI/production; khi đổi prompt/model/pipeline; khi báo cáo chất lượng |
| [`guardrails-and-safety.md`](guardrails-and-safety.md) | Guardrail runtime, chính sách nội dung, fallback, an toàn người dùng | Khi tính năng tiếp xúc người dùng cuối hoặc dữ liệu nhạy cảm; khi viết chính sách nội dung |
| [`protocols-mcp-a2a.md`](protocols-mcp-a2a.md) | Giao thức: MCP, A2A, AG-UI, Agent Skills, AGENTS.md | Trước khi cài/xuất bản MCP server; khi nối agent liên tổ chức; khi viết SKILL.md/AGENTS.md |
| [`observability-and-cost.md`](observability-and-cost.md) | Quan sát & chi phí: trace OTel GenAI, token, gateway, failover | Khi lên production; khi cần chi phí theo tenant, failover nhà cung cấp, trace agent |
| [`data-and-fine-tuning.md`](data-and-fine-tuning.md) | Dữ liệu, fine-tuning, dataset, bản quyền, PII trong dữ liệu huấn luyện | Khi xây dataset eval/few-shot; khi cân nhắc fine-tune; khi dùng dữ liệu khách hàng/web để huấn luyện |
