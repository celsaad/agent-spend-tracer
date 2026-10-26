import { useAgentInfo, useDecisions } from "./api";
import { ChainLink, LiveIndicator } from "./components";
import { DecisionDetail } from "./DecisionDetail";
import { usdc } from "./format";
import { Overview } from "./Overview";
import { useRoute } from "./router";
import { UnauthorizedAlerts } from "./UnauthorizedAlerts";

function Header() {
  const agent = useAgentInfo();
  const decisions = useDecisions();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/">
          Agent Spend Console
        </a>
        <span className="network">Base Sepolia</span>
        <div className="wallet">
          {agent.data && (
            <>
              <span className="muted">Agent wallet</span>
              <ChainLink kind="address" value={agent.data.address} />
              <span className="wallet-balance num">{usdc(agent.data.usdcBalance)} USDC</span>
            </>
          )}
        </div>
        <LiveIndicator updatedAt={decisions.dataUpdatedAt} error={decisions.isError} />
      </div>
    </header>
  );
}

export function App() {
  const route = useRoute();
  return (
    <>
      <Header />
      <main className="page">
        <UnauthorizedAlerts />
        {route.page === "decision" ? <DecisionDetail id={route.id} /> : <Overview />}
      </main>
    </>
  );
}
