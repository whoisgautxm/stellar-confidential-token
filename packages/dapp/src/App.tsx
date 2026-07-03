import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
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
import "./App.css";

type Tab = "register" | "deposit" | "balance" | "transfer" | "withdraw";
type Tone = "ready" | "pending" | "idle" | "warn";

const proofStats = [
  ["5", "registration public signals"],
  ["32", "transfer public signals"],
  ["16", "withdraw public signals"],
  ["~1s", "browser Groth16 proof time"],
] as const;

const featureCards = [
  {
    title: "Balances stay encrypted",
    body: "Each account stores an ElGamal ciphertext over BabyJubJub plus replay-safe balance hashes. Plaintext balances are recovered locally with the user's derived key.",
  },
  {
    title: "Amounts disappear from transfers",
    body: "Private transfers update sender and receiver ciphertexts with a Groth16 proof. Observers see participants and proof data, not the transferred amount.",
  },
  {
    title: "Stellar assets still settle publicly",
    body: "Deposits and withdrawals wrap a single CONF Stellar Asset Contract, so the public boundary remains compatible with wallets, trustlines, and StellarExpert.",
  },
] as const;

const technicalStack = [
  ["Circuits", "Avalanche EncryptedERC Circom artifacts reused unchanged"],
  ["Verifier layer", "Three Soroban Groth16 verifier contracts using BN254 pairing_check"],
  ["Crypto state", "BabyJubJub guest Rust for ciphertext add/sub and key registry"],
  ["Client", "TypeScript SDK, snarkjs witness generation, Freighter signing"],
  ["Replay guard", "Balance hash plus nonce persisted on every state-changing write"],
] as const;

const flowSteps = [
  ["Register", "Derive a BabyJubJub key from a wallet signature and publish the public key."],
  ["Deposit", "Move public CONF into contract escrow and add a client-encrypted EGCT."],
  ["Transfer", "Prove balance consistency while moving only encrypted value between users."],
  ["Withdraw", "Prove spendability and release public CONF back through the SAC boundary."],
] as const;

const differentiators = [
  "No new cryptographic scheme: the project ports an existing eERC-style design to Stellar.",
  "Converter mode keeps Stellar's public asset rails while moving confidential state into Soroban.",
  "Browser and CLI share the same SDK, so the demo is wallet-signed without a backend service.",
  "Verifier contracts are split by circuit, keeping Wasm small and independently upgradeable.",
] as const;

const tabs: Array<{ id: Tab; label: string; summary: string }> = [
  {
    id: "register",
    label: "Register",
    summary: "Publish your privacy key once per Stellar account.",
  },
  {
    id: "deposit",
    label: "Deposit",
    summary: "Move public CONF into an encrypted balance.",
  },
  {
    id: "balance",
    label: "Balance",
    summary: "Read encrypted state and decrypt locally.",
  },
  {
    id: "transfer",
    label: "Transfer",
    summary: "Send a private amount with a ZK proof.",
  },
  {
    id: "withdraw",
    label: "Withdraw",
    summary: "Reveal funds back to the public SAC token.",
  },
];

const networkExplorer: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/contract/",
  mainnet: "https://stellar.expert/explorer/public/contract/",
};

