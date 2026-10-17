import { vndInWords } from "@hm/app";
import { vnd } from "../../lib/format.ts";

/** Số tiền: hiện "1.580.000 đ", trình đọc màn hình đọc thành chữ ("một triệu … đồng") — SPEC-portal §5 tiếp cận. */
export function Money({ value, testId }: { value: number; testId?: string }) {
  return (
    <span className="money">
      <span aria-hidden="true" data-testid={testId}>
        {vnd(value)}
      </span>
      <span className="visually-hidden">{vndInWords(value)}</span>
    </span>
  );
}
