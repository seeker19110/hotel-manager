// F-006 Vòng tự động, việc chờ người, quyết định (SPEC-app §4): việc cần người đứng đầu; D-NNN có tìm; ADR.
function decision(h, d) {
  return h("li", null,
    h("details", null, h("summary", null, h("strong", null, d.id), " · " + d.question),
      h("p", { class: "muted" }, d.at),
      h("ol", null, d.options.map((o) => h("li", null, o))),
      h("p", null, "Chọn: " + d.choice),
      h("p", null, "Lý do: " + d.why),
      h("p", null, "Đường lùi: " + d.revert)));
}

export async function render(main, { api, h, loading, empty, error }) {
  const human = h("section", null);
  const state = h("section", null);
  const q = h("input", { type: "search", id: "dec-q", placeholder: "Tìm trong quyết định" });
  const decs = h("div", null);
  const adrs = h("section", null);
  main.replaceChildren(
    h("h1", null, "Vòng tự động"),
    h("h2", null, "Việc cần người"), human,
    h("h2", null, "Trạng thái vòng"), state,
    h("h2", null, "Quyết định (D-NNN)"), h("label", { for: "dec-q" }, "Tìm "), q, decs,
    h("h2", null, "ADR"), adrs,
  );

  async function loadLoop() {
    loading(human);
    try {
      const d = await api("/api/loop");
      human.replaceChildren(d.deferred.length
        ? h("ul", null, d.deferred.map((x) => h("li", null, h("strong", null, x.id), " — " + x.reason + (x.at ? " (" + x.at + ")" : ""))))
        : h("p", null, "Không có việc chờ người."));
      state.replaceChildren(h("p", null, h("strong", null, d.verdict), d.reason ? " — " + d.reason : ""),
        h("p", { class: "muted" }, "Vòng " + (d.iterations ?? "—") + "/" + (d.max_iterations ?? "—") + (d.deadline ? " · hạn " + d.deadline : "")),
        h("p", null, "Kiểm: ", h("code", null, "python3 scripts/xt.py loop status")));
    } catch (e) {
      error(human, e, loadLoop);
    }
  }

  async function loadDecisions() {
    loading(decs);
    try {
      const v = q.value.trim();
      const d = await api("/api/decisions" + (v ? "?q=" + encodeURIComponent(v) : ""));
      if (!d.decisions.length) return empty(decs, "Không có quyết định khớp.");
      decs.replaceChildren(h("ul", { class: "items" }, d.decisions.map((x) => decision(h, x))),
        d.truncated ? h("p", { class: "muted" }, "Chỉ hiện 200 mục mới nhất.") : null);
    } catch (e) {
      error(decs, e, loadDecisions);
    }
  }

  async function loadAdrs() {
    loading(adrs);
    try {
      const d = await api("/api/adrs");
      if (!d.adrs.length) return empty(adrs, "Chưa có ADR.");
      adrs.replaceChildren(h("ul", { class: "items" }, d.adrs.map((a) =>
        h("li", null, h("strong", null, "ADR-" + String(a.number).padStart(4, "0")), " " + a.title, h("p", { class: "muted" }, a.status || "—")))));
    } catch (e) {
      error(adrs, e, loadAdrs);
    }
  }

  let timer = null;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(loadDecisions, 300); });
  await Promise.all([loadLoop(), loadDecisions(), loadAdrs()]);
}