export function App() {
  const networkName = cfg.network.network ?? "testnet";
  const kit = useMemo<StellarWalletsKit>(() => getKit(networkName), [networkName]);
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
  const derivingRef = useRef(false);

  const append = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} - ${line}`, ...l].slice(0, 100));
  }, []);

  const fundFromFriendbot = useCallback(async () => {
    if (!address) return;
    if (networkName !== "testnet") {
      append("friendbot only available on testnet");
      return;
    }
    try {
      setBusy(true);
      append(`funding ${shortAddress(address)} via Friendbot`);
      const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
      if (!res.ok) throw new Error(`friendbot ${res.status}`);
      append("account funded - retry your action");
    } catch (e) {
      append(`friendbot failed: ${errorMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }, [address, append, networkName]);

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
      append(`signing ChangeTrust ${cfg.asset.code}:${shortAddress(cfg.asset.issuer)}`);
      const res = await changeTrust({
        network: networkName,
        sourceAddress: address,
        sign,
        code: cfg.asset.code,
        issuer: cfg.asset.issuer,
      });
      append(
        res.skipped
          ? "trustline already exists"
          : `trustline set (tx ${res.hash.slice(0, 8)}) - ask operator to send ${cfg.asset.code}`,
      );
    } catch (e) {
      append(`trustline failed: ${errorMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }, [address, append, networkName, sign]);

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
      kpRef.current = derived;
      const px = derived.publicKey[0].toString();
      const py = derived.publicKey[1].toString();
      append(`BJJ pubkey: (${px.slice(0, 10)}..., ${py.slice(0, 10)}...)`);
      setKpReady(true);
    } catch (e) {
      append(`key derivation failed: ${errorMsg(e)}`);
    } finally {
      derivingRef.current = false;
      setBusy(false);
    }
  }, [address, kit, append]);

  useEffect(() => {
    if (address && !kpReady && !derivingRef.current) {
      queueMicrotask(() => {
        void deriveKey();
      });
    }
  }, [address, kpReady, deriveKey]);

  const activeTab = tabs.find((item) => item.id === tab) ?? tabs[0];
  const setupItems = [
    {
      label: "Wallet",
      text: address ? shortAddress(address) : "Not connected",
      tone: address ? "ready" : "idle",
    },
    {
      label: "Privacy key",
      text: kpReady ? "Derived" : busy && address ? "Deriving" : "Waiting",
      tone: kpReady ? "ready" : busy && address ? "pending" : "idle",
    },
    {
      label: "Network",
      text: networkName,
      tone: networkName === "testnet" ? "ready" : "warn",
    },
    {
      label: "Asset",
      text: cfg.asset.issuer ? cfg.asset.code : "Issuer missing",
      tone: cfg.asset.issuer ? "ready" : "warn",
    },
  ] satisfies Array<{ label: string; text: string; tone: Tone }>;

  return (
    <main className="appShell">
      <nav className="siteNav" aria-label="Site navigation">
        <div className="brandMark">
          <span className="brandGlyph" aria-hidden="true">
            N
          </span>
          Nebula
        </div>
        <div className="navLinks">
          <a href="#overview">Overview</a>
          <a href="#architecture">Architecture</a>
          <a href="#workbench">Workbench</a>
        </div>
        <div className="navActions">
          <a
            className="secondaryButton"
            href="https://github.com/whoisgautxm/stellar-confidential-token"
            target="_blank"
            rel="noreferrer"
          >
            Repo
          </a>
        </div>
      </nav>

      <header className="hero" id="overview">
        <div className="heroCopy">
          <p className="eyebrow">Live intelligence on Stellar testnet</p>
          <h1>
            Nebula reads <em>between</em> the chains
          </h1>
          <p className="lede">
            Confidential tokens for Stellar — public sender and receiver,
            hidden balances and amounts. Wallet-signed Groth16 proofs, full
            register-to-withdraw flow, zero backend.
          </p>
          <div className="heroCtas">
            <a className="primaryButton" href="#workbench">
              Open workbench
            </a>
            <a
              className="ghostButton"
              href="https://stellar.expert/explorer/testnet/contract/"
              target="_blank"
              rel="noreferrer"
            >
              Explorer
            </a>
          </div>
        </div>
        <div className="heroVisual" aria-label="Confidential state brief">
          <div className="briefChrome">
            <div className="briefDots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <span>Nebula / Sentinel Brief</span>
          </div>
          <div className="briefBody">
            <p className="briefStatus">Encrypted balance verified</p>
            <div className="briefMeta">
              <div className="briefRow">
                <span>Network</span>
                <strong>{networkName}</strong>
              </div>
              <div className="briefRow">
                <span>Asset</span>
                <strong>{cfg.asset.code}</strong>
              </div>
              <div className="briefRow">
                <span>Proof system</span>
                <strong>Groth16 / BN254</strong>
              </div>
            </div>
            <pre className="briefCode">{`{
  "egct": "Enc(pk, amount)",
  "nonce": "replay-safe",
  "balance_hash": "Poseidon-bound"
}`}</pre>
          </div>
        </div>
      </header>

      <section className="proofStrip" aria-label="Proof summary">
        {proofStats.map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>

      <section className="landingSection">
        <div className="sectionIntro">
          <p className="eyebrow darkEyebrow">What it proves</p>
          <h2>Private balances without abandoning Stellar's public settlement rails.</h2>
        </div>
        <div className="featureGrid">
          {featureCards.map((feature) => (
            <article className="featureCard" key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="architectureSection" id="architecture">
        <div className="sectionIntro">
          <p className="eyebrow darkEyebrow">Technical architecture</p>
          <h2>eERC circuits, Stellar assets, Soroban verification.</h2>
        </div>
        <div className="architectureGrid">
          <div className="stackList">
            {technicalStack.map(([label, body]) => (
              <div className="stackItem" key={label}>
                <span>{label}</span>
                <p>{body}</p>
              </div>
            ))}
          </div>
          <div className="flowPanel">
            {flowSteps.map(([label, body], index) => (
              <div className="flowStep" key={label}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{label}</h3>
                  <p>{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="differenceSection">
        <div className="sectionIntro">
          <p className="eyebrow darkEyebrow">Why it is different</p>
          <h2>A practical bridge between public settlement and confidential state.</h2>
        </div>
        <div className="differenceList">
          {differentiators.map((item) => (
            <div className="differenceItem" key={item}>
              <span />
              <p>{item}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="caveatBand">
        <div>
          <span>Research prototype</span>
          <p>
            Testnet only and not audited. Withdraw still trusts a
            client-encrypted amount EGCT as a hackathon-scope compromise;
            production needs the withdraw circuit to emit and bind that EGCT.
          </p>
        </div>
      </section>

      <section className="workbenchHeader" id="workbench">
        <div>
          <p className="eyebrow darkEyebrow">Command center</p>
          <h2>Run the confidential-token flow from your wallet.</h2>
        </div>
        <StatusPill tone={busy ? "pending" : address ? "ready" : "idle"}>
          {busy ? "Transaction in progress" : address ? "Wallet connected" : "Wallet needed"}
        </StatusPill>
      </section>

      <section className="statusGrid" aria-label="Setup status">
        {setupItems.map((item) => (
          <div className="statusTile" key={item.label}>
            <span className={`dot dot-${item.tone}`} />
            <div>
              <p>{item.label}</p>
              <strong>{item.text}</strong>
            </div>
          </div>
        ))}
      </section>

      <div className="workspace">
        <aside className="leftRail">
          <Panel title="Wallet" kicker="Access">
            {!address ? (
              <div className="stack">
                <p className="muted">
                  Connect Freighter or another Stellar Wallets Kit wallet to
                  sign transactions and derive your local privacy key.
                </p>
                <button className="primaryButton" onClick={connect}>
                  Connect wallet
                </button>
              </div>
            ) : (
              <div className="stack">
                <div className="addressBox">
                  <span>Connected account</span>
                  <code>{address}</code>
                </div>
                <div className="keyState">
                  <span className={`dot dot-${kpReady ? "ready" : busy ? "pending" : "idle"}`} />
                  <span>
                    BabyJubJub key {kpReady ? "ready" : busy ? "deriving" : "queued"}
                  </span>
                </div>
                {networkName === "testnet" && (
                  <div className="buttonRow">
                    <button className="secondaryButton" onClick={fundFromFriendbot} disabled={busy}>
                      Fund XLM
                    </button>
                    <button className="secondaryButton" onClick={setupTrustline} disabled={busy}>
                      Trustline
                    </button>
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel title="Contracts" kicker="Deployment">
            <ContractIds />
          </Panel>
        </aside>

        <section className="mainSurface">
          <div className="tabs" role="tablist" aria-label="Confidential token actions">
            {tabs.map((item) => (
              <button
                className={item.id === tab ? "tabButton active" : "tabButton"}
                key={item.id}
                onClick={() => setTab(item.id)}
                disabled={busy}
                role="tab"
                aria-selected={item.id === tab}
              >
                <span>{item.label}</span>
                <small>{item.summary}</small>
              </button>
            ))}
          </div>

          <Panel title={activeTab.label} kicker="Action">
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
          </Panel>

          <Panel title="Activity" kicker="Runtime">
            <ActivityLog items={log} />
          </Panel>
        </section>
      </div>
    </main>
  );
}

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
  kpRef: MutableRefObject<SenderKeypair | null>;
  kpReady: boolean;
  sign: ReturnType<typeof makeWalletSigner>;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onLog: (s: string) => void;
}) {
  const [amount, setAmount] = useState("100");
  const [to, setTo] = useState("");
  const [balanceResult, setBalanceResult] = useState<string | null>(null);

  if (!address) {
    return (
      <EmptyState
        title="Connect a wallet to begin"
        body="The dApp needs your Stellar address for signing and for local privacy-key derivation."
      />
    );
  }

  if (!kpReady || !kpRef.current) {
    return (
      <EmptyState
        title="Deriving privacy key"
        body="Approve the wallet message if prompted. The derived BabyJubJub key stays in this browser."
      />
    );
  }

  const kp = kpRef.current;

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      onLog(`> ${label}`);
      await fn();
    } catch (e) {
      onLog(`${label} failed: ${errorMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const ctxBase = { address, kp, sign, onProgress: onLog };

  switch (tab) {
    case "register":
      return (
        <ActionLayout
          title="Register privacy identity"
          body="Publishes your BabyJubJub public key to the registrar and proves knowledge of the matching secret. This is normally a one-time action."
          aside={[
            ["Proof", "Groth16 registration"],
            ["Writes", "Registrar public key"],
            ["Wallet", "Signs Soroban transaction"],
          ]}
        >
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() => run("register", () => register(ctxBase))}
          >
            Register account
          </button>
        </ActionLayout>
      );

    case "deposit":
      return (
        <ActionLayout
          title="Deposit into encrypted balance"
          body="Moves public CONF into the confidential token contract, then homomorphically adds an encrypted amount for your registered privacy key."
          aside={[
            ["Input", "Public CONF"],
            ["Output", "Encrypted balance"],
            ["Amount", formatStroops(amount)],
          ]}
        >
          <Field label="Amount in stroops">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              placeholder="100"
            />
          </Field>
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() =>
              run(`deposit ${amount}`, () =>
                deposit({ ...ctxBase, amount: BigInt(amount || "0") }),
              )
            }
          >
            Deposit CONF
          </button>
        </ActionLayout>
      );

    case "balance":
      return (
        <ActionLayout
          title="Decrypt local balance"
          body="Reads encrypted contract state, decrypts it with your local privacy key, and shows the plaintext only in this browser."
          aside={[
            ["Read path", "Contract state"],
            ["Decrypt", "Local browser"],
            ["Search", "BSGS discrete log"],
          ]}
        >
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() =>
              run("read encrypted balance", async () => {
                const r = await readAndDecryptBalance(address, kp);
                if (r.amount === null) {
                  setBalanceResult("(no balance recorded - deposit first)");
                  return;
                }
                setBalanceResult(
                  `${r.amount} stroops (${(Number(r.amount) / 1e7).toFixed(7)} CONF) - ` +
                    `BSGS ${r.bsgsMs} ms - nonce ${r.raw.nonce}`,
                );
                onLog(`balance = ${r.amount} stroops (BSGS ${r.bsgsMs} ms)`);
              })
            }
          >
            Read and decrypt
          </button>
          {balanceResult && <pre className="resultBox">{balanceResult}</pre>}
        </ActionLayout>
      );

    case "transfer":
      return (
        <ActionLayout
          title="Private transfer"
          body="Builds a transfer proof that hides the amount. The sender and receiver remain visible on Stellar, and the recipient must already be registered."
          aside={[
            ["Visible", "Sender and receiver"],
            ["Hidden", "Transfer amount"],
            ["Recipient", to ? shortAddress(to) : "Required"],
          ]}
        >
          <Field label="Recipient Stellar address">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="GCSOMETHING..."
              spellCheck={false}
            />
          </Field>
          <Field label="Amount in stroops">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              placeholder="30"
            />
          </Field>
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() =>
              run(`transfer ${amount} to ${shortAddress(to)}`, () =>
                transfer({
                  ...ctxBase,
                  to: to.trim(),
                  amount: BigInt(amount || "0"),
                }),
              )
            }
          >
            Send private transfer
          </button>
        </ActionLayout>
      );

    case "withdraw":
      return (
        <ActionLayout
          title="Withdraw to public token"
          body="Proves your encrypted balance covers the amount, updates confidential state, then moves public CONF back out through the SAC."
          aside={[
            ["Proof", "Balance >= amount"],
            ["Output", "Public CONF"],
            ["Amount", formatStroops(amount)],
          ]}
        >
          <Field label="Amount in stroops">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              placeholder="20"
            />
          </Field>
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() =>
              run(`withdraw ${amount}`, () =>
                withdraw({ ...ctxBase, amount: BigInt(amount || "0") }),
              )
            }
          >
            Withdraw CONF
          </button>
        </ActionLayout>
      );
  }
}

