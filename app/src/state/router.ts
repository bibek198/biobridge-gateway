import { useEffect, useState } from "react";

// Hash routing (#/devices, #/devices/c3): linkable pages and a working back button without a router dependency.

export type PageId =
  | "overview"
  | "devices"
  | "live"
  | "alerts"
  | "sync"
  | "placement"
  | "recordings"
  | "pipeline"
  | "add"
  | "descriptors"
  | "verification";

export const PAGE_IDS: PageId[] = ["overview", "devices", "live", "alerts", "sync", "placement", "recordings", "pipeline", "add", "descriptors", "verification"];

export type Route = { page: PageId; param: string | null };

export function parseHash(hash: string): Route {
  const [page, param] = hash.replace(/^#\/?/, "").split("/");
  return PAGE_IDS.includes(page as PageId) ? { page: page as PageId, param: param ? decodeURIComponent(param) : null } : { page: "overview", param: null };
}

export function href(page: PageId, param?: string | null): string {
  return `#/${page}${param ? `/${encodeURIComponent(param)}` : ""}`;
}

export function navigate(page: PageId, param?: string | null): void {
  window.location.hash = href(page, param);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseHash(window.location.hash));
      document.querySelector(".workspace")?.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
