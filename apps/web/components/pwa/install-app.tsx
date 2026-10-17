"use client";
// Cài ứng dụng (SPEC-pwa S-002/S-003): Chrome/Edge có `beforeinstallprompt` ⇒ nút "Cài ứng dụng" mở hộp cài của trình duyệt;
// Safari iOS không có sự kiện ⇒ hướng dẫn "Chia sẻ → Thêm vào MH chính" bằng chữ + hình, KHÔNG có nút cài giả; đã chạy ở chế
// độ standalone ⇒ báo đã cài. Trình duyệt khác chưa hỗ trợ ⇒ chỉ lời nhắn.
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { useInstall } from "./pwa-shell.tsx";

export function InstallApp() {
  const { state, install } = useInstall();
  return (
    <section aria-labelledby="cai-ung-dung" className="panel" data-testid="install-app" data-state={state}>
      <h2 id="cai-ung-dung">Cài ứng dụng</h2>
      {state === "installed" ? <p role="status">Ứng dụng đã được cài trên thiết bị này.</p> : null}
      {state === "prompt" ? (
        <>
          <p>Cài về màn hình chính để mở nhanh như một ứng dụng.</p>
          <Button onClick={() => void install()}>Cài ứng dụng</Button>
        </>
      ) : null}
      {state === "ios" ? (
        <div data-testid="ios-install-guide">
          <p>Trên iPhone/iPad (Safari, iOS 16.4 trở lên), cài ứng dụng bằng 3 bước:</p>
          <ol className="install-steps">
            <li>
              Bấm nút <strong>Chia sẻ</strong> <Icon name="share" /> ở thanh công cụ của Safari.
            </li>
            <li>
              Kéo xuống và chọn <strong>Thêm vào MH chính</strong> <Icon name="plus-square" />.
            </li>
            <li>
              Bấm <strong>Thêm</strong> ở góc trên bên phải.
            </li>
          </ol>
        </div>
      ) : null}
      {state === "unsupported" ? (
        <p>
          Trình duyệt này chưa cho cài trực tiếp từ đây. Dùng Chrome hoặc Edge (Android, máy tính) hoặc Safari
          (iPhone, iPad) để cài ứng dụng.
        </p>
      ) : null}
    </section>
  );
}
