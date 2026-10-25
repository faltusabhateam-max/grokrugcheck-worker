import { DEFAULTS, Settings } from "./config";
// Five preset strategy bots. Each runs on top of the 14-check rug filter (a fixed safety floor).
export type Sample = { t: number; price: number; liq: number; volM5: number; buysM5: number; sellsM5: number; buysH1: number; sellsH1: number };
export type PoolLite = { price: number; liq_usd: number; age_min: number | null; chg: Record<string, number | null>; vol: Record<string, number | null>;
  tx: Record<string, { buys: number; sells: number } | null>; buys_1h: number; sells_1h: number };
export type Signal = { go: boolean; why: string };
export type Bot = { id: string; name: string; desc: string; risk: "Low" | "Medium" | "High"; hold: string; rules: string[];
  sizePct: number; minUsd: number; maxUsd: number; exits: Partial<Settings>; maxOpen: number; dailyLossPct: number;
  extra: (p: PoolLite, riskScore: number | null) => string | null; signal: (p: PoolLite, h: Sample[], grok?: string) => Signal; color: string };

export const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let e = xs[0]; for (const x of xs.slice(1)) e = x * k + e * (1 - k); return e; };
export function rsi(xs: number[], n = 14) {
  if (xs.length < n + 1) return null; let g = 0, l = 0;
  for (let i = xs.length - n; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100; const rs = g / n / (l / n); return 100 - 100 / (1 + rs);
}
export function vwap(h: Sample[]) { const w = h.reduce((s, x) => s + x.volM5, 0); return w > 0 ? h.reduce((s, x) => s + x.price * x.volM5, 0) / w : null; }
const n = (v: number | null | undefined) => (typeof v === "number" ? v : null);
const warm = (h: Sample[], need: number): Signal | null => (h.length < need ? { go: false, why: `warming up ${h.length}/${need} samples` } : null);

export const BOTS: Bot[] = [
  { id: "momentum", name: "Momentum Breakout", color: "#FFD1DC", risk: "High", hold: "15 min - 2 h",
    desc: "Buys when price breaks above its recent high on a volume surge, then rides it with a tight trailing stop.",
    rules: ["Price above highest sampled price of last ~10 min", "5m volume > 3x the 1h average 5m volume", "5m buys > 5m sells", "Exit: discretionary scoring (momentum, volume, sell pressure, liquidity, holders, drawdown from peak, time in trade)"],
    sizePct: 0.06, minUsd: 5, maxUsd: 50, maxOpen: 3, dailyLossPct: 0.15,
    exits: { stopPct: -15, tp1Pct: 50, tp1Frac: 0.5, tp2Pct: 120, tp2Frac: 0.25, trailPct: 15, timeStopHours: 2, timeStopMinPct: 10, liqDropPct: 30 },
    extra: () => null,
    signal: (p, h) => { const w = warm(h, 6); if (w) return w;
      const prevHigh = Math.max(...h.slice(-21, -1).map((x) => x.price)); const v5 = n(p.vol.m5) ?? 0, v1 = n(p.vol.h1) ?? 0; const avg = v1 / 12;
      const t5 = p.tx.m5 || { buys: 0, sells: 0 };
      if (p.price <= prevHigh) return { go: false, why: "no breakout above recent high" };
      if (!(avg > 0 && v5 > 3 * avg)) return { go: false, why: `volume surge ${(avg ? v5 / avg : 0).toFixed(1)}x < 3x` };
      if (t5.buys <= t5.sells) return { go: false, why: "sellers in control on 5m" };
      return { go: true, why: `breakout + ${(v5 / avg).toFixed(1)}x volume surge` }; } },
  { id: "dip", name: "Mean Reversion Dip Buyer", color: "#FFF5BA", risk: "Medium", hold: "10 min - 1 h",
    desc: "Buys sharp 20-40% pullbacks on healthy pools once oversold and buyers return, takes profit quickly.",
    rules: ["Drawdown 20-40% from sampled / 6h high", "RSI(14) on samples < 30, or 5m turning green", "1h buys >= sells (flow recovering)", "Exit: discretionary scoring (momentum, volume, sell pressure, liquidity, holders, drawdown from peak, time in trade)"],
    sizePct: 0.05, minUsd: 5, maxUsd: 40, maxOpen: 3, dailyLossPct: 0.12,
    exits: { stopPct: -20, tp1Pct: 25, tp1Frac: 0.6, tp2Pct: 50, tp2Frac: 0.25, trailPct: 12, timeStopHours: 1, timeStopMinPct: 5, liqDropPct: 30 },
    extra: (p) => (p.liq_usd < 50000 ? "dip_needs_liq_50k" : null),
    signal: (p, h) => { const w = warm(h, 15); if (w) return w;
      const h6 = n(p.chg.h6); const hi = Math.max(...h.map((x) => x.price)); const ddS = (p.price / hi - 1) * 100;
      const dd = Math.min(ddS, h6 ?? 0); const r = rsi(h.map((x) => x.price)); const m5 = n(p.chg.m5) ?? 0;
      if (!(dd <= -20 && dd >= -40)) return { go: false, why: `drawdown ${dd.toFixed(0)}% not in -20..-40%` };
      if (!((r !== null && r < 30) || m5 > 0)) return { go: false, why: `RSI ${r?.toFixed(0) ?? "--"} not oversold` };
      if (p.buys_1h < p.sells_1h) return { go: false, why: "flow not recovering" };
      return { go: true, why: `dip ${dd.toFixed(0)}%, RSI ${r?.toFixed(0) ?? "--"}, buyers back` }; } },
  { id: "trend", name: "VWAP Trend Follower", color: "#D1FFDA", risk: "Medium", hold: "1 - 6 h",
    desc: "EMA(5) crossing above EMA(15) on sampled prices, confirmed by price over VWAP. Rides trends with ladder exits.",
    rules: ["EMA5 crosses above EMA15", "Price above volume-weighted average price", "1h change positive", "Exit: discretionary scoring (momentum, volume, sell pressure, liquidity, holders, drawdown from peak, time in trade)"],
    sizePct: 0.07, minUsd: 5, maxUsd: 60, maxOpen: 4, dailyLossPct: 0.15,
    exits: { stopPct: -25, tp1Pct: 60, tp1Frac: 0.4, tp2Pct: 150, tp2Frac: 0.3, trailPct: 20, timeStopHours: 6, timeStopMinPct: 15, liqDropPct: 40 },
    extra: () => null,
    signal: (p, h) => { const w = warm(h, 16); if (w) return w;
      const xs = h.map((x) => x.price); const f = ema(xs, 5), s = ema(xs, 15), fp = ema(xs.slice(0, -1), 5), sp = ema(xs.slice(0, -1), 15); const vw = vwap(h);
      if (!(f > s && fp <= sp)) return { go: false, why: f > s ? "already above, waiting for fresh cross" : "EMA5 below EMA15" };
      if (vw === null || p.price < vw) return { go: false, why: "below VWAP" };
      if ((n(p.chg.h1) ?? 0) <= 0) return { go: false, why: "1h trend negative" };
      return { go: true, why: "EMA cross up, above VWAP" }; } },
  { id: "flow", name: "Smart Flow", color: "#E3DAFF", risk: "Medium", hold: "30 min - 3 h",
    desc: "Order-flow bot: strong buy/sell pressure with growing buyers and growing liquidity, boosted by Grok's X read when available. Scales out.",
    rules: ["1h buys/sells >= 1.5 and 5m buys/sells >= 1.3", "5m buy count rising across samples", "Liquidity up vs first sample", "Grok BUY counts as a boost when configured", "Exit: discretionary scoring (momentum, volume, sell pressure, liquidity, holders, drawdown from peak, time in trade)"],
    sizePct: 0.06, minUsd: 5, maxUsd: 50, maxOpen: 4, dailyLossPct: 0.15,
    exits: { stopPct: -25, tp1Pct: 40, tp1Frac: 0.33, tp2Pct: 100, tp2Frac: 0.33, trailPct: 20, timeStopHours: 3, timeStopMinPct: 10, liqDropPct: 35 },
    extra: () => null,
    signal: (p, h, grok) => { const w = warm(h, 5); if (w) return w;
      const r1 = p.buys_1h / Math.max(1, p.sells_1h); const t5 = p.tx.m5 || { buys: 0, sells: 0 }; const r5 = t5.buys / Math.max(1, t5.sells);
      const boost = grok === "BUY" ? 0.2 : 0; const growing = h[h.length - 1].buysM5 >= h[Math.max(0, h.length - 5)].buysM5; const liqUp = p.liq_usd >= h[0].liq;
      if (r1 < 1.5 - boost || r5 < 1.3 - boost) return { go: false, why: `flow ${r1.toFixed(2)} / ${r5.toFixed(2)} too weak` };
      if (!growing) return { go: false, why: "buyer count fading" };
      if (!liqUp) return { go: false, why: "liquidity shrinking" };
      return { go: true, why: `buy pressure ${r1.toFixed(1)}x 1h, ${r5.toFixed(1)}x 5m${boost ? ", Grok boost" : ""}` }; } },
  { id: "safe", name: "Conservative Safe-Haven", color: "#D6ECFF", risk: "Low", hold: "2 - 6 h",
    desc: "Strictest filters only: older tokens, deep pools, very low risk score. Small size, wide stop, patient time stop.",
    rules: ["Age 6h - 72h", "Liquidity > $100k", "Rugcheck risk score < 20", "24h and 1h change positive, 1h buys >= sells", "Exit: discretionary scoring (momentum, volume, sell pressure, liquidity, holders, drawdown from peak, time in trade)"],
    sizePct: 0.04, minUsd: 5, maxUsd: 30, maxOpen: 3, dailyLossPct: 0.1,
    exits: { stopPct: -30, tp1Pct: 50, tp1Frac: 0.5, tp2Pct: 100, tp2Frac: 0.25, trailPct: 25, timeStopHours: 6, timeStopMinPct: 10, liqDropPct: 40 },
    extra: (p, rs) => (p.age_min === null || p.age_min < 360 ? "safe_needs_age_6h" : p.liq_usd < 100000 ? "safe_needs_liq_100k" : rs === null || rs >= 20 ? "safe_needs_risk_lt_20" : null),
    signal: (p, h) => { const w = warm(h, 3); if (w) return w;
      if ((n(p.chg.h24) ?? -1) <= 0 || (n(p.chg.h1) ?? -1) <= 0) return { go: false, why: "trend not positive" };
      if (p.buys_1h < p.sells_1h) return { go: false, why: "more sellers than buyers" };
      return { go: true, why: "deep, older, low-risk pool trending up" }; } },
];
export const botById = (id: string) => BOTS.find((b) => b.id === id) || BOTS[4];
export const botSettings = (b: Bot): Settings => ({ ...DEFAULTS, ...b.exits, maxOpen: b.maxOpen });
// Size: % of balance, clamped to bot min/max. Live keeps a 0.02 SOL fee reserve.
export function sizeUsd(b: Bot, balanceUsd: number) { const s = Math.min(b.maxUsd, balanceUsd * b.sizePct); return s < b.minUsd ? 0 : Math.round(s * 100) / 100; }
