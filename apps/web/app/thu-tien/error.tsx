"use client";
import { RouteError } from "../../components/ui/route-state.tsx";
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";

export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  const m = useMessages();
  return <RouteError title={tm(m, "common.route_title.thu_tien")} {...props} />;
}
