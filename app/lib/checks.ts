import { DEFAULTS, Settings } from "./config";
// Server-side port of rugcheck.py, market.py, grok.py, prompts.py and check.py from the article.
const RC = "https://api.rugcheck.xyz/v1/tokens";
const DS = "https://api.dexscreener.com/tokens/v1";
type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function getJson(url: string, ms = 15000) {
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function report(mint: string) {
  const d: J = await getJson(`${RC}/${mint}/report`, 20000);
  const token = d.token || {}; const known = d.knownAccounts || {};
  const isPool = (h: J) => { const tag = known[h.owner] || known[h.address] || {}; return ["AMM", "LOCKER"].includes(String(tag.type || "").toUpperCase()); };
  const holders = (d.topHolders || []).filter((h: J) => !isPool(h));
  const liq = (m: J) => ((m.lp || {}).baseUSD || 0) + ((m.lp || {}).quoteUSD || 0);
  const markets = [...(d.markets || [])].sort((a: J, b: J) => liq(b) - liq(a));
  const lp = markets.length ? markets[0].lp || {} : {};
  const supply = token.supply || 0; const risks = d.risks || [];
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    mint, symbol: (d.tokenMeta || {}).symbol ?? null, name: (d.tokenMeta || {}).name ?? null,
    image: (d.fileMeta || {}).image || null,
    rugged: !!d.rugged, risk_score: d.score_normalised ?? null,
    danger: risks.filter((x: J) => x.level === "danger").map((x: J) => x.name),
    warn: risks.filter((x: J) => x.level === "warn").map((x: J) => x.name),
    mint_authority: "mintAuthority" in token ? token.mintAuthority : d.mintAuthority ?? null,
    freeze_authority: "freezeAuthority" in token ? token.freezeAuthority : d.freezeAuthority ?? null,
    lp_locked_pct: lp.lpLockedPct ?? d.lpLockedPct ?? null,
    top10_pct: holders.length ? r2(holders.slice(0, 10).reduce((s: number, h: J) => s + (h.pct || 0), 0)) : null,
    dev_pct: supply ? r2(((d.creatorBalance || 0) / supply) * 100) : null,
    insiders: holders.filter((h: J) => h.insider).length + (d.graphInsidersDetected || 0),
    holders: d.totalHolders ?? null,
  };
}
export type Facts = Awaited<ReturnType<typeof report>>;

export async function pool(mint: string, chain = "solana") {
  const data: J = await getJson(`${DS}/${chain}/${mint}`);
  let pairs: J[] = Array.isArray(data) ? data : data.pairs || [];
  pairs = pairs.filter((p) => String((p.baseToken || {}).address).toLowerCase() === mint.toLowerCase());
  if (!pairs.length) return null;
  const p = pairs.reduce((a, b) => (((b.liquidity || {}).usd || 0) > ((a.liquidity || {}).usd || 0) ? b : a));
  const h1 = (p.txns || {}).h1 || {}; const born = p.pairCreatedAt;
  return {
    symbol: (p.baseToken || {}).symbol ?? null, name: (p.baseToken || {}).name ?? null,
    price: Number(p.priceUsd || 0), liq_usd: (p.liquidity || {}).usd || 0,
    age_min: born ? Math.round((Date.now() - born) / 60000) : null,
    buys_1h: h1.buys ?? 0, sells_1h: h1.sells ?? 0, vol_1h: (p.volume || {}).h1 ?? null,
    chg: { m5: p.priceChange?.m5 ?? null, h1: p.priceChange?.h1 ?? null, h6: p.priceChange?.h6 ?? null, h24: p.priceChange?.h24 ?? null },
    vol: { m5: p.volume?.m5 ?? null, h1: p.volume?.h1 ?? null, h6: p.volume?.h6 ?? null, h24: p.volume?.h24 ?? null },
    tx: { m5: p.txns?.m5 ?? null, h1: p.txns?.h1 ?? null, h6: p.txns?.h6 ?? null },
    url: p.url ?? null, image: (p.info || {}).imageUrl ?? null, pair: p.pairAddress ?? null,
  };
}
export type Pool = Awaited<ReturnType<typeof pool>>;

export type Check = { n: number; id: string; label: string; pass: boolean | null; value: string };

