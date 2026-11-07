# Handoff: "Build in BetMGM" buttons (bet-slip deep links) for the promo bot

**Goal.** When @Bmorepromobot recommends a bet, the user taps a button and the sportsbook app or site opens with that bet already in the slip. The user only checks the stake and taps Place Bet. The bot never places bets.

**Scope.** Only `promo-bot` and `_shared/ev/`. Don't touch `telegram-bot`, `grade-bets` or the tracker app.

---

## 1. What's already known (live test, 2026-11-07)

A one-off edge function called The Odds API v4 with `includeLinks=true&includeSids=true` on the NFL (`h2h,spreads,totals`), an NFL per-game call (`player_anytime_td`, CIN @ ATL) and NBA `h2h`. Every outcome from the four free-plan books had a link:

| Book (feed key) | Coverage | Outcome link (`outcome.link`) | Event link (`bookmaker.link`) |
|---|---|---|---|
| BetMGM (`betmgm`) | 100%: main lines + anytime TD | `https://sports.{state}.betmgm.com/en/sports?options=6:44009-3451275-5411235&type=Single` (`event-market-option`) | `https://sports.{state}.betmgm.com/en/sports/events/cincinnati-bengals-@-atlanta-falcons-6%3A44009` |
| DraftKings (`draftkings`) | 100%, props too | `https://sportsbook.draftkings.com/?outcomes=0ML84695561_1` (prop sids contain `#`, already escaped as `%23`) | `https://sportsbook.draftkings.com/event/34118128` |
| FanDuel (`fanduel`) | 100%, props too | `https://sportsbook.fanduel.com/addToBetslip?marketId=42.578189645&selectionId=50199` | `https://sportsbook.fanduel.com/football/nfl/cincinnati-bengals-%40-atlanta-falcons-35603243` |
| theScore (`espnbet`) | 100% | `https://sportsbook.thescore.bet/?market_selection_id[0]=<uuid>&odds_numerator[0]=2&odds_denominator[0]=1` | game page; `market.link` = game page + `/section/lines` |
| Caesars, Fanatics | nothing: paid plan only | n/a | n/a |
| Bet365 | not on the feed | n/a | n/a |

Facts the build relies on:
- **No extra credits.** With links on, the calls cost the same as before (3 for 3 markets, 1 per single-market call).
- **BetMGM links contain a literal `{state}`.** The users are in Maryland, so replace it with `md`.
- **theScore's link carries a dummy price (2/1).** It should be replaced by the live price once the slip loads; that has to be confirmed on a phone (section 4).
- `market.link` is null for everyone except theScore. `outcome.sid` and `bookmaker.sid` also come back.
- BetMGM and theScore had lines up for only 14 of the 27 NFL games, so a leg can be missing a link. Always fall back to the event link.

**Not tested: multi-leg links.** The URL shapes suggest several legs can go in one link (theScore's `[0]` indexes, BetMGM's `type=Single`), but nobody has tried it. See phase 2.

**Cleanup.** The temporary edge function `odds-links-probe` is still deployed as an empty stub (returns 410). Delete it: `supabase functions delete odds-links-probe`.

---

## 2. Phase 1: single-leg links (ship this first)

### 2a. `_shared/ev/odds-api.ts`
- In `get()`, add `includeLinks: "true"` and `includeSids: "true"` to the params. This covers every call: `getOdds`, `getEventOdds`, and so the picks, SGP, question and slip paths.
- Extend the types (all optional):
  - `Outcome`: add `link?: string | null; sid?: string | null`
  - `Market`: add `link?: string | null`
  - `Bookmaker`: add `link?: string | null; sid?: string | null`

### 2b. New `_shared/ev/links.ts` (pure, no Deno APIs, `.ts` imports like the rest of `ev/`)
- `export const BOOK_STATE = "md";`. The promo bot may read an optional `PROMO_BOOK_STATE` env var and pass it in, but the module itself stays pure.
- `fillState(link: string, state = BOOK_STATE): string` replaces `{state}`.
- `legLink(leg)` returns the outcome link, or the event link, or null, with the state filled in.
- `slipButtons(bookName, legs, opts)` returns Telegram inline URL buttons (`{ text, url }[][]`):
  - one leg with an outcome link: one button, `🛒 Build in <Book>`.
  - several legs (phase 1): one button per leg, `🛒 1. <selection>`, max ~5; Telegram button text gets cut off around 40–60 characters. Then one `📍 Open game` button per distinct event when the legs have no outcome links.
  - no links at all: no buttons, so the card is sent exactly as today.
- Add a tests file `links.test.ts`: state fill, fallback order, multi-leg layout, and no buttons when there are no links. Fixtures are the real URLs in the table above.

