import { createRemoteJWKSet, jwtVerify } from "jose";
const APP = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
const JWKS = APP ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${APP}/jwks.json`)) : null;
// Verifies the Privy access token sent by the browser; returns the Privy user id (did:privy:...).
export async function userFrom(req: Request): Promise<string | null> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok || !JWKS) return null;
  try { const { payload } = await jwtVerify(tok, JWKS, { issuer: "privy.io", audience: APP }); return String(payload.sub); } catch { return null; }
}
// Server-side lookup of the user's linked accounts (uses PRIVY_APP_SECRET, never sent to the client).
export async function privyUser(userId: string) {
  const r = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(userId)}`, { cache: "no-store",
    headers: { authorization: "Basic " + Buffer.from(`${APP}:${process.env.PRIVY_APP_SECRET}`).toString("base64"), "privy-app-id": APP } });
  if (!r.ok) throw new Error(`privy user lookup ${r.status}`);
  return r.json() as Promise<{ linked_accounts: { type: string; chain_type?: string; address?: string; wallet_client_type?: string; id?: string; delegated?: boolean }[] }>;
}
