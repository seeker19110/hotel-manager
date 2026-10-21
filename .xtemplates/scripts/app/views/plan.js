// F-005 Kế hoạch và phân chia việc (SPEC-app §4): chọn PLAN, task theo lát, cột "Đợt" (= xt.py plan waves), bị chặn.
const STATES = { " ": "mở", x: "xong", "~": "bỏ" };

function waveIndex(waves) {
  const idx = {};
  for (const w of waves) for (const t of w.tasks) idx[t.id] = w.wave;
  return idx;
}

function taskRow(h, t, wave) {
  return h("tr", null,
    h("td", null, h("strong", null, t.id)),
    h("td", null, STATES[t.state] || t.state),
    h("td", null, wave ? String(wave) : "—"),
    h("td", null, t.tier === "deep" ? "executor-deep" : "executor"),
    h("td", null, t.title),
    h("td", null, t.gate ? h("code", null, t.gate) : "—"));
}

function warnings(h, d) {
  const out = [];
  if (d.cycles.length) out.push("Chu trình sau: " + d.cycles.join(", "));
  for (const [id, notes] of Object.entries(d.bad_links)) out.push(id + ": ghi chú hỏng — " + notes.join("; "));
  for (const [id, ids] of Object.entries(d.unknown_after)) out.push(id + ": sau: trỏ ID không có — " + ids.join(", "));
  for (const o of d.overlaps) out.push(o.tasks.join(" ∩ ") + " cùng ghi " + o.files.join(", "));
  return out.length ? h("div", { class: "state error", role: "alert" }, h("ul", null, out.map((x) => h("li", null, x)))) : null;
}

export async function render(main, { api, h, loading, empty, error }) {
  const picker = h("select", { id: "plan-pick" });
  const stateSel = h("select", { id: "plan-state" }, h("option", { value: "" }, "Mọi trạng thái"), ...Object.entries(STATES).map(([k, v]) => h("option", { value: k }, v)));
  const body = h("div", null);
  main.replaceChildren(
    h("h1", null, "Kế hoạch và phân chia việc"),
    h("div", { class: "toolbar" }, h("label", { for: "plan-pick" }, "PLAN ", picker), h("label", { for: "plan-state" }, "Trạng thái ", stateSel)),
    body,
  );

  async function show() {
    loading(body);
    try {
      const d = await api("/api/plan" + (picker.value ? "?path=" + encodeURIComponent(picker.value) : ""));
      if (!d.path) return empty(body, "Chưa có PLAN trong docs/autopilot/.");
      const wave = waveIndex(d.waves);
      const st = stateSel.value;
      const sections = d.sections.map((s) => {
        const rows = s.tasks.filter((t) => !st || t.state === st).map((t) => taskRow(h, t, wave[t.id]));
        return rows.length ? [h("h2", null, s.title || "(không mục)"), h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, ...["ID", "Trạng thái", "Đợt", "Tầng", "Việc", "Gate"].map((x) => h("th", null, x)))),
          h("tbody", null, rows)))] : [];
      });
      body.replaceChildren(
        h("p", null, "Chia đợt: ", h("code", null, "python3 scripts/xt.py plan waves --plan " + d.path)),
        h("p", null, d.waves.length + " đợt · " + d.waves.map((w) => "Đợt " + w.wave + ": " + w.tasks.map((t) => t.id).join(" · ")).join(" | ")),
        warnings(h, d),
        d.blocked.length ? h("div", null, h("h2", null, "Bị chặn"), h("ul", null, d.blocked.map((b) => h("li", null, b.id + " — " + b.reason)))) : null,
        ...sections.flat(),
      );
    } catch (e) {
      error(body, e, show);
    }
  }

  picker.addEventListener("change", show);
  stateSel.addEventListener("change", show);
  try {
    const p = await api("/api/plans");
    picker.replaceChildren(...p.plans.map((x) => h("option", { value: x.path, selected: x.active }, x.path + " (" + x.open + " mở)")));
  } catch (e) {
    return error(body, e, () => render(main, { api, h, loading, empty, error }));
  }
  await show();
}
