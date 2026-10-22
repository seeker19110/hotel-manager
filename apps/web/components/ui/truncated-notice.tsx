// Tách khỏi state.tsx (D-098): state.tsx được client component dùng nên không được import lib/i18n.ts (kéo cả catalog vào
// bundle); thông báo này chỉ render ở server.
import { t } from "../../lib/i18n.ts";

/**
 * Danh sách bị cắt ở trần của truy vấn (AUD-XFEAT-001): `shown` = số dòng nhận được, `limit` = trần SQL. Chạm trần ⇒ có thể còn
 * dòng bị bỏ — báo rõ thay vì im lặng (lịch phòng thiếu đặt phòng trông như phòng trống). Chưa chạm trần ⇒ không hiện gì.
 */
export function TruncatedNotice({ shown, limit }: { shown: number; limit: number }) {
  if (shown < limit) return null;
  return (
    <div className="state" role="status">
      <p className="state__text">{t("list.truncated", { n: limit })}</p>
    </div>
  );
}
