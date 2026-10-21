// F-001 Tổng quan (SPEC-app §4): thẻ số dẫn sang màn chi tiết; dữ liệu từ GET /api/overview.
function card(h, href, value, label) {
  return h("a", { class: "card", href }, h("div", { class: "num" }, value), h("div", { class: "label" }, label));
}

function blueprintCard(h, bp) {
  if (!bp || !bp.must_total) return card(h, "#/compose", "chưa có", "BLUEPRINT.md — ghép ở màn Ghép blueprint");
  const pct = Math.round((100 * bp.must_done) / bp.must_total);
  return card(h, "#/blueprint", pct + " %", "MUST đạt (" + bp.must_done + "/" + bp.must_total + ")");
}

function planCard(h, plan) {
  if (!plan) return card(h, "#/plan", "—", "Chưa có PLAN");
  return card(h, "#/plan", String(plan.open), "Task mở · " + plan.path);
}

export async function render(main, { api, h, loading, error }) {
  const body = h("div", null);
  main.replaceChildren(h("h1", null, "Tổng quan"), body);
  async function load() {
    loading(body);
    try {
      const d = await api("/api/overview");
      const loop = d.loop || {};
      body.replaceChildren(
        h("p", { class: "muted" }, d.project + " · khung " + (d.version || "?")),
        h(
          "div",
          { class: "cards" },
          blueprintCard(h, d.blueprint),
          planCard(h, d.plan),
          card(h, "#/loop", String(d.pending_human), "Việc chờ người"),
          card(h, "#/loop", loop.verdict || "—", "Vòng tự động"),
        ),
        loop.reason ? h("p", null, "Lý do: " + loop.reason) : null,
        d.blueprint ? null : h("p", null, "Ghép blueprint: ", h("code", null, "python3 scripts/xt.py compose --profile <p> --scale <S|M|L> --out BLUEPRINT.md")),
      );
    } catch (e) {
      error(body, e, load);
    }
  }
  await load();
}
