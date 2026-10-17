// Điểm công khai của module `auth` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export { type Auth, createAuth } from "./auth.ts";
export { createSignInOtpSender } from "./otp-mail.ts";
