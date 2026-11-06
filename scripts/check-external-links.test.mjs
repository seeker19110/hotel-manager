// BASE-DOC-006 / WF-DOC-002: kiểm link ngoài — trích URL, loại trừ, phân loại, thử lại, cache. Không gọi mạng (fetch giả).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkUrl,
  classifyStatus,
  collectUrls,
  extractUrls,
  freshInCache,
  hostMatches,
  htmlAnchors,
  isExcluded,
  MAX_HTML_BYTES,
  missingFragments,
  runChecks,
} from "./check-external-links.mjs";

const urls = (md) => extractUrls(md).map((x) => x.url);

describe("extractUrls", () => {
  it("link Markdown, autolink, URL trần; bỏ fragment và dấu câu cuối", () => {
    expect(
      urls("[a](https://a.example.org/x#muc) <https://b.dev/y> xem https://c.dev/z, và https://d.dev/w."),
    ).toEqual(["https://a.example.org/x", "https://b.dev/y", "https://c.dev/z", "https://d.dev/w"]);
  });
  it("bỏ khối code rào, đoạn code dòng, URL trùng; giữ số dòng", () => {
    const md = "```\nhttps://trong-code.dev\n```\n`https://dong.dev` và https://that.dev\nhttps://that.dev\n";
    expect(extractUrls(md)).toEqual([{ url: "https://that.dev", line: 4 }]);
  });
  it("ngoặc cân bằng trong URL được giữ (Wikipedia), ngoặc đóng của link Markdown bị bỏ", () => {
    expect(urls("[w](https://vi.wikipedia.org/wiki/A_(b)) và (https://x.dev/y)")).toEqual([
      "https://vi.wikipedia.org/wiki/A_(b)",
      "https://x.dev/y",
    ]);
  });
  it("rỗng, không có link, placeholder <domain", () => {
    expect(urls("")).toEqual([]);
    expect(urls("không có link\nhttps://<domain>/x")).toEqual([]);
  });
  it("Unicode trong văn bản quanh link", () => {
    expect(urls("Đọc [quy định](https://thuvienphapluat.vn/van-ban) ạ.")).toEqual([
      "https://thuvienphapluat.vn/van-ban",
    ]);
  });
});

describe("hostMatches / isExcluded", () => {
  it("khớp tên đúng, miền con, *.hậu-tố; không khớp tên chứa", () => {
    expect(hostMatches("linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatches("www.linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatches("notlinkedin.com", "linkedin.com")).toBe(false);
    expect(hostMatches("a.b.test", "*.test")).toBe(true);
    expect(hostMatches("test", "*.test")).toBe(false);
  });
  it("loại trừ cục bộ/ví dụ/một nhãn/cấu hình; link thật không bị loại", () => {
    for (const u of [
      "http://localhost:3000",
      "http://127.0.0.1:3100",
      "https://hotel.invalid/x",
      "https://example.com/a",
      "http://x",
      "not a url",
    ]) {
      expect(isExcluded(u)).toBe(true);
    }
    expect(isExcluded("https://postgresql.org/docs")).toBe(false);
    expect(isExcluded("https://www.linkedin.com/in/x", { excludeHosts: ["linkedin.com"] })).toBe(true);
    expect(isExcluded("https://a.dev/private/1", { excludePatterns: ["/private/"] })).toBe(true);
  });
});

describe("classifyStatus", () => {
  it.each([
    [200, "ok"],
    [301, "ok"],
    [404, "dead"],
    [410, "dead"],
    [400, "dead"],
    [401, "warn"],
    [403, "warn"],
    [429, "warn"],
    [500, "warn"],
    [503, "warn"],
  ])("%i → %s", (status, kind) => expect(classifyStatus(status)).toBe(kind));
});

const respond = (...statuses) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const status = statuses.shift();
    if (status instanceof Error) throw status;
    return { status, body: { cancel() {} } };
  };
  return { impl, calls };
};
const fast = { retries: 2, backoffMs: 1, sleep: async () => {} };

