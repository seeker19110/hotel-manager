// X-Templates app: router hash + helper DOM. Chỉ createElement/textContent (không HTML động, CSP không inline).
const TOKEN_KEY = "xt-token";
const ROUTES = {
  "": ["overview", "Tổng quan"],
  catalog: ["catalog", "Thư viện yêu cầu"],
  compose: ["compose", "Ghép blueprint"],
  blueprint: ["blueprint", "Tiến độ blueprint"],
  plan: ["plan", "Kế hoạch"],
  loop: ["loop", "Vòng tự động"],
  pr: ["pr", "PR"],
};

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    const k = String(key).toLowerCase();
    if (k.startsWith("on") || k.startsWith("style")) {
      throw new Error("thuộc tính không được phép: " + key);
    }
    if (value === false || value === null || value === undefined) continue;
    el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function captureToken() {
  const m = /(?:^#|&)t=([^&]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export async function api(path, opts = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY) || "";
  const headers = { ...(opts.headers || {}), "X-XT-Token": token };
  const init = { ...opts, headers };
  if (opts.body !== undefined && typeof opts.body !== "string") {
    init.body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw Object.assign(new Error("không kết nối được máy chủ"), { status: 0, error: "không kết nối được máy chủ" });
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || "lỗi " + res.status;
    throw Object.assign(new Error(msg), { status: res.status, error: msg });
  }
  return data;
}

export function loading(el, msg = "Đang tải…") {
  el.replaceChildren(h("p", { class: "state loading", role: "status" }, msg));
}

export function empty(el, msg) {
  el.replaceChildren(h("p", { class: "state empty" }, msg));
}

export function error(el, err, retry) {
  const msg = (err && (err.error || err.message)) || "lỗi không rõ";
  const box = h("div", { class: "state error", role: "alert" }, h("p", null, "Lỗi: " + msg));
  if (typeof retry === "function") {
    box.append(h("button", { type: "button" }, "Thử lại"));
    box.lastChild.addEventListener("click", retry);
  }
  el.replaceChildren(box);
}

function routeName() {
  const m = /^#\/([\w-]*)/.exec(location.hash);
  return m ? m[1] : "";
}

// `moveFocus`: chuyển màn do người dùng (hashchange, nút Thử lại) → focus vào main; lần tải đầu thì không, để điểm Tab
// đầu tiên vẫn là link "Bỏ qua tới nội dung" (WCAG 2.4.1/2.4.3, E2E tests_e2e).
async function route(moveFocus = true) {
  const main = document.getElementById("main");
  const status = document.getElementById("status");
  const name = routeName();
  const entry = ROUTES[name];
  for (const a of document.querySelectorAll("nav a")) {
    const target = a.getAttribute("href").replace(/^#\//, "");
    if (entry && target === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (!sessionStorage.getItem(TOKEN_KEY)) {
    main.replaceChildren(h("p", { class: "state error", role: "alert" }, "Mở lại bằng URL in ở terminal."));
    return;
  }
  if (!entry) {
    document.title = "Không tìm thấy — X-Templates";
    empty(main, "Không có màn này.");
    return;
  }
  document.title = entry[1] + " — X-Templates";
  loading(main);
  try {
    const view = await import("./views/" + entry[0] + ".js");
    main.replaceChildren();
    await view.render(main, { api, h, loading, empty, error });
    status.textContent = "Đã mở màn " + entry[1];
  } catch (e) {
    error(main, e, route);
  }
  if (moveFocus) main.focus();
}

captureToken();
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#/")) route(true); // `#main` (bỏ qua tới nội dung) không phải màn
});
if (!location.hash) history.replaceState(null, "", location.pathname + "#/");
route(false);
