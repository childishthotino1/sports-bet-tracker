# @Bmorepromobot: how to use it

Sportsbooks hand out boosts every day: "50% profit boost," "30% SGP boost," and so on. Most of them still lose money, because the book's margin is bigger than the boost. This bot tells you which bets actually make money with the boost, and how much to put on them.

It does that by comparing the book's price with the "sharp" price: Pinnacle plus the betting exchanges (Novig, ProphetX, Kalshi, Polymarket). The sharp price is the best estimate of a bet's real chance of winning. When the book pays more than that, the bet is **+EV** (it makes money over time). When it pays less, the bet is **-EV**.

---

## 1. Get access

The bot is private.

1. Open Telegram and message **@Bmorepromobot** (send anything, like "hi").
2. It replies: *"This bot is private. Your chat ID is 123456789."*
3. Send that number, or your Telegram @username, to Brent. Once you're added you can use the bot right away.

## 2. Set your bankroll (do this first)

Your bankroll is the money you set aside for betting. Tell the bot what it is:

```
/bankroll 1000
```

After that, every bet the bot suggests says how much to put on it, for example **💵 Bet $24**. That stake:

- is sized to your edge (quarter Kelly: a cautious version of the standard formula),
- never goes over **3% of your bankroll** on one bet,
- never goes over the promo's max wager.

Keep each day's total at or under about 7% of your bankroll. Change your bankroll anytime with `/bankroll 1500`, or remove it with `/bankroll off`.

## 3. The three things you can send it

### A. A promo screenshot: "what should I bet with this?"

Screenshot the promo's details in your sportsbook app (the screen with the % boost, max wager, minimum odds and eligible bets) and send it.

The bot reads the rules, then asks for anything the screenshot didn't show (which book, the max wager, which sport). Then tap:

- **🎯 Find the best bets.** It asks what odds range you want (say +250 to +500, or Any odds), then sends the best qualifying bets.
- **🔍 Check a bet I'm building.** Build the bet in your app, screenshot the slip, and send it. You'll get a yes or no.
- **🎚 Set target odds.** Only show picks around a certain price.

Each pick card shows the bet to build, the book's price against the fair price, the **EV**, your **stake**, and a **💡 Why** line explaining where the edge comes from.

**🛒 Build in BetMGM** (or whichever book the promo is on): tap it and the bet opens in your app, already in the slip. Parlays get one button for all the legs (on Fanatics, one per leg for now). Always check the price in the slip matches the card before you place it.

**Tip:** add a caption to the screenshot to narrow it down, like "Ravens game" or "props only". The bot then searches straight away without asking questions.

### B. A bet slip screenshot: "is this bet any good?"

Build a bet (single, parlay or SGP) and screenshot the slip before you place it. If no boost is showing, the bot asks whether you're using one (tap 20%, 25%, 50%, or No boost). You get:

- each leg's fair price,
- the whole bet's **EV**: ✅ +EV (worth it) or ❌ -EV (skip it),
- your stake,
- if no boost is involved, any leg that's priced better at another one of your books.

Then it asks **🛒 Want a link to build this bet? Which book?**, with each book that offers every leg (and its price, on a single or parlay). Tap one and you get a button that opens the bet in that book's slip. Handy when a friend shares a screenshot of their bet.

### C. A plain question

Just type, for example:

- *"good bets on the Ravens game?"* gives that game's best prices across BetMGM, DraftKings, FanDuel, theScore, Caesars and Fanatics, against the fair price. Lines marked ✅ are worth betting even without a boost.
- *"teasers"* gives this week's NFL Wong teaser legs.

### Using it in a group chat

The bot also works in a Telegram group. There, it stays out of the conversation:

- **Screenshots:** drop a promo or slip in the group as usual; it answers those and ignores everything else (memes, photos of your dog).
- **Questions:** start with **@Bmorepromobot** (*"@Bmorepromobot good bets on the Ravens game?"*), or reply to one of its messages.
- **Its questions:** tap the buttons, or type a short answer like *+350* or *25*.

Everything is shared by the group: one bankroll, one set of /settings, one promo at a time. For your own bankroll, use the bot one-on-one.

## 4. Commands

| Command | What it does |
|---|---|
| `/bankroll 1000` | Set your bankroll, so you get one stake per bet (`/bankroll off` to clear it) |
| `/settings` | Pick main lines, player props, or both. Main lines are easier on your accounts: books limit prop bettors sooner. |
| `/skip` | Drop the promo you're working on and start fresh |
| `/stats` | How the bot's suggestions to you have done, per bet at 1 unit (`/stats 7` for the last week). A promo can get up to 3 cards that share legs, so the main record counts only the best card of each promo. `/stats all` shows every tester's combined; `/stats full` adds the breakdown by book, league, market and boost. |
| `/help` | A short reminder of all this |

## 5. Good habits

- **Only bet ✅ +EV.** If the bot says -EV, skip it or try different legs. A boost on a bad bet is still a bad bet.
- **Bet the stake it gives you, not more.** Even good bets lose often. The edge only shows up over many bets.
- **Prices move.** If the slip shows a worse price than the card, send the slip screenshot and the bot reprices it.
- **Check the boost rules** (minimum odds, number of legs, eligible games and dates). A promo for one date ("can be placed on 11/7") only gets picks from that day's games. The bot checks too, and warns you when a slip doesn't qualify.
- **Don't expect wins every day.** Think in months, not nights. `/stats` keeps score honestly.

## 6. What it can't do

- **Live, in-game bets:** live prices change faster than the bot's odds feed.
- **Odds for bet365:** the bot can't pull bet365's odds. It can still check a bet365 slip, using the prices printed on it.
- **Every kind of bet:** some exotic markets have no sharp price to compare against. When that happens, the bot says so and gives a rough estimate.
- **Guarantees:** +EV means profitable over many bets, not on any single one.

Questions? Ask Brent.