describe("checkUrl", () => {
  it("HEAD 200 → ok, một lần gọi", async () => {
    const f = respond(200);
    expect(await checkUrl("https://a.dev", { ...fast, fetchImpl: f.impl })).toMatchObject({ kind: "ok" });
    expect(f.calls).toEqual(["HEAD https://a.dev"]);
  });
  it("HEAD 405 → GET 200 → ok", async () => {
    const f = respond(405, 200);
    expect((await checkUrl("https://a.dev", { ...fast, fetchImpl: f.impl })).kind).toBe("ok");
    expect(f.calls).toEqual(["HEAD https://a.dev", "GET https://a.dev"]);
  });
  it("404 cả HEAD lẫn GET → dead, không thử lại", async () => {
    const f = respond(404, 404);
    expect((await checkUrl("https://a.dev", { ...fast, fetchImpl: f.impl })).kind).toBe("dead");
    expect(f.calls).toHaveLength(2);
  });
  it("503 rồi 200 (thử lại có lùi) → ok", async () => {
    const waits = [];
    const f = respond(503, 503, 200);
    const r = await checkUrl("https://a.dev", {
      retries: 2,
      backoffMs: 10,
      sleep: async (ms) => waits.push(ms),
      fetchImpl: f.impl,
    });
    expect(r.kind).toBe("ok");
    expect(waits).toEqual([10]);
  });
  it("503 mãi → warn (không đỏ); 429 → warn", async () => {
    expect(
      (
        await checkUrl("https://a.dev", {
          ...fast,
          fetchImpl: respond(503, 503, 503, 503, 503, 503, 503, 503, 503).impl,
        })
      ).kind,
    ).toBe("warn");
    expect(
      (await checkUrl("https://a.dev", { ...fast, retries: 0, fetchImpl: respond(429, 429).impl })).kind,
    ).toBe("warn");
  });
  it("DNS sai (ENOTFOUND) → dead; hết giờ/ECONNRESET → warn", async () => {
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(
      (await checkUrl("https://khong-co.dev", { ...fast, retries: 0, fetchImpl: respond(dns).impl })).kind,
    ).toBe("dead");
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const r = await checkUrl("https://a.dev", { ...fast, retries: 0, fetchImpl: respond(reset).impl });
    expect(r.kind).toBe("warn");
    expect(r.detail).toContain("ECONNRESET");
  });
});

describe("cache + runChecks", () => {
  it("freshInCache theo hạn", () => {
    expect(freshInCache({ u: { at: 1000 } }, "u", 1500, 1000)).toBe(true);
    expect(freshInCache({ u: { at: 1000 } }, "u", 2000, 1000)).toBe(false);
    expect(freshInCache({}, "u", 1, 1000)).toBe(false);
  });
  it("URL trong cache không gọi mạng; kết quả ok được ghi vào cache, dead/warn thì không", async () => {
    const cache = { "https://cu.dev": { at: 900 } };
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { status: url.includes("chet") ? 404 : 200, body: null };
    };
    const results = await runChecks(["https://moi.dev", "https://cu.dev", "https://chet.dev"], {
      cache,
      now: 1000,
      ttlMs: 500,
      fetchImpl,
      ...fast,
    });
    expect(results.map((r) => [r.url, r.kind])).toEqual([
      ["https://chet.dev", "dead"],
      ["https://cu.dev", "ok"],
      ["https://moi.dev", "ok"],
    ]);
    expect(calls.filter((u) => u === "https://cu.dev")).toHaveLength(0);
    expect(Object.keys(cache).sort()).toEqual(["https://cu.dev", "https://moi.dev"]);
  });
  it("danh sách rỗng → không lỗi", async () => {
    expect(await runChecks([], { fetchImpl: async () => ({ status: 200 }) })).toEqual([]);
  });
});

