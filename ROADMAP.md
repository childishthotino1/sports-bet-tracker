# Roadmap: from Baltimore Bets to a betting copilot

**The goal.** A Telegram bot plus a Telegram Mini App that works as an AI betting copilot: ask questions in plain language, get +EV bets found by comparing retail books to sharp prices, open the bet slip in the right book with one tap, get pinged when bets settle or a parlay is one leg away, and see your long-run results, including closing line value (CLV).

This file maps that goal onto what's already built, says which parts the outside world won't allow, and orders the work. Last reviewed 2026-11-07.

---

## 1. Where we are

Most of the hard math and the AI parts already exist. They're split across two bots, and the tracker app can't see the promo bot's data.

| Goal | Built today | Where |
|---|---|---|
| Answer game and market questions in plain language | Typed question → finds the game → one odds call across 4 books + 5 sharp sources → each leg at its best book vs the fair price | `promo-bot` `answerQuestion`, `shopLegs` |
| "Find NFL props over +150" | Target odds (`parseTarget`) and the main-lines/props setting, but only inside a promo | `promo-flow.ts`, `/settings` |
| Promo help ("best way to use DK's 50% boost") | Promo screenshot → rules → best qualifying bets ranked by boosted EV; SGP leg suggestions | `promo.ts`, `picks.ts` |
| Top-down +EV vs sharp consensus | Pinnacle + Novig, ProphetX, Kalshi, Polymarket, devigged and combined; EV and quarter-Kelly stakes | `sharp.ts`, `devig.ts`, `ev.ts` |
| Line shopping | `shopLegs`, `betterPrices` | `picks.ts` |
| Deep links to the slip | Planned in detail: The Odds API returns slip links for BetMGM, DK, FanDuel, theScore at no extra cost | `HANDOFF-bet-slip-links.md` |
| Settlement alerts | Daily auto-grader (13:00 UTC) with Claude + web search; Telegram FYI or buttons | `grade-bets` |
| Portfolio tracking | Full ledger, P&L, per-book balances, snapshots chart. Entry by screenshot to the tracker bot | app + `telegram-bot` |
| Structured legs (needed for live tracking and CLV) | `bets.legs` jsonb on parlays; straights have none | `add_legs_and_grading_support.sql` |
| Line movement, sweat alerts, hedging, CLV, Mini App, voice | Not started | n/a |

---

## 2. What the outside world won't allow (design around these)

