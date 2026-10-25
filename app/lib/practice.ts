import { START } from "./book";
import { Gift } from "./store";
type S = { cash?: number; practiceInit?: number; giftApplied?: number; positions?: Record<string, { mode?: string; qty: number; lastPrice: number }> } | null;
// Practice cash as the user should see it now: $1,000 until the worker initializes the book, plus any gift not yet applied by the worker.
export function practiceView(state: S, gift: Gift | null) {
  const init = !!state?.practiceInit;
  const cash = (init ? state!.cash ?? 0 : START) + Math.max(0, (gift?.totalUsd || 0) - (init ? state!.giftApplied || 0 : 0));
  const held = init ? Object.values(state?.positions || {}).filter((p) => p.mode === "paper").reduce((s, p) => s + p.qty * p.lastPrice, 0) : 0;
  return { cash, equity: cash + held, start: START + (gift?.totalUsd || 0) };
}
