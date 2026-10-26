import { useTransfers } from "./api";
import { BlockLink, ChainLink } from "./components";
import { dateTime, usdc } from "./format";

/**
 * Transfers out of the agent wallet that no approved decision accounts for. Shown on every page,
 * above everything else, because each one means money moved outside the policy.
 */
export function UnauthorizedAlerts() {
  const { data: alerts } = useTransfers({ authorization: "unauthorized" });
  if (!alerts?.length) return null;

  const total = alerts.reduce((sum, t) => sum + BigInt(t.amount), 0n);
  return (
    <section className="alert" role="alert">
      <header className="alert-head">
        <span className="alert-icon" aria-hidden>
          !
        </span>
        <div>
          <h2>
            {alerts.length} unauthorized {alerts.length === 1 ? "transfer" : "transfers"} from the agent wallet
          </h2>
          <p>
            {usdc(total)} USDC left the wallet with no approved decision behind it. Investigate before approving
            further spend.
          </p>
        </div>
      </header>
      <table className="table alert-table">
        <thead>
          <tr>
            <th>Detected</th>
            <th className="num">Amount (USDC)</th>
            <th>To</th>
            <th>Block</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((t) => (
            <tr key={t.id}>
              <td>{dateTime(t.confirmedAt ?? t.seenAt)}</td>
              <td className="num">{usdc(t.amount)}</td>
              <td>
                <ChainLink kind="address" value={t.to} />
              </td>
              <td>
                <BlockLink n={t.blockNumber} />
              </td>
              <td>
                <ChainLink kind="tx" value={t.txHash} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
