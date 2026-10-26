import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import type { AgentInfo, Spend } from "@agent-spend-tracer/shared";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const usdc = (amount: string) => formatUnits(BigInt(amount), 6);

export function App() {
  const agent = useQuery({ queryKey: ["agent"], queryFn: () => fetchJson<AgentInfo>("/api/agent") });
  const spends = useQuery({ queryKey: ["spends"], queryFn: () => fetchJson<Spend[]>("/api/spends") });

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Agent Spend Tracer</h1>

      <section>
        <h2>Agent</h2>
        {agent.isPending && <p>Loading…</p>}
        {agent.error && <p>Error: {agent.error.message}</p>}
        {agent.data && (
          <p>
            <code>{agent.data.address}</code> — {usdc(agent.data.usdcBalance)} USDC
          </p>
        )}
      </section>

      <section>
        <h2>Spends</h2>
        {spends.isPending && <p>Loading…</p>}
        {spends.error && <p>Error: {spends.error.message}</p>}
        {spends.data?.length === 0 && <p>No spends yet.</p>}
        <ul>
          {spends.data?.map((s) => (
            <li key={s.id}>
              {usdc(s.amount)} USDC → <code>{s.to}</code> {s.memo && `(${s.memo})`}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
