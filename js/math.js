const BetMath = {
  // Boost increases the odds number by boost% of itself
  // Works for both positive (+200 + 20% = +240) and negative (-110 + 20% = -88)
  boostedOdds(baseOdds, boostPct) {
    if (!boostPct || boostPct === 0) return baseOdds;
    const boost = Math.round(Math.abs(baseOdds) * (boostPct / 100));
    return baseOdds > 0 ? baseOdds + boost : baseOdds + boost;
    // Negative: -110 + 22 = -88 (less negative = better odds) ✓
    // Positive: +200 + 40 = +240 (more positive = better odds) ✓
  },

  // Total return includes original wager
  totalReturn(wager, odds) {
    const profit = odds > 0
      ? wager * (odds / 100)
      : wager * (100 / Math.abs(odds));
    return wager + profit;
  },

  // Proportional share of total return based on wager split
  splitReturn(totalReturn, totalWager, partnerWager) {
    return totalReturn * (partnerWager / totalWager);
  },

  // Friend's equity from transactions + settled shared bets
  // Pending bets don't affect equity — money is still in the pool, just at risk
  friendEquity(transactions, bets) {
    let equity = 0;

    for (const t of transactions) {
      if (t.person === 'friend') {
        equity += t.type === 'deposit' ? parseFloat(t.amount) : -parseFloat(t.amount);
      }
    }

    for (const bet of bets) {
      if (bet.status === 'pending') continue;
      const boosted = this.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
      const hisWager = parseFloat(bet.his_wager);
      const totalWager = parseFloat(bet.total_wager);

      if (bet.status === 'won') {
        const totalRet = this.totalReturn(totalWager, boosted);
        const hisReturn = this.splitReturn(totalRet, totalWager, hisWager);
        equity += hisReturn - hisWager; // net profit only
      } else if (bet.status === 'lost') {
        equity -= hisWager;
      }
      // push: 0 net effect
    }

    return equity;
  },

  friendPendingExposure(bets) {
    return bets
      .filter(b => b.status === 'pending')
      .reduce((sum, b) => sum + parseFloat(b.his_wager), 0);
  },

  myPendingExposure(bets) {
    return bets
      .filter(b => b.status === 'pending')
      .reduce((sum, b) => sum + parseFloat(b.my_wager), 0);
  },

  totalBalance(sportsbooks) {
    return sportsbooks.reduce((sum, sb) => sum + parseFloat(sb.current_balance), 0);
  },

  // My equity is the residual — naturally absorbs solo bet results
  myEquity(totalBalance, friendEquity) {
    return totalBalance - friendEquity;
  },

  fmt(n) {
    const num = parseFloat(n) || 0;
    const abs = Math.abs(num).toFixed(2);
    return (num < 0 ? '-$' : '$') + parseFloat(abs).toLocaleString('en-US', { minimumFractionDigits: 2 });
  },

  fmtOdds(odds) {
    return odds > 0 ? `+${odds}` : `${odds}`;
  },
};
