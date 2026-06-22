import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jub } from "@confidential-token/sdk";
import type { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { cfg } from "./lib/config.js";
import { changeTrust } from "./lib/classic.js";
import { deriveBjjSeed, getKit, makeWalletSigner } from "./lib/wallet.js";
import {
  type SenderKeypair,
  deposit,
  readAndDecryptBalance,
  register,
  transfer,
  withdraw,
} from "./lib/ctoken.js";

type Tab = "register" | "deposit" | "balance" | "transfer" | "withdraw";

const networkExplorer: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/contract/",
  mainnet: "https://stellar.expert/explorer/public/contract/",
};

export function App() {
  const kit = useMemo<StellarWalletsKit>(() => getKit(cfg.network.network ?? "testnet"), []);
  const sign = useMemo(() => makeWalletSigner(kit), [kit]);

  const [address, setAddress] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("register");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // kp is intentionally NOT in React state: it contains BabyJubJub points as
  // [bigint, bigint] tuples, and React 19's dev tooling JSON.stringify's
  // state on each commit. That throws on bigint (despite the toJSON polyfill
  // in index.html, some library codepaths use replacer functions that bypass
  // toJSON) and corrupts the scheduler. Keep it in a ref and surface only a
  // boolean readiness flag.
  const kpRef = useRef<SenderKeypair | null>(null);
  const [kpReady, setKpReady] = useState(false);
  // Re-entry guard for the auto-derive effect.
  const derivingRef = useRef(false);

  const append = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} — ${line}`, ...l].slice(0, 100));
  }, []);

  const fundFromFriendbot = useCallback(async () => {
    if (!address) return;
    if ((cfg.network.network ?? "testnet") !== "testnet") {
      append("friendbot only available on testnet");
      return;
    }
    try {
      setBusy(true);
      append(`funding ${address.slice(0, 6)}… via Friendbot`);
      const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
      if (!res.ok) throw new Error(`friendbot ${res.status}`);
      append(`✓ account funded — retry your action`);
    } catch (e) {
      append(`friendbot failed: ${errorMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }, [address, append]);

  const setupTrustline = useCallback(async () => {
    if (!address) return;
    if (!cfg.asset.issuer) {
      append(
        `asset issuer not configured. Re-run \`cd packages/dapp && npm run sync-env\` ` +
          `with the stellar CLI's "issuer" key in scope.`,
      );
      return;
    }
    try {
      setBusy(true);
      append(`signing ChangeTrust ${cfg.asset.code}:${cfg.asset.issuer.slice(0, 6)}…`);
      const res = await changeTrust({
        network: cfg.network.network ?? "testnet",
        sourceAddress: address,
        sign,
        code: cfg.asset.code,
        issuer: cfg.asset.issuer,
      });
      append(
        res.skipped
          ? `✓ trustline already exists`
          : `✓ trustline set (tx ${res.hash.slice(0, 8)}…) — ask operator to send you ${cfg.asset.code}`,
      );
    } catch (e) {
      append(`trustline failed: ${errorMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }, [address, append, sign]);

  const connect = useCallback(async () => {
    await kit.openModal({
      onWalletSelected: async (option) => {
        try {
          kit.setWallet(option.id);
          const { address: addr } = await kit.getAddress();
          // Defer the state update one microtask so we don't update React
          // state inside the wallet kit's postMessage handler frame.
          queueMicrotask(() => {
            setAddress(addr);
            append(`connected: ${addr}`);
          });
        } catch (e) {
          queueMicrotask(() => append(`connect failed: ${errorMsg(e)}`));
        }
      },
    });
  }, [kit, append]);

  const deriveKey = useCallback(async () => {
    if (!address) return;
    if (derivingRef.current) return;
    derivingRef.current = true;
    setBusy(true);
    append("signing message to derive BabyJubJub key (this may prompt your wallet)");
    try {
      const seed = await deriveBjjSeed(kit, address);
      const derived = jub.keypairFromSeed(seed) as SenderKeypair;
      // Store the bigint-bearing object in a ref, NOT state.
      kpRef.current = derived;
      const px = derived.publicKey[0].toString();
      const py = derived.publicKey[1].toString();
      append(`BJJ pubkey: (${px.slice(0, 10)}…, ${py.slice(0, 10)}…)`);
      setKpReady(true);
    } catch (e) {
      append(`key derivation failed: ${errorMsg(e)}`);
    } finally {
      derivingRef.current = false;
      setBusy(false);
    }
  }, [address, kit, append]);

  // Auto-derive when an address connects. queueMicrotask escapes the current
  // React render frame before doing async work that triggers more state
  // updates via the wallet's postMessage RPCs.
  useEffect(() => {
    if (address && !kpReady && !derivingRef.current) {
      queueMicrotask(() => {
        void deriveKey();
      });
    }
  }, [address, kpReady, deriveKey]);

  return (
    <div style={{ maxWidth: 920, margin: "40px auto", padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Confidential Token — Stellar</h1>
      <p style={{ opacity: 0.7 }}>
        Encrypted balances, public sender/receiver, ZK-proven private
        transfers and withdraws. Testnet only — not audited.
      </p>

      <Section title="Wallet">
        {!address ? (
          <button onClick={connect} style={btn}>
            Connect Freighter
          </button>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <code style={{ wordBreak: "break-all" }}>{address}</code>
            <small style={{ opacity: 0.6 }}>
              BabyJubJub key{" "}
              {kpReady ? "derived ✓" : busy ? "deriving…" : "(click action to derive)"}
            </small>
            {(cfg.network.network ?? "testnet") === "testnet" && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={fundFromFriendbot} disabled={busy} style={btn}>
                  Fund XLM via Friendbot
                </button>
                <button onClick={setupTrustline} disabled={busy} style={btn}>
                  Setup {cfg.asset.code} trustline
                </button>
              </div>
            )}
          </div>
        )}
      </Section>

      <nav style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}>
        {(["register", "deposit", "balance", "transfer", "withdraw"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...btn, opacity: t === tab ? 1 : 0.55 }}
            disabled={busy}
          >
            {t}
          </button>
        ))}
      </nav>

      <Section title={`Action — ${tab}`}>
        <ActionPanel
          tab={tab}
          address={address}
          kpRef={kpRef}
          kpReady={kpReady}
          sign={sign}
          busy={busy}
          setBusy={setBusy}
          onLog={append}
        />
      </Section>

      <Section title="Contracts">
        <ContractIds />
      </Section>

      <Section title="Activity">
        <pre style={pre}>{log.join("\n") || "(no activity yet)"}</pre>
      </Section>

      <footer style={{ opacity: 0.5, fontSize: 12, marginTop: 24 }}>
        Hackathon prototype. dApp ↔ Soroban via Freighter; circuits served
        from {`/circuits/*`}. Source: {" "}
        <a href="https://github.com/whoisgautxm/stellar-confidential-token" target="_blank" rel="noreferrer">
          repo
        </a>
        .
      </footer>
    </div>
  );
}

// ─────────────────────── action panel ───────────────────────

function ActionPanel({
  tab,
  address,
  kpRef,
  kpReady,
  sign,
  busy,
  setBusy,
  onLog,
}: {
  tab: Tab;
  address: string | null;
  // The keypair holds bigints. Kept in a ref to stay out of React state /
  // DevTools serialization paths.
  kpRef: React.MutableRefObject<SenderKeypair | null>;
  kpReady: boolean;
  sign: ReturnType<typeof makeWalletSigner>;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onLog: (s: string) => void;
}) {
  const [amount, setAmount] = useState("100");
  const [to, setTo] = useState("");
  const [balanceResult, setBalanceResult] = useState<string | null>(null);

  if (!address) return <p>Connect Freighter to continue.</p>;
  if (!kpReady || !kpRef.current) {
    return <p>Deriving BabyJubJub key from your Stellar wallet…</p>;
  }
  const kp = kpRef.current;

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      onLog(`▶ ${label}`);
      await fn();
    } catch (e) {
      onLog(`✗ ${label} failed: ${errorMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const ctxBase = { address, kp, sign, onProgress: onLog };

  switch (tab) {
    case "register":
      return (
        <div style={grid}>
          <p style={{ opacity: 0.7, fontSize: 13 }}>
            Publishes your BabyJubJub public key to the registrar, proving
            knowledge of the matching secret. One-time per Stellar account.
          </p>
          <button
            style={btn}
            disabled={busy}
            onClick={() => run("register", () => register(ctxBase))}
          >
            Register
          </button>
        </div>
      );

    case "deposit":
      return (
        <div style={grid}>
          <label style={lbl}>Amount (stroops)</label>
          <input
            style={input}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="100"
          />
          <button
            style={btn}
            disabled={busy}
            onClick={() =>
              run(`deposit ${amount}`, () =>
                deposit({ ...ctxBase, amount: BigInt(amount || "0") }),
              )
            }
          >
            Deposit
          </button>
          <small style={{ opacity: 0.6 }}>
            Public SAC.transfer in, then homomorphic add of Enc(pk, amount).
          </small>
        </div>
      );

    case "balance":
      return (
        <div style={grid}>
          <button
            style={btn}
            disabled={busy}
            onClick={() =>
              run("read encrypted balance", async () => {
                const r = await readAndDecryptBalance(address, kp);
                if (r.amount === null) {
                  setBalanceResult("(no balance recorded — deposit first)");
                  return;
                }
                setBalanceResult(
                  `${r.amount} stroops (${(Number(r.amount) / 1e7).toFixed(7)} CONF) — ` +
                    `BSGS ${r.bsgsMs} ms — nonce ${r.raw.nonce}`,
                );
                onLog(`balance = ${r.amount} stroops (BSGS ${r.bsgsMs} ms)`);
              })
            }
          >
            Read & decrypt balance
          </button>
          {balanceResult && <pre style={pre}>{balanceResult}</pre>}
        </div>
      );

    case "transfer":
      return (
        <div style={grid}>
          <label style={lbl}>Recipient Stellar address (G…)</label>
          <input
            style={input}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="GCSOMETHING…"
          />
          <label style={lbl}>Amount (stroops)</label>
          <input
            style={input}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="30"
          />
          <button
            style={btn}
            disabled={busy}
            onClick={() =>
              run(`transfer ${amount} → ${to.slice(0, 6)}…`, () =>
                transfer({
                  ...ctxBase,
                  to: to.trim(),
                  amount: BigInt(amount || "0"),
                }),
              )
            }
          >
            Private transfer
          </button>
          <small style={{ opacity: 0.6 }}>
            On-chain tx envelope shows from/to but no amount. Recipient must
            be registered already.
          </small>
        </div>
      );

    case "withdraw":
      return (
        <div style={grid}>
          <label style={lbl}>Amount (stroops)</label>
          <input
            style={input}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="20"
          />
          <button
            style={btn}
            disabled={busy}
            onClick={() =>
              run(`withdraw ${amount}`, () =>
                withdraw({ ...ctxBase, amount: BigInt(amount || "0") }),
              )
            }
          >
            Withdraw to public SAC
          </button>
          <small style={{ opacity: 0.6 }}>
            ZK-proves SenderBalance ≥ amount, then SAC.transfer out and burns
            the client-supplied EGCT.
          </small>
        </div>
      );
  }
}

// ─────────────────────── support components ───────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{ margin: "10px 0 6px" }}>{title}</h3>
      {children}
    </section>
  );
}

function ContractIds() {
  const explorer = networkExplorer[cfg.network.network ?? "testnet"] ?? networkExplorer.testnet;
  const ids: [string, string][] = [
    ["confidentialToken", cfg.contracts.confidentialToken],
    ["registrar", cfg.contracts.registrar],
    ["sacToken", cfg.contracts.sacToken],
    ["verifierTransfer", cfg.contracts.verifierTransfer],
    ["verifierWithdraw", cfg.contracts.verifierWithdraw],
    ["verifierRegistration", cfg.contracts.verifierRegistration],
  ];
  return (
    <ul style={{ marginTop: 0, paddingLeft: 18 }}>
      {ids.map(([name, id]) => (
        <li key={name}>
          <strong>{name}:</strong>{" "}
          {id ? (
            <a href={`${explorer}${id}`} target="_blank" rel="noreferrer">
              {id.slice(0, 8)}…{id.slice(-6)}
            </a>
          ) : (
            <em style={{ opacity: 0.5 }}>not configured</em>
          )}
        </li>
      ))}
    </ul>
  );
}

function errorMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  // Friendlier hints for common first-time-user issues.
  if (raw.includes("Account not found")) {
    return `${raw} — click "Fund XLM via Friendbot" above to create this account on testnet`;
  }
  if (raw.includes("trustline entry is missing")) {
    return (
      `${raw} — click "Setup ${cfg.asset.code} trustline" above, then ask the operator ` +
      `to send you ${cfg.asset.code} via \`scripts/fund-conf.sh <your-address>\``
    );
  }
  if (raw.includes("Error(Contract, #13)")) {
    return (
      `${raw} — likely the SAC.transfer step. Most common cause: missing trustline or ` +
      `insufficient ${cfg.asset.code} balance. Run trustline setup + fund-conf.sh, then retry.`
    );
  }
  return raw;
}

// ─────────────────────── styles ───────────────────────

const btn: React.CSSProperties = {
  background: "#1f2a55",
  color: "#e6e9f5",
  border: "1px solid #2a3a78",
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 14,
};

const input: React.CSSProperties = {
  background: "#11193a",
  color: "#e6e9f5",
  border: "1px solid #2a3a78",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 14,
};

const lbl: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
  marginTop: 4,
};

const grid: React.CSSProperties = {
  display: "grid",
  gap: 8,
};

const pre: React.CSSProperties = {
  background: "#11193a",
  padding: 12,
  borderRadius: 8,
  overflowX: "auto",
  fontSize: 12,
  maxHeight: 280,
  margin: 0,
};
