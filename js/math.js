const BetMath = {

  // Boost increases the payout by boost% of the profit rate.
  // Floor to avoid crediting more than the book actually pays.
  boostedOdds(baseOdds, boostPct) {
    if (!boostPct) return baseOdds;
    if (baseOdds >= 0) {
      return Math.floor(baseOdds * (1 + boostPct / 100));
    } else {
      const profitPer100 = (10000 / Math.abs(baseOdds)) * (1 + boostPct / 100);
      if (profitPer100 >= 100) return Math.floor(profitPer100);
      return -Math.floor(10000 / profitPer100);
    }
  },

  // Floor profit to the cent — don't credit more than the book pays
  totalReturn(wager, odds) {
    if (!odds) return wager;
    const rawProfit = odds > 0
      ? wager * (odds / 100)
      : wager * (100 / Math.abs(odds));
    const profit = Math.floor(rawProfit * 100) / 100;
    return wager + profit;
  },

  splitReturn(totalReturn, totalWager, partnerWager) {
    if (!totalWager) return 0;
    return totalReturn * (partnerWager / totalWager);
  },

  // ─── Person normalization (legacy 'me'/'friend' support) ──

  _norm(person) {
    if (person === 'me')     return 'brent';
    if (person === 'friend') return 'dan';
    return person;
  },

  // ─── Pool / Bank ──────────────────────────────────────────

  sportsbookTotal(sportsbooks) {
    return sportsbooks.reduce((s, sb) => s + parseFloat(sb.current_balance), 0);
  },

  // Bank = money withdrawn from books, minus redeployments back in, minus payouts made
  bankBalance(transactions) {
    return transactions.reduce((s, t) => {
      if (t.type === 'withdrawal')                          return s + parseFloat(t.amount);
      if (t.type === 'redeployment')                        return s - parseFloat(t.amount);
      if (t.type === 'disbursement' || t.type === 'payout') return s - parseFloat(t.amount);
      return s;
    }, 0);
  },

  // Total pool = live sportsbook balances + cash in bank
  totalPool(sportsbooks, transactions) {
    return this.sportsbookTotal(sportsbooks) + this.bankBalance(transactions);
  },

  // ─── Person Equity (symmetric for both) ──────────────────

  // equity = deposits + adjustments + bet P&L − payouts received
  personEquity(transactions, bets, person) {
    let equity = 0;
    for (const t of transactions) {
      if (this._norm(t.person) !== person) continue;
      if (t.type === 'deposit' || t.type === 'adjustment') equity += parseFloat(t.amount);
      if (t.type === 'disbursement' || t.type === 'payout') equity -= parseFloat(t.amount);
    }
    const field = person === 'dan' ? 'his_wager' : 'my_wager';
    return equity + this.personBetPnl(bets, field);
  },

  personAdjustment(transactions, person) {
    return transactions
      .filter(t => this._norm(t.person) === person && t.type === 'adjustment')
      .reduce((s, t) => s + parseFloat(t.amount), 0);
  },

  poolAdjustment(transactions) {
    return transactions
      .filter(t => t.type === 'adjustment')
      .reduce((s, t) => s + parseFloat(t.amount), 0);
  },

  // ─── Bet P&L ──────────────────────────────────────────────

  personBetPnl(bets, field) {
    return bets.reduce((sum, b) => {
      if (b.status === 'push') return sum;
      const wager   = parseFloat(b[field]);
      const totalW  = parseFloat(b.total_wager);
      if (b.status === 'pending') return sum - wager;
      const boosted = this.boostedOdds(parseInt(b.base_odds), parseFloat(b.boost_pct) || 0);
      if (b.status === 'won') {
        return sum + this.splitReturn(this.totalReturn(totalW, boosted), totalW, wager) - wager;
      }
      return sum - wager;
    }, 0);
  },

  poolBetPnl(bets) {
    return bets.reduce((sum, b) => {
      if (b.status === 'push' || b.status === 'pending') return sum;
      const boosted = this.boostedOdds(parseInt(b.base_odds), parseFloat(b.boost_pct));
      if (b.status === 'won') {
        return sum + this.totalReturn(parseFloat(b.total_wager), boosted) - parseFloat(b.total_wager);
      }
      return sum - parseFloat(b.total_wager);
    }, 0);
  },

  rollingPnl(bets, days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    return this.poolBetPnl(
      bets.filter(b => new Date(b.placed_at) >= cutoff)
    );
  },

  dayBets(bets, daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const dStr = d.toDateString();
    return bets.filter(b =>
      new Date(b.placed_at).toDateString() === dStr &&
      b.status !== 'pending'
    );
  },

  yesterdayBets(bets) { return this.dayBets(bets, 1); },

  // ─── Snapshots (used only for the performance chart) ──────

  lastSnapshot(snapshots) {
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  },

  // ─── Formatting ───────────────────────────────────────────

  fmt(n) {
    const num = parseFloat(n) || 0;
    const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (num < 0 ? '-$' : '$') + abs;
  },

  fmtOdds(odds) {
    return odds > 0 ? `+${odds}` : `${odds}`;
  },
};
