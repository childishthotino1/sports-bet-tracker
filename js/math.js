const BetMath = {

  // Boost increases the odds by boost% of itself
  // Positive: +200 + 20% = +240 | Negative: -110 + 20% = -88 (better)
  boostedOdds(baseOdds, boostPct) {
    if (!boostPct) return baseOdds;
    return Math.round(baseOdds + Math.abs(baseOdds) * (boostPct / 100));
  },

  totalReturn(wager, odds) {
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

  // Bucket = total withdrawn from sportsbooks minus total disbursed to people
  bucketBalance(transactions) {
    return transactions.reduce((s, t) => {
      if (t.type === 'withdrawal')   return s + parseFloat(t.amount);
      if (t.type === 'disbursement') return s - parseFloat(t.amount);
      return s;
    }, 0);
  },

  // Total pool = all sportsbook money + bucket (withdrawals not yet disbursed)
  totalPool(sportsbooks, transactions) {
    return this.sportsbookTotal(sportsbooks) + this.bucketBalance(transactions);
  },

  // ─── Person Equity ────────────────────────────────────────

  // Dan's equity: what he's owed from the pool
  // = his deposits − his disbursements received + his shared bet P&L
  danEquity(transactions, bets) {
    let equity = 0;

    for (const t of transactions) {
      if (t.person !== 'dan') continue;
      if (t.type === 'deposit')      equity += parseFloat(t.amount);
      if (t.type === 'disbursement') equity -= parseFloat(t.amount);
    }

    for (const bet of bets) {
      if (bet.status === 'pending') continue;
      const boosted   = this.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
      const hisWager  = parseFloat(bet.his_wager);
      const totalW    = parseFloat(bet.total_wager);
      if (bet.status === 'won') {
        const totalRet = this.totalReturn(totalW, boosted);
        equity += this.splitReturn(totalRet, totalW, hisWager) - hisWager; // net profit
      } else if (bet.status === 'lost') {
        equity -= hisWager;
      }
      // push: 0 net
    }

    return equity;
  },

  // Brent's equity is the residual — automatically absorbs his solo bet results
  brentEquity(totalPool, danEquity) {
    return totalPool - danEquity;
  },

  // Pending exposure per person
  danPending(bets) {
    return bets.filter(b => b.status === 'pending')
               .reduce((s, b) => s + parseFloat(b.his_wager), 0);
  },

  brentPending(bets) {
    return bets.filter(b => b.status === 'pending')
               .reduce((s, b) => s + parseFloat(b.my_wager), 0);
  },

  // ─── Per-Person Stats ─────────────────────────────────────

  personStats(transactions, bets, person) {
    const field = person === 'dan' ? 'his_wager' : 'my_wager';

    const deposited = transactions
      .filter(t => t.person === person && t.type === 'deposit')
      .reduce((s, t) => s + parseFloat(t.amount), 0);

    const received = transactions
      .filter(t => t.person === person && t.type === 'disbursement')
      .reduce((s, t) => s + parseFloat(t.amount), 0);

    let sharedPnl = 0;
    let sharedWon = 0;
    let sharedLost = 0;
    for (const bet of bets) {
      if (bet.status === 'pending') continue;
      const boosted = this.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
      const wager   = parseFloat(bet[field]);
      const totalW  = parseFloat(bet.total_wager);
      if (bet.status === 'won') {
        const totalRet = this.totalReturn(totalW, boosted);
        const profit = this.splitReturn(totalRet, totalW, wager) - wager;
        sharedPnl  += profit;
        sharedWon  += 1;
      } else if (bet.status === 'lost') {
        sharedPnl  -= wager;
        sharedLost += 1;
      }
    }

    const pending = bets.filter(b => b.status === 'pending')
                        .reduce((s, b) => s + parseFloat(b[field]), 0);

    return { deposited, received, sharedPnl, sharedWon, sharedLost, pending };
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
