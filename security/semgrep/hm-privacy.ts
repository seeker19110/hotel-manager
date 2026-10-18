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
// ruleid: hm-log-pii-field
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
