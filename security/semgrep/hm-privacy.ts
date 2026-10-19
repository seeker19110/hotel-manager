// Test dương/âm cho security/semgrep/hm-privacy.yml (`semgrep --test security/semgrep`).
declare const log: {
  info(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
};
declare const user: { id: string; fullName: string; email: string };
declare const req: { method: string; body: unknown };
declare const guest: { id: string; name: string };

// ruleid: hm-log-pii-object
log.info("đăng nhập", { user });
// ruleid: hm-log-pii-object
log.info("đăng nhập", { actor: user });
// ruleid: hm-log-pii-object
log.error("lỗi", { request: req });
// ruleid: hm-log-pii-object
log.info("body", { b: req.body });
// ruleid: hm-log-pii-field, hm-log-pii-key
log.info("khách", { guest_name: guest.name });
// ruleid: hm-log-pii-field
log.info("khách", { n: user.fullName });

// ok: hm-log-pii-object
log.info("đăng nhập", { person_id: user.id });
// ok: hm-log-pii-object
log.info("request", { method: req.method });
// ok: hm-log-pii-field
log.info("khách", { guest_id: guest.id });
// ok: hm-log-pii-object
log.info("job.done", { job: "x", ms: 1 });
declare const job: { name: string };
declare const err: { message: string };
// ok: hm-log-pii-field
log.info("worker.started", { name: job.name });
// ok: hm-log-pii-object
log.error("job.failed", { message: err.message });

// --- Logger tiêm vào (hàm `log`/`logger`), msg không literal, chuỗi truy cập, khoá và spread ---
declare function logger(msg: string, f?: Record<string, unknown>): void;
declare const msg: string;
declare const actor: { id: string; fullName: string };
declare const ctx: { user?: { fullName: string; id: string } };
declare const stay: { guest_name: string; id: string };
declare const row: { guestName: string; id: string };

// ruleid: hm-log-pii-object-fn
logger("notification.x", { guest });
// ruleid: hm-log-pii-object
log.info(msg, { user });
// ruleid: hm-log-pii-object
log.info("b", { actor });
// ruleid: hm-log-pii-object
log.info("b", { u: ctx.user! });
// ruleid: hm-log-pii-object
log.info("b", { u: ctx["user"] });
// ruleid: hm-log-pii-field
log.info("b", { n: ctx.user?.fullName });
// ruleid: hm-log-pii-field
log.info("b", { n: user["fullName"] });
// ruleid: hm-log-pii-field
log.info("b", { n: guest?.name });
// ruleid: hm-log-pii-field-fn
logger("b", { n: user.fullName });
// ruleid: hm-log-pii-key, hm-log-pii-field
log.info("b", { guest_name: stay.guest_name });
// ruleid: hm-log-pii-key, hm-log-pii-field
log.info("b", { guestName: row.guestName });
// ruleid: hm-log-pii-spread
log.info("b", { ...user });

// ok: hm-log-pii-object-fn
logger("notification.x", { guest_id: guest.id });
// ok: hm-log-pii-key
log.info("b", { stay_id: stay.id, org: row.id });
// ok: hm-log-pii-object
log.info(msg, { u: ctx.user?.id });

// ruleid: hm-log-pii-key-fn, hm-log-pii-field-fn
logger("b", { guest_name: stay.guest_name });
// ruleid: hm-log-pii-spread-fn
logger("b", { ...user });
// ok: hm-log-pii-spread
log.info("b", { ...{ job: "x" } });

// --- JSON.stringify object người trong lời gọi log (chuỗi JSON né được che theo tên khoá) ---
declare const childLog: { child(b: Record<string, unknown>): typeof log };
// ruleid: hm-log-pii-stringify
log.info("đăng nhập", { u: JSON.stringify(user) });
// ruleid: hm-log-pii-stringify
log.error(`lỗi ${JSON.stringify(req.body)}`);
// ruleid: hm-log-pii-stringify
log.info("b", { u: JSON.stringify(ctx.user, null, 2) });
// ruleid: hm-log-pii-stringify-fn
logger("b", { g: JSON.stringify(guest) });
// ok: hm-log-pii-stringify
log.info("b", { ids: JSON.stringify([user.id, guest.id]) });
// ok: hm-log-pii-stringify
log.info("job", { meta: JSON.stringify(job) });
// ok: hm-log-pii-stringify-fn
logger("b", { ids: JSON.stringify({ person_id: user.id }) });

// --- Logger con: bindings gắn vào mọi dòng log sau đó ---
// ruleid: hm-log-pii-child
childLog.child({ user });
// ruleid: hm-log-pii-child
childLog.child({ actor: ctx.user! });
// ruleid: hm-log-pii-child
childLog.child({ ...req });
// ruleid: hm-log-pii-child
childLog.child({ n: guest.name });
// ruleid: hm-log-pii-child
childLog.child({ n: row.guestName });
// ruleid: hm-log-pii-child
childLog.child({ u: JSON.stringify(user) });
// ok: hm-log-pii-child
childLog.child({ component: "notify.dispatch", person_id: user.id });
// ok: hm-log-pii-child
childLog.child({ correlation_id: "c-1" });
