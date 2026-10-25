import type { Sample, PoolLite } from "./bots";
import type { Pos } from "./book";
// Discretionary exit engine. No fixed take-profit or stop-loss levels: each bot scores live signals and
// sells when the evidence says the move is over. Only a hidden catastrophic floor (rug / liquidity pull) is fixed.
export type Style = { holdMin: number; ddTol: number; patience: number; greed: number };
export const STYLES: Record<string, Style> = {
  momentum: { holdMin: 60, ddTol: 0.18, patience: 0.8, greed: 1.0 },
  dip: { holdMin: 45, ddTol: 0.12, patience: 0.7, greed: 0.6 },
  flow: { holdMin: 30, ddTol: 0.22, patience: 0.6, greed: 1.3 },
  trend: { holdMin: 240, ddTol: 0.25, patience: 1.3, greed: 1.5 },
  safe: { holdMin: 120, ddTol: 0.10, patience: 1.0, greed: 0.7 },
};
export type Extra = { top10Drop?: number | null; devDrop?: number | null; grok?: "bullish" | "bearish" | null };
export type Decision = { frac: number; reason: string; score: number; signals: string[]; emergency?: boolean };
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const pctTxt = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(0)}%`;

export function decideExit(p: Pos, pl: PoolLite | null | undefined, h: Sample[], botId: string, x: Extra = {}): Decision | null {
  if (!pl) return null; // feed down: hold and retry next loop
  const st = STYLES[botId] || STYLES.safe;
  const gain = p.entry > 0 ? (pl.price / p.entry - 1) * 100 : 0;
  // hidden catastrophic floor: rug pull / liquidity removal / dead pool
  if (!pl.price || pl.liq_usd <= 0) return { frac: 1, score: 99, emergency: true, signals: ["pool gone"], reason: "Emergency exit: pool removed or price feed returned zero" };
  if (p.liq0 > 0 && pl.liq_usd < p.liq0 * 0.5) return { frac: 1, score: 99, emergency: true, signals: ["liquidity pulled"], reason: `Emergency exit: liquidity pulled ${Math.round((1 - pl.liq_usd / p.liq0) * 100)}% since entry, ${pctTxt(gain)}` };
  if (gain <= -70) return { frac: 1, score: 99, emergency: true, signals: ["collapse"], reason: `Emergency exit: price collapse ${pctTxt(gain)}` };
  const since = h.filter((s) => s.t >= p.opened - 60000);
  if (since.length < 4) return null; // need ~2 minutes of live samples before judging
  const px = since.map((s) => s.price); const peak = Math.max(p.peak, ...px); const dd = 1 - pl.price / peak;
  const mins = (Date.now() - p.opened) / 60000; const sig: [number, string][] = [];
  // momentum: short vs longer slope
  const f = avg(px.slice(-4)), sl = avg(px.slice(-12, -4).length ? px.slice(-12, -4) : px.slice(0, -4));
  if (sl > 0 && f < sl * 0.97) sig.push([1.2, "momentum rolling over"]); else if (sl > 0 && f > sl * 1.03) sig.push([-1, ""]);
  // volume decay
  const v = since.map((s) => s.volM5); const vNow = avg(v.slice(-3)), vPeak = Math.max(...v);
  if (vPeak > 0 && vNow < vPeak * 0.35) sig.push([1, "volume fading"]);
  // buy/sell pressure
  const b5 = pl.tx.m5?.buys || 0, s5 = pl.tx.m5?.sells || 0; const sp = b5 + s5 >= 6 ? s5 / (b5 + s5) : 0.5;
  if (sp > 0.62) sig.push([1.2, "sell pressure rising"]); else if (sp < 0.4) sig.push([-0.6, ""]);
  // liquidity draining (non-catastrophic)
  if (p.liq0 > 0 && pl.liq_usd < p.liq0 * 0.8) sig.push([1, "liquidity draining"]);
  // price structure: lower highs
  const third = Math.max(2, Math.floor(px.length / 3)); const h1 = Math.max(...px.slice(0, third)), h2 = Math.max(...px.slice(third, 2 * third)), h3 = Math.max(...px.slice(2 * third));
  if (px.length >= 9 && h3 < h2 && h2 < h1) sig.push([0.8, "lower highs forming"]);
  // trailing drawdown from peak, tolerance scales with style and with how far the trade ran
  const tol = st.ddTol * (gain > 50 ? 0.7 : 1);
  if (dd > tol) sig.push([1.5, `down ${Math.round(dd * 100)}% from peak`]);
  // holder and dev wallet movement (from periodic re-checks)
  if ((x.top10Drop || 0) > 3) sig.push([1.3, "top wallets selling"]);
  if ((x.devDrop || 0) > 1) sig.push([1.5, "dev wallet selling"]);
  if (x.grok === "bearish") sig.push([1, "X sentiment turning bearish"]); else if (x.grok === "bullish") sig.push([-0.8, ""]);
  // time in trade without progress
  if (mins > st.holdMin * st.patience && gain < 5) sig.push([1, "no progress for the hold window"]);
  if (mins > st.holdMin * 3) sig.push([1, "held well past the bot's horizon"]);
  // profit awareness: a big unrealized gain lowers the bar to take money off
  const greedBar = 3 + Math.min(1.5, Math.max(0, gain) / (60 * st.greed)) * -1;
  const score = sig.reduce((s, [w]) => s + w, 0); const words = sig.filter(([w, t]) => w > 0 && t).map(([, t]) => t);
  if (score < Math.max(1.6, greedBar) || !words.length) return null;
  const w3 = words.slice(0, 3); const why = w3.length > 1 ? `${w3.slice(0, -1).join(", ")} and ${w3[w3.length - 1]}` : w3[0];
  const frac = gain > 25 && score < greedBar + 1.2 && p.steps === 0 ? 0.5 : 1;
  const tail = gain >= 0 ? `locked ${pctTxt(gain)}` : `cut at ${pctTxt(gain)}`;
  return { frac, score, signals: words, reason: `${frac < 1 ? "Sold half" : "Sold"}: ${why}, ${tail}` };
}
