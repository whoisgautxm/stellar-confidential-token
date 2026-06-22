import ReactDOM from "react-dom/client";
import { App } from "./App.js";

// NB: BigInt#toJSON polyfill lives in index.html so it runs before any module
// (including React itself) evaluates — React 19's dev tooling JSON.stringify's
// component state, which would otherwise throw on bigint values.
//
// NB: deliberately not wrapping in <React.StrictMode>. StrictMode's
// double-invocation of effects in dev races with @creit.tech/stellar-wallets-kit's
// postMessage RPCs to the Freighter content script and trips React's
// "Should not already be working" scheduler assertion. We rely on the
// app-level re-entry guards (derivingRef in App.tsx, busy flag) instead.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
