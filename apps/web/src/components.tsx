import { useEffect, useState, type ReactNode } from "react";
import type { Decision } from "@agent-spend-tracer/shared";
import { useAgents } from "./api";
import { decisionStatus, explorer, short, type Tone } from "./format";

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** With `withReason`, a denial or failure also shows why, next to the badge. */
export function StatusBadge({ decision, withReason }: { decision: Decision; withReason?: boolean }) {
  const status = decisionStatus(decision);
  const badge = (
    <Badge tone={status.tone} title={status.detail}>
      {status.label}
    </Badge>
  );
  if (!withReason || status.tone !== "neg" || !status.detail) return badge;
  return (
    <span className="status-with-reason">
      {badge}
      <span className="reason" title={status.detail}>
        {status.detail}
      </span>
    </span>
  );
}

/** Block numbers link to the explorer, ungrouped like explorers show them. */
export function BlockLink({ n }: { n: number }) {
  return (
    <a className="mono" href={explorer.block(n)} target="_blank" rel="noreferrer">
      {n}
    </a>
  );
}

/** A shortened address or hash linking to the explorer. */
export function ChainLink({ kind, value }: { kind: "tx" | "address"; value: string }) {
  return (
    <a className="mono" href={explorer[kind](value)} target="_blank" rel="noreferrer" title={value}>
      {short(value)}
    </a>
  );
}

export function AgentName({ id }: { id: string }) {
  const agents = useAgents();
  return <>{agents.data?.find((a) => a.id === id)?.name ?? short(id, 6)}</>;
}

export function Panel({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** "Live · 3s ago", turning stale after a few missed polls. */
export function LiveIndicator({ updatedAt, error }: { updatedAt: number; error: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const age = updatedAt ? Math.max(0, Math.round((now - updatedAt) / 1000)) : undefined;
  const stale = error || age === undefined || age > 10;
  return (
    <span className={`live ${stale ? "live-stale" : ""}`}>
      <span className="live-dot" />
      {stale ? "Reconnecting…" : `Live · ${age}s ago`}
    </span>
  );
}
