// F-004 Tiến độ blueprint (SPEC-app §4): tiến độ tổng và theo module, MUST chưa đạt có lọc, lệnh kiểm để chép.
function bar(h, done, total, label) {
  return h("div", { class: "meter" }, h("span", null, label + ": " + done + "/" + total),
    h("progress", { max: String(total || 1), value: String(done), "aria-label": label }));
}

export async function render(main, { api, h, loading, empty, error }) {
  const body = h("div", null);
  main.replaceChildren(h("h1", null, "Tiến độ blueprint"), body);

  function openList(items) {
    const filter = h("input", { type: "search", id: "bp-filter", placeholder: "Lọc theo ID, module, chữ" });
    const list = h("ul", { class: "items" });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = items.filter((it) => !q || (it.id + " " + it.module + " " + it.text).toLowerCase().includes(q));
      list.replaceChildren(...shown.map((it) => h("li", null, h("strong", null, it.id), " · " + it.module + " — " + it.text)));
    };
    filter.addEventListener("input", draw);
    draw();
    return [h("label", { for: "bp-filter" }, "Lọc "), filter, list];
  }

  async function load() {
    loading(body);
    try {
      const d = await api("/api/blueprint");
      if (!d.path) {
        empty(body, "Chưa có BLUEPRINT.md — ghép ở màn Ghép blueprint.");
        body.append(h("p", null, h("a", { href: "#/compose" }, "Sang màn Ghép blueprint")));
        return;
      }
      const m = d.levels.MUST;
      const s = d.levels.SHOULD;
      body.replaceChildren(
        h("p", { class: "muted" }, d.path),
        bar(h, m.done + m.waived, m.done + m.waived + m.open, "MUST đã giải quyết"),
        bar(h, s.done + s.waived, s.done + s.waived + s.open, "SHOULD đã giải quyết"),
        h("p", null, "Kiểm: ", h("code", null, d.check_cmd)),
        d.bad_lines.length ? h("div", { class: "state error", role: "alert" }, h("p", null, "Dòng lỗi:"), h("ul", null, d.bad_lines.map((x) => h("li", null, x)))) : null,
        h("h2", null, "Theo module"),
        h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Module"), h("th", null, "MUST"), h("th", null, "SHOULD"))),
          h("tbody", null, d.modules.map((x) => h("tr", null, h("td", null, x.module),
            h("td", null, x.must_done + "/" + x.must_total), h("td", null, x.should_done + "/" + x.should_total)))))),
        h("h2", null, "MUST chưa đạt (" + d.open_must.length + (d.truncated ? "+" : "") + ")"),
        ...(d.open_must.length ? openList(d.open_must) : [h("p", null, "Không còn MUST mở.")]),
      );
    } catch (e) {
      if (e.status === 404) {
        empty(body, "Chưa có BLUEPRINT.md — ghép ở màn Ghép blueprint.");
        body.append(h("p", null, h("a", { href: "#/compose" }, "Sang màn Ghép blueprint")));
        return;
      }
      error(body, e, load);
    }
  }
  await load();
}
