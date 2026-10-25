import { get, put } from "@vercel/blob";
// Shared state in a private Vercel Blob store. Used by API routes and by the worker.
export type ArmedUser = { userId: string; address: string; bot: string; armed: boolean; armedAt: number; disarmedAt?: number; walletId?: string; evmAddress?: string; evmWalletId?: string; chains?: string[]; mode?: "practice" | "pending" | "live"; budgetUsd?: number; perTradeUsd?: number; confirmedAt?: number; practiceEndedAt?: number };
export type Users = Record<string, ArmedUser>;
export type Control = { killAll: boolean; updated: number };
export type Heartbeat = { t: number; loops: number; scanned: number; armed: number; dryRun: boolean; host: string; lastError?: string | null; source?: string };
export type FeedItem = { t: number; mint: string; symbol: string | null; image: string | null; verdict: string; reason: string; passed: number; liq?: number | null; chain?: string };
export type Networks = Record<string, import("./chains").Chain & { addedBy: string; addedAt: number }>;

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const r = await get(path, { access: "private", useCache: false });
    if (!r || !r.stream) return fallback;
    return JSON.parse(await new Response(r.stream).text()) as T;
  } catch { return fallback; }
}
export async function writeJson(path: string, data: unknown) {
  await put(path, JSON.stringify(data), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 });
}
export const P = { users: "users/index.json", control: "control.json", hb: "heartbeat.json", feed: "feed.json", networks: "networks.json", state: (u: string) => `state/${encodeURIComponent(u)}.json`, gift: (u: string) => `gift/${encodeURIComponent(u)}.json` };

export type Gift = { lastClaimAt: number; totalUsd: number; claims: number };
export const GIFT_USD = 10000; export const GIFT_MS = 24 * 3600 * 1000;
