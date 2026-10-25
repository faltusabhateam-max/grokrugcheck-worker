// GrokRugCheck always-on worker. Loops every 30s: leads -> 14-check floor -> bot signals -> Jupiter swaps
// signed via Privy server-side signing (session signer / key quorum) -> exits. State in Vercel Blob.
// Never trades for a user who has not armed; checks the per-user arm flag and the global kill switch every loop.
import fs from "node:fs";
import { PrivyClient } from "@privy-io/node";
import { runCheck } from "../../app/lib/checks";
import { BOTS, botById, botSettings, Sample, PoolLite } from "../../app/lib/bots";
import { Book, Pos, Mode, applyExit, todayPnl, guard, openPos, equityOf, START } from "../../app/lib/book";
import { decideExit } from "../../app/lib/exits";
import { readJson, writeJson, P, Users, Control, FeedItem, Networks } from "../../app/lib/store";
import { PRESETS, Chain, NATIVE_EVM, rpcCall } from "../../app/lib/chains";
import { DEFAULTS, SOL_MINT } from "../../app/lib/config";

const LOOP_MS = Number(process.env.LOOP_MS || 30000);
const DRY = process.env.DRY_RUN !== "0"; // safe default: dry run unless DRY_RUN=0
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const APP_ID = process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
const AUTH_KEY = process.env.PRIVY_AUTHORIZATION_KEY || (fs.existsSync(".secrets/auth_key") ? fs.readFileSync(".secrets/auth_key", "utf8").trim() : "");
const QUORUM = process.env.PRIVY_SIGNER_ID || (fs.existsSync(".secrets/quorum_id") ? fs.readFileSync(".secrets/quorum_id", "utf8").trim() : "");
const HOST = process.env.WORKER_HOST || "box";
const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FEE_RESERVE_SOL = 0.02;
const privy = APP_ID && process.env.PRIVY_APP_SECRET ? new PrivyClient({ appId: APP_ID, appSecret: process.env.PRIVY_APP_SECRET }) : null;
type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson(url: string, init?: RequestInit, ms = 12000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]}`); return r.json();
}
async function rpc(method: string, params: unknown[]) {
  const j = await getJson(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`); return j.result;
}

// ---------- chains ----------
// Position / cache key: Solana mint as-is, EVM "chain:0xaddr".
const keyOf = (chain: string, addr: string) => (chain === "solana" ? addr : `${chain}:${addr.toLowerCase()}`);
const parseKey = (k: string) => (k.includes(":") ? { chain: k.split(":")[0], addr: k.split(":")[1] } : { chain: "solana", addr: k });
let customNets: Networks = {}; let lastNets = 0;
const allChains = () => [...PRESETS, ...Object.values(customNets)] as Chain[];
const chainOf = (id: string) => allChains().find((c) => c.id === id || c.ds === id);
const scanChains = () => allChains().filter((c) => c.status !== "soon");
const evmRpc = async (c: Chain, method: string, params: unknown[]) => rpcCall(c.rpc, method, params, 12000);

