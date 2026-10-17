// Điểm công khai của module `notifications` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export { createNotification } from "./dispatch.ts";
export {
  getPreferences,
  listDeliveries,
  listMyNotifications,
  markAllRead,
  markRead,
  retryDelivery,
  unsubscribe,
  unsubscribeKey,
  updatePreference,
  updateSettings,
} from "./preferences.ts";