export function factChecks(t: Facts | null, c: Settings): Check[] {
  const f = (v: unknown) => (v === null || v === undefined ? "null" : String(v));
  if (!t) return ["Already rugged", "Mint authority", "Freeze authority", "Danger flags", "Risk score", "LP locked", "Top 10 holders", "Dev wallet", "Insiders"]
    .map((label, i) => ({ n: i + 1, id: "facts_" + (i + 1), label, pass: null, value: "source down" }));
  const has = t.risk_score !== null;
  return [
    { n: 1, id: "already_rugged", label: "Already rugged", pass: has ? !t.rugged : false, value: t.rugged ? "rugged" : "no" },
    { n: 2, id: "mint_open", label: "Mint authority", pass: !t.mint_authority, value: t.mint_authority ? "open" : "revoked" },
    { n: 3, id: "freeze_open", label: "Freeze authority", pass: !t.freeze_authority, value: t.freeze_authority ? "open" : "revoked" },
    { n: 4, id: "danger", label: "Danger flags", pass: t.danger.length === 0, value: t.danger.length ? t.danger.join(", ") : "none" },
    { n: 5, id: "risk_score", label: `Risk score <= ${c.maxRiskScore}`, pass: has && t.risk_score! <= c.maxRiskScore, value: f(t.risk_score) },
    { n: 6, id: "lp_unlocked", label: `LP locked >= ${c.minLpLockedPct}%`, pass: t.lp_locked_pct !== null && t.lp_locked_pct >= c.minLpLockedPct, value: t.lp_locked_pct === null ? "null" : `${Math.round(t.lp_locked_pct * 10) / 10}%` },
    { n: 7, id: "top10_heavy", label: `Top 10 <= ${c.maxTop10Pct}%`, pass: t.top10_pct !== null && t.top10_pct <= c.maxTop10Pct, value: t.top10_pct === null ? "null" : `${t.top10_pct}%` },
    { n: 8, id: "dev_holds", label: `Dev wallet <= ${c.maxDevPct}%`, pass: t.dev_pct !== null && t.dev_pct <= c.maxDevPct, value: t.dev_pct === null ? "null" : `${t.dev_pct}%` },
    { n: 9, id: "insiders", label: `Insiders <= ${c.maxInsiders}`, pass: t.insiders <= c.maxInsiders, value: String(t.insiders) },
  ];
}
export function factKill(t: Facts, c: Settings): string | null {
  if (t.risk_score === null) return "no_report";
  if (t.rugged) return "already_rugged";
  if (t.mint_authority) return "mint_open";
  if (t.freeze_authority) return "freeze_open";
  if (t.danger.length) return "danger:" + t.danger[0];
  if (t.risk_score > c.maxRiskScore) return "risk_score";
  if (t.lp_locked_pct === null || t.lp_locked_pct < c.minLpLockedPct) return "lp_unlocked";
  if (t.top10_pct === null || t.top10_pct > c.maxTop10Pct) return "top10_heavy";
  if (t.dev_pct === null || t.dev_pct > c.maxDevPct) return "dev_holds";
  if (t.insiders > c.maxInsiders) return "insiders";
  return null;
}
export function poolChecks(m: Pool, c: Settings): Check[] {
  const ok = !!m && m.price > 0;
  return [
    { n: 10, id: "thin_pool", label: `Liquidity >= $${c.minLiquidityUsd.toLocaleString()}`, pass: ok && m!.liq_usd >= c.minLiquidityUsd, value: m ? `$${Math.round(m.liq_usd).toLocaleString()}` : "no pool" },
    { n: 11, id: "ticket_too_big", label: `Ticket <= ${c.maxTicketShare * 100}% of pool`, pass: ok && m!.liq_usd > 0 && c.ticketUsd / m!.liq_usd <= c.maxTicketShare, value: m && m.liq_usd ? `${((c.ticketUsd / m.liq_usd) * 100).toFixed(3)}%` : "n/a" },
    { n: 12, id: "age", label: `Age ${c.minAgeMin}m - ${c.maxAgeHours}h`, pass: ok && m!.age_min !== null && m!.age_min >= c.minAgeMin && m!.age_min <= c.maxAgeHours * 60, value: m && m.age_min !== null ? `${m.age_min}m` : "null" },
    { n: 13, id: "nobody_can_sell", label: "Sells exist", pass: ok && !(m!.buys_1h >= 20 && m!.sells_1h === 0), value: m ? `${m.buys_1h} buys / ${m.sells_1h} sells (1h)` : "n/a" },
  ];
}
export function marketKill(m: Pool, c: Settings): string | null {
  if (!m) return "no_pool";
  if (m.price <= 0) return "no_price";
  if (m.liq_usd < c.minLiquidityUsd) return "thin_pool";
  if (c.ticketUsd / m.liq_usd > c.maxTicketShare) return "ticket_too_big";
  if (m.age_min === null || m.age_min < c.minAgeMin) return "too_fresh";
  if (m.age_min > c.maxAgeHours * 60) return "too_old";
  if (m.buys_1h >= 20 && m.sells_1h === 0) return "nobody_can_sell";
  return null;
}

