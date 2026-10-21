// F-007 PR, chỉ đọc (SPEC-app §4): bảng PR mở + số đo; không có nút merge — chỉ lệnh `pr next` để chép.
function prTable(h, prs) {
  return h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, ...["PR", "Tiêu đề", "Làn", "Hành động kế", "Lý do", "Lệnh"].map((x) => h("th", null, x)))),
    h("tbody", null, prs.map((p) => h("tr", null,
      h("td", null, "#" + p.number),
      h("td", null, p.title),
      h("td", null, p.lane || "—"),
      h("td", null, h("strong", null, p.action || "—")),
      h("td", null, (p.reasons || []).join("; ")),
      h("td", null, h("code", null, "python3 scripts/xt.py pr next --pr " + p.number)))))));
}

function stats(h, s) {
  const lt = s.lead_time_hours || {};
  return h("div", { class: "cards" },
    h("div", { class: "card" }, h("div", { class: "num" }, String(s.merged)), h("div", { class: "label" }, "PR merge " + s.days + " ngày")),
    h("div", { class: "card" }, h("div", { class: "num" }, lt.p50 == null ? "—" : lt.p50 + " giờ"), h("div", { class: "label" }, "Lead time trung vị")),
    h("div", { class: "card" }, h("div", { class: "num" }, s.bad_run_rate == null ? "—" : Math.round(100 * s.bad_run_rate) + " %"), h("div", { class: "label" }, "Run CI đỏ/huỷ")),
    h("div", { class: "card" }, h("div", { class: "num" }, String(s.reverts)), h("div", { class: "label" }, "Revert")));
}

export async function render(main, { api, h, loading, empty, error }) {
  const list = h("section", null);
  const metric = h("section", null);
  main.replaceChildren(h("h1", null, "PR"), h("h2", null, "PR đang mở"), list, h("h2", null, "Số đo"), metric);

  async function loadPrs() {
    loading(list);
    try {
      const d = await api("/api/prs");
      if (!d.available) return empty(list, "Không đọc được GitHub: " + d.reason + ". Các màn khác vẫn dùng được.");
      if (!d.prs.length) return empty(list, "Không có PR mở.");
      list.replaceChildren(prTable(h, d.prs));
    } catch (e) {
      error(list, e, loadPrs);
    }
  }

  async function loadStats() {
    loading(metric);
    try {
      const s = await api("/api/pr-stats?days=7");
      if (!s.available) return empty(metric, "Không có số đo: " + s.reason);
      metric.replaceChildren(stats(h, s));
    } catch (e) {
      error(metric, e, loadStats);
    }
  }

  await Promise.all([loadPrs(), loadStats()]);
}
