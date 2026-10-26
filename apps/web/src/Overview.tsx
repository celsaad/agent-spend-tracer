import type { Decision } from "@agent-spend-tracer/shared";
import { ApiError, useDecisions, usePendingReviews, useReviewAction } from "./api";
import { AgentName, ChainLink, Empty, Panel, StatusBadge } from "./components";
import { dateTime, usdc } from "./format";
import { decisionHref } from "./router";

export function Overview() {
  return (
    <>
      <Summary />
      <ReviewQueue />
      <DecisionsTable />
    </>
  );
}

function Summary() {
  const { data: decisions = [] } = useDecisions();
  const { data: reviews = [] } = usePendingReviews();
  const sum = (ds: Decision[]) => usdc(ds.reduce((total, d) => total + BigInt(d.amount), 0n));
  const confirmed = decisions.filter((d) => d.paymentStatus === "confirmed");
  const inFlight = decisions.filter((d) => d.paymentStatus === "approved" || d.paymentStatus === "submitted");

  return (
    <div className="stats">
      <Stat label="Awaiting review" value={String(reviews.length)} sub={`${sum(reviews)} USDC held`} />
      <Stat label="In flight" value={String(inFlight.length)} sub={`${sum(inFlight)} USDC`} />
      <Stat label="Settled onchain" value={`${sum(confirmed)}`} sub={`USDC · ${confirmed.length} payments`} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

function ReviewQueue() {
  const { data: reviews, isPending } = usePendingReviews();
  return (
    <Panel title="Review queue" aside={reviews?.length ? <span className="count">{reviews.length}</span> : null}>
      {isPending ? (
        <Empty>Loading…</Empty>
      ) : !reviews?.length ? (
        <Empty>Nothing waiting for review.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Requested</th>
              <th className="hide-sm">Agent</th>
              <th className="hide-sm">Recipient</th>
              <th className="num">Amount (USDC)</th>
              <th className="actions-col" />
            </tr>
          </thead>
          <tbody>
            {reviews.map((d) => (
              <ReviewRow key={d.id} decision={d} />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ReviewRow({ decision }: { decision: Decision }) {
  const approve = useReviewAction("approve");
  const deny = useReviewAction("deny");
  const busy = approve.isPending || deny.isPending;
  const error = approve.error ?? deny.error;

  return (
    <tr>
      <td>
        <a href={decisionHref(decision.id)}>{dateTime(decision.createdAt)}</a>
      </td>
      <td className="hide-sm">
        <AgentName id={decision.agentId} />
      </td>
      <td className="hide-sm">
        <ChainLink kind="address" value={decision.recipient} />
      </td>
      <td className="num strong">{usdc(decision.amount)}</td>
      <td className="actions">
        {error && <span className="inline-error">{reviewErrorText(error)}</span>}
        <button className="btn btn-secondary" disabled={busy} onClick={() => deny.mutate(decision.id)}>
          Deny
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => approve.mutate(decision.id)}>
          {approve.isPending ? "Paying…" : "Approve"}
        </button>
      </td>
    </tr>
  );
}

function reviewErrorText(error: Error): string {
  if (!(error instanceof ApiError)) return error.message;
  switch (error.code) {
    case "deny_limit":
      return "Would exceed limits now";
    case "deny_revoked":
      return "Mandate revoked";
    case "deny_recipient":
      return "Recipient no longer allowed";
    case "not_pending_review":
      return "Already handled";
    default:
      return error.message;
  }
}

function DecisionsTable() {
  const { data: decisions, isPending } = useDecisions();
  return (
    <Panel title="Decisions">
      {isPending ? (
        <Empty>Loading…</Empty>
      ) : !decisions?.length ? (
        <Empty>No spend requests yet.</Empty>
      ) : (
        <table className="table table-hover">
          <thead>
            <tr>
              <th>Requested</th>
              <th className="hide-sm">Agent</th>
              <th>Recipient</th>
              <th className="num">Amount (USDC)</th>
              <th>Status</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => (
              <tr key={d.id} onClick={() => (window.location.hash = decisionHref(d.id))}>
                <td>
                  <a href={decisionHref(d.id)}>{dateTime(d.createdAt)}</a>
                </td>
                <td className="hide-sm">
                  <AgentName id={d.agentId} />
                </td>
                <td>
                  <ChainLink kind="address" value={d.recipient} />
                </td>
                <td className="num strong">{usdc(d.amount)}</td>
                <td>
                  <StatusBadge decision={d} withReason />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {d.txHash ? <ChainLink kind="tx" value={d.txHash} /> : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
