const BetMath = {

  // Boost increases the payout by boost% of the profit rate
  // Positive: +200 + 20% = +240 | Negative: -114 + 30% = +114
  boostedOdds(baseOdds, boostPct) {
    if (!boostPct) return baseOdds;
    if (baseOdds >= 0) {
      return Math.round(baseOdds * (1 + boostPct / 100));
    } else {
      const profitPer100 = (10000 / Math.abs(baseOdds)) * (1 + boostPct / 100);
      if (profitPer100 >= 100) return Math.round(profitPer100);
      return -Math.round(10000 / profitPer100);
    }
  },

  totalReturn(wager, odds) {
    if (!odds) return wager; // no odds recorded — return wager (no profit displayed)
    const profit = odds > 0
      ? wager * (odds / 100)
      : wager * (100 / Math.abs(odds));
    return wager + profit;
  },

  splitReturn(totalReturn, totalWager, partnerWager) {
    return totalReturn * (partnerWager / totalWager);
  },

  // ─── Pool / Bucket ────────────────────────────────────────

  sportsbookTotal(sportsbooks) {
    return sportsbooks.reduce((s, sb) => s + parseFloat(sb.current_balance), 0);
  },

  // Bucket = withdrawn from sportsbooks, minus redeployments back to books, minus disbursements paid out
  // Owned proportionally by both people — no manual attribution needed
  bucketBalance(transactions) {
    return transactions.reduce((s, t) => {
      if (t.type === 'withdrawal')    return s + parseFloat(t.amount);
      if (t.type === 'redeployment')  return s - parseFloat(t.amount); // back into a sportsbook
      if (t.type === 'disbursement')  return s - parseFloat(t.amount);
      return s;
    }, 0);
  },

  // Total pool = all sportsbook money + bucket (cash in bank account)
  totalPool(sportsbooks, transactions) {
    return this.sportsbookTotal(sportsbooks) + this.bucketBalance(transactions);
  },

  // ─── Person Equity ────────────────────────────────────────

  // Each person's share of the bucket = their equity % of the pool
  // No manual tagging needed — the residual formula handles it automatically

  // Dan's equity: deposits + bet P&L − disbursements received
  // Withdrawals are NOT added here — they just move money within the pool,
  // and Dan's proportional ownership of the bucket flows through naturally
  // via brentEquity = totalPool − danEquity
  danEquity(transactions, bets) {
    let equity = 0;

    for (const t of transactions) {
      if (t.person !== 'dan') continue;
      if (t.type === 'deposit')      equity += parseFloat(t.amount);
      if (t.type === 'disbursement') equity -= parseFloat(t.amount); // Dan has received this cash
    }

    for (const bet of bets) {
      if (bet.status === 'push') continue;
      const boosted   = this.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
      const hisWager  = parseFloat(bet.his_wager);
      const totalW    = parseFloat(bet.total_wager);
      if (bet.status === 'won') {
        const totalRet = this.totalReturn(totalW, boosted);
        equity += this.splitReturn(totalRet, totalW, hisWager) - hisWager;
      } else if (bet.status === 'lost') {
        equity -= hisWager;
      }
      // pending: not counted — money is still in the pool
    }

    return equity;
  },

  // Brent's equity is the residual — automatically absorbs his solo bet results
  brentEquity(totalPool, danEquity) {
    return totalPool - danEquity;
  },

  // ─── Shared helpers ───────────────────────────────────────

  // Last snapshot entry, or null if none
  lastSnapshot(snapshots) {
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  },

  // Snapshot-aligned sportsbook total (falls back to live balances if no snapshot)
  snapTotal(snapshots, sportsbooks) {
    const snap = this.lastSnapshot(snapshots);
    return snap ? parseFloat(snap.cash) : this.sportsbookTotal(sportsbooks);
  },

  // Per-person bet P&L across a list of bets
  // field: 'his_wager' (Dan) or 'my_wager' (Brent)
  personBetPnl(bets, field) {
    return bets.reduce((sum, b) => {
      if (b.status === 'push' || b.status === 'pending') return sum;
      const boosted = this.boostedOdds(parseInt(b.base_odds), parseFloat(b.boost_pct) || 0);
      const wager   = parseFloat(b[field]);
      const totalW  = parseFloat(b.total_wager);
      if (b.status === 'won') {
        return sum + this.splitReturn(this.totalReturn(totalW, boosted), totalW, wager) - wager;
      }
      return sum - wager;
    }, 0);
  },

  // ─── Pool P&L ─────────────────────────────────────────

  // Net profit/loss from a set of bets (pool level, excludes pending)
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

  // Bets placed N days ago (local date) that have been settled
  dayBets(bets, daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const dStr = d.toDateString();
    return bets.filter(b =>
      new Date(b.placed_at).toDateString() === dStr &&
      b.status !== 'pending'
    );
  },

  // Convenience alias
  yesterdayBets(bets) { return this.dayBets(bets, 1); },

  // Net P&L from bets placed within the last N rolling days
  rollingPnl(bets, days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    return this.poolBetPnl(
      bets.filter(b => new Date(b.placed_at) >= cutoff)
    );
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
