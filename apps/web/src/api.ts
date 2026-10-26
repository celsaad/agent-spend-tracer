import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, AgentInfo, Decision, Transfer } from "@agent-spend-tracer/shared";

/** How often every view re-fetches. Blocks on Base land every ~2s, so faster buys nothing. */
export const POLL_MS = 2000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body?.code, body?.message ?? `${path}: ${res.status}`);
  return body as T;
}

export const useAgentInfo = () =>
  useQuery({ queryKey: ["agent"], queryFn: () => request<AgentInfo>("/api/agent"), refetchInterval: 10_000 });

export const useAgents = () => useQuery({ queryKey: ["agents"], queryFn: () => request<Agent[]>("/api/agents") });

export const useDecisions = () =>
  useQuery({ queryKey: ["decisions"], queryFn: () => request<Decision[]>("/api/decisions"), refetchInterval: POLL_MS });

export const usePendingReviews = () =>
  useQuery({
    queryKey: ["decisions", "pendingReview"],
    queryFn: () => request<Decision[]>("/api/decisions?pendingReview=true"),
    refetchInterval: POLL_MS,
  });

export const useDecision = (id: string) =>
  useQuery({
    queryKey: ["decisions", id],
    queryFn: () => request<Decision>(`/api/decisions/${id}`),
    refetchInterval: POLL_MS,
  });

export const useTransfers = (filter: { decisionId?: string; authorization?: "unauthorized" } = {}) =>
  useQuery({
    queryKey: ["transfers", filter],
    queryFn: () => request<Transfer[]>(`/api/transfers?${new URLSearchParams(filter)}`),
    refetchInterval: POLL_MS,
  });

/** Approve or deny a held review. Refreshes every decision view on success. */
export function useReviewAction(action: "approve" | "deny") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<Decision>(`/api/decisions/${id}/${action}`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["decisions"] }),
  });
}
