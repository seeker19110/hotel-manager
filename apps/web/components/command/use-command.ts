"use client";
// Gửi command theo API-CONTRACT §1 (JSON + Idempotency-Key) với hành vi mạng của SPEC-pwa:
// - S-006 mất mạng: không gửi, báo OFFLINE; bấm lại được khi có mạng.
// - S-010 hết thời gian chờ/mất phản hồi: "Đang kiểm tra kết quả…" → GET /api/v1/commands/{key}; đã commit ⇒ hiện kết quả
//   từ server, KHÔNG gửi lần hai. S-012 đang xử lý ⇒ hỏi lại.
// - S-011 server chưa nhận (404 COMMAND_NOT_FOUND) ⇒ bật "Gửi lại", gửi lại dùng CÙNG key.
// Key giữ nguyên tới khi có kết quả chắc chắn; lỗi nghiệp vụ (4xx) ⇒ key mới cho lần sửa sau (tránh IDEMPOTENCY_CONFLICT).
import { checkCommandInput } from "@hm/app/command-inputs";
import { useCallback, useRef, useState } from "react";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import { useOnline } from "../pwa/pwa-shell.tsx";
import { CONTEXT_CHANGED_CODE, CONTEXT_CHANGED_TEXT, orgContextHeaders } from "./org-context.ts";

export interface ProblemLike {
  code: string;
  status?: number;
  title?: string;
  detail?: string;
  errors?: { field: string; code: string }[];
  items?: Record<string, unknown>[];
  correlation_id?: string;
}

// unknown: chưa biết server đã nhận (404/mất mạng khi tra) ⇒ chỉ "Gửi lại" cùng key; processing: server báo đang xử lý quá
// lâu (S-012) ⇒ "Kiểm tra lại". Ở hai trạng thái này form bị khoá: không gửi payload khác dưới key cũ (review lát 4 🟠2).
export type CommandPhase = "idle" | "sending" | "checking" | "unknown" | "processing" | "done" | "error";

const POLL_MS = 1_000;
const POLL_TRIES = 8;

export const INVALID_INPUT_TEXT = "Dữ liệu chưa hợp lệ. Kiểm tra lại các ô đã nhập rồi gửi lại.";

export const OFFLINE_TEXT = "Không có kết nối mạng. Thao tác chưa được gửi.";
export const PENDING_TEXT =
  'Thao tác trước chưa rõ kết quả. Bấm "Gửi lại" để gửi đúng thao tác đó, hoặc tải lại trang để xem kết quả trước khi làm thao tác khác.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SERVER_ERROR_TEXT =
  "Hệ thống đang gặp lỗi, thao tác chưa thực hiện được. Vui lòng thử lại sau ít phút.";

/** Lỗi 5xx: KHÔNG hiện `detail`/`title` từ server (phòng khi lớp nào đó lộ chi tiết nội bộ) — chỉ câu chung + mã tra cứu. */
export function problemText(p: ProblemLike | null): string | null {
  if (!p) return null;
  if ((p.status ?? 0) >= 500)
    return p.correlation_id && /^[\w-]{1,64}$/.test(p.correlation_id)
      ? `${SERVER_ERROR_TEXT} Mã tra cứu: ${p.correlation_id}.`
      : SERVER_ERROR_TEXT;
  return p.detail || p.title || "Không thực hiện được. Vui lòng thử lại.";
}

const contextChanged = (): ProblemLike => ({
  code: CONTEXT_CHANGED_CODE,
  status: 409,
  detail: CONTEXT_CHANGED_TEXT,
});