// ---------- leads (all scanned chains) ----------
let rot = 0;
async function leads(): Promise<string[]> {
  const out = new Set<string>(); const sc = scanChains(); const dsIds = new Map(sc.map((c) => [c.ds, c.id]));
  const pick = sc[rot++ % sc.length];
  const srcs = await Promise.allSettled([
    getJson("https://api.dexscreener.com/token-profiles/latest/v1"),
    getJson("https://api.dexscreener.com/token-boosts/latest/v1"),
    getJson("https://api.dexscreener.com/latest/dex/search?q=pump"),
    getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(pick.ds)}`),
  ]);
  for (const s of srcs.slice(0, 2)) if (s.status === "fulfilled" && Array.isArray(s.value)) for (const x of s.value) { const id = dsIds.get(x.chainId); if (id && x.tokenAddress) out.add(keyOf(id, x.tokenAddress)); }
  for (const s of srcs.slice(2)) if (s.status === "fulfilled") for (const p of s.value.pairs || []) { const id = dsIds.get(p.chainId);
    if (id && p.pairCreatedAt && Date.now() - p.pairCreatedAt < 72 * 3600e3) out.add(keyOf(id, p.baseToken.address)); }
  return [...out];
}

// ---------- check cache with per-source backoff ----------
type Res = Awaited<ReturnType<typeof runCheck>> & { chain?: string; key?: string };
const cache = new Map<string, { at: number; r: Res }>();
const backoff: Record<string, { until: number; ms: number }> = { sol: { until: 0, ms: 5000 }, evm: { until: 0, ms: 5000 } };
const queue: string[] = [];
async function checkSome(n: number) {
  const out: Res[] = [];
  for (let i = 0, tries = 0; i < n && queue.length && tries < queue.length + n; tries++) {
    const k = queue.shift()!; const { chain, addr } = parseKey(k); const c = chainOf(chain); if (!c) continue;
    const src = chain === "solana" ? "sol" : "evm"; if (Date.now() < backoff[src].until) { queue.push(k); continue; }
    i++;
    const r = (chain === "solana" ? await runCheck(addr, {}) : await runCheck(addr, {}, c.ds, c.chainId)) as Res; r.chain = chain; r.key = k;
    if (r.reason?.startsWith("source down")) { const b = backoff[src]; b.until = Date.now() + b.ms; b.ms = Math.min(b.ms * 2, 120000); queue.push(k); log("backoff", src, b.ms, r.reason); }
    else backoff[src].ms = 5000;
    cache.set(k, { at: Date.now(), r }); out.push(r);
  }
  return out;
}

// ---------- price sampler (grouped by chain) ----------
const hist = new Map<string, Sample[]>();
const pools = new Map<string, PoolLite & { liq_usd: number }>();
async function sample(keys: string[]) {
  const by = new Map<string, string[]>(); for (const k of keys) { const { chain, addr } = parseKey(k); (by.get(chain) || by.set(chain, []).get(chain)!).push(addr); }
  for (const [chain, addrs] of by) { const c = chainOf(chain); if (!c) continue;
    for (let i = 0; i < addrs.length; i += 30) {
      const chunk = addrs.slice(i, i + 30); const lc = chunk.map((x) => x.toLowerCase());
      try {
        const arr: J[] = await getJson(`https://api.dexscreener.com/tokens/v1/${c.ds}/${chunk.join(",")}`);
        const best = new Map<string, J>();
        for (const p of arr) { const m = String(p.baseToken?.address); const j = chain === "solana" ? chunk.indexOf(m) : lc.indexOf(m.toLowerCase()); if (j < 0) continue; const a = chunk[j];
          if (!best.has(a) || (p.liquidity?.usd || 0) > (best.get(a).liquidity?.usd || 0)) best.set(a, p); }
        for (const a of chunk) { const k = keyOf(chain, a);
          const p = best.get(a); if (!p) { pools.set(k, { price: 0, liq_usd: 0 } as J); continue; }
          const tx = p.txns || {}; const pl: PoolLite = { price: Number(p.priceUsd) || 0, liq_usd: p.liquidity?.usd || 0,
            age_min: p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 60000) : null, chg: p.priceChange || {}, vol: p.volume || {},
            tx: { m5: tx.m5 || null, h1: tx.h1 || null, h6: tx.h6 || null, h24: tx.h24 || null }, buys_1h: tx.h1?.buys || 0, sells_1h: tx.h1?.sells || 0 };
          pools.set(k, pl);
          const h = hist.get(k) || []; h.push({ t: Date.now(), price: pl.price, liq: pl.liq_usd, volM5: p.volume?.m5 || 0, buysM5: tx.m5?.buys || 0, sellsM5: tx.m5?.sells || 0, buysH1: tx.h1?.buys || 0, sellsH1: tx.h1?.sells || 0 });
          hist.set(k, h.slice(-180)); }
      } catch (e) { for (const a of chunk) pools.delete(keyOf(chain, a)); log("sampler", chain, (e as Error).message); }
    } }
}

