"use client";
// Cài ứng dụng (SPEC-pwa S-002/S-003): Chrome/Edge có `beforeinstallprompt` ⇒ nút "Cài ứng dụng" mở hộp cài của trình duyệt;
// Safari iOS không có sự kiện ⇒ hướng dẫn "Chia sẻ → Thêm vào MH chính" bằng chữ + hình, KHÔNG có nút cài giả; đã chạy ở chế
// độ standalone ⇒ báo đã cài. Trình duyệt khác chưa hỗ trợ ⇒ chỉ lời nhắn.
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { useInstall } from "./pwa-shell.tsx";

export function InstallApp({ m }: { m: Messages<"install_app."> }) {
  const { state, install } = useInstall();
  return (
    <section aria-labelledby="cai-ung-dung" className="panel" data-testid="install-app" data-state={state}>
      <h2 id="cai-ung-dung">{tm(m, "install_app.heading")}</h2>
      {state === "installed" ? <p role="status">{tm(m, "install_app.installed")}</p> : null}
      {state === "prompt" ? (
        <>
          <p>{tm(m, "install_app.prompt.text")}</p>
          <Button onClick={() => void install()}>{tm(m, "install_app.prompt.button")}</Button>
        </>
      ) : null}
      {state === "ios" ? (
        <div data-testid="ios-install-guide">
          <p>{tm(m, "install_app.ios.intro")}</p>
          <ol className="install-steps">
            <li>
              {tm(m, "install_app.ios.step1_before")}
              <strong>{tm(m, "install_app.ios.step1_target")}</strong> <Icon name="share" />
              {tm(m, "install_app.ios.step1_after")}
            </li>
            <li>
              {tm(m, "install_app.ios.step2_before")}
              <strong>{tm(m, "install_app.ios.step2_target")}</strong> <Icon name="plus-square" />.
            </li>
            <li>
              {tm(m, "install_app.ios.step3_before")}
              <strong>{tm(m, "install_app.ios.step3_target")}</strong>
              {tm(m, "install_app.ios.step3_after")}
            </li>
          </ol>
        </div>
      ) : null}
      {state === "unsupported" ? <p>{tm(m, "install_app.unsupported")}</p> : null}
    </section>
  );
}
