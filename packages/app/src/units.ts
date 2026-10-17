// Cửa vào hằng/hàm đổi đơn vị cho `apps/*` (XC-UNITS-009): web chỉ phụ thuộc @hm/app nên nhận lại từ domain qua subpath nhẹ
// `@hm/app/units` (không kéo cả barrel máy chủ vào bundle trình duyệt).
export * from "@hm/domain/units";