export const JUDGE_PROMPT = `
You are RUG DESK. A Solana memecoin just passed every hard check in code:
authorities, LP, holders, dev wallet, insiders, pool depth, age.
Do not re-check those numbers. You decide if one flat ticket goes in.
You never size, you never pick exits.

INPUT: {"token": {...rugcheck facts...}, "pool": {...dexscreener facts...}}

STEP 1. Search X for the ticker and for the contract address, last 72 hours.
STEP 2. Judge only what code can't see:
  - do the warn-level risks stack into something worse together
  - who posted first: the dev, a real account with history, or a wave of fresh accounts
  - organic or bought: same wording, same minute, accounts with no past
  - is the contract address in those posts the same one as in INPUT
  - has this ticker name or this dev been tied to a rug before

RETURN ONLY JSON:
{"verdict": "BUY" | "SKIP", "confidence": 0.0-1.0,
 "why": "two lines max", "x_read": "one line on what X looks like",
 "main_risk": "one line"}

Zero posts on X is an answer: nobody knows it exists. SKIP.
Another contract address under the same ticker on X: copycat risk. SKIP.
NEVER answer BUY when a field you needed is null.
NEVER mention price targets. You don't know them.
`;

function outText(resp: J): string {
  if (typeof resp.output_text === "string") return resp.output_text;
  const parts: string[] = [];
  for (const item of resp.output || []) if (item.type === "message") for (const c of item.content || []) if (["output_text", "text"].includes(c.type)) parts.push(c.text || "");
  return parts.join("\n");
}
export async function judge(payload: unknown) {
  const key = process.env.XAI_API_KEY; if (!key) throw new Error("no XAI_API_KEY");
  const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const body = { model: process.env.XAI_MODEL || "grok-4.7",
    input: [{ role: "system", content: JUDGE_PROMPT }, { role: "user", content: JSON.stringify(payload) }],
    tools: [{ type: "x_search", from_date: since }], max_turns: 2 };
  const r = await fetch("https://api.x.ai/v1/responses", { method: "POST", signal: AbortSignal.timeout(55000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`xAI HTTP ${r.status}`);
  const text = outText(await r.json()); const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1) throw new Error("no json in answer");
  return JSON.parse(text.slice(s, e + 1));
}

export const PLAIN: Record<string, string> = {
  no_report: "Rugcheck has no report yet", already_rugged: "already rugged", mint_open: "dev can still mint new supply",
  freeze_open: "dev can freeze your tokens", risk_score: "Rugcheck risk score too high", lp_unlocked: "liquidity not locked",
  top10_heavy: "top 10 wallets hold too much", dev_holds: "dev wallet still holds too much", insiders: "insider wallets detected",
  no_pool: "no DEX pool", no_price: "no price", thin_pool: "pool too thin", ticket_too_big: "ticket would move the price",
  too_fresh: "too fresh, under 30 minutes", too_old: "too old, the move already happened", nobody_can_sell: "honeypot shape: nobody sells",
};

export async function runCheck(mint: string, cfg: Partial<Settings>, chain = "solana", chainId?: number) {
  const c = { ...DEFAULTS, ...cfg };
  if (chain !== "solana") return evmCheck(mint, c, chain, chainId);
  const [rf, pf] = await Promise.allSettled([report(mint), pool(mint)]);
  const facts = rf.status === "fulfilled" ? rf.value : null;
  const m = pf.status === "fulfilled" ? pf.value : null;
  const base = { mint, symbol: m?.symbol || facts?.symbol || null, name: m?.name || facts?.name || null,
    image: m?.image || facts?.image || null, facts, pool: m,
    checks: [...factChecks(facts, c), ...poolChecks(m, c), { n: 14, id: "grok", label: "X read (Grok)", pass: null as boolean | null, value: "not reached" }], passedCode: false, time: Date.now() };
  const g = (pass: boolean | null, value: string) => ({ n: 14, id: "grok", label: "X read (Grok)", pass, value });
  const code = base.checks.slice(0, 13);
  if (!facts) return { ...base, stage: "facts", verdict: "SKIP", reason: `source down: rugcheck failed (${(rf as PromiseRejectedResult).reason?.message})` };
  const fk = factKill(facts, c);
  if (fk) return { ...base, stage: "facts", verdict: "SKIP", reason: fk, plain: PLAIN[fk.split(":")[0]] || fk };
  if (pf.status === "rejected") return { ...base, stage: "pool", verdict: "SKIP", reason: `source down: dexscreener failed (${pf.reason?.message})` };
  const mk = marketKill(m, c);
  if (mk) return { ...base, stage: "pool", verdict: "SKIP", reason: mk, plain: PLAIN[mk] };
  if (!process.env.XAI_API_KEY) return { ...base, checks: [...code, g(null, "no key configured")], passedCode: true, stage: "grok", verdict: "NEEDS_KEY", reason: "passed code filter - NEEDS GROK KEY" };
  try {
    const ans = await judge({ token: facts, pool: m });
    let verdict = ans.verdict; const conf = Number(ans.confidence) || 0; let why = ans.why;
    if (verdict === "BUY" && conf < c.minConfidence) { verdict = "SKIP"; why = `low confidence ${conf}`; }
    if (verdict !== "BUY") verdict = "SKIP";
    return { ...base, checks: [...code, g(verdict === "BUY", ans.x_read || "")], passedCode: true, stage: "grok", verdict, confidence: conf, reason: why, x_read: ans.x_read, main_risk: ans.main_risk };
  } catch (e) {
    return { ...base, checks: [...code, g(false, "error")], passedCode: true, stage: "grok", verdict: "SKIP", reason: `grok failed: ${(e as Error).message}` };
  }
}

// ---------- EVM: GoPlus token security + DexScreener pool, same 14-row layout ----------
export async function goplus(chainId: number, addr: string) {
  const j: J = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${addr}`, 15000);
  const t = (j.result || {})[addr.toLowerCase()]; if (!t) throw new Error("no GoPlus data");
  const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  const holders = (t.holders || []).filter((h: J) => !h.is_contract || h.is_locked);
  const lp = t.lp_holders || []; const lpLocked = lp.length ? lp.filter((h: J) => h.is_locked === 1 || h.is_locked === "1" || /dead|0x0000/.test(h.address)).reduce((s: number, h: J) => s + Number(h.percent || 0), 0) * 100 : null;
  return { honeypot: t.is_honeypot === "1", buy_tax: n(t.buy_tax), sell_tax: n(t.sell_tax), mintable: t.is_mintable === "1", owner_change: t.can_take_back_ownership === "1" || t.hidden_owner === "1" || t.owner_change_balance === "1",
    blacklist: t.is_blacklisted === "1" || t.transfer_pausable === "1" || t.cannot_sell_all === "1" || t.trading_cooldown === "1", lp_locked_pct: lpLocked,
    top10_pct: holders.length ? Math.round(holders.slice(0, 10).reduce((s: number, h: J) => s + Number(h.percent || 0), 0) * 10000) / 100 : null,
    dev_pct: n(t.creator_percent) !== null ? Math.round(Number(t.creator_percent) * 10000) / 100 : null, holders: n(t.holder_count), open_source: t.is_open_source === "1",
    symbol: t.token_symbol || null, name: t.token_name || null };
}
async function evmCheck(mint: string, c: Settings, chain: string, chainId?: number) {
  const [gf, pf] = await Promise.allSettled([chainId ? goplus(chainId, mint) : Promise.reject(new Error("no chain id")), pool(mint, chain)]);
  const t = gf.status === "fulfilled" ? gf.value : null; const m = pf.status === "fulfilled" ? pf.value : null;
  const pct = (v: number | null) => (v === null ? "null" : `${v}%`);
  const tax = (v: number | null) => (v === null ? "null" : `${Math.round(v * 1000) / 10}%`);
  const rows: Check[] = t ? [
    { n: 1, id: "honeypot", label: "Not a honeypot", pass: !t.honeypot, value: t.honeypot ? "honeypot" : "no" },
    { n: 2, id: "buy_tax", label: "Buy tax <= 10%", pass: t.buy_tax !== null && t.buy_tax <= 0.1, value: tax(t.buy_tax) },
    { n: 3, id: "sell_tax", label: "Sell tax <= 10%", pass: t.sell_tax !== null && t.sell_tax <= 0.1, value: tax(t.sell_tax) },
    { n: 4, id: "mint_open", label: "Owner cannot mint", pass: !t.mintable, value: t.mintable ? "mintable" : "no" },
    { n: 5, id: "owner_power", label: "No hidden owner / takeback", pass: !t.owner_change, value: t.owner_change ? "owner powers" : "none" },
    { n: 6, id: "lp_unlocked", label: `LP locked >= ${c.minLpLockedPct}%`, pass: t.lp_locked_pct !== null && t.lp_locked_pct >= c.minLpLockedPct, value: t.lp_locked_pct === null ? "null" : `${Math.round(t.lp_locked_pct)}%` },
    { n: 7, id: "top10_heavy", label: `Top 10 <= ${c.maxTop10Pct}%`, pass: t.top10_pct !== null && t.top10_pct <= c.maxTop10Pct, value: pct(t.top10_pct) },
    { n: 8, id: "dev_holds", label: `Dev wallet <= ${c.maxDevPct}%`, pass: t.dev_pct !== null && t.dev_pct <= c.maxDevPct, value: pct(t.dev_pct) },
    { n: 9, id: "blacklist", label: "No blacklist / pause / sell limit", pass: !t.blacklist && t.open_source, value: t.blacklist ? "restricted" : t.open_source ? "none" : "closed source" },
  ] : factChecks(null, c);
  const base = { mint, chain, symbol: m?.symbol || t?.symbol || null, name: m?.name || t?.name || null, image: m?.image || null,
    facts: t ? { risk_score: null, top10_pct: t.top10_pct, holders: t.holders } : null, pool: m,
    checks: [...rows, ...poolChecks(m, c), { n: 14, id: "grok", label: "X read (Grok)", pass: null as boolean | null, value: "not reached" }], passedCode: false, time: Date.now() };
  if (!t) return { ...base, stage: "facts", verdict: "SKIP", reason: `source down: GoPlus failed (${(gf as PromiseRejectedResult).reason?.message})` };
  const bad = rows.find((r) => !r.pass);
  if (bad) return { ...base, stage: "facts", verdict: "SKIP", reason: bad.id, plain: `${bad.label}: ${bad.value}` };
  if (!m) return { ...base, stage: "pool", verdict: "SKIP", reason: "no_pool", plain: "no DEX pool" };
  const mk = marketKill(m, c); if (mk) return { ...base, stage: "pool", verdict: "SKIP", reason: mk, plain: PLAIN[mk] };
  const code = base.checks.slice(0, 13); const g = (pass: boolean | null, value: string) => ({ n: 14, id: "grok", label: "X read (Grok)", pass, value });
  if (!process.env.XAI_API_KEY) return { ...base, checks: [...code, g(null, "no key configured")], passedCode: true, stage: "grok", verdict: "NEEDS_KEY", reason: "passed code filter - NEEDS GROK KEY" };
  try { const ans = await judge({ chain, token: t, pool: m }); const conf = Number(ans.confidence) || 0; const verdict = ans.verdict === "BUY" && conf >= c.minConfidence ? "BUY" : "SKIP";
    return { ...base, checks: [...code, g(verdict === "BUY", ans.x_read || "")], passedCode: true, stage: "grok", verdict, confidence: conf, reason: ans.why, x_read: ans.x_read };
  } catch (e) { return { ...base, checks: [...code, g(false, "error")], passedCode: true, stage: "grok", verdict: "SKIP", reason: `grok failed: ${(e as Error).message}` }; }
}
