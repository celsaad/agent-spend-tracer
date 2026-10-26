import { useSyncExternalStore } from "react";

// Two routes don't justify a router library: "#/" and "#/decisions/:id".
export type Route = { page: "overview" } | { page: "decision"; id: string };

function parse(hash: string): Route {
  const match = hash.match(/^#\/decisions\/([\w-]+)$/);
  return match ? { page: "decision", id: match[1]! } : { page: "overview" };
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}

export const decisionHref = (id: string) => `#/decisions/${id}`;
