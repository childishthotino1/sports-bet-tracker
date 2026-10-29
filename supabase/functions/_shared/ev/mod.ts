// +EV core: devig, EV, Kelly, and the bet-card formatter. Pure functions with no
// platform or DB code, so the Telegram bot and a later Discord bot share it.
// promo-vision.ts (the Claude call) is Deno-only and imported directly, not from here.
// Tests: node --test supabase/functions/_shared/ev/*.test.ts  (or: deno test)

export * from "./odds.ts";
export * from "./devig.ts";
export * from "./bet.ts";
export * from "./format.ts";
export * from "./promo.ts";
