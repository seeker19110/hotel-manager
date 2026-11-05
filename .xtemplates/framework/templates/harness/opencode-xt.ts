import type { Plugin } from "@opencode-ai/plugin"

// X-Templates guard cho OpenCode (ADR-0064 lát B): mọi lời gọi tool qua `xt_adapter.py opencode`; deny → throw (chặn tool).
// Không có logic ở đây — luật nằm ở guard của khung. Giới hạn: hook có thể không chạy ở `opencode run` (issue #41422).
export const XtGuard: Plugin = async ({ $, worktree }) => ({
  "tool.execute.before": async (input, output) => {
    const payload = JSON.stringify({ tool: input.tool, args: output.args, sessionID: input.sessionID, cwd: worktree })
    const adapter = `${worktree}/.xtemplates/scripts/xt_adapter.py`
    const r = await $`python3 -I -B ${adapter} opencode < ${new Response(payload)}`.nothrow().quiet()
    const out = JSON.parse(r.stdout.toString() || "{}")
    if (out.decision === "deny") throw new Error(out.reason || "X-Templates guard: chặn")
  },
})