// ---------- native prices ----------
const nativeUsd: Record<string, number> = {};
async function priceOf(c: Chain) {
  try { if (c.kind === "sol") { const j = await getJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`); const p = Number(j?.[SOL_MINT]?.usdPrice); if (p > 0) nativeUsd[c.id] = p; }
    else { const j = await getJson(`https://li.quest/v1/token?chain=${c.chainId}&token=${NATIVE_EVM}`); const p = Number(j.priceUSD); if (p > 0) nativeUsd[c.id] = p; } } catch {}
  return nativeUsd[c.id] || 0;
}

// ---------- Solana: Jupiter ----------
const solBal = async (a: string) => (await rpc("getBalance", [a, { commitment: "confirmed" }])).value / 1e9;
async function tokenBal(owner: string, mint: string) {
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let raw = BigInt(0), dec = 0; for (const a of r.value) { const t = a.account.data.parsed.info.tokenAmount; raw += BigInt(t.amount); dec = t.decimals; } return { raw, dec };
}
async function swap(u: { address: string; walletId: string }, inputMint: string, outputMint: string, amountRaw: string) {
  const q = await getJson(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${DEFAULTS.slippageBps}&restrictIntermediateTokens=true`);
  if (q.error) throw new Error("quote: " + q.error);
  const s = await getJson("https://lite-api.jup.ag/swap/v1/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    quoteResponse: q, userPublicKey: u.address, dynamicComputeUnitLimit: true, wrapAndUnwrapSol: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: DEFAULTS.priorityMaxLamports, priorityLevel: "high" } } }) });
  if (!s.swapTransaction) throw new Error("swap build failed");
  if (DRY) return { sig: null as string | null, outAmount: String(q.outAmount), inAmount: String(q.inAmount), dry: true };
  if (!privy || !AUTH_KEY) throw new Error("server signing not configured");
  const r: J = await privy.wallets().solana().signAndSendTransaction(u.walletId, { caip2: SOL_CAIP2, transaction: s.swapTransaction,
    authorization_context: { authorization_private_keys: [AUTH_KEY] } } as J);
  return { sig: String(r.hash || r.signature || ""), outAmount: String(q.outAmount), inAmount: String(q.inAmount), dry: false };
}
async function confirmed(sig: string | null) {
  if (!sig) return true;
  for (let i = 0; i < 15; i++) { await sleep(2000); try { const st = (await rpc("getSignatureStatuses", [[sig]])).value[0];
    if (st?.err) return false; if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return true; } catch {} }
  return false;
}

// ---------- EVM: LI.FI (keyless) + Privy eth_sendTransaction ----------
const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const evmBal = async (c: Chain, a: string) => Number(BigInt(await evmRpc(c, "eth_getBalance", [a, "latest"]))) / 1e18;
async function erc20Bal(c: Chain, owner: string, token: string) {
  const raw = BigInt(await evmRpc(c, "eth_call", [{ to: token, data: "0x70a08231" + pad(owner) }, "latest"]) || "0x0");
  let dec = 18; try { dec = Number(BigInt(await evmRpc(c, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]))); } catch {}
  return { raw, dec };
}
const hex = (v: string | number | bigint | undefined) => (v === undefined || v === null ? undefined : "0x" + BigInt(v).toString(16));
async function evmSend(c: Chain, walletId: string, tx: { to: string; data: string; value?: string; gasLimit?: string }) {
  if (!privy || !AUTH_KEY) throw new Error("server signing not configured");
  const r: J = await privy.wallets().ethereum().sendTransaction(walletId, { caip2: `eip155:${c.chainId}`,
    params: { transaction: { to: tx.to, data: tx.data, value: hex(tx.value || "0"), chain_id: hex(c.chainId!), gas_limit: hex(tx.gasLimit) } },
    authorization_context: { authorization_private_keys: [AUTH_KEY] } } as J);
  return String(r.hash || r.transaction_hash || "");
}
async function evmConfirmed(c: Chain, h: string | null) {
  if (!h) return true;
  for (let i = 0; i < 30; i++) { await sleep(3000); try { const rc = await evmRpc(c, "eth_getTransactionReceipt", [h]); if (rc) return rc.status === "0x1"; } catch {} }
  return false;
}
async function evmSwap(c: Chain, u: { address: string; walletId: string }, from: string, to: string, amountRaw: string) {
  const q = await getJson(`https://li.quest/v1/quote?fromChain=${c.chainId}&toChain=${c.chainId}&fromToken=${from}&toToken=${to}&fromAmount=${amountRaw}&fromAddress=${u.address}&slippage=${DEFAULTS.slippageBps / 10000}&integrator=grokrugcheck`, undefined, 20000);
  const tr = q.transactionRequest; if (!tr?.to) throw new Error("no LI.FI route");
  const out = String(q.estimate?.toAmount || "0");
  if (DRY) return { sig: null as string | null, outAmount: out, inAmount: amountRaw, dry: true, tool: q.tool };
  if (from !== NATIVE_EVM && q.estimate?.approvalAddress) { // ERC-20 sell needs allowance for the LI.FI contract
    const al = BigInt(await evmRpc(c, "eth_call", [{ to: from, data: "0xdd62ed3e" + pad(u.address) + pad(q.estimate.approvalAddress) }, "latest"]) || "0x0");
    if (al < BigInt(amountRaw)) { const h = await evmSend(c, u.walletId, { to: from, data: "0x095ea7b3" + pad(q.estimate.approvalAddress) + BigInt(amountRaw).toString(16).padStart(64, "0") });
      if (!(await evmConfirmed(c, h))) throw new Error(`approve not confirmed ${h}`); } }
  const h = await evmSend(c, u.walletId, { to: tr.to, data: tr.data, value: tr.value, gasLimit: tr.gasLimit });
  return { sig: h, outAmount: out, inAmount: amountRaw, dry: false, tool: q.tool };
}

// ---------- signer verification ----------
const signerOk = new Map<string, { at: number; ok: boolean; walletId?: string; why?: string }>();
async function verifySigner(address: string, chainType: "solana" | "ethereum" = "solana") {
  const c = signerOk.get(address); if (c && Date.now() - c.at < 300000) return c;
  let v: { at: number; ok: boolean; walletId?: string; why?: string } = { at: Date.now(), ok: false, why: "privy not configured" };
  if (privy && QUORUM) try {
    for await (const w of privy.wallets().list({ address, chain_type: chainType } as J) as J) {
      const has = (w.additional_signers || []).some((s: J) => s.signer_id === QUORUM);
      v = { at: Date.now(), ok: has, walletId: w.id, why: has ? undefined : "app signer not granted on wallet" }; break;
    }
  } catch (e) { v = { at: Date.now(), ok: false, why: (e as Error).message }; }
  signerOk.set(address, v); return v;
}

// ---------- per-user state ----------
type UState = Book & { practiceInit?: number; giftApplied?: number; kills: { t: number; mint: string; symbol: string | null; reason: string }[]; updated: number; note?: string };
const states = new Map<string, { s: UState; dirty: boolean }>();
async function loadState(uid: string) {
  if (!states.has(uid)) states.set(uid, { s: await readJson<UState>(P.state(uid), { cash: 0, positions: {}, trades: [], equity: [], kills: [], updated: Date.now() }), dirty: false });
  return states.get(uid)!;
}
const kill = (st: { s: UState; dirty: boolean }, mint: string, symbol: string | null, reason: string) => {
  st.s.kills = [{ t: Date.now(), mint, symbol, reason }, ...st.s.kills].slice(0, 200); st.dirty = true; };

// Practice fills: live price, price impact from pool depth, DEX fee and a per-chain gas estimate.
const GAS_USD: Record<string, number> = { solana: 0.01, ethereum: 3, bsc: 0.1, polygon: 0.02, avalanche: 0.05 };
function simFill(c: Chain, pl: PoolLite, usd: number, buy: boolean) {
  const impact = pl.liq_usd > 0 ? (usd / (pl.liq_usd / 2)) : 0.05; const slip = Math.min(0.15, 0.004 + impact); const fee = c.kind === "sol" ? 0.0025 : 0.003;
  const gas = GAS_USD[c.id] ?? 0.05; const gasPct = usd > 0 ? gas / usd : 0;
  const k = buy ? 1 + slip + fee + gasPct : Math.max(0, 1 - slip - fee - gasPct);
  return { price: pl.price * k, note: `slippage ${(slip * 100).toFixed(2)}%, fee ${(fee * 100).toFixed(2)}%, gas $${gas}` };
}

// ---------- main loop ----------
let loops = 0, scanned = 0, lastHb = 0, lastFeed = 0, lastLeads = 0, lastError: string | null = null;
let feed: FeedItem[] = [];
const signals = new Map<string, string>();
// Per-chain wallet adapter: balance, token balance, swap, confirm.
type W = { address: string; walletId: string };
const FEE_RESERVE: Record<string, number> = { solana: FEE_RESERVE_SOL, ethereum: 0.004, bsc: 0.003, polygon: 1, avalanche: 0.05 }; // native units kept for gas
const reserveOf = (c: Chain) => FEE_RESERVE[c.id] ?? (c.native === "ETH" ? 0.0008 : 0);
async function nativeBal(c: Chain, w: W) { return c.kind === "sol" ? solBal(w.address) : evmBal(c, w.address); }
async function heldRaw(c: Chain, w: W, addr: string) { return c.kind === "sol" ? tokenBal(w.address, addr) : erc20Bal(c, w.address, addr); }
async function doSwap(c: Chain, w: W, buy: boolean, addr: string, amountRaw: string) {
  if (c.kind === "sol") { const x = await swap(w, buy ? SOL_MINT : addr, buy ? addr : SOL_MINT, amountRaw); return { ...x, ok: await confirmed(x.sig) }; }
  const x = await evmSwap(c, w, buy ? NATIVE_EVM : addr, buy ? addr : NATIVE_EVM, amountRaw); return { ...x, ok: await evmConfirmed(c, x.sig) };
}

async function tick() {
  loops++;
  if (Date.now() - lastNets > 120000) { lastNets = Date.now(); customNets = await readJson<Networks>(P.networks, customNets); }
  const [control, users] = await Promise.all([readJson<Control>(P.control, { killAll: false, updated: 0 }), readJson<Users>(P.users, {})]);
  const armed = Object.values(users).filter((u) => u.armed && !control.killAll); // never trade a user who has not armed
  for (const k of await leads()) { const c = cache.get(k); if ((!c || Date.now() - c.at > 600000) && !queue.includes(k)) queue.push(k); }
  if (queue.length > 400) queue.splice(0, queue.length - 400);
  const fresh = await checkSome(8); scanned += fresh.length;
  for (const r of fresh) feed = [{ t: Date.now(), chain: r.chain, mint: r.mint, symbol: r.symbol, image: r.image, verdict: r.verdict, reason: (r as J).plain || r.reason, passed: r.checks.filter((c: J) => c.pass === true).length, liq: r.pool?.liq_usd ?? null }, ...feed].slice(0, 60);
  const candidates = [...cache.values()].filter((c) => c.r.passedCode && (c.r.verdict === "BUY" || c.r.verdict === "NEEDS_KEY") && Date.now() - c.at < 3600000).map((c) => c.r);
  const held = new Set<string>(); for (const st of states.values()) for (const m of Object.keys(st.s.positions)) held.add(m);
  await sample([...new Set([...candidates.map((c) => c.key!), ...held])]);

  // holder/dev drift for held tokens: re-run the fact checks at most every 5 min per token
  const drift = new Map<string, { top10: number | null; dev: number | null }>();
  let rechecks = 0;
  for (const k of held) { const c0 = cache.get(k); if (c0 && Date.now() - c0.at < 300000) continue; if (rechecks++ >= 3) break;
    try { const { chain, addr } = parseKey(k); const c = chainOf(chain); if (!c) continue;
      const r = (chain === "solana" ? await runCheck(addr, {}) : await runCheck(addr, {}, c.ds, c.chainId)) as Res; r.chain = chain; r.key = k; if (r.facts) cache.set(k, { at: Date.now(), r }); } catch {} }
  for (const k of held) { const f = (cache.get(k)?.r.facts || {}) as J; drift.set(k, { top10: f.top10_pct ?? null, dev: f.dev_pct ?? null }); }

  for (const u of armed) {
    const st = await loadState(u.userId); const bot = botById(u.bot); const s = botSettings(bot);
    const mode = u.mode || "practice"; const practice = mode === "practice";
    const enabled = new Set(u.chains && u.chains.length ? u.chains : ["solana"]);
    if (practice && !st.s.practiceInit) { st.s = { ...st.s, cash: START, practiceInit: Date.now(), equity: [{ t: Date.now(), v: START }] }; st.dirty = true; }
    { const g = await readJson<{ totalUsd: number } | null>(P.gift(u.userId), null); const d = (g?.totalUsd || 0) - (st.s.giftApplied || 0);
      if (d > 0) { st.s = { ...st.s, cash: st.s.cash + d, giftApplied: g!.totalUsd }; st.dirty = true; } }
    const notes: string[] = [];
    const wallets: Record<string, W | null> = {};
    if (!practice) {
      const sv = await verifySigner(u.address, "solana"); wallets.sol = sv.ok ? { address: u.address, walletId: sv.walletId! } : null; if (!sv.ok) notes.push(`Solana: ${sv.why}`);
      if (u.evmAddress) { const ev = await verifySigner(u.evmAddress, "ethereum"); wallets.evm = ev.ok ? { address: u.evmAddress, walletId: ev.walletId! } : null; if (!ev.ok) notes.push(`EVM: ${ev.why}`); }
    }
    if (mode === "pending") notes.push("Deposit detected: confirm your limits in the app to start real trading");
    const walletFor = (c: Chain) => (c.kind === "sol" ? wallets.sol : c.kind === "evm" ? wallets.evm : null);
    const note = notes.join("; ") || undefined; if (st.s.note !== note) { st.s.note = note; st.dirty = true; }
    // ---- exits: discretionary scoring engine, every open position (practice positions only close via simulation)
    for (const [k, p0] of Object.entries(st.s.positions)) {
      const pl = pools.get(k); if (!pl) continue;
      const p = { ...p0, peak: Math.max(p0.peak, pl.price || 0), lastPrice: pl.price || p0.lastPrice }; st.s.positions[k] = p; st.dirty = true;
      const d0 = (p as J).snap || {}; const dn = drift.get(k) || { top10: null, dev: null };
      const dec = decideExit(p, pl, hist.get(k) || [], p.bot || bot.id, { top10Drop: d0.top10 != null && dn.top10 != null ? d0.top10 - dn.top10 : null, devDrop: d0.dev != null && dn.dev != null ? d0.dev - dn.dev : null });
      if (!dec) continue;
      const { chain, addr } = parseKey(k); const c = chainOf(chain); if (!c) continue;
      if (p.mode === "paper") { // practice: simulated fill at the live price with realistic slippage, fees and gas
        const out = simFill(c, pl, p.qty0 * Math.min(1, dec.frac >= 1 ? p.qty / p.qty0 : dec.frac) * pl.price, false);
        const r = applyExit(st.s, { mint: k, frac: dec.frac, reason: dec.reason, price: out.price, ladderStep: dec.frac < 1 }, "PRACTICE");
        st.s = { ...st.s, ...r.book }; log(u.userId, c.id, "PRACTICE SELL", p.symbol, dec.reason); continue; }
      if (practice) continue; // never touch real positions from a practice account
      const w = walletFor(c); if (!w) continue;
      try {
        const { raw } = await heldRaw(c, w, addr); const amt = dec.frac >= 1 ? raw : (raw * BigInt(Math.round(dec.frac * 1000))) / BigInt(1000);
        if (amt <= BigInt(0)) { const r = applyExit(st.s, { mint: k, frac: 1, reason: "position empty on-chain", price: pl.price }); st.s = { ...st.s, ...r.book }; kill(st, k, p.symbol, "position empty on-chain"); continue; }
        const usdN = await priceOf(c); const x = await doSwap(c, w, false, addr, amt.toString());
        if (!x.ok) { kill(st, k, p.symbol, `sell not confirmed ${x.sig}`); continue; }
        const outUsd = (Number(x.outAmount) / (c.kind === "sol" ? 1e9 : 1e18)) * usdN; const fillPrice = outUsd / (p.qty0 * (dec.frac >= 1 ? p.qty / p.qty0 : dec.frac));
        const r = applyExit(st.s, { mint: k, frac: dec.frac, reason: dec.reason, price: isFinite(fillPrice) && fillPrice > 0 ? fillPrice : pl.price, ladderStep: dec.frac < 1 }, x.sig || (x.dry ? "DRY_RUN" : undefined));
        st.s = { ...st.s, ...r.book }; log(u.userId, c.id, x.dry ? "DRY SELL" : "SELL", p.symbol, dec.reason, x.sig);
      } catch (err) { kill(st, k, p.symbol, `sell failed: ${(err as Error).message}`); }
    }
    if (mode === "pending") continue; // practice ended by a deposit; wait for the user to confirm limits
    // ---- entries
    const pm: Mode = practice ? "paper" : "live";
    const byChain = new Map<string, Res[]>(); for (const c of candidates) if (enabled.has(c.chain!)) (byChain.get(c.chain!) || byChain.set(c.chain!, []).get(c.chain!)!).push(c);
    for (const [chainId, list] of byChain) {
      const c = chainOf(chainId); if (!c || c.status !== "live") continue; const w = practice ? null : walletFor(c); if (!practice && !w) continue;
      let room: number;
      if (practice) room = st.s.cash;
      else { let bal = 0; try { bal = await nativeBal(c, w!); } catch (e) { lastError = `${c.id}: ${(e as Error).message}`; continue; }
        const usdN = await priceOf(c); if (!usdN) continue; const balUsd = Math.max(0, bal - reserveOf(c)) * usdN;
        const deployed = Object.values(st.s.positions).filter((p) => p.mode === "live").reduce((t, p) => t + p.costUsd * (p.qty / p.qty0), 0);
        room = Math.min(balUsd, Math.max(0, (u.budgetUsd || 0) - deployed)); }
      const cap = practice ? Math.max(25, Math.min(100, START * bot.sizePct)) : u.perTradeUsd || 0;
      if (todayPnl(st.s, pm) <= -((practice ? START : u.budgetUsd || 0) * bot.dailyLossPct)) { kill(st, "", null, "daily loss halt"); break; }
      for (const r of list) {
        const k = r.key!; if (st.s.positions[k]) continue;
        const pl = pools.get(k); if (!pl || !pl.price) continue;
        const size = Math.min(cap, room); if (size < (practice ? 5 : bot.minUsd)) break;
        const g = guard(st.s, k, { ...s, ticketUsd: size, dailyLossHaltUsd: Infinity }, pm); if (g) continue;
        if (size / pl.liq_usd > DEFAULTS.maxTicketShare) continue;
        if (bot.extra(pl, r.facts?.risk_score ?? null)) continue;
        const sg = bot.signal(pl, hist.get(k) || [], r.verdict); signals.set(`${u.userId}:${k}`, sg.why); if (!sg.go) continue;
        const snap = { top10: (r.facts as J)?.top10_pct ?? null, dev: (r.facts as J)?.dev_pct ?? null };
        if (practice) {
          const f = simFill(c, pl, size, true);
          const pos = { chain: c.id, mint: k, symbol: r.symbol || "?", image: r.image, entry: f.price, liq0: pl.liq_usd, mode: "paper" as Mode, costUsd: size, bot: bot.id, why: `${sg.why} (fill ${f.note})`, snap };
          st.s = { ...st.s, ...openPos(st.s, pos, size, "PRACTICE") }; st.dirty = true; room -= size;
          log(u.userId, c.id, "PRACTICE BUY", r.symbol, size.toFixed(2)); continue; }
        try {
          const usdN = await priceOf(c);
          const raw = c.kind === "sol" ? String(Math.floor((size / usdN) * 1e9)) : (BigInt(Math.floor((size / usdN) * 1e9)) * BigInt(1e9)).toString();
          const x = await doSwap(c, w!, true, parseKey(k).addr, raw);
          if (!x.ok) { kill(st, k, r.symbol, `buy not confirmed ${x.sig}`); continue; }
          const dec = x.dry ? (c.kind === "sol" ? 6 : 18) : (await heldRaw(c, w!, parseKey(k).addr).catch(() => ({ dec: 18 }))).dec;
          const qty = Number(x.outAmount) / 10 ** dec; const entry = qty > 0 ? size / qty : pl.price;
          const pos = { chain: c.id, mint: k, symbol: r.symbol || "?", image: r.image, entry, liq0: pl.liq_usd, mode: "live" as Mode, costUsd: size, bot: bot.id, why: sg.why, snap };
          st.s = { ...st.s, ...openPos(st.s, pos, size, x.sig || (x.dry ? "DRY_RUN" : undefined)) }; st.dirty = true; room -= size;
          log(u.userId, c.id, x.dry ? "DRY BUY" : "BUY", r.symbol, size.toFixed(2), x.sig);
        } catch (err) { kill(st, k, r.symbol, `buy failed: ${(err as Error).message}`); }
      }
    }
    if (practice) { const eq = equityOf(st.s); const last = st.s.equity[st.s.equity.length - 1]; if (!last || Date.now() - last.t > 300000) { st.s.equity = [...st.s.equity, { t: Date.now(), v: eq }].slice(-500); st.dirty = true; } }
  }
  for (const [uid, st] of states) if (st.dirty) { st.s.updated = Date.now(); await writeJson(P.state(uid), st.s); st.dirty = false; }
  if (fresh.length) await writeJson(P.feed, feed);
  if (Date.now() - lastHb > 25000) { lastHb = Date.now(); await writeJson(P.hb, { t: Date.now(), loops, scanned, armed: armed.length, dryRun: DRY, host: HOST, lastError, killAll: control.killAll, bots: BOTS.length, loopMs: LOOP_MS,
    chains: scanChains().map((c) => ({ id: c.id, status: c.status })), queue: queue.length }); }
}

(async () => {
  // Health endpoint for hosts that need a web port (Render free web service), plus a keep-alive self-ping.
  if (process.env.PORT) {
    const http = await import("node:http");
    http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, loops, host: HOST, t: Date.now() })); }).listen(Number(process.env.PORT), "0.0.0.0");
    const self = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
    if (self) setInterval(() => { fetch(`${self}/health`).catch(() => {}); }, 9 * 60 * 1000);
  }
  log(`worker start dryRun=${DRY} loop=${LOOP_MS}ms signer=${QUORUM ? "set" : "missing"} authKey=${AUTH_KEY ? "set" : "missing"} privy=${!!privy} chains=${scanChains().length}`);
  if (process.env.TEST_SWAP) { // dry-run route check against live quotes on every live chain; never signs
    if (!DRY) throw new Error("TEST_SWAP requires dry run");
    const USDC: Record<string, string> = { solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", sonic: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", unichain: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", linea: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
      zksync: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", abstract: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1", robinhood: "" };
    const evmA = process.env.TEST_EVM || "0x1111111111111111111111111111111111111111";
    for (const c of PRESETS.filter((x) => x.status === "live")) {
      try { const usdN = await priceOf(c); const amt = c.kind === "sol" ? String(0.05e9) : (BigInt(Math.floor((5 / usdN) * 1e9)) * BigInt(1e9)).toString();
        let to = USDC[c.id]; if (!to) { const d: J = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${c.ds}`); to = (d.pairs || []).find((p: J) => p.chainId === c.ds)?.baseToken?.address; }
        const x = c.kind === "sol" ? await swap({ address: process.env.TEST_SWAP, walletId: "none" }, SOL_MINT, to, amt) : await evmSwap(c, { address: evmA, walletId: "none" }, NATIVE_EVM, to, amt);
        log(`DRY ${c.id}: price ${usdN} route OK out=${x.outAmount} signed=${!!x.sig}`);
      } catch (e) { log(`DRY ${c.id}: FAIL ${(e as Error).message}`); } }
    process.exit(0); }
  if (process.env.ONCE) { await tick(); log("once done", { scanned, feed: feed.slice(0, 8).map((f) => `${f.chain}:${f.symbol}:${f.verdict}:${f.reason}`) }); process.exit(0); }
  for (;;) { const t0 = Date.now(); try { await tick(); lastError = null; } catch (e) { lastError = (e as Error).message; log("tick error", lastError); }
    if (loops % 10 === 0) log(`loop ${loops} scanned=${scanned} queue=${queue.length} feed0=${feed[0]?.chain}:${feed[0]?.symbol}:${feed[0]?.verdict}`);
    await sleep(Math.max(500, LOOP_MS - (Date.now() - t0))); }
})();
