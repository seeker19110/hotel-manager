// Đơn vị và hằng chuyển đổi tập trung (XC-UNITS-009, P5): MỌI phép đổi byte/giây/mili-giây đi qua file này — không số ma thuật
// (`* 1000`, `/ 1024`, `86_400_000`) rải trong mã. Rào: packages/app/src/units-guards.test.ts quét mã nguồn.
// Quy ước tên: đại lượng có đơn vị mang đơn vị trong tên (`...Ms`, `...Seconds`, `...Bytes`); hàm đổi trả số nguyên.

// ——— Thời gian ———
export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;

export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
export const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
export const MS_PER_DAY = MS_PER_HOUR * HOURS_PER_DAY;
export const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;
export const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;

/** Độ lệch của múi giờ Việt Nam so với UTC (Asia/Ho_Chi_Minh, không giờ mùa hè), tính bằng giờ. */
export const VN_UTC_OFFSET_HOURS = 7;

/** giây → mili-giây. */
export const secondsToMs = (s: number): number => s * MS_PER_SECOND;
/** phút → mili-giây. */
export const minutesToMs = (m: number): number => m * MS_PER_MINUTE;
/** giờ → mili-giây. */
export const hoursToMs = (h: number): number => h * MS_PER_HOUR;
/** ngày → mili-giây. */
export const daysToMs = (d: number): number => d * MS_PER_DAY;
/** giờ → phút. */
export const hoursToMinutes = (h: number): number => h * MINUTES_PER_HOUR;
/** phút → giây. */
export const minutesToSeconds = (m: number): number => m * SECONDS_PER_MINUTE;
/** mili-giây → giây, làm tròn XUỐNG (đồng hồ đếm ngược, hạn token không được dài hơn thật). */
export const msToSeconds = (ms: number): number => Math.floor(ms / MS_PER_SECOND);
/** mili-giây → giây KHÔNG làm tròn (so khoảng lệch với mốc `exp`/timestamp của chữ ký webhook). */
export const msToSecondsExact = (ms: number): number => ms / MS_PER_SECOND;
/** Thời điểm → giây kể từ epoch (làm tròn xuống) — dạng `exp` của token/chữ ký. */
export const epochSeconds = (d: Date): number => msToSeconds(d.getTime());

/** Độ lệch múi giờ Việt Nam tính bằng mili-giây (cộng vào epoch UTC để lấy "giờ tường" Việt Nam). */
export const VN_UTC_OFFSET_MS = hoursToMs(VN_UTC_OFFSET_HOURS);

// ——— Dung lượng (nhị phân: KiB = 1024 byte) ———
export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

/** KiB → byte. */
export const kibToBytes = (n: number): number => n * BYTES_PER_KIB;
/** MiB → byte. */
export const mibToBytes = (n: number): number => n * BYTES_PER_MIB;