1. **Sportsbook account sync isn't available to us.** No US book has a public bet-history API. Pikkit and similar apps sync by logging in as you (credential or session scraping) under their own deals with the books; a two-person project can't do that safely or within the books' terms. **Instead:** keep screenshot intake as the main path and make it faster (one photo, no questions when the split is obvious); add **email receipts**: BetMGM, DraftKings and FanDuel email bet confirmations, which a forwarding address or a Gmail filter can feed to the same parser. Optionally a Pikkit CSV import if Pikkit's export covers it.
2. **Cash-out values aren't on any feed.** The books show them only inside their own apps. **Instead:** compute hedges from live odds (we have those) and show a "fair cash-out" (what the position is worth at fair odds) so the user can judge the book's offer.
3. **Bets can't be placed for the user.** Deep links put the leg in the slip; the user taps Place Bet. Stakes usually can't be pre-filled (check per book in the handoff's phone tests).
4. **Circa isn't on The Odds API.** Pinnacle + the four exchanges are the sharp side. Bet365 isn't on the feed either; Caesars and Fanatics need a paid plan.
5. **Line movement history costs extra.** The Odds API's historical endpoint is paid and expensive. **Instead:** record our own snapshots of the lines we care about (a `line_snapshots` table filled by `pg_cron`). That same table gives closing lines for CLV.
6. **Live player stats need a stats feed.** The Odds API `/scores` endpoint has game scores, not player stats. Prop milestones ("crossed 250 passing yards") need a live box-score source (ESPN's public JSON, or a paid feed such as SportsDataIO / Sportradar).
7. **Credits.** The free Odds API plan (500 credits/month) is enough for on-demand questions. A scanner that sweeps every sport's lines and props every few minutes needs a paid plan; budget it before building section 3.D.
8. **Voice.** Claude doesn't take audio directly. Voice notes need a speech-to-text step before the same text handler.

---

## 3. The plan, in order

Each phase ships something usable on its own. The order follows dependencies: the data model has to come before live tracking and CLV.

### A. Finish what's planned (small)
- Ship the deep-link handoff (phase 1: single-leg buttons; phase 2: one link per parlay, where a phone test proves it).
- Open questions without a promo: "NFL props over +150 at BetMGM" → `bestBets` with a target and no boost. Mostly wiring `parseTarget` and `answerQuestion` together.

### B. One bot, one bet record (the foundation)
- **Merge the bots' brains, not their webhooks.** Keep the tracker bot's rule that only slips sent to it become bets, but let it answer questions and promos through `_shared/ev`, or let the promo bot hand a slip to the tracker with a "Log this bet" button. One conversation is the goal; the `pending_bets` safety (no stray photo becomes a bet) must survive.
- **Every bet gets structured legs, straights included.** Add per leg: Odds API `event_id`, `sport_key`, `market` key, `selection`, `point`, `price_at_bet`, and the commence time. The vision prompt already reads these; matching to `/events` is how the promo bot's slip check already works. This one change is what live tracking, auto-grading of parlays, and CLV all depend on.
- **Log the bets the copilot recommends** (`recommendations` table: pick, fair price, EV at the time, link tapped or not). Without this there's no way to tell later whether the +EV picks actually beat the close.

### C. Telegram Mini App (the dashboard)
- Host the existing PWA as the Mini App: same `index.html`, opened from a bot menu button.
- Replace PIN login inside Telegram with Telegram's signed `initData`, checked by a small edge function using the bot token (the PIN stays for the browser).
- New views: open bets with live status, a "bet builder" that collects picks and shows the best book per leg with 🛒 buttons, and the CLV chart (phase E).

### D. Live notifications
- **Settlement within minutes, not daily.** A `pg_cron` job every few minutes in game windows: pull `/scores` for sports with open bets (2 credits a call), mark finished games, then settle straights automatically (moneyline, spread, total settle from the final score with no Claude call) and keep Claude + web search for props and anything ambiguous. Message: result + updated P&L for Brent and Dan.
- **Sweat alert.** For each open parlay, track each leg as it settles. When all legs but one have won, send "1 leg from $X" with the remaining leg's game and time.
- **Hedge calculator.** On the sweat alert, price the other side of the last leg across our books (live odds), and show the hedge stake that locks in the most profit, the guaranteed profit, and the fair value of the position. A 🛒 button opens that book's slip. Pure math, goes in `_shared/ev/hedge.ts` with tests.
- **Prop milestones** come last and only with a live stats source (section 2.6).

### E. Line history and CLV
- `line_snapshots`: for every event with an open bet or a recommendation, record that market's prices at the book and the sharp consensus on a schedule, with a last snapshot right before the start.
- **CLV per bet** = the price you got vs the closing fair price (devigged sharp close). Show it per bet, per book, per market and over time, for real bets and for the bot's recommendations separately.
- "How has the Celtics line moved since this morning?" reads the same table and answers with a small chart (image sent in Telegram, interactive in the Mini App).

### F. Scanner and alerts (needs a paid odds plan)
- A scheduled sweep for +EV lines across the chosen books and sports, using the existing `priceLegs` / `consensus`. Alerts above a minimum EV and liquidity, deduplicated, with quiet hours and a daily cap.
- Daily promo digest: the user forwards or screenshots the day's promos; the bot ranks how to use each one. (No feed publishes promos, so scraping them isn't planned.)

### G. Voice and polish
- Voice notes → speech-to-text → the same text handler.
- Per-user settings: books you have, state, bankroll, Kelly fraction, alert thresholds.

---

## 4. Decisions to make before phase B

1. **Who is it for?** Today the data model is two people sharing one bankroll (Brent + Dan, V2 ledger). A product for other users needs a `users` table, per-user books and bankrolls, and RLS on every table. That's a fork in the design; deciding late means migrating twice.
2. **Which bot is the front door?** Recommended: the promo bot becomes the copilot, and the tracker bot stays the narrow, safe "log a shared bet" path until B is done.
3. **Odds budget.** Which plan, and how much of it goes to scanning vs on-demand questions.
4. **Stats source** for live props (free ESPN JSON, unofficial and can change, or a paid feed).
