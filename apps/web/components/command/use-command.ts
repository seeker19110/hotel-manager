"use client";
// Gửi command theo API-CONTRACT §1 (JSON + Idempotency-Key) với hành vi mạng của SPEC-pwa:
// - S-006 mất mạng: không gửi, báo OFFLINE; bấm lại được khi có mạng.
// - S-010 hết thời gian chờ/mất phản hồi: "Đang kiểm tra kết quả…" → GET /api/v1/commands/{key}; đã commit ⇒ hiện kết quả
//   từ server, KHÔNG gửi lần hai. S-012 đang xử lý ⇒ hỏi lại.
// - S-011 server chưa nhận (404 COMMAND_NOT_FOUND) ⇒ bật "Gửi lại", gửi lại dùng CÙNG key.
// Key giữ nguyên tới khi có kết quả chắc chắn; lỗi nghiệp vụ (4xx) ⇒ key mới cho lần sửa sau (tránh IDEMPOTENCY_CONFLICT).
import { useCallback, useRef, useState } from "react";
import { useOnline } from "../pwa/pwa-shell.tsx";

export interface ProblemLike {
  code: string;
  status?: number;
  title?: string;
  detail?: string;
  errors?: { field: string; code: string }[];
  items?: Record<string, unknown>[];
}

// unknown: chưa biết server đã nhận (404/mất mạng khi tra) ⇒ chỉ "Gửi lại" cùng key; processing: server báo đang xử lý quá
// lâu (S-012) ⇒ "Kiểm tra lại". Ở hai trạng thái này form bị khoá: không gửi payload khác dưới key cũ (review lát 4 🟠2).
export type CommandPhase = "idle" | "sending" | "checking" | "unknown" | "processing" | "done" | "error";

const TIMEOUT_MS = 15_000;
const POLL_MS = 1_000;
const POLL_TRIES = 8;

export const OFFLINE_TEXT = "Không có kết nối mạng. Thao tác chưa được gửi.";
export const PENDING_TEXT =
  'Thao tác trước chưa rõ kết quả. Bấm "Gửi lại" để gửi đúng thao tác đó, hoặc tải lại trang để xem kết quả trước khi làm thao tác khác.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function problemText(p: ProblemLike | null): string | null {
  if (!p) return null;
  return p.detail || p.title || "Không thực hiện được. Vui lòng thử lại.";
}

export function useCommand<T = unknown>(path: string) {
  const online = useOnline();
  const key = useRef<string | null>(null);
  const lastBody = useRef<unknown>(null);
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
        const res = await fetch(`/api/v1/commands/${key.current}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (res.status === 401) {
          window.location.assign("/dang-nhap");
          return null;
        }
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
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current as string },
        body: JSON.stringify(lastBody.current ?? {}),
        credentials: "same-origin",
        signal: ctl.signal,
      });
    } catch {
      return check();
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      window.location.assign("/dang-nhap");
      return null;
    }
    const j = (await res.json().catch(() => null)) as ({ data?: T } & ProblemLike) | null;
    if (res.ok) return finish(j?.data as T);
    // Key đã dùng cho thao tác khác (vd thao tác trước đã ghi) ⇒ giữ key, tra và hiện kết quả thao tác đó, không tạo key mới.
    if (res.status >= 500 || j?.code === "IDEMPOTENCY_CONFLICT") return check();
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
      if (!online) return offline();
      if (key.current && JSON.stringify(body) !== JSON.stringify(lastBody.current)) {
        setProblem({ code: "PENDING_UNKNOWN", detail: PENDING_TEXT });
        return null;
      }
      key.current ??= crypto.randomUUID();
      lastBody.current = body;
      return post();
    },
    [online, post, offline],
  );

  /** S-011: gửi lại đúng lệnh cũ, cùng Idempotency-Key. */
  const resend = useCallback(async (): Promise<T | null> => {
    if (!online) return offline();
    if (!key.current) return null;
    return post();
  }, [online, post, offline]);

  /** S-012: tra lại kết quả lệnh đang xử lý. */
  const recheck = useCallback(async (): Promise<T | null> => (key.current ? check() : null), [check]);

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
