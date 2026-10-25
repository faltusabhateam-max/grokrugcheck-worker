// Flovia: an MCP gateway (https://api.flovia.dev/mcp) bundling CoinGecko (incl. GeckoTerminal onchain DEX data),
// Nansen, Quicknode, Zerion and Exa behind one key. We call its flovia_coingecko tool server-side for pool OHLCV.
// The key never leaves the server and is never logged.
type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export async function floviaTool(name: string, args: Record<string, unknown>, ms = 9000): Promise<J> {
  const key = process.env.FLOVIA_API_KEY; if (!key) throw new Error("flovia key missing");
  const r = await fetch("https://api.flovia.dev/mcp", { method: "POST", signal: AbortSignal.timeout(ms),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (!r.ok) throw new Error(`flovia HTTP ${r.status}`);
  const t = await r.text(); const line = t.split("\n").find((l) => l.startsWith("data:")); const msg = JSON.parse(line ? line.slice(5) : t);
  if (msg.error) throw new Error(`flovia: ${msg.error.message}`);
  const outer = JSON.parse(msg.result?.content?.[0]?.text || "{}"); if (!outer.ok) throw new Error(`flovia: ${outer.error || outer.status || "not ok"}`);
  return typeof outer.response === "string" ? JSON.parse(outer.response) : outer.response;
}
// DexScreener chain id -> GeckoTerminal / CoinGecko onchain network id
export const GT_NET: Record<string, string> = { solana: "solana", ethereum: "eth", base: "base", bsc: "bsc", arbitrum: "arbitrum", polygon: "polygon_pos",
  avalanche: "avax", optimism: "optimism", sonic: "sonic", unichain: "unichain", abstract: "abstract", zksync: "zksync", linea: "linea", blast: "blast", hyperevm: "hyperevm", robinhood: "robinhood" };
export const TF: Record<string, { tf: string; agg: number; limit: number }> = {
  "5m": { tf: "minute", agg: 5, limit: 96 }, "15m": { tf: "minute", agg: 15, limit: 96 }, "1h": { tf: "hour", agg: 1, limit: 96 }, "4h": { tf: "hour", agg: 4, limit: 90 }, "1d": { tf: "day", agg: 1, limit: 90 } };
export async function ohlcv(ds: string, pool: string, tfKey: string): Promise<{ candles: number[][]; source: string }> {
  const net = GT_NET[ds] || ds; const t = TF[tfKey] || TF["15m"]; const path = `/onchain/networks/${net}/pools/${pool}/ohlcv/${t.tf}`;
  try {
    const j = await floviaTool("flovia_coingecko", { request_text: `OHLCV candles for pool ${pool} on ${net}`, purpose: "candlestick chart in a token card", path, query: { aggregate: t.agg, limit: t.limit, currency: "usd" } });
    const l = j?.data?.attributes?.ohlcv_list; if (Array.isArray(l) && l.length) return { candles: l.slice().reverse(), source: "Flovia (CoinGecko onchain)" };
  } catch {}
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/${t.tf}?aggregate=${t.agg}&limit=${t.limit}&currency=usd`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`ohlcv HTTP ${r.status}`); const j = await r.json();
  return { candles: (j?.data?.attributes?.ohlcv_list || []).slice().reverse(), source: "GeckoTerminal" };
}
