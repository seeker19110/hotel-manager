// Bộ quét tĩnh "đang trong transaction?" dùng cho rào `tx-guards.test.ts` (T-502). Chỉ chạy trong test; không import vào mã chạy.
// Không phải bộ phân tích cú pháp đầy đủ: che comment/chuỗi/regex rồi tìm vùng bằng ngoặc cân bằng — đủ chặt cho mã dự án
// (rào tự kiểm bằng mẫu + kiểm "trạng thái cuối là mã" trên mọi file).

/**
 * Trả về chuỗi CÙNG ĐỘ DÀI: comment và nội dung chuỗi/template bị thay bằng khoảng trắng (giữ xuống dòng); phần `${…}` của
 * template vẫn là mã. `clean` = kết thúc ở trạng thái mã (không kẹt trong chuỗi/comment — dấu hiệu bộ quét bị lệch).
 */
export function maskCode(src: string): { masked: string; clean: boolean } {
  const out = src.split("");
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  // Ngăn xếp ngữ cảnh: "code" hoặc "tpl" (đang trong template, đếm `{` của `${`).
  const stack: { kind: "code" | "tpl"; depth: number }[] = [{ kind: "code", depth: 0 }];
  let i = 0;
  let prevSig = ""; // ký tự có nghĩa gần nhất ở ngữ cảnh mã (để phân biệt `/` chia và regex)
  let prevWord = "";
  const top = () => stack[stack.length - 1] as { kind: "code" | "tpl"; depth: number };
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (top().kind === "tpl") {
      // Trong phần chữ của template.
      if (c === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (c === "`") {
        blank(i);
        stack.pop();
        prevSig = "`";
        i++;
      } else if (c === "$" && n === "{") {
        blank(i);
        blank(i + 1);
        stack.push({ kind: "code", depth: 0 });
        prevSig = "{";
        prevWord = "";
        i += 2;
      } else {
        blank(i);
        i++;
      }
      continue;
    }
    // Ngữ cảnh mã.
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) blank(i++);
    } else if (c === '"' || c === "'") {
      blank(i);
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") blank(i++);
        blank(i++);
      }
      blank(i);
      i++;
      prevSig = c;
    } else if (c === "`") {
      blank(i);
      stack.push({ kind: "tpl", depth: 0 });
      i++;
    } else if (
      c === "/" &&
      (prevSig === "" ||
        "(,=:[!&|?{};+-*%<>~^".includes(prevSig) ||
        ["return", "typeof", "case"].includes(prevWord))
    ) {
      // Regex literal: bỏ tới `/` đóng (lớp ký tự [...] có thể chứa `/`).
      blank(i);
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        const d = src[i] as string;
        if (d === "\\") blank(i++);
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        blank(i++);
      }
      blank(i);
      i++;
      while (i < src.length && /[a-z]/i.test(src[i] as string)) blank(i++);
      prevSig = "/";
      prevWord = "";
    } else {
      if (c === "{") top().depth++;
      else if (c === "}") {
        if (top().depth === 0 && stack.length > 1) {
          blank(i);
          stack.pop(); // đóng `${…}` → về template
          i++;
          continue;
        }
        top().depth--;
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < src.length && /[\w$]/.test(src[j] as string)) j++;
        prevWord = src.slice(i, j);
        prevSig = "a";
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        prevSig = c;
        prevWord = "";
      }
      i++;
    }
  }
  return { masked: out.join(""), clean: stack.length === 1 };
}

/** Vị trí đóng của nhóm mở tại `open` (`(`, `{` hoặc `[`) trong chuỗi đã che; -1 nếu không cân bằng. */
function matching(masked: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i] as string;
    if (pairs[c]) stack.push(pairs[c] as string);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export interface Region {
  kind: string;
  start: number;
  end: number;
}

