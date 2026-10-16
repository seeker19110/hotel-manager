"use client";
import { RouteError } from "../../components/ui/route-state.tsx";

export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError title="Đối soát ngân hàng" {...props} />;
}
