// BASE-ERR-001 — không có lỗi bị nuốt: không `catch {}` rỗng (kể cả chỉ có comment), không `.catch(() => {})`, không
// `except: pass`. Thay cho rule lint `noEmptyBlockStatements` (biome.json bị khoá với agent — xem báo cáo T-403): quét văn bản
// toàn mã nguồn; ngoại lệ phải nằm trong `ALLOWED` kèm LÝ DO và bị đỏ khi không còn khớp (không để ngoại lệ mồ côi).
import { describe, expect, it } from "vitest";
import { braceBody, type SourceFile, sourceFiles } from "../testing/source-scan.ts";

interface Swallow {
  file: string;
  line: number;
  kind: "catch-rong" | "catch-callback" | "except-pass";
  /** Comment trong khối (nếu có) — dùng để ghép với ngoại lệ. */
  note: string;
}

const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Mọi nhánh bắt lỗi mà thân rỗng (sau khi bỏ comment) hoặc callback `() => {}`/`() => undefined`. */
function findSwallowed(files: readonly SourceFile[]): Swallow[] {
  const found: Swallow[] = [];
  for (const f of files) {
    if (/\.(ts|tsx|mjs|js)$/.test(f.path)) {
      for (const m of f.text.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
        const body = braceBody(f.text, m.index + m[0].length - 1);
        if (body === null) continue;
        if (body.replace(COMMENTS, "").trim() === "")
          found.push({
            file: f.path,
            line: lineOf(f.text, m.index),
            kind: "catch-rong",
            note: body.trim(),
          });
      }
      for (const m of f.text.matchAll(
        /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*(?:\/\/[^\n]*\n\s*)*\}|undefined|void 0)\s*\)/g,
      ))
        found.push({ file: f.path, line: lineOf(f.text, m.index), kind: "catch-callback", note: m[0] });
    } else {
      for (const m of f.text.matchAll(/^\s*except\b[^\n]*:\s*(?:#[^\n]*)?\n\s*pass\b/gm))
        found.push({ file: f.path, line: lineOf(f.text, m.index), kind: "except-pass", note: m[0].trim() });
    }
  }
  return found;
}

/**
 * Ngoại lệ đã duyệt: nuốt lỗi có CHỦ Ý, an toàn vì không còn việc nào để làm với lỗi đó (dọn dẹp best-effort khi đã có lỗi
 * khác đang được ném/ghi, hoặc tính năng trình duyệt tuỳ chọn). Mỗi mục phải khớp ĐÚNG MỘT chỗ.
 */
const ALLOWED: readonly { file: string; note: RegExp; why: string; count?: number }[] = [
  {
    file: "apps/web/components/pwa/pwa-shell.tsx",
    note: /Cache Storage bị chặn/,
    why: "xoá cache trình duyệt best-effort khi đổi tổ chức; bị chặn (chế độ riêng tư) thì không còn gì để xoá",
  },
  {
    file: "apps/web/components/pwa/pwa-shell.tsx",
    note: /IndexedDB/,
    why: "trình duyệt không hỗ trợ liệt kê IndexedDB; pilot không lưu dữ liệu nghiệp vụ ở đó",
  },
  {
    file: "apps/web/components/command/use-command.ts",
    note: /vẫn mất mạng/,
    why: "thử gửi lại khi mạng về; lệnh vẫn nằm trong hàng chờ có Idempotency-Key, lần sau thử lại và báo trạng thái",
  },
  {
    file: "apps/web/e2e/server.ts",
    note: /cluster tạm bị dừng/,
    why: "hạ tầng E2E: dọn cluster tạm lúc tắt, thư mục tạm bị xoá ngay sau đó",
  },
  {
    file: "packages/app/src/logging/logger.ts",
    note: /Không có\/không đọc được package\.json/,
    why: "đi ngược cây thư mục tìm package.json; thất bại ở một tầng là bình thường, cuối cùng có giá trị mặc định 0.0.0",
  },
  {
    file: "apps/worker/src/runtime.ts",
    note: /\.catch\(\(\) => \{\}\)/,
    count: 2,
    why: "(1) dọn pg-boss khi khởi động dở: lỗi gốc được ném lại ngay sau, lỗi dừng không được che nó; (2) chống unhandled rejection của lời hứa khởi động — lỗi thật xử lý ở try/catch bên dưới và ghi log worker.start_failed",
  },
  {
    file: "apps/worker/src/runtime.ts",
    note: /\.catch\(\(\) => undefined\)/,
    why: "chờ khởi động xong để dừng êm; nếu khởi động lỗi thì không có worker để dừng — lỗi đó đã được báo bởi nhánh try/catch của runMain",
  },
  {
    file: "packages/app/src/exports/exports.ts",
    note: /\.catch\(\(\) => \{\}\)/,
    why: "đánh dấu job `failed` best-effort ngay trước khi ném lại lỗi gốc cho worker log/pg-boss; lỗi ghi đánh dấu không được che lỗi gốc",
  },
  {
    file: "packages/app/src/logging/security-events.ts",
    note: /lỗi ghi log không đổi kết quả request/,
    why: "chính bộ ghi log hỏng — không còn nơi nào để báo; sự kiện bảo mật không được làm hỏng request đang xử lý",
  },
  {
    file: "packages/testkit/src/s3-server.ts",
    note: /chưa lên/,
    why: "hạ tầng test: vòng thăm dò chờ S3 tạm khởi động, hết số lần thử thì test báo lỗi rõ ràng",
  },
];

describe("BASE-ERR-001 — không có catch nuốt lỗi (quét toàn repo)", () => {
  const files = sourceFiles(["apps", "packages", "scripts"], /\.(ts|tsx|mjs|js|py)$/);

  it("mọi nhánh bắt lỗi rỗng đều là ngoại lệ có lý do; không ngoại lệ mồ côi", () => {
    const swallowed = findSwallowed(files);
    const used = new Map<number, number>();
    const unexplained = swallowed.filter((s) => {
      const i = ALLOWED.findIndex((a) => a.file === s.file && a.note.test(s.note));
      if (i < 0) return true;
      used.set(i, (used.get(i) ?? 0) + 1);
      return false;
    });
    expect(unexplained.map((s) => `${s.file}:${s.line} ${s.kind}`)).toEqual([]);
    // Số lần khớp phải đúng: thêm một chỗ nuốt lỗi mới vào file đã có ngoại lệ cũng bị bắt; ngoại lệ không còn khớp → xoá đi.
    expect(ALLOWED.map((a, i) => [a.file, used.get(i) ?? 0])).toEqual(
      ALLOWED.map((a) => [a.file, a.count ?? 1]),
    );
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(20);
  });

  it("bộ quét bắt đúng các dạng nuốt lỗi (hồi quy của chính rào)", () => {
    const bad = (path: string, text: string) => findSwallowed([{ path, text }]).map((s) => s.kind);
    expect(bad("a.ts", "try { f() } catch {}")).toEqual(["catch-rong"]);
    expect(bad("a.ts", "try { f() } catch (e) {\n  // bỏ qua\n}")).toEqual(["catch-rong"]);
    expect(bad("a.ts", "try { f() } catch (e) { /* x */ }")).toEqual(["catch-rong"]);
    expect(bad("a.ts", "p.catch(() => {})")).toEqual(["catch-callback"]);
    expect(bad("a.ts", "p.catch((_e) => undefined)")).toEqual(["catch-callback"]);
    expect(bad("a.py", "try:\n  f()\nexcept Exception:\n  pass\n")).toEqual(["except-pass"]);
    // Không bắt nhầm: có xử lý/ghi log/chuyển tiếp/trả giá trị.
    expect(bad("a.ts", "try { f() } catch (e) { log.error('x', { e }) }")).toEqual([]);
    expect(bad("a.ts", "try { f() } catch { return null }")).toEqual([]);
    expect(bad("a.ts", "p.catch(() => null)")).toEqual([]);
    expect(bad("a.ts", "p.catch((e) => { throw e })")).toEqual([]);
    expect(bad("a.py", "try:\n  f()\nexcept Exception:\n  log()\n")).toEqual([]);
  });
});
