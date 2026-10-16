// Gửi mã OTP đăng nhập của người thuê (SPEC-portal Q-01, D-005). Chưa có adapter SMTP thật (D-010: chờ duyệt giấy phép),
// nên chỉ có hai chế độ theo `SMTP_URL`:
// - `fake://local` (mặc định): bỏ mã — không giữ OTP trong bộ nhớ/log.
// - `fake://file?path=<đường dẫn tuyệt đối>`: bản giả cho dev/E2E, mỗi mã là một dòng JSON ở hộp thư giả. Chỉ dùng với DB
//   giả: người vận hành phải cố ý đặt SMTP_URL kiểu này.
// - `smtp(s)://…`: chưa hỗ trợ → trả `undefined` (không gửi), giống trước khi có adapter.
import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface OutboxLine {
  to: string;
  subject: string;
  text: string;
}

export const OTP_TTL_MINUTES = 5;

export function otpMessage(otp: string): { subject: string; text: string } {
  return {
    subject: "Mã đăng nhập Hotel Manager",
    text: `Mã đăng nhập của bạn là ${otp}. Mã có hiệu lực ${OTP_TTL_MINUTES} phút. Không chia sẻ mã này cho bất kỳ ai.`,
  };
}

/** Đường dẫn hộp thư giả từ SMTP_URL; null nếu không phải dạng `fake://file?path=…` hợp lệ. */
export function fakeOutboxPath(smtpUrl: string): string | null {
  if (!smtpUrl.startsWith("fake://file")) return null;
  try {
    const p = new URL(smtpUrl).searchParams.get("path");
    return p && isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

export function createSignInOtpSender(
  smtpUrl: string,
): ((email: string, otp: string) => Promise<void>) | undefined {
  const path = fakeOutboxPath(smtpUrl);
  if (path) {
    return async (email, otp) => {
      const line: OutboxLine = { to: email, ...otpMessage(otp) };
      await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    };
  }
  if (smtpUrl.startsWith("fake://")) return async () => {};
  return undefined;
}