### 2c. `_shared/ev/picks.ts`
- `PricedLeg`: add `link?: string; eventLink?: string`.
- In `priceLegs`, set `link: o.link ?? undefined` and `eventLink: book.link ?? undefined`, from the **book's** outcome, never a sharp source's.
- `shopLegs` already spreads `PricedLeg`, so `ShopLeg` carries the link of the book that has the best price. Check that the link stays with the book it came from when `best` switches books.
- `SgpSuggestion.legs` are `PricedLeg`s, so they get links for free.

### 2d. `promo-bot/index.ts`
- Add a helper: `sendWithButtons(chatId, text, rows: { text: string; url: string }[][])` → `tg("sendMessage", { chat_id, text, reply_markup: { inline_keyboard: rows } })`. URL buttons use `url`, not `callback_data`, so no callback routing changes.
- Attach buttons in these places:
  1. **`sendPicks`**: every pick card (`formatBet(...)` send), from `slipButtons(promo.book!, p.legs)`.
  2. **`sendSgpLegs`**: the `formatSgpSuggestion` message, one button per suggested leg. Add a line to the text saying that tapping several legs adds them to the slip, and that the user may have to switch the slip to SGP / Same Game Parlay. Confirm on each book (section 4).
  3. **`answerQuestion`**: the `formatShop` reply. Add buttons for the top +EV legs (at most 4), labelled `🛒 <selection> @ <book>`, each to that leg's own book.
  4. **Optional, in `priceSlip`**: when `formatBetterPrices` finds a better book, add a button to that book's leg. `betterPrices` returns only `{book, odds, mine}` today, so it would need to return the link too. Do this last; skip it if it gets messy.
- Don't change the message text beyond the SGP hint. The buttons are extra.

### 2e. Tests and samples
- Run the existing suite: `node --test supabase/functions/_shared/ev/*.test.ts` and `node --test supabase/functions/_shared/books/*.test.ts`. The sample-based tests (`samples/*.json`) have no links, so everything new must be optional and the existing tests must still pass unchanged.
- Capture one real pull with links into `_shared/ev/samples/` (e.g. `nfl-<date>-links.json`, the four books + sharps, main lines plus one prop market). Add a test that `priceLegs` on it gives every BetMGM leg a `link` with `{state}` filled in once it goes through `legLink`.

### 2f. Deploy
- `supabase functions deploy promo-bot --no-verify-jwt`. Keep the flag: Telegram can't send a JWT.
- Delete `odds-links-probe`.

### 2g. Docs
- `CLAUDE.md`, promo bot section: one paragraph on links: `includeLinks` (no extra credits), `links.ts`, BetMGM's `{state}` = `md`, which books return links, and the per-leg fallback for parlays.
- Delete this handoff file once it's built.

---

## 3. Phase 2: one link for a whole parlay (after phase 1 is live)

Build one URL with every leg, per book, and only for books where a phone test shows it works. Candidate formats, **all unverified**:
- theScore: repeat the indexed params, `market_selection_id[1]=…&odds_numerator[1]=…&odds_denominator[1]=…`.
- BetMGM: comma-join the `options` values, `options=A,B,C`, and try `type=Combo` (or drop `type`).
- FanDuel: `addToBetslip?marketId[0]=…&selectionId[0]=…&marketId[1]=…&selectionId[1]=…`, or repeat the unindexed params.
- DraftKings: `?outcomes=A+B` (or a comma).

Put the result in `links.ts` as `MULTI_LEG: Record<string, (links: string[]) => string | null>`, with an entry only for verified books. `slipButtons` uses it when present and falls back to per-leg buttons otherwise. Note: a combined SGP link may still open as a regular parlay; check whether the book turns it into an SGP.

---

## 4. Manual checks (the user does these on a phone in Maryland, signed in)

Send the user test links from a real pull and ask for:
1. BetMGM single (with `md`): does the slip open with the leg and the right price, in the app or only on the website?
2. DraftKings, FanDuel, theScore singles: same question. For theScore, does the dummy 2/1 price get replaced by the live price?
3. One anytime-TD prop link per book.
4. Phase 2: each multi-leg candidate format, per book.
5. A boosted promo: does the slip show the boost once the leg is in (usually a toggle on the slip)? The bot can't select the boost; the card should keep saying which boost to apply.

Record the results in `CLAUDE.md`. If a book's single link doesn't open the slip, have `slipButtons` use that book's event link instead.

---

## 5. Done when
- [ ] Pick cards, SGP suggestions and game answers show 🛒 buttons for BetMGM, DraftKings, FanDuel and theScore.
- [ ] BetMGM links open on the `md` site/app with the leg in the slip, checked on a phone.
- [ ] The existing tests pass, the new `links.test.ts` passes, and the sample with links is committed.
- [ ] `promo-bot` is deployed, and `odds-links-probe` is deleted.
- [ ] `CLAUDE.md` is updated and this file is removed.
