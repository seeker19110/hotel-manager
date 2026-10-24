import { RouteLoading } from "../../../components/ui/route-state.tsx";
import { t } from "../../../lib/i18n.ts";

export default function Loading() {
  return <RouteLoading title={t("route_title.walk_in")} />;
}
