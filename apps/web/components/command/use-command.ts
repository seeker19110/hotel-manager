"use client";
// Gửi command theo API-CONTRACT §1 (JSON + Idempotency-Key) với hành vi mạng của SPEC-pwa:
// - S-006 mất mạng: không gửi, báo OFFLINE; bấm lại được khi có mạng — nhưng khi mạng vừa trở lại, `router.refresh()` tải lại
//   trạng thái từ máy chủ rồi mới mở nút (khoá ~1 round-trip, tối đa RECONNECT_REFRESH_CAP_MS) để không thao tác trên màn đã cũ
//   (SPEC-housekeeping-maintenance S-024; mâu thuẫn với S-006 đã giải ở D-050).
// - S-010 hết thời gian chờ/mất phản hồi: "Đang kiểm tra kết quả…" → GET /api/v1/commands/{key}; đã commit ⇒ hiện kết quả
//   từ server, KHÔNG gửi lần hai. S-012 đang xử lý ⇒ hỏi lại theo backoff 1-2-4-8 s, tổng tối đa 30 s (nút "Gửi lại" khoá suốt
//   thời gian chờ); quá hạn ⇒ RESULT_UNKNOWN kèm command_id, KHÔNG gửi lại.
// - BE-API-008 (D-043): 409 IDEMPOTENCY_IN_PROGRESS (lần đầu cùng key còn chạy) ⇒ đợi `Retry-After` rồi tra như "checking",
//   KHÔNG gửi payload mới; lần đầu chưa commit nên GET chưa thấy lệnh (404) = vẫn đang chạy, không phải "server chưa nhận".
// - S-011 server chưa nhận (404 COMMAND_NOT_FOUND) ⇒ bật "Gửi lại", gửi lại dùng CÙNG key.
// Key giữ nguyên tới khi có kết quả chắc chắn; lỗi nghiệp vụ (4xx) ⇒ key mới cho lần sửa sau (tránh IDEMPOTENCY_CONFLICT).
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import { type CommonMessages, useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { firstNonEmpty } from "../../lib/text.ts";
import { reportClientOutdated, useOnline } from "../pwa/pwa-shell.tsx";
import { appVersionHeaders, CLIENT_OUTDATED_CODE } from "./app-version.ts";
import { checkCommandInputLazy } from "./command-inputs-lazy.ts";
import { IN_PROGRESS_CODE, retryAfterMs } from "./in-progress.ts";
import { CONTEXT_CHANGED_CODE, orgContextHeaders } from "./org-context.ts";
import { requestReauth } from "./reauth.ts";
import { recheckSchedule } from "./recheck.ts";

export interface ProblemLike {
  code: string;
  status?: number;
  title?: string;
  detail?: string;
  errors?: { field: string; code: string }[];
  items?: Record<string, unknown>[];
  correlation_id?: string;
  /** Mã thao tác (Idempotency-Key) — chỉ có ở `RESULT_UNKNOWN` (client) để người dùng đọc cho quản lý/hỗ trợ. */
  command_id?: string;
}

// unknown: chưa biết server đã nhận (404/mất mạng khi tra) ⇒ chỉ "Gửi lại" cùng key; processing: server báo đang xử lý quá
// lâu (S-012) ⇒ "Kiểm tra lại". Ở hai trạng thái này form bị khoá: không gửi payload khác dưới key cũ (review lát 4 🟠2).
export type CommandPhase = "idle" | "sending" | "checking" | "unknown" | "processing" | "done" | "error";

export const RESULT_UNKNOWN_CODE = "RESULT_UNKNOWN";

/** Trần chờ tải lại sau khi có mạng: mạng chập chờn không được khoá nút vô hạn (hết hạn thì mở, lệnh vẫn do server kiểm). */
export const RECONNECT_REFRESH_CAP_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lỗi 5xx: KHÔNG hiện `detail`/`title` từ server (phòng khi lớp nào đó lộ chi tiết nội bộ) — chỉ câu chung + mã tra cứu.
 * `m` = chữ `common.` (`useMessages()`, D-101).
 */
export function problemText(m: CommonMessages, p: ProblemLike | null): string | null {
  if (!p) return null;
  if ((p.status ?? 0) >= 500)
    return p.correlation_id && /^[\w-]{1,64}$/.test(p.correlation_id)
      ? tm(m, "common.command.server_error_ref", { code: p.correlation_id })
      : tm(m, "common.command.server_error");
  return firstNonEmpty(p.detail, p.title) ?? tm(m, "common.command.failed");
}

const contextChanged = (m: CommonMessages): ProblemLike => ({
  code: CONTEXT_CHANGED_CODE,
  status: 409,
  detail: tm(m, "common.command.context_changed"),
});

export function useCommand<T = unknown>(path: string) {
  const m = useMessages();
  const online = useOnline();
  const router = useRouter();
  const [refreshPending, startRefresh] = useTransition();
  // true từ lúc mạng trở lại đến khi `router.refresh()` xong (hoặc hết trần chờ).
  const [reconnecting, setReconnecting] = useState(false);
  const wasOnline = useRef(online);
  const key = useRef<string | null>(null);
  const lastBody = useRef<unknown>(null);
  // Key đã từng vào check() (POST mất phản hồi/5xx/409 đang xử lý…): server CÓ THỂ đã ghi ⇒ không được bỏ key (kể cả khi 401
  // lúc gửi lại rồi người dùng bấm "Để sau"), nếu không lần Lưu sau tạo key mới ⇒ ghi trùng. false = lượt gửi đầu, chưa rõ gì.
  const uncertain = useRef(false);
  // Đăng nhập lại tối đa một lần mỗi lượt gửi/gửi lại/tra (cookie không lưu được ⇒ không lặp hộp thoại vô hạn):
  // none = chưa hỏi · ok = đã đăng nhập lại · declined = bấm "Để sau"/đã dùng hết lượt.
  const reauth = useRef<"none" | "ok" | "declined">("none");
  // Đang có một lượt gửi/tra chạy: lần bấm thứ hai (bấm đúp, Enter lặp) bị bỏ qua — đúng 1 POST (UX-STATE-006, FE-FORM-007).
  // Không dựa vào `disabled` của nút vì state cập nhật sau sự kiện thứ hai trong cùng một nhịp.
  const inflight = useRef(false);
  const [phase, setPhase] = useState<CommandPhase>("idle");
  const [problem, setProblem] = useState<ProblemLike | null>(null);
  const [data, setData] = useState<T | null>(null);
  // Mã thao tác đang gửi/tra (S-010 hiện rút gọn; S-012 RESULT_UNKNOWN hiện đủ để đọc cho quản lý).
  const [commandId, setCommandId] = useState<string | null>(null);

  // S-024: offline → online ⇒ tải lại trạng thái từ máy chủ rồi mới mở nút. Lỗi "mất mạng" cũ không còn đúng nữa nên bỏ.
  useEffect(() => {
    if (online && !wasOnline.current) {
      setReconnecting(true);
      startRefresh(() => router.refresh());
      if (problem?.code === "OFFLINE") {
        setProblem(null);
        if (!key.current) setPhase("idle");
      }
    }
    wasOnline.current = online;
  }, [online, router, problem]);
  useEffect(() => {
    if (!reconnecting) return;
    if (!refreshPending) {
      setReconnecting(false);
      return;
    }
    const t = setTimeout(() => setReconnecting(false), RECONNECT_REFRESH_CAP_MS);
    return () => clearTimeout(t);
  }, [reconnecting, refreshPending]);

  const askReauth = useCallback(async (): Promise<boolean> => {
    if (reauth.current !== "none") return false;
    const ok = await requestReauth();
    reauth.current = ok ? "ok" : "declined";
    return ok;
  }, []);

  /** 401 mà không đăng nhập lại được: key chưa rõ kết quả thì GIỮ (phase unknown, "Gửi lại" cùng key); lượt đầu thì bỏ. */
  const unauthenticated = useCallback((): null => {
    const p: ProblemLike = {
      code: "UNAUTHENTICATED",
      status: 401,
      detail: tm(m, "common.command.unauthenticated"),
    };
    if (!uncertain.current) {
      key.current = null;
      setCommandId(null);
      setProblem(p);
      setPhase("error");
      return null;
    }
    setProblem(p);
    setPhase("unknown");
    return null;
  }, [m]);

  const finish = useCallback((d: T): T => {
    key.current = null;
    uncertain.current = false;
    setCommandId(null);
    setData(d);
    setPhase("done");
    return d;
  }, []);

  const fail = useCallback((p: ProblemLike): null => {
    key.current = null;
    uncertain.current = false;
    setCommandId(null);
    setProblem(p);
    setPhase("error");
    return null;
  }, []);

  // `pending`: server vừa báo lệnh đang xử lý (409 IDEMPOTENCY_IN_PROGRESS) ⇒ đợi `waitMs` trước lần tra đầu, và 404 (lệnh chưa
  // commit nên chưa thấy) nghĩa là còn chạy chứ không phải "server chưa nhận" — không bật "Gửi lại" sớm.
  const check = useCallback(
    async (pending?: { waitMs: number }): Promise<T | null> => {
      uncertain.current = true;
      setPhase("checking");
      let inProgress = false;
      if (pending) {
        inProgress = true;
        await sleep(pending.waitMs);
      }
      const waits = recheckSchedule();
      for (let i = 0; i <= waits.length; i++) {
        try {
          const res = await timedFetch(`/api/v1/commands/${key.current}`, {
            credentials: "same-origin",
            cache: "no-store",
            headers: orgContextHeaders(),
          });
          if (res.status === 401) {
            // S-013: phiên hết hạn lúc đang tra kết quả ⇒ đăng nhập lại rồi tra tiếp CÙNG command_id.
            if (await askReauth()) {
              i--;
              continue;
            }
            return unauthenticated();
          }
          if (res.status === 409) {
            // Sau đăng nhập lại mà tổ chức đang chọn đã khác/mất ⇒ huỷ form như post() (S-013).
            const code = ((await res.json().catch(() => null)) as ProblemLike | null)?.code;
            if (code === CONTEXT_CHANGED_CODE || (reauth.current === "ok" && code === "ORG_CONTEXT_REQUIRED"))
              return fail(contextChanged(m));
          }
          if (res.status === 404 && !pending) {
            setPhase("unknown");
            return null;
          }
          if (res.ok) {
            const j = (await res.json()) as { status: string; data?: T; problem?: ProblemLike };
            if (j.status === "committed") return finish(j.data as T);
            if (j.status === "failed") return fail(j.problem ?? { code: "INTERNAL" });
            inProgress = pending ? true : j.status === "in_progress";
          }
        } catch {
          // vẫn mất mạng — thử lại sau
        }
        const wait = waits[i];
        if (wait !== undefined) await sleep(wait);
      }
      if (inProgress) {
        // S-012: quá hạn hỏi lại mà server vẫn báo đang xử lý ⇒ KHÔNG biết kết quả; khoá form, không cho gửi lại.
        setProblem({
          code: RESULT_UNKNOWN_CODE,
          detail: tm(m, "common.command.result_unknown"),
          command_id: key.current ?? "",
        });
        setPhase("processing");
      } else setPhase("unknown");
      return null;
    },
    [m, finish, fail, askReauth, unauthenticated],
  );

  const post = useCallback(
    async (afterReauth = false): Promise<T | null> => {
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
            ...appVersionHeaders(),
          },
          body: JSON.stringify(lastBody.current ?? {}),
          credentials: "same-origin",
        });
      } catch {
        // Hết hạn (TimeoutError của timedFetch) hay mất mạng: chưa rõ server đã ghi chưa ⇒ tra theo Idempotency-Key, không gửi lại mù.
        return check();
      }
      // Client quá cũ (S-009): server không ghi gì ⇒ bỏ key, báo cập nhật (banner toàn cục có nút "Cập nhật").
      if (res.status === 426) {
        reportClientOutdated();
        return fail({
          code: CLIENT_OUTDATED_CODE,
          status: 426,
          detail: tm(m, "common.command.client_outdated"),
        });
      }
      if (res.status === 401) {
        // D-129: REAUTH_REQUIRED = lệnh nhạy cảm cần mật khẩu/đăng nhập lại gần đây — lỗi nghiệp vụ hiện tại form, KHÔNG phải phiên hết hạn.
        const p = (await res
          .clone()
          .json()
          .catch(() => null)) as ProblemLike | null;
        if (p?.code === "REAUTH_REQUIRED") return fail({ ...p, status: 401 });
        // S-013: phiên hết hạn ⇒ hộp đăng nhập lại; xong thì gửi lại với CÙNG key (server chưa ghi gì ở lượt 401).
        if (await askReauth()) return post(true);
        return unauthenticated();
      }
      const j = (await res.json().catch(() => null)) as ({ data?: T } & ProblemLike) | null;
      if (res.ok) return finish(j?.data as T);
      // Tab khác đã đổi tổ chức: server không ghi gì — báo tải lại, KHÔNG gửi lại (S-013).
      // Sau đăng nhập lại mà tổ chức đang chọn đã khác/mất (cookie ngữ cảnh) ⇒ huỷ form, không gửi sang tổ chức khác (S-013).
      if (
        res.status === 409 &&
        (j?.code === CONTEXT_CHANGED_CODE || (afterReauth && j?.code === "ORG_CONTEXT_REQUIRED"))
      )
        return fail(contextChanged(m));
      // Lần đầu cùng key còn đang xử lý: đợi Retry-After rồi tra kết quả theo key — không gửi payload mới, không tạo key mới.
      if (res.status === 409 && j?.code === IN_PROGRESS_CODE)
        return check({ waitMs: retryAfterMs(res.headers.get("retry-after")) });
      // Key đã dùng cho thao tác khác (vd thao tác trước đã ghi) ⇒ giữ key, tra và hiện kết quả thao tác đó, không tạo key mới.
      if (res.status >= 500 || j?.code === "IDEMPOTENCY_CONFLICT") {
        // Giữ mã tra cứu của lỗi 5xx để hiện cùng "Chưa rõ… Gửi lại" nếu tra kết quả không thấy lệnh.
        if (res.status >= 500 && j) setProblem({ ...j, status: res.status });
        return check();
      }
      return fail(j ?? { code: "INTERNAL", status: res.status });
    },
    [m, path, check, finish, fail, askReauth, unauthenticated],
  );

  /** Mất mạng: không gửi; KHÔNG bỏ key của thao tác đang chưa rõ kết quả. */
  const offline = useCallback((): null => {
    setProblem({ code: "OFFLINE", detail: tm(m, "common.command.offline") });
    setPhase(key.current ? "unknown" : "error");
    return null;
  }, [m]);

  /** Gửi lệnh mới với `body`. Còn thao tác chưa rõ kết quả ⇒ chỉ cho gửi lại đúng payload đó (cùng key). */
  const send = useCallback(
    async (body: unknown): Promise<T | null> => {
      if (inflight.current) return null;
      if (!online) return offline();
      if (key.current && JSON.stringify(body) !== JSON.stringify(lastBody.current)) {
        setProblem({ code: "PENDING_UNKNOWN", detail: tm(m, "common.command.pending") });
        return null;
      }
      // Lưới an toàn cho mọi form (FE-FORM-001): kiểm bằng CHÍNH schema `input` của lệnh trong registry trước khi gửi.
      // Chỉ với thao tác mới (key rỗng): gửi lại cùng payload đã qua kiểm ở lần đầu. Server vẫn validate lại.
      if (!key.current) {
        // Giữ khoá trong lúc chờ tải schema (nạp trễ): bấm gửi lần hai lúc này không tạo thêm lệnh với key khác.
        inflight.current = true;
        let issues: Awaited<ReturnType<typeof checkCommandInputLazy>>;
        try {
          issues = await checkCommandInputLazy(path, body);
        } finally {
          inflight.current = false;
        }
        if (issues && issues.length > 0) {
          setProblem({
            code: "VALIDATION_FAILED",
            status: 422,
            detail: tm(m, "common.command.invalid_input"),
            errors: issues.map((i) => ({ field: i.field, code: "invalid" })),
          });
          setPhase("error");
          return null;
        }
      }
      if (!key.current) {
        key.current = crypto.randomUUID();
        uncertain.current = false;
      }
      setCommandId(key.current);
      lastBody.current = body;
      inflight.current = true;
      reauth.current = "none";
      try {
        return await post();
      } finally {
        inflight.current = false;
      }
    },
    [m, online, path, post, offline],
  );

  /** S-011: gửi lại đúng lệnh cũ, cùng Idempotency-Key. */
  const resend = useCallback(async (): Promise<T | null> => {
    if (inflight.current) return null;
    if (!online) return offline();
    if (!key.current) return null;
    inflight.current = true;
    reauth.current = "none";
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
    reauth.current = "none";
    setProblem(null);
    try {
      return await check();
    } finally {
      inflight.current = false;
    }
  }, [check]);

  const locked =
    phase === "sending" ||
    phase === "checking" ||
    phase === "unknown" ||
    phase === "processing" ||
    reconnecting;
  return {
    send,
    resend,
    recheck,
    phase,
    problem,
    data,
    commandId,
    locked,
    /** Đang tải lại trạng thái sau khi có mạng (S-024). */
    reconnecting,
    busy: phase === "sending" || phase === "checking",
  };
}
