// F-003 Ghép blueprint (SPEC-app §4): chọn hồ sơ/ngành/quy mô/module/fact → xem trước; tải .md; ghi BLUEPRINT.md có xác nhận.
function multi(h, id, label, values) {
  const sel = h("select", { id, multiple: true, size: "5" }, values.map((v) => h("option", { value: v.slug || v }, v.title ? v.title + " (" + v.slug + ")" : v)));
  return [h("label", { for: id }, label), sel];
}

function picked(sel) {
  return Array.from(sel.selectedOptions).map((o) => o.value);
}

export async function render(main, { api, h, loading, empty, error }) {
  const form = h("form", { class: "compose" });
  const preview = h("section", { "aria-live": "polite" });
  main.replaceChildren(h("h1", null, "Ghép blueprint"), form, preview);
  let opts;
  try {
    opts = await api("/api/compose/options");
  } catch (e) {
    return error(form, e, () => render(main, { api, h, loading, empty, error }));
  }
  const profile = h("select", { id: "cp-profile", required: true }, opts.profiles.map((p) => h("option", { value: p.slug }, p.title + " (" + p.slug + ")")));
  const scale = h("select", { id: "cp-scale" }, opts.scales.map((s) => h("option", { value: s }, s)));
  const [indL, ind] = multi(h, "cp-industry", "Ngành (chọn nhiều)", opts.industries);
  const [addL, add] = multi(h, "cp-add", "Module thêm", opts.modules);
  const [featL, feat] = multi(h, "cp-feature", "Fact (--feature)", opts.features);
  const run = h("button", { type: "submit" }, "Xem trước");
  form.replaceChildren(
    h("label", { for: "cp-profile" }, "Hồ sơ"), profile, h("label", { for: "cp-scale" }, "Quy mô"), scale,
    indL, ind, addL, add, featL, feat, run);

  function params() {
    return { profile: profile.value, scale: scale.value, industry: picked(ind), add: picked(add), feature: picked(feat) };
  }

  function query(p) {
    const u = new URLSearchParams({ profile: p.profile, scale: p.scale });
    for (const k of ["industry", "add", "feature"]) for (const v of p[k]) u.append(k, v);
    return u.toString();
  }

  async function write(p, btn, out) {
    if (!window.confirm("Ghi BLUEPRINT.md (và backlog) trong dự án? Tick đã có được giữ theo ID.")) return;
    btn.disabled = true;
    try {
      const r = await api("/api/blueprint", { method: "POST", body: { ...p, out: "BLUEPRINT.md" } });
      out.replaceChildren(h("p", { role: "status" }, "Đã ghi " + r.written.join(", ") + " — giữ " + r.kept + ", bỏ " + r.dropped + ", cũ " + r.stale + "."));
    } catch (e) {
      error(out, e, () => write(p, btn, out));
    } finally {
      btn.disabled = false;
    }
  }

  async function show() {
    const p = params();
    loading(preview);
    try {
      const d = await api("/api/compose?" + query(p));
      const blob = URL.createObjectURL(new Blob([d.markdown], { type: "text/markdown" }));
      const save = h("button", { type: "button" }, "Ghi BLUEPRINT.md");
      const out = h("div", null);
      save.addEventListener("click", () => write(p, save, out));
      preview.replaceChildren(
        h("p", null, "MUST " + d.counts.MUST + " · SHOULD " + d.counts.SHOULD + " · MAY " + d.counts.MAY + (d.truncated ? " · xem trước bị cắt ở 512 KB" : "")),
        h("p", null, h("a", { href: blob, download: "BLUEPRINT.md" }, "Tải .md"), " · ", save),
        out,
        h("p", null, "Lệnh tương đương: ", h("code", null, "python3 scripts/xt.py compose " + query(p).replace(/&/g, " ").replace(/=/g, " ").replace(/(^|\s)(\w+) /g, "$1--$2 ") + " --out BLUEPRINT.md")),
        // Vùng cuộn được phải nhận focus bàn phím (axe scrollable-region-focusable, WCAG 2.1.1) — có tên vùng.
        h("pre", { class: "md", tabindex: "0", role: "region", "aria-label": "Xem trước BLUEPRINT.md" }, d.markdown),
      );
    } catch (e) {
      error(preview, e, show);
    }
  }

  form.addEventListener("submit", (ev) => { ev.preventDefault(); show(); });
  empty(preview, "Chọn hồ sơ và quy mô rồi bấm Xem trước.");
}