export function useCommand<T = unknown>(path: string) {
  const online = useOnline();
  const key = useRef<string | null>(null);
  const lastBody = useRef<unknown>(null);
  // Đang có một lượt gửi/tra chạy: lần bấm thứ hai (bấm đúp, Enter lặp) bị bỏ qua — đúng 1 POST (UX-STATE-006, FE-FORM-007).
  // Không dựa vào `disabled` của nút vì state cập nhật sau sự kiện thứ hai trong cùng một nhịp.
  const inflight = useRef(false);
  const [phase, setPhase] = useState<CommandPhase>("idle");
  const [problem, setProblem] = useState<ProblemLike | null>(null);
  const [data, setData] = useState<T | null>(null);

  const finish = useCallback((d: T): T => {
    key.current = null;
    setData(d);
    setPhase("done");
    return d;
  }, []);

  const fail = useCallback((p: ProblemLike): null => {
    key.current = null;
    setProblem(p);
    setPhase("error");
    return null;
  }, []);

  const check = useCallback(async (): Promise<T | null> => {
    setPhase("checking");
    let inProgress = false;
    for (let i = 0; i < POLL_TRIES; i++) {
      try {
        const res = await timedFetch(`/api/v1/commands/${key.current}`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: orgContextHeaders(),
        });
        if (res.status === 401) {
          window.location.assign("/dang-nhap");
          return null;
        }
        if (
          res.status === 409 &&
          ((await res.json().catch(() => null)) as ProblemLike | null)?.code === CONTEXT_CHANGED_CODE
        )
          return fail(contextChanged());
        if (res.status === 404) {
          setPhase("unknown");
          return null;
        }
        if (res.ok) {
          const j = (await res.json()) as { status: string; data?: T; problem?: ProblemLike };
          if (j.status === "committed") return finish(j.data as T);
          if (j.status === "failed") return fail(j.problem ?? { code: "INTERNAL" });
          inProgress = j.status === "in_progress";
        }
      } catch {
        // vẫn mất mạng — thử lại sau
      }
      await sleep(POLL_MS);
    }
    setPhase(inProgress ? "processing" : "unknown");
    return null;
  }, [finish, fail]);

  const post = useCallback(async (): Promise<T | null> => {
    setPhase("sending");
    setProblem(null);
    let res: Response;
    try {
      res = await timedFetch(`/api/v1/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key.current as string,
          ...orgContextHeaders(),
        },
        body: JSON.stringify(lastBody.current ?? {}),
        credentials: "same-origin",
      });
    } catch {
      // Hết hạn (TimeoutError của timedFetch) hay mất mạng: chưa rõ server đã ghi chưa ⇒ tra theo Idempotency-Key, không gửi lại mù.
      return check();
    }
    if (res.status === 401) {
      window.location.assign("/dang-nhap");
      return null;
    }
    const j = (await res.json().catch(() => null)) as ({ data?: T } & ProblemLike) | null;
    if (res.ok) return finish(j?.data as T);
    // Tab khác đã đổi tổ chức: server không ghi gì — báo tải lại, KHÔNG gửi lại (S-013).
    if (res.status === 409 && j?.code === CONTEXT_CHANGED_CODE) return fail(contextChanged());
    // Key đã dùng cho thao tác khác (vd thao tác trước đã ghi) ⇒ giữ key, tra và hiện kết quả thao tác đó, không tạo key mới.
    if (res.status >= 500 || j?.code === "IDEMPOTENCY_CONFLICT") {
      // Giữ mã tra cứu của lỗi 5xx để hiện cùng "Chưa rõ… Gửi lại" nếu tra kết quả không thấy lệnh.
      if (res.status >= 500 && j) setProblem({ ...j, status: res.status });
      return check();
    }
    return fail(j ?? { code: "INTERNAL", status: res.status });
  }, [path, check, finish, fail]);

  /** Mất mạng: không gửi; KHÔNG bỏ key của thao tác đang chưa rõ kết quả. */
  const offline = useCallback((): null => {
    setProblem({ code: "OFFLINE", detail: OFFLINE_TEXT });
    setPhase(key.current ? "unknown" : "error");
    return null;
  }, []);

  /** Gửi lệnh mới với `body`. Còn thao tác chưa rõ kết quả ⇒ chỉ cho gửi lại đúng payload đó (cùng key). */
  const send = useCallback(
    async (body: unknown): Promise<T | null> => {
      if (inflight.current) return null;
      if (!online) return offline();
      if (key.current && JSON.stringify(body) !== JSON.stringify(lastBody.current)) {
        setProblem({ code: "PENDING_UNKNOWN", detail: PENDING_TEXT });
        return null;
      }
      // Lưới an toàn cho mọi form (FE-FORM-001): kiểm bằng CHÍNH schema `input` của lệnh trong registry trước khi gửi.
      // Chỉ với thao tác mới (key rỗng): gửi lại cùng payload đã qua kiểm ở lần đầu. Server vẫn validate lại.
      if (!key.current) {
        const issues = checkCommandInput(path, body);
        if (issues && issues.length > 0) {
          setProblem({
            code: "VALIDATION_FAILED",
            status: 422,
            detail: INVALID_INPUT_TEXT,
            errors: issues.map((i) => ({ field: i.field, code: "invalid" })),
          });
          setPhase("error");
          return null;
        }
      }
      key.current ??= crypto.randomUUID();
      lastBody.current = body;
      inflight.current = true;
      try {
        return await post();
      } finally {
        inflight.current = false;
      }
    },
    [online, path, post, offline],
  );

  /** S-011: gửi lại đúng lệnh cũ, cùng Idempotency-Key. */
  const resend = useCallback(async (): Promise<T | null> => {
    if (inflight.current) return null;
    if (!online) return offline();
    if (!key.current) return null;
    inflight.current = true;
    try {
      return await post();
    } finally {
      inflight.current = false;
    }
  }, [online, post, offline]);

  /** S-012: tra lại kết quả lệnh đang xử lý. */
  const recheck = useCallback(async (): Promise<T | null> => {
    if (inflight.current || !key.current) return null;
    inflight.current = true;
    try {
      return await check();
    } finally {
      inflight.current = false;
    }
  }, [check]);

  const locked = phase === "sending" || phase === "checking" || phase === "unknown" || phase === "processing";
  return {
    send,
    resend,
    recheck,
    phase,
    problem,
    data,
    locked,
    busy: phase === "sending" || phase === "checking",
  };
}
