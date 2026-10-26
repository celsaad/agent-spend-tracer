import type { ReactNode } from "react";
import type { Decision, Transfer } from "@agent-spend-tracer/shared";
import { useDecision, useTransfers } from "./api";
import { AgentName, Badge, BlockLink, ChainLink, Empty, Panel, StatusBadge } from "./components";
import { dateTime, decisionStatus, usdc } from "./format";

type StepState = "done" | "current" | "failed" | "upcoming";
interface Step {
  title: string;
  state: StepState;
  time?: string | null;
  body?: ReactNode;
}

const STEP_TITLES = ["Requested", "Policy verdict", "Approved", "Transaction submitted", "Confirmed onchain"];

const VERDICT_TEXT: Record<Decision["verdict"], string> = {
  allow: "Allowed: within the mandate's limits",
  review: "Held for review: above the review threshold",
  deny_limit: "Denied: would exceed the per-payment or 30-day limit",
  deny_recipient: "Denied: recipient isn't on the mandate's allow list",
  deny_revoked: "Denied: the agent's mandate is revoked",
};

/** The path from request to chain. Stops at the first step that failed; later ones are greyed out. */
function buildSteps(d: Decision, transfer: Transfer | undefined): Step[] {
  const steps: Step[] = [
    {
      title: "Requested",
      state: "done",
      time: d.createdAt,
      body: (
        <>
          {usdc(d.amount)} USDC to <ChainLink kind="address" value={d.recipient} />
        </>
      ),
    },
  ];
  const finish = () => [
    ...steps,
    ...STEP_TITLES.slice(steps.length).map((title): Step => ({ title, state: "upcoming" })),
  ];

  const denied = d.verdict !== "allow" && d.verdict !== "review";
  steps.push({ title: "Policy verdict", state: denied ? "failed" : "done", time: d.createdAt, body: VERDICT_TEXT[d.verdict] });
  if (denied) return finish();

  if (d.verdict === "allow") {
    steps.push({ title: "Approved", state: "done", time: d.createdAt, body: "Automatically, by policy" });
  } else if (d.deniedAt) {
    steps.push({ title: "Rejected", state: "failed", time: d.deniedAt, body: "Rejected by a reviewer. Nothing was paid." });
    return finish();
  } else if (d.approvedAt) {
    steps.push({ title: "Approved", state: "done", time: d.approvedAt, body: "By a reviewer, after re-checking limits" });
  } else {
    steps.push({ title: "Approved", state: "current", body: "Waiting for a reviewer in the review queue" });
    return finish();
  }

  if (d.txHash) {
    steps.push({
      title: "Transaction submitted",
      state: "done",
      time: d.submittedAt,
      body: (
        <>
          USDC transfer broadcast · <ChainLink kind="tx" value={d.txHash} />
        </>
      ),
    });
  } else if (d.paymentStatus === "failed") {
    steps.push({ title: "Transaction submitted", state: "failed", body: `Not sent: ${d.paymentError}` });
    return finish();
  } else {
    steps.push({ title: "Transaction submitted", state: "current", body: "Sending…" });
    return finish();
  }

  if (d.paymentStatus === "confirmed" && transfer) {
    steps.push({
      title: "Confirmed onchain",
      state: "done",
      time: transfer.confirmedAt,
      body: (
        <>
          Block <BlockLink n={transfer.blockNumber} /> · Transfer event matches the decision
        </>
      ),
    });
  } else if (d.paymentStatus === "failed") {
    steps.push({ title: "Confirmed onchain", state: "failed", body: d.paymentError });
  } else if (transfer) {
    steps.push({
      title: "Confirmed onchain",
      state: "current",
      body: (
        <>
          Mined in block <BlockLink n={transfer.blockNumber} />, waiting for confirmations
        </>
      ),
    });
  } else {
    steps.push({ title: "Confirmed onchain", state: "current", body: "Waiting to be mined" });
  }
  return steps;
}

function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="timeline">
      {steps.map((step, i) => (
        <li key={i} className={`step step-${step.state}`}>
          <span className="step-marker" aria-hidden>
            {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : ""}
          </span>
          <div className="step-content">
            <div className="step-head">
              <span className="step-title">{step.title}</span>
              {step.time && <time className="step-time">{dateTime(step.time)}</time>}
            </div>
            {step.body && <div className="step-body">{step.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function DecisionDetail({ id }: { id: string }) {
  const { data: decision, error } = useDecision(id);
  const { data: transfers = [] } = useTransfers({ decisionId: id });

  if (error) return <Empty>Couldn't load this decision: {error.message}</Empty>;
  if (!decision) return <Empty>Loading…</Empty>;

  const authorized = transfers.find((t) => t.authorization === "authorized") ?? transfers[0];
  const status = decisionStatus(decision);

  return (
    <>
      <a className="back" href="#/">
        ← All decisions
      </a>
      <div className="detail-head">
        <div>
          <div className="detail-amount num">
            {usdc(decision.amount)} <span className="unit">USDC</span>
          </div>
          <div className="muted">
            <AgentName id={decision.agentId} /> → <ChainLink kind="address" value={decision.recipient} />
          </div>
        </div>
        <div className="detail-status">
          <StatusBadge decision={decision} />
          {status.detail && <span className="muted small">{status.detail}</span>}
        </div>
      </div>

      <div className="detail-grid">
        <Panel title="Trace">
          <Timeline steps={buildSteps(decision, authorized)} />
        </Panel>

        <div className="detail-side">
          <Panel title="Details">
            <dl className="fields">
              <Field label="Decision">
                <span className="mono">{decision.id}</span>
              </Field>
              <Field label="Mandate">
                <span className="mono">{decision.mandateId}</span>
              </Field>
              <Field label="Verdict">{decision.verdict}</Field>
              <Field label="Transaction">
                {decision.txHash ? <ChainLink kind="tx" value={decision.txHash} /> : "—"}
              </Field>
            </dl>
          </Panel>

          <Panel title="Onchain transfers">
            {transfers.length === 0 ? (
              <Empty>None seen yet.</Empty>
            ) : (
              <ul className="transfer-list">
                {transfers.map((t) => (
                  <li key={t.id}>
                    <div>
                      <span className="num strong">{usdc(t.amount)} USDC</span> · block <BlockLink n={t.blockNumber} />
                    </div>
                    <div className="transfer-badges">
                      <Badge tone={t.status === "confirmed" ? "pos" : "info"}>{t.status}</Badge>
                      {t.authorization && (
                        <Badge tone={t.authorization === "authorized" ? "neutral" : "neg"}>{t.authorization}</Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
