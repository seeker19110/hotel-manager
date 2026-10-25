import { type InputHTMLAttributes, type SelectHTMLAttributes, useId } from "react";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: string | undefined;
  /** Thông điệp lỗi theo mã (API-CONTRACT) — gắn với ô bằng aria-describedby, đọc ngay bằng role="alert". */
  error?: string | undefined;
}

export function TextField({ label, hint, error, ...rest }: TextFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span id={hintId} className="field__hint">
          {hint}
        </span>
      ) : null}
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {error ? (
        <span id={errorId} className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  options: { value: string; label: string }[];
}

/** Ô chọn một trong danh sách — cùng nhãn/gợi ý/lỗi (aria-describedby + role="alert") như `TextField`. */
export function SelectField({ label, hint, error, options, ...rest }: SelectFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span id={hintId} className="field__hint">
          {hint}
        </span>
      ) : null}
      <select id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? (
        <span id={errorId} className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  label: string;
  hint?: string | undefined;
}

/**
 * Ô chọn có nhãn (đồng ý không bắt buộc — T-2310). Ô vuông 44 px (vùng chạm UX-A11Y-001) đứng trước nhãn bấm được; gợi ý gắn bằng
 * aria-describedby. Không bao giờ tick sẵn trừ khi người gọi truyền `defaultChecked`/`checked` từ trạng thái đã lưu.
 */
export function CheckboxField({ label, hint, ...rest }: CheckboxFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="check">
      <input id={id} type="checkbox" aria-describedby={hintId} {...rest} />
      <div>
        <label htmlFor={id}>{label}</label>
        {hint ? (
          <span id={hintId} className="check__hint">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}
