import { Settings } from "./config";
// Client-side port of book.py + watch.py. Paper fills at the live DexScreener price.
export type Mode = "paper" | "live";
export type Pos = { chain?: string; mint: string; symbol: string; image: string | null; entry: number; qty0: number; qty: number; peak: number;
  liq0: number; opened: number; steps: number; mode: Mode; costUsd: number; lastPrice: number; rawQty0?: string; decimals?: number; bot?: string; why?: string; snap?: { top10: number | null; dev: number | null } };
export type Trade = { time: number; mint: string; symbol: string; image: string | null; action: "open" | "partial" | "close";
  usd: number; pnl: number; reason: string; mode: Mode; sig?: string; heldMin?: number; bot?: string };
export type Book = { cash: number; positions: Record<string, Pos>; trades: Trade[]; equity: { t: number; v: number }[] };
export const START = 1000;
export const newBook = (): Book => ({ cash: START, positions: {}, trades: [], equity: [{ t: Date.now(), v: START }] });
const day = (t: number) => new Date(t).toDateString();

export const todayPnl = (b: Book, mode: Mode = "paper") => b.trades.filter((t) => t.mode === mode && day(t.time) === day(Date.now())).reduce((s, t) => s + t.pnl, 0);

export function guard(b: Book, mint: string, s: Settings, mode: Mode = "paper"): string | null {
  const now = Date.now(); const mine = Object.values(b.positions).filter((p) => p.mode === mode);
  if (todayPnl(b, mode) <= -s.dailyLossHaltUsd) return "halted_daily_loss";
  if (b.positions[mint]) return "already_open";
  if (mine.length >= s.maxOpen) return "max_open";
  if (b.trades.filter((t) => t.mode === mode && t.action === "open" && day(t.time) === day(now)).length >= s.maxEntriesPerDay) return "max_entries_today";
  if (b.trades.some((t) => t.mint === mint && t.action === "close" && t.time >= now - s.cooldownHours * 3600000)) return "cooldown";
  if (mode === "paper" && b.cash < s.ticketUsd) return "no_paper_cash";
  return null;
}

export function openPos(b: Book, p: Omit<Pos, "qty0" | "qty" | "peak" | "opened" | "steps" | "lastPrice">, usd: number, sig?: string): Book {
  const pos: Pos = { ...p, qty0: usd / p.entry, qty: usd / p.entry, peak: p.entry, opened: Date.now(), steps: 0, lastPrice: p.entry, costUsd: usd };
  return { ...b, cash: p.mode === "paper" ? b.cash - usd : b.cash, positions: { ...b.positions, [p.mint]: pos },
    trades: [...b.trades, { time: Date.now(), mint: p.mint, symbol: p.symbol, image: p.image, action: "open", usd, pnl: 0, reason: p.why || "entry", mode: p.mode, sig, bot: p.bot }] };
}

export function sell(b: Book, mint: string, frac: number, price: number, reason: string, sig?: string): { book: Book; pnl: number } {
  const p = { ...b.positions[mint] }; if (!p.mint) return { book: b, pnl: 0 };
  const q = Math.min(p.qty, p.qty0 * frac); const pnl = q * (price - p.entry); p.qty -= q;
  const action = p.qty <= p.qty0 * 1e-6 ? "close" : "partial";
  const positions = { ...b.positions }; if (action === "close") delete positions[mint]; else positions[mint] = p;
  const t: Trade = { time: Date.now(), mint, symbol: p.symbol, image: p.image, action, usd: q * price, pnl, reason, mode: p.mode, sig, bot: p.bot, heldMin: Math.round((Date.now() - p.opened) / 60000) };
  return { book: { ...b, cash: p.mode === "paper" ? b.cash + q * price : b.cash, positions, trades: [...b.trades, t] }, pnl };
}

export type Exit = { mint: string; frac: number; reason: string; price: number; ladderStep?: boolean };
type Mkt = { price: number; liq_usd: number } | null | { error: string };
// watch.py: returns at most one exit per position, in the article's priority order.
export function watch(b: Book, prices: Record<string, Mkt>, sFor: (p: Pos) => Settings): { book: Book; exits: Exit[] } {
  const positions = { ...b.positions }; const exits: Exit[] = [];
  for (const [mint, p0] of Object.entries(b.positions)) {
    if (!(mint in prices)) continue; const s = sFor(p0); const m = prices[mint];
    if (m && "error" in m) continue; // feed down: hold, retry
    if (!m || m.price <= 0) { exits.push({ mint, frac: 1, reason: "pool_gone", price: 0 }); continue; }
    const p = { ...p0, peak: Math.max(p0.peak, m.price), lastPrice: m.price }; positions[mint] = p;
    const pct = (m.price / p.entry - 1) * 100; const hours = (Date.now() - p.opened) / 3600000;
    const ladder: [number, number][] = [[s.tp1Pct, s.tp1Frac], [s.tp2Pct, s.tp2Frac]];
    if (m.liq_usd < p.liq0 * (1 - s.liqDropPct / 100)) exits.push({ mint, frac: 1, reason: "liquidity_pulled", price: m.price });
    else if (pct <= s.stopPct) exits.push({ mint, frac: 1, reason: "stop", price: m.price });
    else if (p.steps < ladder.length && pct >= ladder[p.steps][0]) exits.push({ mint, frac: ladder[p.steps][1], reason: `take_profit_${ladder[p.steps][0]}`, price: m.price, ladderStep: true });
    else if (p.steps > 0 && m.price <= p.peak * (1 - s.trailPct / 100)) exits.push({ mint, frac: 1, reason: "trailing_stop", price: m.price });
    else if (hours >= s.timeStopHours && pct < s.timeStopMinPct) exits.push({ mint, frac: 1, reason: "time_stop", price: m.price });
  }
  return { book: { ...b, positions }, exits };
}
export function applyExit(b: Book, e: Exit, sig?: string) {
  const r = sell(b, e.mint, e.frac, e.price, e.reason, sig);
  if (e.ladderStep && r.book.positions[e.mint]) r.book.positions[e.mint] = { ...r.book.positions[e.mint], steps: r.book.positions[e.mint].steps + 1 };
  return r;
}
export const equityOf = (b: Book) => b.cash + Object.values(b.positions).filter((p) => p.mode === "paper").reduce((s, p) => s + p.qty * p.lastPrice, 0);
