const App = {
  state: {
    view: 'pool',
    betFilter: 'pending',
    betViewMode: 'list',    // 'list' | 'cards'
    sportsbooks: [],
    bets: [],
    transactions: [],
    settings: {},
    snapshots: [],
    activityLog: [],
    loaded: false,
    undoStack: [],          // [{type, bet, result}] — last 3 actions
    currentUser: 'brent',  // 'brent' | 'dan' — set on PIN entry
  },

  _miniChart: null,
  _fullChart: null,

  pinEntry: '',

  // ─── Init ──────────────────────────────────────────────

  async init() {
    this.initPin();
    try {
      await this.loadData();
      this.state.loaded = true;
    } catch (e) {
      console.error('Load error:', e);
    }
  },

  async loadData() {
    const [sportsbooks, bets, transactions, settings, snapshots, activityLog] = await Promise.all([
      DB.getSportsbooks(),
      DB.getBets(),
      DB.getTransactions(),
      DB.getSettings(),
      DB.getSnapshots(),
      DB.getActivityLog(),
    ]);
    this.state.sportsbooks  = sportsbooks;
    this.state.bets         = bets;
    this.state.transactions = transactions;
    this.state.settings     = settings;
    this.state.snapshots    = snapshots;
    this.state.activityLog  = activityLog;
  },

  // ─── PIN ──────────────────────────────────────────────

  initPin() {
    document.querySelectorAll('.pin-key[data-digit]').forEach(btn => {
      btn.addEventListener('click', () => this.handlePinDigit(btn.dataset.digit));
    });
    document.querySelector('.pin-key[data-action="clear"]').addEventListener('click', () => {
      this.pinEntry = this.pinEntry.slice(0, -1);
      this.updatePinDots();
    });
  },

  handlePinDigit(digit) {
    if (this.pinEntry.length >= 4) return;
    this.pinEntry += digit;
    this.updatePinDots();
    if (this.pinEntry.length === 4) setTimeout(() => this.checkPin(), 150);
  },

  updatePinDots() {
    for (let i = 0; i < 4; i++) {
      document.getElementById(`dot-${i}`).classList.toggle('filled', i < this.pinEntry.length);
    }
  },

  async checkPin() {
    if (!this.state.loaded) { await this.loadData(); this.state.loaded = true; }
    const isBrent = this.pinEntry === this.state.settings.pin;
    const isDan   = this.pinEntry === this.state.settings.pin_dan;
    if (isBrent || isDan) {
      this.state.currentUser = isBrent ? 'brent' : 'dan';
      DB.logActivity(this.state.currentUser, 'login');
      document.getElementById('pin-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      this.navigate('pool');
    } else {
      const err = document.getElementById('pin-error');
      err.classList.remove('hidden');
      this.pinEntry = '';
      this.updatePinDots();
      setTimeout(() => err.classList.add('hidden'), 1800);
    }
  },

  // ─── Navigation ────────────────────────────────────────

  navigate(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    const navBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (navBtn) navBtn.classList.add('active');
    this.state.view = view;
    const titles = { pool: 'Honeypot', bets: 'Bets', 'add-bet': 'New Bet', brent: 'Brent', dan: 'Dan', stats: 'Stats' };
    document.getElementById('header-title').textContent = titles[view] || view;
    this.render(view);
  },

  render(view) {
    const map = {
      pool:     () => this.renderPool(),
      bets:     () => this.renderBets(),
      'add-bet': () => this.renderAddBet(),
      brent:    () => this.renderPerson('brent'),
      dan:      () => this.renderPerson('dan'),
      stats:    () => this.renderStats(),
    };
    if (map[view]) map[view]();
  },

  // ─── Pool View ─────────────────────────────────────────

  renderPool() {
    const { sportsbooks, bets, transactions, snapshots } = this.state;

    // All-time
    const settledBets   = bets.filter(b => b.status !== 'pending');
    const allTimePnl    = BetMath.poolBetPnl(settledBets);
    const totalWon      = settledBets.filter(b => b.status === 'won').length;
    const totalWithResult = settledBets.filter(b => b.status !== 'push').length;
    const winRate       = totalWithResult > 0 ? Math.round(totalWon / totalWithResult * 100) : 0;

    // Pool / rolling
    const sbTotal       = BetMath.sportsbookTotal(sportsbooks);
    const bucket        = BetMath.bucketBalance(transactions);
    const totalPool     = BetMath.totalPool(sportsbooks, transactions);
    const openBets      = bets.filter(b => b.status === 'pending');
    const openExposure  = openBets.reduce((s, b) => s + parseFloat(b.total_wager), 0);
    const pnl7          = BetMath.rollingPnl(bets, 7);
    const pnl30         = BetMath.rollingPnl(bets, 30);

    // Snapshot reminder
    const lastSnap      = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    const daysSinceSnap = lastSnap
      ? Math.floor((Date.now() - new Date(lastSnap.snapshot_date)) / 864e5)
      : null;
    const showSnapReminder = !lastSnap || daysSinceSnap >= 7;
    const snapMsg = !lastSnap
      ? 'No snapshots yet — add one to start tracking pool growth'
      : `Last snapshot ${daysSinceSnap}d ago — add one to keep the chart accurate`;

    // Estimated balance: last known balance (at time of last manual update) + P&L from bets placed since
    const { settings } = this.state;
    const booksUpdatedRaw = settings.books_last_updated;
    const booksUpdatedDate = booksUpdatedRaw ? new Date(booksUpdatedRaw) : null;
    const sbAsOf = booksUpdatedDate
      ? `${String(booksUpdatedDate.getDate()).padStart(2,'0')}/${String(booksUpdatedDate.getMonth()+1).padStart(2,'0')}`
      : null;
    const betsSince = booksUpdatedDate
      ? bets.filter(b => new Date(b.placed_at) > booksUpdatedDate && b.status !== 'pending')
      : [];
    const pnlSince   = BetMath.poolBetPnl(betsSince);
    const estBalance = sbTotal + pnlSince;

    document.getElementById('pool-content').innerHTML = `
      <div class="section-label">Est. Sportsbook Balance</div>
      <div class="hp-today-card">
        <div class="hp-today-pnl">
          <div class="hp-today-amount">${BetMath.fmt(estBalance)}</div>
          ${pnlSince !== 0 ? `<div class="hp-today-record"><span class="${pnlSince > 0 ? 'hp-rec-w' : 'hp-rec-l'}">${pnlSince > 0 ? '+' : ''}${BetMath.fmt(pnlSince)} since last update</span></div>` : ''}
        </div>
      </div>

      <div class="hp-metrics-grid">
        <div class="hp-metric">
          <div class="hp-metric-label">${sbAsOf ? `Books as of ${sbAsOf}` : 'In Sportsbooks'}</div>
          <div class="hp-metric-value">${BetMath.fmt(sbTotal)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">Bucket</div>
          <div class="hp-metric-value">${BetMath.fmt(bucket)}</div>
        </div>
        <div class="hp-metric hp-metric-total">
          <div class="hp-metric-label">Total Equity</div>
          <div class="hp-metric-value">${BetMath.fmt(totalPool)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">At Risk</div>
          <div class="hp-metric-value ${openExposure > 0 ? 'text-gold' : 'text-muted'}">${BetMath.fmt(openExposure)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">7-Day P&amp;L</div>
          <div class="hp-metric-value ${pnl7 > 0 ? 'text-green' : pnl7 < 0 ? 'text-red' : ''}">${pnl7 > 0 ? '+' : ''}${BetMath.fmt(pnl7)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">30-Day P&amp;L</div>
          <div class="hp-metric-value ${pnl30 > 0 ? 'text-green' : pnl30 < 0 ? 'text-red' : ''}">${pnl30 > 0 ? '+' : ''}${BetMath.fmt(pnl30)}</div>
        </div>
      </div>

      <div class="section-label">Last 5 Days</div>
      <div class="day-strip">${
        [5,4,3,2,1].map(i => {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const db   = BetMath.dayBets(bets, i);
          const pnl  = BetMath.poolBetPnl(db);
          const won  = db.filter(b => b.status === 'won').length;
          const lost = db.filter(b => b.status === 'lost').length;
          const push = db.filter(b => b.status === 'push').length;
          const hasData = db.length > 0;
          const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
          const pnlCls = pnl > 0 ? 'text-green' : pnl < 0 ? 'text-red' : '';
          const rec = [won > 0 ? `${won}W` : '', lost > 0 ? `${lost}L` : '', push > 0 ? `${push}P` : ''].filter(Boolean).join(' ');
          return `<div class="day-box">
            <div class="day-box-label">${label}</div>
            <div class="day-box-pnl ${pnlCls}">${hasData ? (pnl >= 0 ? '+' : '') + BetMath.fmt(pnl) : '—'}</div>
            <div class="day-box-rec">${rec || (hasData ? '—' : '')}</div>
          </div>`;
        }).join('')
      }</div>

      <div class="pool-actions">
        <button class="action-btn" id="pool-log-btn">+ Deposit / Withdrawal / Payout</button>
      </div>

      ${showSnapReminder ? `<button class="snap-reminder" id="snap-reminder-btn">${snapMsg}</button>` : ''}

      ${openBets.length > 0 ? `
        <div class="section-label">
          Open Bets
          <span class="badge badge-pending">${openBets.length}</span>
        </div>
        ${openBets.map(b => this.betRowHTML(b)).join('')}
      ` : `<div class="hp-no-open">All bets settled ✓</div>`}
    `;

    this.attachBetCardHandlers();
    document.getElementById('pool-log-btn')?.addEventListener('click', () => this.showLogTransactionModal());
    document.getElementById('snap-reminder-btn')?.addEventListener('click', () => this.showAddSnapshotModal());
  },

  // ─── Bet Card HTML ─────────────────────────────────────

  betCardHTML(bet) {
    const boosted = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
    const statusLabels  = { won: 'WON', lost: 'LOST', push: 'PUSH', pending: 'OPEN' };
    const statusClasses = { won: 'badge-won', lost: 'badge-lost', push: 'badge-push', pending: 'badge-pending' };
    const isPending = bet.status === 'pending';

    let payoutLine = '';
    if (bet.status === 'won') {
      const totalRet  = BetMath.totalReturn(parseFloat(bet.total_wager), boosted);
      const danRet    = BetMath.splitReturn(totalRet, parseFloat(bet.total_wager), parseFloat(bet.his_wager));
      const brentRet  = BetMath.splitReturn(totalRet, parseFloat(bet.total_wager), parseFloat(bet.my_wager));
      payoutLine = `<div class="bet-payout"><span>Dan +${BetMath.fmt(danRet - parseFloat(bet.his_wager))}</span><span>Brent +${BetMath.fmt(brentRet - parseFloat(bet.my_wager))}</span></div>`;
    }

    return `
      <div class="bet-card ${isPending ? 'bet-card-pending' : ''}" data-bet-id="${bet.id}">
        <div class="bet-card-top">
          <div class="bet-meta">
            <span class="bet-sport">${bet.sport}</span>
            <span class="bet-dot">·</span>
            <span class="bet-desc">${bet.description}</span>
          </div>
          <span class="badge ${statusClasses[bet.status]}">${statusLabels[bet.status]}</span>
        </div>
        <div class="bet-card-mid">
          <span class="bet-book">${bet.sportsbooks?.name || ''}</span>
          <span class="bet-odds-display">
            ${BetMath.fmtOdds(boosted)}
            ${bet.boost_pct > 0 ? `<span class="boost-tag">+${bet.boost_pct}%</span>` : ''}
          </span>
        </div>
        <div class="bet-card-bot">
          <span>Total ${BetMath.fmt(bet.total_wager)}</span>
          <span>Dan ${BetMath.fmt(bet.his_wager)}</span>
          <span>Brent ${BetMath.fmt(bet.my_wager)}</span>
        </div>
        ${payoutLine}
        ${isPending ? `
          <div class="settle-inline">
            <button class="settle-btn settle-w" data-id="${bet.id}" data-result="won">W</button>
            <button class="settle-btn settle-l" data-id="${bet.id}" data-result="lost">L</button>
            <button class="settle-btn settle-p" data-id="${bet.id}" data-result="push">P</button>
            <button class="settle-btn settle-del" data-id="${bet.id}" data-result="delete">×</button>
          </div>
        ` : ''}
      </div>
    `;
  },

  // ─── Bet Row HTML (list view) ──────────────────────────

  betRowHTML(b) {
    const boosted    = BetMath.boostedOdds(parseInt(b.base_odds), parseFloat(b.boost_pct));
    const isPending  = b.status === 'pending';
    const baseOdds   = parseInt(b.base_odds);
    const boostPct   = parseFloat(b.boost_pct);
    const danWager   = parseFloat(b.his_wager);
    const brentWager = parseFloat(b.my_wager);
    const totalW     = parseFloat(b.total_wager);

    const d    = new Date(b.placed_at);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const sportColors = {
      NBA: 'sport-nba', NFL: 'sport-nfl', NHL: 'sport-nhl', MLB: 'sport-mlb',
      NCAAB: 'sport-ncaab', CBB: 'sport-ncaab', CFB: 'sport-cfb', NCAAF: 'sport-cfb',
    };
    const sportClass = sportColors[b.sport] || 'sport-other';

    let oddsHtml = '';
    if (baseOdds !== 0) {
      if (boostPct > 0) {
        oddsHtml = `
          <span class="br-sep">·</span>
          <span class="br-odds">
            <span class="br-odds-base">${BetMath.fmtOdds(baseOdds)}</span>
            <span class="br-odds-arrow">›</span>
            <span class="br-odds-boosted">${BetMath.fmtOdds(boosted)}</span>
            <span class="boost-tag-xs">+${boostPct}%</span>
          </span>`;
      } else {
        oddsHtml = `<span class="br-sep">·</span><span class="br-odds"><span class="br-odds-boosted">${BetMath.fmtOdds(boosted)}</span></span>`;
      }
    }

    const wagerParts = [];
    if (danWager > 0)   wagerParts.push(`<span class="br-dan">D ${BetMath.fmt(danWager)}</span>`);
    if (brentWager > 0) wagerParts.push(`<span class="br-brent">B ${BetMath.fmt(brentWager)}</span>`);
    const wagersHtml = wagerParts.join(`<span class="br-sep">·</span>`);

    let payoutHtml = '';
    if (b.status === 'won') {
      const totalRet    = BetMath.totalReturn(totalW, boosted);
      const danProfit   = danWager > 0   ? BetMath.splitReturn(totalRet, totalW, danWager)   - danWager   : 0;
      const brentProfit = brentWager > 0 ? BetMath.splitReturn(totalRet, totalW, brentWager) - brentWager : 0;
      const parts = [];
      if (danWager > 0)   parts.push(`<span class="br-profit">D +${BetMath.fmt(danProfit)}</span>`);
      if (brentWager > 0) parts.push(`<span class="br-profit">B +${BetMath.fmt(brentProfit)}</span>`);
      payoutHtml = `<div class="bet-row-l3 br-payout-row">${parts.join(`<span class="br-sep">·</span>`)}</div>`;
    }

    const showEdit = this.state.betFilter === 'all';

    let actionHtml;
    if (isPending) {
      actionHtml = `
        <div class="settle-grid">
          <button class="settle-btn settle-w"   data-id="${b.id}" data-result="won">W</button>
          <button class="settle-btn settle-l"   data-id="${b.id}" data-result="lost">L</button>
          <button class="settle-btn settle-p"   data-id="${b.id}" data-result="push">P</button>
          <button class="settle-btn settle-del" data-id="${b.id}" data-result="delete">×</button>
        </div>`;
    } else {
      const cls = { won: 'badge-won', lost: 'badge-lost', push: 'badge-push' }[b.status] || '';
      const lbl = { won: 'WON', lost: 'LOST', push: 'PUSH' }[b.status] || b.status;
      actionHtml = `<span class="badge ${cls}">${lbl}</span>`;
    }

    const editBtn = showEdit
      ? `<button class="br-edit-btn" data-id="${b.id}" title="Edit bet">✎</button>`
      : '';

    return `
      <div class="bet-row bet-row-${b.status}" data-bet-id="${b.id}">
        <div class="bet-row-info">
          <div class="bet-row-l1">
            <span class="bet-row-sport-badge ${sportClass}">${b.sport}</span>
            <span class="bet-row-desc">${b.description}</span>
          </div>
          <div class="bet-row-l2">
            <span class="br-book">${b.sportsbooks?.name?.replace('theScore Bet', 'Score') || ''}</span>
            <span class="br-sep">·</span>
            <span class="br-date">${date}</span>
            ${oddsHtml}
          </div>
          <div class="bet-row-l3">${wagersHtml}</div>
          ${payoutHtml}
        </div>
        <div class="bet-row-action${showEdit ? ' br-action-col' : ''}">
          ${actionHtml}
          ${editBtn}
        </div>
      </div>
    `;
  },

  attachBetCardHandlers() {
    document.querySelectorAll('.settle-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        btn.disabled = true;
        await this.handleInlineSettle(btn.dataset.id, btn.dataset.result);
      });
    });
    document.querySelectorAll('.br-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const bet = this.state.bets.find(b => b.id === btn.dataset.id);
        if (bet) this.showEditBetModal(bet);
      });
    });
  },

  async handleInlineSettle(betId, result) {
    const bet = this.state.bets.find(b => b.id === betId);
    if (!bet) return;

    // Push to undo stack (cap at 3)
    this.state.undoStack.unshift({ type: result === 'delete' ? 'delete' : 'settle', bet, result });
    if (this.state.undoStack.length > 3) this.state.undoStack.pop();

    if (result === 'delete') {
      await DB.deleteBet(betId);
      DB.logActivity(this.state.currentUser, 'bet_deleted', {
        bet_id: bet.id, sport: bet.sport, description: bet.description, sportsbook: bet.sportsbooks?.name,
      });
    } else {
      await DB.settleBet(betId, result);
      DB.logActivity(this.state.currentUser, 'bet_settled', {
        bet_id: bet.id, sport: bet.sport, description: bet.description, result, sportsbook: bet.sportsbooks?.name,
      });
    }
    await this.loadData();
    this.render(this.state.view);
    this._showUndoToast();
  },

  _showUndoToast() {
    if (this.state.undoStack.length === 0) return;
    clearTimeout(this._undoTimer);

    let toast = document.getElementById('undo-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'undo-toast';
      document.body.appendChild(toast);
    }

    const top    = this.state.undoStack[0];
    const labels = { won: 'Won', lost: 'Lost', push: 'Push', delete: 'Deleted' };
    const action = top.type === 'delete' ? 'delete' : top.result;
    const count  = this.state.undoStack.length;

    toast.innerHTML = `
      <span class="undo-msg">${labels[action] || action}</span>
      <button class="undo-action-btn">Undo${count > 1 ? ` (${count})` : ''}</button>
    `;
    toast.classList.add('visible');
    toast.querySelector('.undo-action-btn').addEventListener('click', () => this._handleUndo());

    this._undoTimer = setTimeout(() => {
      toast.classList.remove('visible');
      this.state.undoStack = []; // clear stack when window expires
    }, 5000);
  },

  async _handleUndo() {
    const entry = this.state.undoStack.shift();
    if (!entry) return;

    try {
      if (entry.type === 'delete') {
        await DB.restoreBet(entry.bet);
      } else {
        await DB.unsettleBet(entry.bet.id);
      }
      DB.logActivity(this.state.currentUser, 'undo', {
        undone: entry.type, bet_id: entry.bet.id, description: entry.bet.description,
      });
      await this.loadData();
      this.render(this.state.view);

      if (this.state.undoStack.length > 0) {
        this._showUndoToast(); // show next undo if available
      } else {
        clearTimeout(this._undoTimer);
        document.getElementById('undo-toast')?.classList.remove('visible');
      }
    } catch (err) {
      alert('Undo failed: ' + err.message);
    }
  },

  // ─── Bets View ─────────────────────────────────────────

  betCodeFromBet(b) {
    const BOOK_SHORT = {
      'theScore Bet': 'ESPN', 'Bet365': 'B365', 'DraftKings': 'DK',
      'BetMGM': 'MGM', 'Fanatics': 'Fanatics',
    };
    const book  = BOOK_SHORT[b.sportsbooks?.name] || b.sportsbooks?.name || '?';
    const odds  = parseInt(b.base_odds);
    const oddsStr = odds !== 0 ? BetMath.fmtOdds(odds) : '';
    const boost = parseFloat(b.boost_pct);
    return [
      book,
      b.sport,
      b.description,
      boost,
      parseFloat(b.total_wager),
      parseFloat(b.his_wager),
      `${parseFloat(b.my_wager)}${oddsStr}`,
    ].join('.');
  },

  renderBets() {
    const filter = this.state.betFilter;

    document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));

    const list = document.getElementById('bets-list');

    if (filter === 'activity') {
      list.innerHTML = this.renderActivityFeed();
      return;
    }

    const filtered = filter === 'all' ? this.state.bets : this.state.bets.filter(b => b.status === filter);
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state">No bets</div>';
      return;
    }

    list.innerHTML = filtered.map(b => this.betRowHTML(b)).join('');
    this.attachBetCardHandlers();
  },

  renderActivityFeed() {
    const log = this.state.activityLog;
    if (!log.length) return '<div class="empty-state">No recent activity</div>';

    const sportColors = { NBA:'sport-nba', NFL:'sport-nfl', NHL:'sport-nhl', MLB:'sport-mlb', NCAAB:'sport-ncaab', CBB:'sport-ncaab', CFB:'sport-cfb', NCAAF:'sport-cfb' };

    return log.flatMap(entry => {
      const user    = entry.user_name === 'brent' ? 'Brent' : 'Dan';
      const userCls = entry.user_name === 'brent' ? 'act-user-brent' : 'act-user-dan';
      const d       = entry.details || {};
      const time    = this.relativeTime(new Date(entry.created_at));

      if (entry.action === 'bets_placed') {
        return (d.bets || []).map(b => {
          const sportCls = sportColors[(b.sport || '').toUpperCase()] || 'sport-other';
          return `<div class="activity-row">
            <span class="act-user-badge ${userCls}">${user}</span>
            <div class="act-body">
              <span class="act-label">Added Bet</span>
              <span class="bet-row-sport-badge ${sportCls}">${b.sport || ''}</span>
              ${b.sportsbook ? `<span class="act-book">${b.sportsbook}</span>` : ''}
            </div>
            <span class="act-time">${time}</span>
          </div>`;
        });
      }

      if (entry.action === 'bet_settled' && (d.result === 'won' || d.result === 'lost')) {
        const sportCls  = sportColors[(d.sport || '').toUpperCase()] || 'sport-other';
        const resCls    = d.result === 'won' ? 'act-res-w' : 'act-res-l';
        const resLabel  = d.result === 'won' ? 'W' : 'L';
        return [`<div class="activity-row">
          <span class="act-user-badge ${userCls}">${user}</span>
          <div class="act-body">
            <span class="act-label">Marked Bet <span class="act-res ${resCls}">${resLabel}</span></span>
            <span class="bet-row-sport-badge ${sportCls}">${d.sport || ''}</span>
            ${d.sportsbook ? `<span class="act-book">${d.sportsbook}</span>` : ''}
          </div>
          <span class="act-time">${time}</span>
        </div>`];
      }

      return [];
    }).join('');
  },

  // Returns YYYY-MM-DD in local time (not UTC) — used for date pickers
  localDateStr(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  },

  relativeTime(date) {
    const secs = Math.floor((Date.now() - date) / 1000);
    if (secs < 60)  return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60)  return `${mins}m ago`;
    const hrs  = Math.floor(mins / 60);
    if (hrs  < 24)  return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days <  7)  return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },

  // ─── Add Bet (Dot Notation) ────────────────────────────

  renderAddBet() {
    const today = this.localDateStr();
    const container = document.getElementById('add-bet-view');
    container.innerHTML = `
      <div class="code-input-wrapper">
        <div class="code-label">Date</div>
        <input type="date" id="bet-date-input" class="form-input" value="${today}">
      </div>
      <div class="code-input-wrapper">
        <div class="code-label">Bet Codes</div>
        <textarea
          id="bet-code-input"
          class="code-input code-textarea"
          placeholder="ESPN.NBA.PlayerProp.20.50.30.20+413&#10;DK.NFL.BrownsCover.0.25.20.5-110&#10;MGM.NHL.CapsCover.15.30.25.5+180"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="characters"
          spellcheck="false"
          rows="5"
        ></textarea>
        <div class="code-format-hint">BOOK · SPORT · DESC · BOOST% · TOTAL · DAN · BRENT±ODDS · one per line</div>
      </div>
      <div id="bet-parse-result"></div>
    `;
    document.getElementById('bet-code-input').addEventListener('input', e => {
      this.handleBetCodesInput(e.target.value);
    });
    document.getElementById('bet-code-input').focus();
  },

  parseBetCode(raw) {
    const code = raw.trim();
    if (!code) return null;

    const parts = code.split('.');

    let book, sport, desc, boostStr, totalStr, danStr, brentStr, oddsStr;

    if (parts.length === 8) {
      // 8-segment: BOOK.SPORT.DESC.BOOST.TOTAL.DAN.BRENT.ODDS
      [book, sport, desc, boostStr, totalStr, danStr, brentStr, oddsStr] = parts;
    } else if (parts.length === 7) {
      // 7-segment: BOOK.SPORT.DESC.BOOST.TOTAL.DAN.BRENT±ODDS
      [book, sport, desc, boostStr, totalStr, danStr] = parts;
      const m = parts[6].match(/^([\d.]+)([+-]\d+)$/);
      if (!m) return { error: 'Last segment must be BrentWager±Odds (e.g. 20+413 or 20-110)' };
      brentStr = m[1];
      oddsStr  = m[2];
    } else {
      return { error: `Need 7 or 8 segments, got ${parts.length}` };
    }

    const boost_pct   = parseFloat(boostStr) || 0;
    const total_wager = parseFloat(totalStr);
    const his_wager   = parseFloat(danStr);
    const my_wager    = parseFloat(brentStr);
    const base_odds   = parseInt(oddsStr);

    if (isNaN(total_wager) || total_wager <= 0) {
      return { error: 'Total wager must be a positive number' };
    }
    if (isNaN(his_wager) || his_wager < 0 || isNaN(my_wager) || my_wager < 0) {
      return { error: 'Wager amounts cannot be negative' };
    }
    if (Math.abs(his_wager + my_wager - total_wager) > 0.02) {
      return { error: `Wagers don't add up: Dan $${his_wager} + Brent $${my_wager} ≠ $${total_wager}` };
    }

    // Match sportsbook (ESPN is the old name for theScore Bet)
    const BOOK_ALIASES = {
      'ESPN': 'theScore Bet', 'THESCORE': 'theScore Bet', 'SCORE': 'theScore Bet',
      'FD': 'FanDuel', 'DK': 'DraftKings', 'MGM': 'BetMGM', 'B365': 'Bet365',
    };
    const bookUpper = book.toUpperCase().replace(/\s/g, '');
    const aliasName = BOOK_ALIASES[bookUpper];
    const matched   = aliasName
      ? this.state.sportsbooks.find(sb => sb.name === aliasName)
      : (this.state.sportsbooks.find(sb => {
          const sbKey = sb.name.toUpperCase().replace(/\s/g, '');
          return sbKey === bookUpper || sbKey.startsWith(bookUpper) || bookUpper.startsWith(sbKey.split('')[0]);
        }) || this.state.sportsbooks.find(sb =>
          sb.name.toUpperCase().includes(bookUpper.slice(0, 4))
        ) || null);

    if (!matched) {
      return { error: `Book "${book}" not recognized` };
    }

    return { book, sport: sport.toUpperCase(), description: desc, boost_pct, total_wager, his_wager, my_wager, base_odds, sportsbook_id: matched.id, sportsbook_matched: matched.name };
  },

  handleBetCodesInput(raw) {
    const result = document.getElementById('bet-parse-result');
    const lines  = raw.split(/\s+/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) { result.innerHTML = ''; return; }

    const rows = lines.map(line => {
      const p = this.parseBetCode(line);
      if (!p) return '';
      if (p.error) {
        return `<div class="parse-row parse-row-error">
          <span class="parse-row-label">${line.slice(0, 40)}${line.length > 40 ? '…' : ''}</span>
          <span class="parse-row-msg">${p.error}</span>
        </div>`;
      }
      const boosted = BetMath.boostedOdds(p.base_odds, p.boost_pct);
      return `<div class="parse-row parse-row-valid">
        <span class="parse-row-book">${p.sportsbook_matched.replace('theScore Bet', 'Score')}</span>
        <span class="parse-row-sport">${p.sport}</span>
        <span class="parse-row-desc">${p.description}</span>
        <span class="parse-row-odds">${BetMath.fmtOdds(boosted)}${p.boost_pct > 0 ? ` +${p.boost_pct}%` : ''}</span>
        <span class="parse-row-wager">${BetMath.fmt(p.total_wager)}</span>
      </div>`;
    }).join('');

    const valid   = lines.filter(l => { const p = this.parseBetCode(l); return p && !p.error; });
    const errored = lines.length - valid.length;

    result.innerHTML = `
      <div class="parse-summary">${rows}</div>
      ${valid.length > 0 ? `
        <button class="btn-place-bet" id="btn-place-bet">
          Place ${valid.length} Bet${valid.length !== 1 ? 's' : ''}${errored > 0 ? ` · ${errored} skipped` : ''}
        </button>
      ` : ''}
    `;

    if (valid.length > 0) {
      document.getElementById('btn-place-bet').addEventListener('click', () => {
        const dateVal  = document.getElementById('bet-date-input')?.value;
        const placedAt = dateVal ? new Date(dateVal + 'T12:00:00').toISOString() : new Date().toISOString();
        const parsed   = valid.map(l => this.parseBetCode(l)).filter(p => p && !p.error);
        this.submitParsedBets(parsed, placedAt);
      });
    }
  },

  async submitParsedBets(parsedBets, placedAt = new Date().toISOString()) {
    const btn = document.getElementById('btn-place-bet');
    btn.disabled = true;
    btn.textContent = 'Placing...';

    try {
      DB.logActivity(this.state.currentUser, 'bets_placed', {
        count: parsedBets.length,
        bets: parsedBets.map(p => ({ sport: p.sport, description: p.description, total_wager: p.total_wager, sportsbook: p.sportsbook_matched })),
      });
      for (const p of parsedBets) {
        await DB.addBet({
          sportsbook_id: p.sportsbook_id,
          sport:         p.sport,
          description:   p.description,
          boost_pct:     p.boost_pct,
          total_wager:   p.total_wager,
          his_wager:     p.his_wager,
          my_wager:      p.my_wager,
          base_odds:     p.base_odds,
          placed_at:     placedAt,
        });
      }
      await this.loadData();
      document.getElementById('bet-code-input').value = '';
      document.getElementById('bet-parse-result').innerHTML = '';
      this.navigate('pool');
    } catch (err) {
      alert('Error: ' + err.message);
      btn.disabled = false;
      btn.textContent = `Place ${parsedBets.length} Bet${parsedBets.length !== 1 ? 's' : ''}`;
    }
  },

  // ─── Person View (Brent / Dan) ────────────────────────

  renderPerson(person) {
    const { sportsbooks, bets, transactions } = this.state;

    const danEquity  = BetMath.danEquity(transactions, bets);
    const totalPool  = BetMath.totalPool(sportsbooks, transactions);
    const equity     = person === 'dan' ? danEquity : BetMath.brentEquity(totalPool, danEquity);
    const stats      = BetMath.personStats(transactions, bets, person);
    const name       = person === 'dan' ? 'Dan' : 'Brent';

    const openBets   = bets.filter(b => b.status === 'pending');
    const exposure   = stats.pending; // their wager amount at risk
    const netIn      = stats.deposited - stats.received;
    const pnlClass   = stats.sharedPnl >= 0 ? 'stat-positive' : 'stat-negative';
    const totalWithResult = stats.sharedWon + stats.sharedLost;
    const winRate    = totalWithResult > 0 ? Math.round(stats.sharedWon / totalWithResult * 100) : 0;
    const record     = `${stats.sharedWon}W – ${stats.sharedLost}L · ${winRate}%`;
    const personTxs  = transactions.filter(t => t.person === person);

    const container  = document.getElementById(`${person}-content`);
    container.innerHTML = `
      <div class="person-hero person-hero-${person}">
        <div class="person-hero-label">Equity</div>
        <div class="person-bankroll">${BetMath.fmt(equity)}</div>
        <div class="person-hero-sub">
          ${exposure > 0
            ? `${BetMath.fmt(exposure)} at risk · ${openBets.length} open bet${openBets.length > 1 ? 's' : ''}`
            : 'no open bets'}
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Deposited</div>
          <div class="stat-value">${BetMath.fmt(stats.deposited)}</div>
          ${stats.received > 0 ? `<div class="stat-sub">${BetMath.fmt(stats.received)} paid out</div>` : '<div class="stat-sub">none paid out</div>'}
        </div>
        <div class="stat-card">
          <div class="stat-label">Net In</div>
          <div class="stat-value">${BetMath.fmt(netIn)}</div>
          <div class="stat-sub">deposits – payouts</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bet P&amp;L</div>
          <div class="stat-value ${pnlClass}">${stats.sharedPnl >= 0 ? '+' : ''}${BetMath.fmt(stats.sharedPnl)}</div>
          <div class="stat-sub">${record}</div>
        </div>
        <div class="stat-card stat-card-equity">
          <div class="stat-label">If Cashed Out</div>
          <div class="stat-value">${BetMath.fmt(equity)}</div>
          <div class="stat-sub">current equity</div>
        </div>
      </div>

      <div class="section-label">${name}'s Transactions</div>
      ${personTxs.length === 0
        ? '<div class="empty-state">No transactions yet</div>'
        : personTxs.map(t => this.txCardHTML(t)).join('')}
    `;
  },

  txCardHTML(t) {
    const typeLabels = { deposit: 'Deposit', withdrawal: 'Withdrawal', disbursement: 'Received' };
    const isIn  = t.type === 'deposit' || t.type === 'disbursement';
    const book  = t.sportsbooks?.name || '';
    const sub   = t.type === 'disbursement' ? 'from bucket' : (book ? `· ${book}` : '');
    return `
      <div class="tx-card">
        <div class="tx-left">
          <div class="tx-type-label">${typeLabels[t.type] || t.type}</div>
          <div class="tx-detail">${sub}</div>
          ${t.notes ? `<div class="tx-notes">${t.notes}</div>` : ''}
        </div>
        <div class="tx-amount ${isIn ? 'text-green' : 'text-red'}">
          ${isIn ? '+' : '-'}${BetMath.fmt(t.amount)}
        </div>
      </div>
    `;
  },

  // ─── Stats View ────────────────────────────────────────

  renderStats() {
    const { bets } = this.state;
    const won    = bets.filter(b => b.status === 'won').length;
    const lost   = bets.filter(b => b.status === 'lost').length;
    const push   = bets.filter(b => b.status === 'push').length;
    const open   = bets.filter(b => b.status === 'pending').length;
    const settled = won + lost + push;
    const winPct  = settled > 0 ? Math.round(won / settled * 100) : 0;

    // Group by sport
    const bySport = {};
    bets.forEach(b => {
      const s = b.sport || 'OTHER';
      if (!bySport[s]) bySport[s] = { total: 0, won: 0, lost: 0 };
      bySport[s].total++;
      if (b.status === 'won')  bySport[s].won++;
      if (b.status === 'lost') bySport[s].lost++;
    });
    const sportRows = Object.entries(bySport).sort((a, b) => b[1].total - a[1].total);
    const maxSport  = sportRows[0]?.[1].total || 1;

    // Group by sportsbook
    const byBook = {};
    bets.forEach(b => {
      const name = b.sportsbooks?.name || 'Unknown';
      if (!byBook[name]) byBook[name] = { total: 0, won: 0, lost: 0 };
      byBook[name].total++;
      if (b.status === 'won')  byBook[name].won++;
      if (b.status === 'lost') byBook[name].lost++;
    });
    const bookRows = Object.entries(byBook).sort((a, b) => b[1].total - a[1].total);
    const maxBook  = bookRows[0]?.[1].total || 1;

    const barRow = (label, data, max, orange = false) => `
      <div class="stat-bar-row">
        <div class="stat-bar-label">${label}</div>
        <div class="stat-bar-track">
          <div class="stat-bar-fill ${orange ? 'stat-bar-fill-orange' : ''}" style="width:${Math.round(data.total/max*100)}%"></div>
        </div>
        <div class="stat-bar-count">${data.total}</div>
        <div class="stat-bar-wr">${data.won + data.lost > 0 ? Math.round(data.won/(data.won+data.lost)*100) + '%' : '—'}</div>
      </div>
    `;

    const { sportsbooks, transactions } = this.state;
    const bucket    = BetMath.bucketBalance(transactions);
    const sbTotal   = BetMath.sportsbookTotal(sportsbooks);
    const totalPool = sbTotal + bucket;

    document.getElementById('stats-content').innerHTML = `
      <div class="perf-card" id="perf-card-tap">
        <div class="perf-card-top">
          <div>
            <div class="perf-label">Pool Performance</div>
            <div class="perf-growth" id="perf-growth-text">Loading chart...</div>
          </div>
          <span class="perf-caret">›</span>
        </div>
        <div class="perf-chart-wrap">
          <canvas id="mini-chart"></canvas>
        </div>
      </div>

      <div class="stats-hero">
        <div class="sh-stat">
          <div class="sh-num">${bets.length}</div>
          <div class="sh-lbl">Total Bets</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num">${won}<span class="sh-w">W</span> ${lost}<span class="sh-l">L</span>${push > 0 ? ` ${push}<span>P</span>` : ''}</div>
          <div class="sh-lbl">Record</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num ${winPct >= 30 ? 'text-green' : ''}">${winPct}%</div>
          <div class="sh-lbl">Win Rate</div>
        </div>
      </div>

      ${open > 0 ? `<div class="sh-open-row"><span class="badge badge-pending">${open} open</span> bets pending settlement</div>` : ''}

      <div class="section-label">By Sport</div>
      <div class="card">
        <div class="stat-bar-header">
          <span></span><span></span><span class="stat-bar-count">Bets</span><span class="stat-bar-wr">W%</span>
        </div>
        ${sportRows.map(([sport, data]) => barRow(sport, data, maxSport)).join('')}
      </div>

      <div class="section-label mt-12">By Sportsbook</div>
      <div class="card">
        <div class="stat-bar-header">
          <span></span><span></span><span class="stat-bar-count">Bets</span><span class="stat-bar-wr">W%</span>
        </div>
        ${bookRows.map(([name, data]) => barRow(name.replace('theScore Bet', 'Score'), data, maxBook, true)).join('')}
      </div>

      <div class="section-label mt-12">Bankroll</div>
      <div class="card">
        ${sportsbooks.map(sb => `
          <div class="bankroll-row">
            <span class="bankroll-name">${sb.name}</span>
            <span class="bankroll-val">${BetMath.fmt(sb.current_balance)}</span>
          </div>
        `).join('')}
        ${bucket > 0 ? `
          <div class="bankroll-row">
            <span class="bankroll-name">Bucket <span class="bankroll-sub">(withdrawn, not disbursed)</span></span>
            <span class="bankroll-val">${BetMath.fmt(bucket)}</span>
          </div>
        ` : ''}
        <div class="bankroll-total-row">
          <span class="bankroll-total-label">Total Pool</span>
          <span class="bankroll-total-val">${BetMath.fmt(totalPool)}</span>
        </div>
      </div>

      <div class="pool-actions">
        <button class="action-btn" id="stats-log-btn">+ Log Transaction</button>
      </div>
      <button class="action-btn" style="width:100%;margin-bottom:32px" id="stats-snap-btn">+ Add Snapshot</button>
    `;

    document.getElementById('stats-log-btn')?.addEventListener('click', () => this.showLogTransactionModal());
    document.getElementById('stats-snap-btn')?.addEventListener('click', () => this.showAddSnapshotModal());
    document.getElementById('perf-card-tap')?.addEventListener('click', () => this.showChartModal());
    this._renderPerfCard();
  },

  // ─── Charts ────────────────────────────────────────────

  _renderPerfCard() {
    const { snapshots, transactions } = this.state;
    if (!snapshots || snapshots.length < 2) {
      const el = document.getElementById('perf-growth-text');
      if (el) el.textContent = 'Add snapshots to see chart';
      return;
    }

    const first   = parseFloat(snapshots[0].cash);
    const current = parseFloat(snapshots[snapshots.length - 1].cash);
    const pct     = ((current - first) / first * 100).toFixed(0);
    const el      = document.getElementById('perf-growth-text');
    if (el) el.textContent = `${BetMath.fmt(first)} → ${BetMath.fmt(current)}  ·  +${pct}%`;

    const canvas = document.getElementById('mini-chart');
    if (!canvas) return;

    if (this._miniChart) { this._miniChart.destroy(); this._miniChart = null; }

    const ctx      = canvas.getContext('2d');
    const cashLine = snapshots.map(s => parseFloat(s.cash));
    const grad     = ctx.createLinearGradient(0, 0, 0, 70);
    grad.addColorStop(0, 'rgba(107,47,160,0.55)');
    grad.addColorStop(1, 'rgba(107,47,160,0)');

    this._miniChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: snapshots.map(() => ''),
        datasets: [{ data: cashLine, borderColor: '#9b6fd0', backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 900, easing: 'easeInOutQuart' },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
  },

  showChartModal() {
    const { snapshots, transactions } = this.state;

    if (!snapshots || snapshots.length === 0) {
      this.showModal(`
        <div class="modal-header">Performance</div>
        <div class="empty-state">No snapshots yet. Add one to start tracking.</div>
        <button class="btn-orange-full" id="add-snap-btn">+ Add Snapshot</button>
        <button class="btn-cancel-modal" id="modal-cancel">Close</button>
      `);
      document.getElementById('add-snap-btn').addEventListener('click', () => { this.hideModal(); setTimeout(() => this.showAddSnapshotModal(), 120); });
      document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
      return;
    }

    const peak     = Math.max(...snapshots.map(s => parseFloat(s.cash)));
    const first    = parseFloat(snapshots[0].cash);
    const last     = parseFloat(snapshots[snapshots.length - 1].cash);
    const totalDep = transactions.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount), 0);
    const totalWdr = transactions.filter(t => t.type === 'withdrawal').reduce((s, t) => s + parseFloat(t.amount), 0);
    const pct      = ((last - first) / first * 100).toFixed(0);

    this.showModal(`
      <div class="modal-drag"></div>
      <div class="chart-modal-header">
        <div>
          <div class="chart-modal-title">Pool Performance</div>
          <div class="chart-modal-sub">Sep 2025 – Today</div>
        </div>
        <button class="btn-add-snap-sm" id="add-snap-btn">+ Snapshot</button>
      </div>

      <div class="chart-stats-row">
        <div class="chart-stat">
          <div class="chart-stat-label">Peak</div>
          <div class="chart-stat-val text-gold">${BetMath.fmt(peak)}</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Growth</div>
          <div class="chart-stat-val text-green">+${pct}%</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Deposited</div>
          <div class="chart-stat-val">${BetMath.fmt(totalDep)}</div>
        </div>
        <div class="chart-stat">
          <div class="chart-stat-label">Withdrawn</div>
          <div class="chart-stat-val text-red">${BetMath.fmt(totalWdr)}</div>
        </div>
      </div>

      <div class="full-chart-wrap">
        <canvas id="full-chart"></canvas>
      </div>

      <div class="section-label" style="margin-top:16px">Book Breakdown</div>
      <div class="snap-table-wrap">
        ${this._buildSnapshotTable(snapshots)}
      </div>

      <button class="btn-cancel-modal" id="modal-cancel">Close</button>
    `);

    // Remove the auto-injected drag handle (showModal adds one, we have our own layout)
    document.querySelector('.modal-drag')?.remove();

    document.getElementById('add-snap-btn').addEventListener('click', () => {
      this.hideModal();
      setTimeout(() => this.showAddSnapshotModal(), 120);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());

    requestAnimationFrame(() => this._renderFullChart(snapshots, transactions));
  },

  _buildSnapshotTable(snapshots) {
    const books = [...new Set(snapshots.flatMap(s => Object.keys(s.book_balances || {})))];
    const rows  = [...snapshots].reverse().map(s => {
      const d    = new Date(s.snapshot_date + 'T12:00:00');
      const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
      const cols = books.map(b => {
        const val = s.book_balances?.[b];
        return `<td>${val != null ? BetMath.fmt(val) : '—'}</td>`;
      }).join('');
      return `<tr><td class="snap-date">${date}</td>${cols}<td class="snap-cash">${BetMath.fmt(s.cash)}</td></tr>`;
    }).join('');

    const headers = books.map(b => `<th>${b.replace('theScore Bet', 'Score')}</th>`).join('');
    return `
      <div class="snap-table-scroll">
        <table class="snap-table">
          <thead><tr><th>Date</th>${headers}<th>Cash</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  },

  _renderFullChart(snapshots, transactions) {
    const canvas = document.getElementById('full-chart');
    if (!canvas || !window.Chart) return;
    if (this._fullChart) { this._fullChart.destroy(); this._fullChart = null; }

    const ctx      = canvas.getContext('2d');
    const labels   = snapshots.map(s => {
      const d = new Date(s.snapshot_date + 'T12:00:00');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const cashLine = snapshots.map(s => parseFloat(s.cash));

    // Deposits + withdrawals per period
    const depositBars = [], withdrawalBars = [];
    for (let i = 0; i < snapshots.length; i++) {
      const from = i === 0 ? new Date('2025-09-01') : new Date(snapshots[i-1].snapshot_date + 'T23:59:59');
      const to   = new Date(snapshots[i].snapshot_date + 'T23:59:59');
      const deps = transactions.filter(t => t.type === 'deposit'    && new Date(t.created_at) >= from && new Date(t.created_at) <= to).reduce((s, t) => s + parseFloat(t.amount), 0);
      const wdrs = transactions.filter(t => t.type === 'withdrawal' && new Date(t.created_at) >= from && new Date(t.created_at) <= to).reduce((s, t) => s + parseFloat(t.amount), 0);
      depositBars.push(deps);
      withdrawalBars.push(wdrs);
    }

    const grad = ctx.createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, 'rgba(107,47,160,0.6)');
    grad.addColorStop(1, 'rgba(107,47,160,0.02)');

    this._fullChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line', label: 'Pool Balance',
            data: cashLine,
            borderColor: '#9b6fd0', backgroundColor: grad,
            fill: true, tension: 0.4, borderWidth: 2.5,
            pointBackgroundColor: '#c9a44a', pointBorderColor: '#c9a44a',
            pointRadius: 5, pointHoverRadius: 7,
            yAxisID: 'y', order: 0,
          },
          {
            type: 'bar', label: 'Deposits',
            data: depositBars,
            backgroundColor: 'rgba(34,197,94,0.35)', borderColor: 'rgba(34,197,94,0.65)',
            borderWidth: 1, borderRadius: 4,
            yAxisID: 'y2', order: 1,
          },
          {
            type: 'bar', label: 'Withdrawn',
            data: withdrawalBars.map(w => -w),
            backgroundColor: 'rgba(216,82,0,0.35)', borderColor: 'rgba(216,82,0,0.65)',
            borderWidth: 1, borderRadius: 4,
            yAxisID: 'y2', order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 700, easing: 'easeInOutQuart' },
        scales: {
          y: {
            position: 'left',
            grid: { color: 'rgba(28,28,50,0.9)' },
            border: { color: '#1c1c32' },
            ticks: { color: '#6a6880', font: { size: 11 }, callback: v => '$' + (v/1000).toFixed(0) + 'k' },
          },
          y2: {
            position: 'right',
            grid: { display: false },
            ticks: { color: '#6a6880', font: { size: 10 }, callback: v => '$' + Math.abs(v/1000).toFixed(1) + 'k' },
          },
          x: {
            grid: { color: 'rgba(28,28,50,0.5)' },
            border: { color: '#1c1c32' },
            ticks: { color: '#6a6880', font: { size: 10 }, maxRotation: 35 },
          },
        },
        plugins: {
          legend: {
            labels: { color: '#ede9f8', font: { size: 12 }, usePointStyle: true, pointStyle: 'circle', padding: 14 },
          },
          tooltip: {
            backgroundColor: '#0e0e1c', borderColor: '#6b2fa0', borderWidth: 1,
            titleColor: '#c9a44a', titleFont: { weight: '700' },
            bodyColor: '#ede9f8', padding: 12,
            callbacks: {
              label: c => {
                const v = Math.abs(c.parsed.y);
                const sign = c.dataset.label === 'Withdrawn' ? '-' : '';
                return ` ${c.dataset.label}: ${sign}$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
              },
            },
          },
        },
      },
    });
  },

  showAddSnapshotModal() {
    const today = this.localDateStr();
    const sbInputs = this.state.sportsbooks.map(sb => `
      <div class="form-group">
        <label>${sb.name}</label>
        <input type="number" class="form-input snap-book-input"
               data-id="${sb.id}" data-book="${sb.name}"
               value="${parseFloat(sb.current_balance).toFixed(2)}" step="0.01" inputmode="decimal">
      </div>
    `).join('');

    this.showModal(`
      <div class="modal-header">Add Snapshot</div>
      <div class="modal-sub">Records current balances for the performance chart.</div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="snap-date" class="form-input" value="${today}">
      </div>
      ${sbInputs}
      <div class="form-group">
        <label>At Risk (pending bets total $)</label>
        <input type="number" id="snap-at-risk" class="form-input" value="0" step="0.01" inputmode="decimal">
      </div>
      <button class="btn-primary-full" id="save-snap">Save Snapshot</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    document.getElementById('save-snap').addEventListener('click', async () => {
      const snapshot_date = document.getElementById('snap-date').value;
      const at_risk       = parseFloat(document.getElementById('snap-at-risk').value) || 0;
      const book_balances = {};
      const bookUpdates   = [];
      let cash = 0;
      document.querySelectorAll('.snap-book-input').forEach(inp => {
        const val = parseFloat(inp.value) || 0;
        book_balances[inp.dataset.book] = val;
        cash += val;
        bookUpdates.push({ id: inp.dataset.id, val });
      });
      await DB.addSnapshot({ snapshot_date, cash, at_risk, book_balances });
      await Promise.all(bookUpdates.map(({ id, val }) => DB.updateSportsbookBalance(id, val)));
      await DB.updateSetting('books_last_updated', new Date().toISOString());
      await this.loadData();
      this.hideModal();
      this.render(this.state.view);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  // ─── Modals ────────────────────────────────────────────

  showModal(html) {
    document.getElementById('modal-content').innerHTML = `<div class="modal-drag"></div>` + html;
    document.getElementById('modal').classList.remove('hidden');
  },

  hideModal() {
    document.getElementById('modal').classList.add('hidden');
    document.getElementById('modal-content').innerHTML = '';
  },

  showSettleModal(bet) {
    const boosted     = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
    const totalReturn = BetMath.totalReturn(parseFloat(bet.total_wager), boosted);
    const danReturn   = BetMath.splitReturn(totalReturn, parseFloat(bet.total_wager), parseFloat(bet.his_wager));
    const brentReturn = BetMath.splitReturn(totalReturn, parseFloat(bet.total_wager), parseFloat(bet.my_wager));

    this.showModal(`
      <div class="modal-header">Settle Bet</div>
      <div class="settle-info">
        <div class="settle-title">${bet.sport} · ${bet.description}</div>
        <div class="settle-sub">${bet.sportsbooks?.name} · ${BetMath.fmtOdds(boosted)}${bet.boost_pct > 0 ? ` (+${bet.boost_pct}% boost)` : ''}</div>
        <div class="settle-wagers">
          <span>Total ${BetMath.fmt(bet.total_wager)}</span>
          <span>Dan ${BetMath.fmt(bet.his_wager)}</span>
          <span>Brent ${BetMath.fmt(bet.my_wager)}</span>
        </div>
      </div>
      <div class="settle-if-won">
        <div class="settle-if-label">If Won</div>
        <div class="settle-if-row"><span>Dan</span><strong class="text-green">${BetMath.fmt(danReturn)}</strong></div>
        <div class="settle-if-row"><span>Brent</span><strong class="text-green">${BetMath.fmt(brentReturn)}</strong></div>
        <div class="settle-if-row text-muted" style="font-size:13px"><span>Total return</span><span>${BetMath.fmt(totalReturn)}</span></div>
      </div>
      <div class="settle-btns">
        <button class="btn-settle btn-won"  data-result="won">Won</button>
        <button class="btn-settle btn-lost" data-result="lost">Lost</button>
        <button class="btn-settle btn-push" data-result="push">Push</button>
      </div>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    document.querySelectorAll('.btn-settle').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await DB.settleBet(bet.id, btn.dataset.result);
        await this.loadData();
        this.hideModal();
        this.render(this.state.view);
      });
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showUpdateBalanceModal(sbId, sbName, currentBal) {
    this.showModal(`
      <div class="modal-header">Update Balance</div>
      <div class="modal-sub">${sbName}</div>
      <div class="form-group">
        <label>Current Balance ($)</label>
        <input type="number" id="new-balance" class="form-input" value="${parseFloat(currentBal).toFixed(2)}" step="0.01" inputmode="decimal">
      </div>
      <button class="btn-primary-full" id="save-balance">Save</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);
    const inp = document.getElementById('new-balance');
    inp.focus(); inp.select();
    document.getElementById('save-balance').addEventListener('click', async () => {
      const val = parseFloat(inp.value);
      if (isNaN(val)) return;
      await DB.updateSportsbookBalance(sbId, val);
      await DB.updateSetting('books_last_updated', new Date().toISOString());
      await this.loadData();
      this.hideModal();
      this.render(this.state.view);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showManageBooksModal() {
    const sbRows = this.state.sportsbooks.map(sb => `
      <div class="sb-card">
        <div>
          <div class="sb-card-name">${sb.name}</div>
          <div class="sb-card-balance">${BetMath.fmt(sb.current_balance)}</div>
        </div>
        <button class="btn-update" data-sb-id="${sb.id}" data-sb-name="${sb.name}" data-sb-bal="${sb.current_balance}">Update</button>
      </div>
    `).join('');

    this.showModal(`
      <div class="modal-header">Sportsbooks</div>
      <div style="margin-bottom:16px">${sbRows}</div>
      <button class="btn-orange-full" id="add-sb-btn">+ Add Sportsbook</button>
      <button class="btn-cancel-modal" id="modal-cancel">Done</button>
    `);

    document.querySelectorAll('[data-sb-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.hideModal();
        setTimeout(() => this.showUpdateBalanceModal(btn.dataset.sbId, btn.dataset.sbName, btn.dataset.sbBal), 100);
      });
    });
    document.getElementById('add-sb-btn').addEventListener('click', () => {
      this.hideModal();
      setTimeout(() => this.showAddSportsbookModal(), 100);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showAddSportsbookModal() {
    this.showModal(`
      <div class="modal-header">Add Sportsbook</div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="new-sb-name" class="form-input" placeholder="ESPN Bet, DraftKings…">
      </div>
      <div class="form-group">
        <label>Current Balance ($)</label>
        <input type="number" id="new-sb-balance" class="form-input" value="0" step="0.01" inputmode="decimal">
      </div>
      <button class="btn-primary-full" id="save-sb">Add</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);
    document.getElementById('new-sb-name').focus();
    document.getElementById('save-sb').addEventListener('click', async () => {
      const name = document.getElementById('new-sb-name').value.trim();
      const bal  = parseFloat(document.getElementById('new-sb-balance').value) || 0;
      if (!name) return;
      await DB.addSportsbook(name, bal);
      await this.loadData();
      this.hideModal();
      this.render(this.state.view);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showEditBetModal(bet) {
    const placedDate = bet.placed_at ? this.localDateStr(new Date(bet.placed_at)) : this.localDateStr();
    const sbOptions  = this.state.sportsbooks.map(sb =>
      `<option value="${sb.id}" ${sb.id === bet.sportsbook_id ? 'selected' : ''}>${sb.name}</option>`
    ).join('');

    this.showModal(`
      <div class="modal-header">Edit Bet</div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="edit-date" class="form-input" value="${placedDate}">
      </div>
      <div class="form-group">
        <label>Sport</label>
        <input type="text" id="edit-sport" class="form-input" value="${bet.sport}" autocapitalize="characters" spellcheck="false">
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="edit-desc" class="form-input" value="${bet.description}" spellcheck="false">
      </div>
      <div class="form-group">
        <label>Sportsbook</label>
        <select id="edit-book" class="form-input">${sbOptions}</select>
      </div>
      <div class="form-group">
        <label>Base Odds (e.g. +150 or -110)</label>
        <input type="number" id="edit-odds" class="form-input" value="${bet.base_odds}" inputmode="numeric">
      </div>
      <div class="form-group">
        <label>Boost %</label>
        <input type="number" id="edit-boost" class="form-input" value="${parseFloat(bet.boost_pct)}" step="0.1" inputmode="decimal">
      </div>
      <div class="form-group">
        <label>Total Wager ($)</label>
        <input type="number" id="edit-total" class="form-input" value="${parseFloat(bet.total_wager).toFixed(2)}" step="0.01" inputmode="decimal">
      </div>
      <div class="form-group">
        <label>Dan Wager ($)</label>
        <input type="number" id="edit-dan" class="form-input" value="${parseFloat(bet.his_wager).toFixed(2)}" step="0.01" inputmode="decimal">
      </div>
      <div class="form-group">
        <label>Brent Wager ($)</label>
        <input type="number" id="edit-brent" class="form-input" value="${parseFloat(bet.my_wager).toFixed(2)}" step="0.01" inputmode="decimal">
      </div>
      <div id="edit-bet-error" class="parse-error" style="display:none;margin-bottom:12px"></div>
      <button class="btn-primary-full" id="save-edit-bet">Save Changes</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    document.getElementById('save-edit-bet').addEventListener('click', async () => {
      const placedAt    = document.getElementById('edit-date').value;
      const sport       = document.getElementById('edit-sport').value.trim().toUpperCase();
      const description = document.getElementById('edit-desc').value.trim();
      const sbId        = document.getElementById('edit-book').value;
      const base_odds   = parseInt(document.getElementById('edit-odds').value);
      const boost_pct   = parseFloat(document.getElementById('edit-boost').value) || 0;
      const total_wager = parseFloat(document.getElementById('edit-total').value);
      const his_wager   = parseFloat(document.getElementById('edit-dan').value);
      const my_wager    = parseFloat(document.getElementById('edit-brent').value);
      const errEl       = document.getElementById('edit-bet-error');

      if (!description || isNaN(total_wager) || total_wager <= 0) {
        errEl.textContent = 'Description and a valid total wager are required.';
        errEl.style.display = 'block';
        return;
      }
      if (Math.abs(his_wager + my_wager - total_wager) > 0.02) {
        errEl.textContent = `Wagers don't add up: Dan $${his_wager} + Brent $${my_wager} ≠ $${total_wager}`;
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';

      const btn = document.getElementById('save-edit-bet');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        await DB.updateBet(bet.id, {
          sport, description, sportsbook_id: sbId,
          base_odds, boost_pct, total_wager,
          his_wager, my_wager,
          placed_at: new Date(placedAt + 'T12:00:00').toISOString(),
        });
        DB.logActivity(this.state.currentUser, 'bet_edited', {
          bet_id: bet.id, sport, description,
        });
        await this.loadData();
        this.hideModal();
        this.render(this.state.view);
      } catch (err) {
        errEl.textContent = 'Save failed: ' + err.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Save Changes';
      }
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  // defaultType: 'deposit' | 'withdrawal' | 'disbursement'
  showLogTransactionModal(defaultType = 'deposit') {
    const { sportsbooks } = this.state;
    const sbOptions = sportsbooks.map(sb => `<option value="${sb.id}">${sb.name}</option>`).join('');

    this.showModal(`
      <div class="modal-header">Log Transaction</div>
      <div class="form-group">
        <label>Type</label>
        <select id="tx-type" class="form-input">
          <option value="deposit"      ${defaultType==='deposit'      ?'selected':''}>Deposit — person → sportsbook</option>
          <option value="withdrawal"   ${defaultType==='withdrawal'   ?'selected':''}>Withdrawal — sportsbook → bucket</option>
          <option value="disbursement" ${defaultType==='disbursement' ?'selected':''}>Payout — bucket → person</option>
        </select>
      </div>
      <div class="form-group" id="tx-person-group">
        <label>Person</label>
        <select id="tx-person" class="form-input">
          <option value="dan">Dan</option>
          <option value="brent">Brent</option>
        </select>
      </div>
      <div class="form-group" id="tx-sportsbook-group">
        <label>Sportsbook</label>
        <select id="tx-sportsbook" class="form-input">${sbOptions}</select>
      </div>
      <div class="form-group">
        <label>Amount ($)</label>
        <input type="number" id="tx-amount" class="form-input" placeholder="0.00" step="0.01" inputmode="decimal">
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <input type="text" id="tx-notes" class="form-input" placeholder="">
      </div>
      <button class="btn-primary-full" id="save-tx">Save</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    // Show/hide fields based on type
    const updateFields = () => {
      const type = document.getElementById('tx-type').value;
      const personGroup = document.getElementById('tx-person-group');
      const sbGroup     = document.getElementById('tx-sportsbook-group');
      // withdrawal: no person needed (goes to bucket)
      personGroup.style.display = type === 'withdrawal' ? 'none' : 'block';
      // disbursement: no sportsbook
      sbGroup.style.display     = type === 'disbursement' ? 'none' : 'block';
    };
    document.getElementById('tx-type').addEventListener('change', updateFields);
    updateFields();

    document.getElementById('save-tx').addEventListener('click', async () => {
      const type   = document.getElementById('tx-type').value;
      const person = document.getElementById('tx-person')?.value;
      const sbId   = document.getElementById('tx-sportsbook')?.value;
      const amount = parseFloat(document.getElementById('tx-amount').value);
      const notes  = document.getElementById('tx-notes').value.trim() || null;

      if (!amount || amount <= 0) return;

      const tx = { type, amount, notes };
      if (type !== 'withdrawal') tx.person = person || 'brent';
      else tx.person = 'brent'; // default for withdrawals
      if (type !== 'disbursement') tx.sportsbook_id = sbId || null;

      await DB.addTransaction(tx);
      DB.logActivity(this.state.currentUser, 'transaction_added', { type, amount, person: tx.person });
      await this.loadData();
      this.hideModal();
      this.render(this.state.view);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },
};

// ─── Boot ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // Bottom nav
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => App.navigate(btn.dataset.view));
  });

  // Header reload button
  document.getElementById('header-reload').addEventListener('click', async () => {
    const btn = document.getElementById('header-reload');
    btn.classList.add('reloading');
    btn.disabled = true;
    try {
      await App.loadData();
      App.render(App.state.view);
    } finally {
      btn.classList.remove('reloading');
      btn.disabled = false;
    }
  });

  // Bet filters
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      App.state.betFilter = tab.dataset.filter;
      App.renderBets();
    });
  });


  // Modal backdrop dismiss
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target.id === 'modal') App.hideModal();
  });
});
