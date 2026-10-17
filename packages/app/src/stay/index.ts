// Điểm công khai của module `stay` (ARC-MOD-005): module khác chỉ import qua tệp này, không import tệp nội bộ.
export { checkOut } from "./checkout.ts";
export { getFolio, postCharge, voidCharge } from "./folio.ts";
export { createRoomType, quote, setRate, updateRoomType } from "./rates.ts";
export {
  cancelReservation,
  changeDates,
  confirmReservation,
  createReservation,
  getReservation,
  holdReservation,
  listReservations,
  markNoShow,
} from "./reservations.ts";
export {
  exportResidenceNotice,
  listNotices,
  markNoticeSubmitted,
  prepareResidenceNotice,
} from "./residence-notices.ts";
export { checkIn, type GuestInput, walkIn } from "./stays.ts";
