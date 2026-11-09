import { useNavigate, type AnyRouter } from "@tanstack/react-router";

import { getTempoLook } from "../../tempo/look/applyTempoLook";
import { GUEST_PAGE_PATH } from "../../guestPage";

// tempo: the tempo look draws Usage as a page in the sheet, like Pull requests, not as a modal.
export const isUsageSheetPage = (pathname: string) =>
  pathname === "/usage" && getTempoLook() === "tempo";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    (pathname === "/usage" && getTempoLook() === "classic")
  );
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") || pathname === "/pull-requests" || isUsageSheetPage(pathname)
  );
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    appModalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) mainAppHref = href;
  };
  record();
  return router.subscribe("onResolved", record);
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
}
