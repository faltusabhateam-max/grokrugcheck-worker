export type Settings = {
  ticketUsd: number; maxOpen: number; maxEntriesPerDay: number; dailyLossHaltUsd: number; cooldownHours: number;
  maxRiskScore: number; minLpLockedPct: number; maxTop10Pct: number; maxDevPct: number; maxInsiders: number;
  minLiquidityUsd: number; maxTicketShare: number; minAgeMin: number; maxAgeHours: number;
  minConfidence: number; stopPct: number; tp1Pct: number; tp1Frac: number; tp2Pct: number; tp2Frac: number;
  trailPct: number; timeStopHours: number; timeStopMinPct: number; liqDropPct: number;
  scanSeconds: number; maxPerScan: number; slippageBps: number; priorityMaxLamports: number;
};
export const DEFAULTS: Settings = {
  ticketUsd: 25, maxOpen: 4, maxEntriesPerDay: 6, dailyLossHaltUsd: 50, cooldownHours: 24,
  maxRiskScore: 40, minLpLockedPct: 90, maxTop10Pct: 30, maxDevPct: 5, maxInsiders: 0,
  minLiquidityUsd: 30000, maxTicketShare: 0.01, minAgeMin: 30, maxAgeHours: 72,
  minConfidence: 0.7, stopPct: -35, tp1Pct: 100, tp1Frac: 0.5, tp2Pct: 200, tp2Frac: 0.25,
  trailPct: 30, timeStopHours: 6, timeStopMinPct: 20, liqDropPct: 40,
  scanSeconds: 60, maxPerScan: 5, slippageBps: 300, priorityMaxLamports: 1000000,
};
export const SOL_MINT = "So11111111111111111111111111111111111111112";
