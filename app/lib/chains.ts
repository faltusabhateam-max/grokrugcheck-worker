// Chain registry. kind "sol" trades via Jupiter; kind "evm" trades via LI.FI (keyless) with GoPlus as the EVM rug source.
export type Chain = { id: string; name: string; kind: "sol" | "evm" | "other"; chainId?: number; rpc: string; native: string; explorer: string;
  explorerName: string; ds: string; logo: string; status: "live" | "soon" | "scan"; note?: string; custom?: boolean; router?: string };
const L = (s: string) => `/logos/chain-${s}.png`;
const evm = (id: string, name: string, chainId: number, rpc: string, native: string, explorer: string, explorerName: string): Chain =>
  ({ id, name, kind: "evm", chainId, rpc, native, explorer, explorerName, ds: id, logo: L(id), status: "live" });
export const PRESETS: Chain[] = [
  { id: "solana", name: "Solana", kind: "sol", rpc: "https://api.mainnet-beta.solana.com", native: "SOL", explorer: "https://solscan.io", explorerName: "Solscan", ds: "solana", logo: L("solana"), status: "live" },
  evm("ethereum", "Ethereum", 1, "https://ethereum-rpc.publicnode.com", "ETH", "https://etherscan.io", "Etherscan"),
  evm("base", "Base", 8453, "https://mainnet.base.org", "ETH", "https://basescan.org", "Basescan"),
  evm("bsc", "BNB Chain", 56, "https://bsc-dataseed.bnbchain.org", "BNB", "https://bscscan.com", "BscScan"),
  evm("arbitrum", "Arbitrum", 42161, "https://arb1.arbitrum.io/rpc", "ETH", "https://arbiscan.io", "Arbiscan"),
  evm("polygon", "Polygon", 137, "https://polygon-bor-rpc.publicnode.com", "POL", "https://polygonscan.com", "Polygonscan"),
  evm("avalanche", "Avalanche", 43114, "https://api.avax.network/ext/bc/C/rpc", "AVAX", "https://snowtrace.io", "Snowtrace"),
  evm("optimism", "Optimism", 10, "https://mainnet.optimism.io", "ETH", "https://optimistic.etherscan.io", "Optimistic Etherscan"),
  evm("robinhood", "Robinhood Chain", 4663, "https://rpc.mainnet.chain.robinhood.com", "ETH", "https://robin.etherscan.io", "Robinhood Etherscan"),
  evm("sonic", "Sonic", 146, "https://rpc.soniclabs.com", "S", "https://sonicscan.org", "SonicScan"),
  evm("unichain", "Unichain", 130, "https://mainnet.unichain.org", "ETH", "https://uniscan.xyz", "Uniscan"),
  evm("abstract", "Abstract", 2741, "https://api.mainnet.abs.xyz", "ETH", "https://abscan.org", "Abscan"),
  evm("zksync", "zkSync Era", 324, "https://mainnet.era.zksync.io", "ETH", "https://era.zksync.network", "zkSync Era Explorer"),
  evm("linea", "Linea", 59144, "https://rpc.linea.build", "ETH", "https://lineascan.build", "Lineascan"),
  { ...evm("blast", "Blast", 81457, "https://rpc.blast.io", "ETH", "https://blastscan.io", "Blastscan"), status: "scan", note: "No keyless swap route (LI.FI does not list Blast). Scanned, not traded." },
  { ...evm("hyperevm", "HyperEVM", 999, "https://rpc.hyperliquid.xyz/evm", "HYPE", "https://hyperevmscan.io", "HyperEVMScan"), status: "scan", note: "GoPlus has no token security data for HyperEVM, so the rug filter cannot pass. Scanned, not traded." },
  { id: "sui", name: "Sui", kind: "other", rpc: "", native: "SUI", explorer: "https://suiscan.xyz/mainnet", explorerName: "Suiscan", ds: "sui", logo: L("sui"), status: "soon", note: "Needs a Sui wallet and Sui aggregator integration." },
  { id: "ton", name: "TON", kind: "other", rpc: "", native: "TON", explorer: "https://tonviewer.com", explorerName: "Tonviewer", ds: "ton", logo: L("ton"), status: "soon", note: "Needs a TON wallet and TON DEX integration." },
  { id: "tron", name: "Tron", kind: "other", rpc: "", native: "TRX", explorer: "https://tronscan.org", explorerName: "Tronscan", ds: "tron", logo: L("tron"), status: "soon", note: "Needs a Tron wallet and SunSwap integration." },
];
export const chainById = (id: string, extra: Chain[] = []) => [...PRESETS, ...extra].find((c) => c.id === id);
export const txUrl = (c: Chain, h: string) => `${c.explorer.replace(/\/$/, "")}/tx/${h}`;
export const tokenUrl = (c: Chain, a: string) => `${c.explorer.replace(/\/$/, "")}/${c.kind === "sol" ? "token" : "token"}/${a}`;
export const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
export async function rpcCall(url: string, method: string, params: unknown[], ms = 10000) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(ms), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
// Can bots trade a chain? Needs a LI.FI route and GoPlus rug data.
export async function tradeSupport(chainId: number) {
  const [lf, gp] = await Promise.allSettled([fetch("https://li.quest/v1/chains?chainTypes=EVM", { signal: AbortSignal.timeout(10000) }).then((r) => r.json()),
    fetch("https://api.gopluslabs.io/api/v1/supported_chains", { signal: AbortSignal.timeout(10000) }).then((r) => r.json())]);
  const lifi = lf.status === "fulfilled" && (lf.value.chains || []).some((c: { id: number }) => c.id === chainId);
  const goplus = gp.status === "fulfilled" && (gp.value.result || []).some((c: { id: string }) => c.id === String(chainId));
  return { lifi, goplus, live: lifi && goplus };
}
