// F-002 Thư viện yêu cầu (SPEC-app §4): cây mảng → module, lọc mức, tìm ID/chữ (≥ 2 ký tự), chi tiết mục.
const LEVELS = ["MUST", "SHOULD", "MAY"];

function itemRow(h, it) {
  return h(
    "li",
    { class: "item" },
    h("p", null, h("strong", null, it.id), " · " + it.level + (it.scale ? " · " + it.scale : "")),
    h("p", null, it.text),
    it.check ? h("p", { class: "muted" }, "Kiểm: ", h("code", null, it.check)) : null,
    it.source ? h("p", { class: "muted" }, "Nguồn: " + it.source) : null,
  );
}

function levelFilter(h, onChange) {
  const sel = h("select", { id: "cat-level" }, h("option", { value: "" }, "Mọi mức"), ...LEVELS.map((l) => h("option", { value: l }, l)));
  sel.addEventListener("change", () => onChange(sel.value));
  return h("label", { for: "cat-level" }, "Mức ", sel);
}

export async function render(main, { api, h, loading, empty, error }) {
  const tree = h("nav", { "aria-label": "Mảng và module" });
  const detail = h("section", { "aria-live": "polite" });
  const search = h("input", { type: "search", id: "cat-q", placeholder: "VD: BASE-SEC hoặc mật khẩu", autocomplete: "off" });
  let level = "";
  let current = null;
  main.replaceChildren(
    h("h1", null, "Thư viện yêu cầu"),
    h("div", { class: "toolbar" }, h("label", { for: "cat-q" }, "Tìm ID hoặc chữ "), search, levelFilter(h, (v) => { level = v; if (current) current(); })),
    h("div", { class: "split" }, tree, detail),
  );

  function showItems(title, items, note) {
    const shown = items.filter((it) => !level || it.level === level);
    if (!shown.length) return empty(detail, "Không có mục" + (level ? " mức " + level : "") + ".");
    detail.replaceChildren(h("h2", null, title), note ? h("p", { class: "muted" }, note) : null, h("ul", { class: "items" }, shown.map((it) => itemRow(h, it))));
  }

  async function openModule(rel) {
    current = () => openModule(rel);
    loading(detail);
    try {
      const m = await api("/api/catalog/module?rel=" + encodeURIComponent(rel));
      showItems(m.title, m.items, "framework/" + m.rel + ".md · " + m.kind);
    } catch (e) {
      error(detail, e, () => openModule(rel));
    }
  }

  async function runSearch() {
    const q = search.value.trim();
    if (q.length < 2) return;
    current = runSearch;
    loading(detail);
    try {
      const d = await api("/api/catalog?q=" + encodeURIComponent(q));
      showItems("Kết quả cho “" + q + "”", d.hits || [], d.truncated ? "Chỉ hiện 200 kết quả đầu." : "");
    } catch (e) {
      error(detail, e, runSearch);
    }
  }

  let timer = null;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 300); });

  async function load() {
    loading(tree);
    try {
      const d = await api("/api/catalog");
      tree.replaceChildren(
        ...d.areas.map((a) =>
          h("details", null, h("summary", null, a.title),
            h("ul", null, a.modules.map((m) => {
              const b = h("button", { type: "button", class: "link" }, m.title + " (" + LEVELS.map((l) => m.counts[l]).join("/") + ")");
              b.addEventListener("click", () => openModule(m.rel));
              return h("li", null, b);
            })),
          ),
        ),
      );
      empty(detail, "Chọn một module hoặc gõ từ khoá. Số trong ngoặc: MUST/SHOULD/MAY.");
    } catch (e) {
      error(tree, e, load);
    }
  }
  await load();
}
