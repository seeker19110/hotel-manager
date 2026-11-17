// Registry sản phẩm, chỉ đọc (ADR-0068 lát E): lệch core/gói so với VERSION khung, ngoại lệ hết hạn — như `xt.py registry`.
function pack(p) {
  return p.pack ? p.pack.id + "@" + p.pack.version : "—";
}

function release(r) {
  return r ? r.version + " · " + r.date + (r.digest ? " · " + r.digest : "") : "—";
}

function exceptions(h, p) {
  if (!p.exceptions.length) return "—";
  return h("ul", null, p.exceptions.map((e) =>
    h("li", null, (p.expired.includes(e.id) ? "hết hạn · " : "") + e.id + " (" + e.until + ") — " + e.why)));
}

function table(h, products) {
  const head = ["Repo", "Owner", "Core", "Lệch core", "Gói", "Lệch gói", "Phát hành", "Ngoại lệ"];
  return h("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Bảng sản phẩm" }, h("table", null,
    h("thead", null, h("tr", null, ...head.map((x) => h("th", null, x)))),
    h("tbody", null, products.map((p) => h("tr", null,
      h("td", null, p.repo),
      h("td", null, p.owner),
      h("td", null, p.core || "—"),
      h("td", null, h("strong", null, p.core_drift)),
      h("td", null, pack(p)),
      h("td", null, p.pack_drift || "—"),
      h("td", null, release(p.release)),
      h("td", null, exceptions(h, p)))))));
}

export async function render(main, { api, h, loading, empty, error }) {
  const body = h("section", null);
  main.replaceChildren(h("h1", null, "Registry sản phẩm"), body);

  async function load() {
    loading(body);
    try {
      const d = await api("/api/registry");
      if (!d.available) {
        empty(body, "Không có registry: " + d.reason + ".");
        if (d.errors.length) body.append(h("ul", null, d.errors.map((e) => h("li", null, e))));
        return;
      }
      body.replaceChildren(
        h("p", null, "Khung " + (d.version || "không rõ VERSION") + " · " + d.products.length + " sản phẩm · lệch " + d.drift
          + " · ngoại lệ hết hạn " + d.expired),
        d.products.length ? table(h, d.products) : h("p", { class: "muted" }, "Chưa có sản phẩm."),
        h("p", null, "Kiểm: ", h("code", null, "python3 scripts/xt.py registry --strict")));
    } catch (e) {
      error(body, e, load);
    }
  }

  await load();
}