/** Mọi vùng "đang trong transaction" của một file (trên chuỗi đã che). */
export function transactionRegions(masked: string): Region[] {
  const regions: Region[] = [];
  const add = (kind: string, start: number, end: number) => {
    if (end > start) regions.push({ kind, start, end });
  };
  // 1) `.transaction()` [.setIsolationLevel(…)] .execute( callback )
  for (const m of masked.matchAll(
    /\.transaction\s*\(\s*\)((?:\s*\.\s*setIsolationLevel\s*\([^)]*\))?)\s*\.\s*execute\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    add("transaction().execute", open, matching(masked, open));
  }
  // 2) Hàm bọc transaction của dự án và pipeline lệnh: toàn bộ danh sách đối số.
  for (const m of masked.matchAll(
    /(?<![\w$.])(withTenantRetry|withTenant|executeCommand)\s*(?:<[^()]*>)?\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    add(m[1] as string, open, matching(masked, open));
  }
  // 3) Hàm có tham số `CommandContext`/`Transaction<…>`: chạy trong transaction của người gọi.
  for (let i = masked.indexOf("("); i >= 0; i = masked.indexOf("(", i + 1)) {
    const close = matching(masked, i);
    if (close < 0) continue;
    const params = masked.slice(i + 1, close);
    if (!/\b(?:CommandContext|Transaction\s*<)/.test(params)) continue;
    // Chỉ khi đây là danh sách tham số của hàm: ngay sau là `=>` hoặc (: kiểu trả về) `{`.
    let j = close + 1;
    let angle = 0;
    let bodyStart = -1;
    let arrow = false;
    for (; j < masked.length; j++) {
      const c = masked[j] as string;
      if (c === "=" && masked[j + 1] === ">") {
        arrow = true;
        bodyStart = j + 2;
        break;
      }
      if (c === "<") angle++;
      else if (c === ">") angle--;
      else if (c === "{" && angle <= 0) {
        bodyStart = j;
        break;
      } else if ((c === ";" || c === ")" || c === ",") && angle <= 0) break;
      if (j - close > 400) break;
    }
    if (bodyStart < 0) continue;
    // Phải là khai báo hàm: trước `(` là tên/`function`/`async`/`=`/`:`/`(`… — loại lời gọi kiểu `f(trx)`: lời gọi không có `{`/`=>` ngay sau.
    if (arrow) {
      let k = bodyStart;
      while (/\s/.test(masked[k] as string)) k++;
      if (masked[k] === "{") add("fn(CommandContext|Transaction)", k, matching(masked, k));
      else {
        let depth = 0;
        let e = k;
        for (; e < masked.length; e++) {
          const c = masked[e] as string;
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c)) {
            if (depth === 0) break;
            depth--;
          } else if ((c === ";" || c === ",") && depth === 0) break;
        }
        add("fn(CommandContext|Transaction)", k, e);
      }
    } else {
      add("fn(CommandContext|Transaction)", bodyStart, matching(masked, bodyStart));
    }
  }
  return regions;
}

export interface Rule {
  id: string;
  what: string;
  re: RegExp;
}

/** Tác dụng phụ ra ngoài CSDL — cấm trong transaction (ARC-INT-003, DB-TX-003). */
export const FORBIDDEN: readonly Rule[] = [
  { id: "net-fetch", what: "fetch(...)", re: /(?<![\w$])(?:globalThis\.)?fetch\s*\(/g },
  {
    id: "net-http",
    what: "client HTTP/socket",
    re: /(?<![\w$.])(?:https?|http2|net|tls)\.(?:request|get|connect|createConnection)\s*\(|\bnew\s+(?:WebSocket|XMLHttpRequest)\b|\bresilientSend\s*\(/g,
  },
  {
    id: "object-storage",
    what: "object storage (put/get/head/delete/ping/ensureBucket)",
    re: /\bstorage\s*\.\s*(?:put|get|head|delete|ping|ensureBucket|list|copy)\s*\(|\bnew\s+ObjectStorage\b/g,
  },
  { id: "queue", what: "pg-boss (`boss.`)", re: /(?<![\w$])boss\s*\.\s*\w+|\bnew\s+PgBoss\b/g },
  {
    id: "mail",
    what: "gửi mail",
    re: /(?<![\w$])(?:sender|emailSender|mailer|transport|smtp)\s*\.\s*send\w*\s*\(|\bsendMail\s*\(|\bsendDueEmails\s*\(|\bnodemailer\b/g,
  },
  {
    id: "av-scan",
    what: "quét mã độc (clamd qua socket)",
    re: /\bscanOrFail\s*\(|\bscanner\s*\.\s*scan\s*\(/g,
  },
];

export interface Violation {
  file: string;
  rule: string;
  region: string;
  line: number;
  text: string;
}

export function scanSource(file: string, src: string): Violation[] {
  const { masked } = maskCode(src);
  const regions = transactionRegions(masked);
  const found = new Map<string, Violation>();
  for (const r of regions) {
    const text = masked.slice(r.start, r.end);
    for (const rule of FORBIDDEN) {
      for (const m of text.matchAll(rule.re)) {
        const at = r.start + (m.index ?? 0);
        const key = `${rule.id}@${at}`; // vùng lồng nhau không đếm hai lần
        if (found.has(key)) continue;
        const line = masked.slice(0, at).split("\n").length;
        found.set(key, {
          file,
          rule: rule.id,
          region: r.kind,
          line,
          text: (src.split("\n")[line - 1] ?? "").trim().slice(0, 100),
        });
      }
    }
  }
  return [...found.values()];
}