function Panel({
  title,
  kicker,
  children,
}: {
  title: string;
  kicker: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <span>{kicker}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ActionLayout({
  title,
  body,
  aside,
  children,
}: {
  title: string;
  body: string;
  aside: Array<[string, string]>;
  children: ReactNode;
}) {
  return (
    <div className="actionGrid">
      <div className="actionForm">
        <h3>{title}</h3>
        <p className="muted">{body}</p>
        <div className="formStack">{children}</div>
      </div>
      <dl className="actionFacts">
        {aside.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="emptyState">
      <span className="emptyMark" />
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </div>
  );
}

function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`statusPill statusPill-${tone}`}>{children}</span>;
}

function ContractIds() {
  const explorer = networkExplorer[cfg.network.network ?? "testnet"] ?? networkExplorer.testnet;
  const ids: [string, string][] = [
    ["Confidential token", cfg.contracts.confidentialToken],
    ["Registrar", cfg.contracts.registrar],
    ["SAC token", cfg.contracts.sacToken],
    ["Transfer verifier", cfg.contracts.verifierTransfer],
    ["Withdraw verifier", cfg.contracts.verifierWithdraw],
    ["Registration verifier", cfg.contracts.verifierRegistration],
  ];
  return (
    <div className="contractList">
      {ids.map(([name, id]) => (
        <a
          className={id ? "contractLink" : "contractLink mutedLink"}
          key={name}
          href={id ? `${explorer}${id}` : undefined}
          target="_blank"
          rel="noreferrer"
        >
          <span>{name}</span>
          <code>{id ? `${id.slice(0, 8)}...${id.slice(-6)}` : "not configured"}</code>
        </a>
      ))}
    </div>
  );
}

function ActivityLog({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <div className="activityEmpty">
        Activity will appear here after wallet prompts, proof generation, and
        contract submissions.
      </div>
    );
  }

  return (
    <ol className="activityList">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ol>
  );
}

function shortAddress(value: string): string {
  if (!value) return "G...";
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function formatStroops(value: string): string {
  try {
    const raw = BigInt(value || "0");
    return `${raw} stroops / ${(Number(raw) / 1e7).toFixed(7)} ${cfg.asset.code}`;
  } catch {
    return "Enter a numeric amount";
  }
}

function errorMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  if (raw.includes("Account not found")) {
    return `${raw} - click "Fund XLM" above to create this account on testnet`;
  }
  if (raw.includes("trustline entry is missing")) {
    return (
      `${raw} - click "Trustline" above, then ask the operator ` +
      `to send you ${cfg.asset.code} via \`scripts/fund-conf.sh <your-address>\``
    );
  }
  if (raw.includes("Error(Contract, #13)")) {
    return (
      `${raw} - likely the SAC.transfer step. Most common cause: missing trustline or ` +
      `insufficient ${cfg.asset.code} balance. Run trustline setup + fund-conf.sh, then retry.`
    );
  }
  return raw;
}