describe("WF-DOC-002 — anchor #heading của link ngoài", () => {
  const page = (html, type = "text/html; charset=utf-8", status = 200) => ({
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? type : null) },
    text: async () => html,
    body: { cancel() {} },
  });
  it("extractUrls gom anchor theo URL, bỏ text fragment; link không anchor giữ nguyên dạng {url, line}", () => {
    const md =
      "[a](https://d.dev/p#cai-dat) [b](https://d.dev/p#Su%20dung) https://d.dev/q#:~:text=x https://e.dev/r";
    expect(extractUrls(md)).toEqual([
      { url: "https://d.dev/p", line: 1, fragments: ["cai-dat", "Su%20dung"] },
      { url: "https://d.dev/q", line: 1 },
      { url: "https://e.dev/r", line: 1 },
    ]);
  });
  it("text fragment sau anchor (`#a:~:text=`) giữ phần anchor; anchor dòng GitHub `#L10`/`#L10-L20` bỏ qua", () => {
    const md =
      "https://d.dev/p#setup:~:text=abc https://github.com/o/r/blob/x.ts#L10-L20 https://github.com/o/r/blob/y.ts#L3";
    expect(extractUrls(md)).toEqual([
      { url: "https://d.dev/p", line: 1, fragments: ["setup"] },
      { url: "https://github.com/o/r/blob/x.ts", line: 1 },
      { url: "https://github.com/o/r/blob/y.ts", line: 1 },
    ]);
  });
  it("T-2607 (AUD-CODE-002): anchor dòng+cột GitHub `#L10C5`, `#L10C5-L12C3` bỏ qua; anchor chữ giống vậy vẫn kiểm", () => {
    const md =
      "https://github.com/o/r/blob/a.ts#L10C5 https://github.com/o/r/blob/b.ts#L10C5-L12C3 https://d.dev/q#L10-intro";
    expect(extractUrls(md)).toEqual([
      { url: "https://github.com/o/r/blob/a.ts", line: 1 },
      { url: "https://github.com/o/r/blob/b.ts", line: 1 },
      { url: "https://d.dev/q", line: 1, fragments: ["L10-intro"] },
    ]);
  });
  it("htmlAnchors giải mã entity trong giá trị (tên + số); entity lạ giữ nguyên", () => {
    const a = htmlAnchors(
      `<h2 id="it&#39;s"></h2><h2 id="a&amp;b"></h2><h2 id="q&#x27;x"></h2><h2 id="k&zz;"></h2>`,
    );
    expect([...a].sort()).toEqual(["a&b", "it's", "k&zz;", "q'x"]);
    // Tên thuộc prototype không được coi là entity (review b5994b4).
    expect([...htmlAnchors(`<h2 id="a&constructor;b"></h2>`)]).toEqual(["a&constructor;b"]);
  });
  it("htmlAnchors đọc id/name (nháy kép, đơn, không nháy) và bỏ tiền tố user-content- của GitHub", () => {
    const a = htmlAnchors(
      `<h2 id="cai-dat">x</h2><a name='old'></a><div id=raw></div><h3 id="user-content-faq">`,
    );
    expect([...a].sort()).toEqual(["cai-dat", "faq", "old", "raw", "user-content-faq"]);
    expect(htmlAnchors("<p>không anchor</p>").size).toBe(0);
  });
  it("missingFragments: anchor có/thiếu; giải mã %20; trang không phải HTML (zip) không kiểm; lỗi tải → null", async () => {
    const html = `<h2 id="cai-dat"></h2><h2 id="Su dung"></h2>`;
    expect(
      await missingFragments("https://d.dev/p", ["cai-dat", "Su%20dung", "khong-co"], {
        fetchImpl: async () => page(html),
      }),
    ).toEqual(["khong-co"]);
    // Lỗi giữa lúc đọc body (reset/hết giờ) → null, không ném (review a2f83f4 🟠).
    const broken = { ...page(""), text: async () => Promise.reject(new TypeError("terminated")) };
    expect(await missingFragments("https://d.dev/p", ["x"], { fetchImpl: async () => broken })).toBeNull();
    // Trang quá trần dung lượng → null (khai qua content-length hoặc đọc ra quá dài).
    const huge = {
      ...page("<h2 id='x'></h2>"),
      headers: {
        get: (k) => ({ "content-type": "text/html", "content-length": String(MAX_HTML_BYTES + 1) })[k],
      },
    };
    expect(await missingFragments("https://d.dev/p", ["x"], { fetchImpl: async () => huge })).toBeNull();
    // T-2606 (AUD-CODE-001): không content-length → đọc stream đếm byte, vượt trần thì cancel, không kéo hết body.
    let pulled = 0;
    let cancelled = false;
    const MB = new Uint8Array(1024 * 1024).fill(0x61);
    const chunked = {
      status: 200,
      headers: { get: (k) => (k === "content-type" ? "text/html" : null) },
      body: new ReadableStream({
        pull(c) {
          pulled++;
          if (pulled > 20) c.close();
          else c.enqueue(MB);
        },
        cancel() {
          cancelled = true;
        },
      }),
      text: async () => {
        throw new Error("không được gọi text() khi có body stream");
      },
    };
    expect(await missingFragments("https://d.dev/p", ["x"], { fetchImpl: async () => chunked })).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_HTML_BYTES / MB.length) + 2);
    // Trần tính theo byte UTF-8, không theo độ dài chuỗi: 2M ký tự "ạ" = 6 MB.
    const wide = { ...page("ạ".repeat(2 * 1024 * 1024)), body: undefined };
    expect(await missingFragments("https://d.dev/p", ["x"], { fetchImpl: async () => wide })).toBeNull();
    // Trang nhỏ qua stream vẫn đọc đúng anchor.
    const small = {
      status: 200,
      headers: { get: (k) => (k === "content-type" ? "text/html" : null) },
      body: new Blob(["<h2 id='co'></h2>"]).stream(),
    };
    expect(
      await missingFragments("https://d.dev/p", ["co", "mat"], { fetchImpl: async () => small }),
    ).toEqual(["mat"]);
    // `%` hỏng (decodeURIComponent ném URIError) không làm sập lượt kiểm: so nguyên dạng.
    expect(
      await missingFragments("https://d.dev/p", ["a%zz", "b%zz"], {
        fetchImpl: async () => page(`<h2 id="a%zz"></h2>`),
      }),
    ).toEqual(["b%zz"]);
    expect(
      await missingFragments("https://z.dev/a.zip", ["mod@v1/LICENSE"], {
        fetchImpl: async () => page("PK…", "application/zip"),
      }),
    ).toEqual([]);
    expect(
      await missingFragments("https://d.dev/p", ["x"], { fetchImpl: async () => page("", "text/html", 503) }),
    ).toBeNull();
    expect(
      await missingFragments("https://d.dev/p", ["x"], {
        fetchImpl: async () => {
          throw new Error("reset");
        },
      }),
    ).toBeNull();
  });
  it("runChecks: anchor thiếu → dead (dù URL sống); anchor đạt → cache url#anchor, lần sau không tải lại; host bỏ qua anchor", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return init.method === "HEAD" ? { status: 200, body: null } : page(`<h2 id="co"></h2>`);
    };
    const cache = {};
    const fragments = new Map([
      ["https://d.dev/p", ["co"]],
      ["https://d.dev/q", ["mat"]],
      ["https://spa.dev/x", ["mat"]],
    ]);
    const opts = {
      cache,
      now: 1000,
      ttlMs: 500,
      fetchImpl,
      fragments,
      ignoreFragmentHosts: ["spa.dev"],
      ...fast,
    };
    const r1 = await runChecks(["https://d.dev/p", "https://d.dev/q", "https://spa.dev/x"], opts);
    expect(r1.map((r) => [r.url, r.kind])).toEqual([
      ["https://d.dev/p", "ok"],
      ["https://d.dev/q", "dead"],
      ["https://spa.dev/x", "ok"],
    ]);
    expect(r1[1].detail).toContain("#mat");
    expect(cache["https://d.dev/p#co"]).toBeDefined();
    expect(cache["https://d.dev/q#mat"]).toBeUndefined();
    calls.length = 0;
    await runChecks(["https://d.dev/p"], opts);
    expect(calls).toEqual([]);
  });
  it("runChecks: lỗi đọc body khi kiểm anchor → warn cho URL đó, các URL khác vẫn có kết quả (không reject)", async () => {
    const fetchImpl = async (_url, init) => {
      if (init.method === "HEAD") return { status: 200, body: null };
      return { ...page(""), text: async () => Promise.reject(new TypeError("terminated")) };
    };
    const r = await runChecks(["https://d.dev/a", "https://d.dev/b"], {
      cache: {},
      fetchImpl,
      fragments: new Map([["https://d.dev/a", ["x"]]]),
      ...fast,
    });
    expect(r.map((x) => [x.url, x.kind])).toEqual([
      ["https://d.dev/a", "warn"],
      ["https://d.dev/b", "ok"],
    ]);
  });
  it("collectUrls gộp anchor của cùng URL từ nhiều file; cấu hình khai ignoreFragmentHosts có ghi chú", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const config = JSON.parse(readFileSync(new URL("./link-check.config.json", import.meta.url), "utf8"));
    expect(Array.isArray(config.ignoreFragmentHosts)).toBe(true);
    expect(config._ghi_chu).toContain("ignoreFragmentHosts");
    const fragments = new Map();
    collectUrls(root, config, fragments);
    for (const [u, fs] of fragments) {
      expect(u).not.toContain("#");
      expect(new Set(fs).size).toBe(fs.length);
    }
  });
  it("T-2614 (AUD-TEST-001): fixture hai file md cùng URL khác anchor → collectUrls gộp đủ, giữ vị trí cả hai file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hm-links-"));
    try {
      mkdirSync(join(tmp, "docs"));
      writeFileSync(join(tmp, "README.md"), "[a](https://d.dev/p#mot) [b](https://d.dev/p#hai)\n");
      writeFileSync(join(tmp, "docs", "x.md"), "\n[c](https://d.dev/p#ba) [d](https://d.dev/p#mot)\n");
      const fragments = new Map();
      const where = collectUrls(tmp, { excludeHosts: [] }, fragments);
      expect(where.get("https://d.dev/p")).toEqual(["README.md:1", "docs/x.md:2"]);
      expect([...fragments.get("https://d.dev/p")].sort()).toEqual(["ba", "hai", "mot"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("repo thật", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = JSON.parse(readFileSync(new URL("./link-check.config.json", import.meta.url), "utf8"));
  it("cấu hình hợp lệ và thu được link ngoài từ tài liệu (không có link localhost/placeholder)", () => {
    expect(config.cacheDays).toBeGreaterThan(0);
    expect(Array.isArray(config.excludeHosts)).toBe(true);
    const where = collectUrls(root, config);
    expect(where.size).toBeGreaterThan(5);
    for (const u of where.keys()) expect(u).toMatch(/^https?:\/\/[^/<>]+\.[a-z]{2,}/i);
  });
});
