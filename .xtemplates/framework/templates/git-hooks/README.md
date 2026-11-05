---
title: Git hook sàn chung
kind: index
updated: 2026-11-02
---

# Git hook sàn chung (ADR-0064 lát C)

> Sàn không phụ thuộc hook của công cụ agent: chạy với Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, Grok, OpenCode
> và người. `scripts/install.py` cài vào thư mục hook của repo (`git rev-parse --git-path hooks`, theo `core.hooksPath`)
> khi dự án chưa có hook riêng — hook không mang dòng `# xtemplates-git-hook` là của dự án, giữ nguyên, gộp tay.
> `git commit --no-verify` bỏ qua hook: agent dưới harness của khung bị guard chặn cờ này; người dùng tự chịu.

| File | Chạy khi | Làm gì |
|---|---|---|
| [`pre-commit`](pre-commit) | `git commit` | `dev-task.sh gate-fast` (hay `gate` khi `commit_gate: full`); bỏ qua trong phiên Claude Code đã có hook Bash của khung (D-309) |
| [`commit-msg`](commit-msg) | `git commit` | `guard.py commit-msg`: subject ≤ 100 ký tự (`LOOP-HARNESS-029`), không ghi công AI khi `ai_attribution: forbid` (`LOOP-HARNESS-027`) |
| [`pre-push`](pre-push) | `git push` | không đẩy thẳng `main`/`master` (hay `XT_MAIN_BRANCH`), không đẩy đè, không xoá nhánh từ xa |
