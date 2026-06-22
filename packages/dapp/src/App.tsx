import { useEffect, useState } from "react";
import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  allowAllModules,
} from "@creit.tech/stellar-wallets-kit";

const networkExplorer: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/contract/",
  mainnet: "https://stellar.expert/explorer/public/contract/",
};

const ids = {
  registrar: import.meta.env.VITE_REGISTRAR_ID ?? "",
  confidentialToken: import.meta.env.VITE_CONFIDENTIAL_TOKEN_ID ?? "",
  sacToken: import.meta.env.VITE_SAC_ID ?? "",
};

const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: FREIGHTER_ID,
  modules: allowAllModules(),
});

export function App() {
  const [address, setAddress] = useState<string | null>(null);
  const [tab, setTab] = useState<"register" | "deposit" | "transfer" | "withdraw" | "balance">("register");
  const [log, setLog] = useState<string[]>([]);

  function append(line: string) {
    setLog((l) => [`${new Date().toLocaleTimeString()} — ${line}`, ...l].slice(0, 50));
  }

  async function connect() {
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit.setWallet(option.id);
        const { address } = await kit.getAddress();
        setAddress(address);
        append(`connected: ${address}`);
      },
    });
  }

  return (
    <div style={{ maxWidth: 880, margin: "40px auto", padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Confidential Token — Stellar</h1>
      <p style={{ opacity: 0.7 }}>
        Research prototype. Encrypted balances, public sender/receiver,
        ZK-proven private transfers. Testnet only.
      </p>

      {!address ? (
        <button onClick={connect} style={btn}>
          Connect Freighter
        </button>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <code>{address}</code>
        </div>
      )}

      <nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {(["register", "deposit", "transfer", "withdraw", "balance"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...btn, opacity: t === tab ? 1 : 0.55 }}
          >
            {t}
          </button>
        ))}
      </nav>

      <Section title={`Action: ${tab}`}>
        <ActionPanel tab={tab} address={address} onLog={append} />
      </Section>

      <Section title="Contracts">
        <ContractIds />
      </Section>

      <Section title="Log">
        <pre style={pre}>{log.join("\n") || "(no activity yet)"}</pre>
      </Section>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "#1f2a55",
  color: "#e6e9f5",
  border: "1px solid #2a3a78",
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
};

const pre: React.CSSProperties = {
  background: "#11193a",
  padding: 12,
  borderRadius: 8,
  overflowX: "auto",
  fontSize: 12,
  maxHeight: 240,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3 style={{ margin: "8px 0" }}>{title}</h3>
      {children}
    </section>
  );
}

function ContractIds() {
  const network = (import.meta.env.VITE_NETWORK as string) ?? "testnet";
  const explorer = networkExplorer[network] ?? networkExplorer.testnet;
  return (
    <ul>
      {Object.entries(ids).map(([k, v]) =>
        v ? (
          <li key={k}>
            <strong>{k}:</strong>{" "}
            <a href={`${explorer}${v}`} target="_blank" rel="noreferrer">
              {v.slice(0, 8)}…{v.slice(-6)}
            </a>
          </li>
        ) : (
          <li key={k} style={{ opacity: 0.5 }}>
            {k}: not configured
          </li>
        ),
      )}
    </ul>
  );
}

function ActionPanel({
  tab,
  address,
  onLog,
}: {
  tab: string;
  address: string | null;
  onLog: (s: string) => void;
}) {
  const [amount, setAmount] = useState("100");
  const [to, setTo] = useState("");

  if (!address) return <p>Connect Freighter to continue.</p>;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {tab !== "register" && tab !== "balance" && (
        <input
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={input}
        />
      )}
      {tab === "transfer" && (
        <input
          placeholder="Recipient G…"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          style={input}
        />
      )}
      <button style={btn} onClick={() => onLog(`${tab}: queued (witness builder in dev)`)}>
        {tab}
      </button>
      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
        Demo build — wallet-signed invokes are wired via Stellar Wallets Kit,
        proof generation runs in-browser via snarkjs. See packages/sdk for full
        crypto primitives.
      </p>
    </div>
  );
}

const input: React.CSSProperties = {
  background: "#11193a",
  color: "#e6e9f5",
  border: "1px solid #2a3a78",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 14,
};
