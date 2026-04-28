const App = {
  state: {
    view: 'pool',
    betFilter: 'pending',
    betBookFilter: 'all',
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
    statsTab: 'overview',  // 'overview' | 'daily'
    reconDate: null,       // selected date for daily recon (YYYY-MM-DD)
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
    const titles = { pool: 'Honeypot', bets: 'Bets', brent: 'Brent', dan: 'Dan', stats: 'Stats' };
    document.getElementById('header-title').textContent = titles[view] || view;
    this.render(view);
  },

  render(view) {
    const map = {
      pool:  () => this.renderPool(),
      bets:  () => this.renderBets(),
      brent: () => this.renderPerson('brent'),
      dan:   () => this.renderPerson('dan'),
      stats: () => this.renderStats(),
    };
    if (!map[view]) return;
    try {
      map[view]();
    } catch (e) {
      console.error(`render(${view}) failed:`, e);
      const containers = { pool: 'pool-content', bets: 'bets-list', brent: 'brent-content', dan: 'dan-content', stats: 'stats-content' };
      const el = containers[view] ? document.getElementById(containers[view]) : null;
      if (el) el.innerHTML = `<div class="empty-state" style="color:var(--red)">Error loading view: ${e.message}</div>`;
    }
  },

  // ─── Pool View ─────────────────────────────────────────

  renderPool() {
    const { sportsbooks, bets, transactions } = this.state;

    const totalSb   = BetMath.sportsbookTotal(sportsbooks);
    const bank      = BetMath.bankBalance(transactions);
    const totalPool = totalSb + bank;

    const brentEq  = BetMath.personEquity(transactions, bets, 'brent');
    const danEq    = BetMath.personEquity(transactions, bets, 'dan');
    const totalEq  = brentEq + danEq;
    // Normalize against actual pool so Brent + Dan always = 100%
    const brentDisplay = totalEq > 0 ? totalPool * (brentEq / totalEq) : totalPool / 2;
    const danDisplay   = totalPool - brentDisplay;
    const brentPct = totalPool > 0 ? (brentDisplay / totalPool * 100).toFixed(1) : '0.0';
    const danPct   = totalPool > 0 ? (danDisplay   / totalPool * 100).toFixed(1) : '0.0';

    const settledBets = bets.filter(b => b.status !== 'pending');
    const allTimePnl  = BetMath.poolBetPnl(settledBets) + BetMath.poolAdjustment(transactions);
    const pnl7        = BetMath.rollingPnl(bets, 7);
    const pnl30       = BetMath.rollingPnl(bets, 30);
    const openBets    = bets.filter(b => b.status === 'pending');

    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : '';
    const sign   = v => v >= 0 ? '+' : '';

    const dayStrip = [5,4,3,2,1].map(i => {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const db      = BetMath.dayBets(bets, i);
      const pnl     = BetMath.poolBetPnl(db);
      const won     = db.filter(b => b.status === 'won').length;
      const lost    = db.filter(b => b.status === 'lost').length;
      const push    = db.filter(b => b.status === 'push').length;
      const hasData = db.length > 0;
      const label   = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      const rec     = [won > 0 ? `${won}W` : '', lost > 0 ? `${lost}L` : '', push > 0 ? `${push}P` : ''].filter(Boolean).join(' ');
      return `<div class="day-box">
        <div class="day-box-label">${label}</div>
        <div class="day-box-pnl ${pnlCls(pnl)}">${hasData ? sign(pnl) + BetMath.fmt(pnl) : '—'}</div>
        <div class="day-box-rec">${rec || (hasData ? '—' : '')}</div>
      </div>`;
    }).join('');

    document.getElementById('pool-content').innerHTML = `
      <div class="pool-hero">
        <div class="pool-label">Pool Total</div>
        <div class="pool-amount">${BetMath.fmt(totalPool)}</div>
        <div class="pool-sub ${pnlCls(allTimePnl)}">${sign(allTimePnl)}${BetMath.fmt(allTimePnl)} all-time P&amp;L</div>
      </div>

      <div class="equity-row">
        <div class="equity-card equity-card-brent">
          <div class="equity-name">Brent</div>
          <div class="equity-amount">${BetMath.fmt(brentDisplay)}</div>
          <div class="equity-risk">${brentPct}% of pool</div>
        </div>
        <div class="equity-card equity-card-dan">
          <div class="equity-name">Dan</div>
          <div class="equity-amount">${BetMath.fmt(danDisplay)}</div>
          <div class="equity-risk">${danPct}% of pool</div>
        </div>
      </div>

      <div class="hp-metrics-grid">
        <div class="hp-metric hp-metric-total">
          <div class="hp-metric-label">In Sportsbooks</div>
          <div class="hp-metric-value">${BetMath.fmt(totalSb)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">In Bank</div>
          <div class="hp-metric-value ${bank > 0 ? 'text-gold' : ''}">${BetMath.fmt(bank)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">7-Day P&amp;L</div>
          <div class="hp-metric-value ${pnlCls(pnl7)}">${sign(pnl7)}${BetMath.fmt(pnl7)}</div>
        </div>
        <div class="hp-metric">
          <div class="hp-metric-label">30-Day P&amp;L</div>
          <div class="hp-metric-value ${pnlCls(pnl30)}">${sign(pnl30)}${BetMath.fmt(pnl30)}</div>
        </div>
      </div>

      <div class="pool-actions">
        <button class="action-btn" id="btn-money-moves">+ Money Moves</button>
        <button class="action-btn" id="btn-manage-books">Manage Books</button>
      </div>

      <div class="section-label">Last 5 Days</div>
      <div class="day-strip">${dayStrip}</div>

      ${openBets.length > 0 ? `
        <div class="section-label">Open Bets <span class="badge badge-pending">${openBets.length}</span></div>
        ${openBets.map(b => this.hpBetRowHTML(b)).join('')}
      ` : `<div class="hp-no-open">All bets settled ✓</div>`}
    `;

    this.attachBetCardHandlers();
    document.getElementById('btn-money-moves')?.addEventListener('click', () => this.showLogTransactionModal());
    document.getElementById('btn-manage-books')?.addEventListener('click', () => this.showManageBooksModal());
  },

  // ─── Honeypot Bet Row ───────────────────────────────────

  hpBetRowHTML(b) {
    const boosted   = BetMath.boostedOdds(parseInt(b.base_odds), parseFloat(b.boost_pct));
    const baseOdds  = parseInt(b.base_odds);
    const boostPct  = parseFloat(b.boost_pct);
    const sportColors = { NBA:'sport-nba', NFL:'sport-nfl', NHL:'sport-nhl', MLB:'sport-mlb', NCAAB:'sport-ncaab', CBB:'sport-ncaab', CFB:'sport-cfb', NCAAF:'sport-cfb' };
    const sportCls  = sportColors[b.sport] || 'sport-other';
    const date      = new Date(b.placed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const oddsHtml = boostPct > 0
      ? `<span class="br-odds"><span class="br-odds-base">${BetMath.fmtOdds(baseOdds)}</span><span class="br-odds-arrow">›</span><span class="br-odds-boosted">${BetMath.fmtOdds(boosted)}</span><span class="boost-tag-xs">+${boostPct}%</span></span>`
      : `<span class="br-odds"><span class="br-odds-boosted">${BetMath.fmtOdds(boosted)}</span></span>`;

    return `
      <div class="bet-row bet-row-pending" data-bet-id="${b.id}">
        <div class="bet-row-info">
          <div class="bet-row-l1">
            <span class="br-book">${b.sportsbooks?.name?.replace('theScore Bet', 'Score') || ''}</span>
            <span class="bet-row-sport-badge ${sportCls}">${b.sport}</span>
            <span class="bet-row-desc">${b.description}</span>
          </div>
          <div class="bet-row-l2">
            <span class="br-date">${date}</span>
            <span class="br-sep">·</span>
            ${oddsHtml}
          </div>
        </div>
        <div class="bet-row-action">
          <div class="settle-grid">
            <button class="settle-btn settle-w"   data-id="${b.id}" data-result="won">W</button>
            <button class="settle-btn settle-l"   data-id="${b.id}" data-result="lost">L</button>
            <button class="settle-btn settle-p"   data-id="${b.id}" data-result="push">P</button>
            <button class="settle-btn settle-del" data-id="${b.id}" data-result="delete">×</button>
          </div>
        </div>
      </div>
    `;
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
        ` : `
          <div class="settle-inline">
            <button class="settle-btn settle-del" data-id="${bet.id}" data-result="delete">×</button>
          </div>
        `}
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
      actionHtml = `
        <span class="badge ${cls}">${lbl}</span>
        <button class="settle-btn settle-del" data-id="${b.id}" data-result="delete" title="Delete bet">×</button>`;
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
        <div class="bet-row-action br-action-col">
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
      if (bet.status === 'pending') {
        await this._adjustBookBalance(bet.sportsbook_id, parseFloat(bet.total_wager));
      }
      DB.logActivity(this.state.currentUser, 'bet_deleted', {
        bet_id: bet.id, sport: bet.sport, description: bet.description, sportsbook: bet.sportsbooks?.name,
      });
    } else {
      await DB.settleBet(betId, result);
      await this._adjustBookBalance(bet.sportsbook_id, this._betSettleDelta(bet, result));
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
        await this._adjustBookBalance(entry.bet.sportsbook_id, -parseFloat(entry.bet.total_wager));
      } else {
        await DB.unsettleBet(entry.bet.id);
        await this._adjustBookBalance(entry.bet.sportsbook_id, -this._betSettleDelta(entry.bet, entry.result));
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

  // Returns the sportsbook balance delta when a bet settles
  _betSettleDelta(bet, result) {
    if (result === 'lost') return 0;
    const boosted = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct) || 0);
    return result === 'won'
      ? BetMath.totalReturn(parseFloat(bet.total_wager), boosted)
      : parseFloat(bet.total_wager); // push: refund wager
  },

  async _adjustBookBalance(sbId, delta) {
    if (!sbId || delta === 0) return;
    const sb = this.state.sportsbooks.find(s => s.id === sbId);
    if (!sb) return;
    await DB.updateSportsbookBalance(sbId, parseFloat(sb.current_balance) + delta);
  },

  // ─── Bets View ─────────────────────────────────────────

  renderBets() {
    const filter     = this.state.betFilter;
    const bookFilter = this.state.betBookFilter;

    document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));

    const bookRow = document.getElementById('book-filter-row');
    const list    = document.getElementById('bets-list');

    if (filter === 'activity') {
      bookRow.hidden = true;
      list.innerHTML = this.renderActivityFeed();
      return;
    }

    const books = this.state.sportsbooks;
    bookRow.hidden = false;
    bookRow.innerHTML = `<div class="book-filter-tabs">${
      [{ id: 'all', name: 'All Books' }, ...books]
        .map(b => `<button class="book-filter-tab${bookFilter === String(b.id) ? ' active' : ''}" data-book="${b.id}">${b.name?.replace('theScore Bet', 'Score') ?? b.name}</button>`)
        .join('')
    }</div>`;

    bookRow.querySelectorAll('.book-filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.betBookFilter = btn.dataset.book;
        this.renderBets();
      });
    });

    let filtered = filter === 'all' ? this.state.bets : this.state.bets.filter(b => b.status === filter);
    if (bookFilter !== 'all') {
      filtered = filtered.filter(b => String(b.sportsbook_id) === bookFilter);
    }

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

  // ─── Person View (Brent / Dan) ────────────────────────

  renderPerson(person) {
    const { bets, transactions, sportsbooks } = this.state;
    const norm = p => BetMath._norm(p);

    const name  = person === 'dan' ? 'Dan' : 'Brent';
    const field = person === 'dan' ? 'his_wager' : 'my_wager';

    const totalSb   = BetMath.sportsbookTotal(sportsbooks);
    const bank      = BetMath.bankBalance(transactions);
    const totalPool = totalSb + bank;
    const equity    = BetMath.personEquity(transactions, bets, person);
    const pct       = totalPool > 0 ? (equity / totalPool * 100).toFixed(1) : '0.0';

    // Receipt breakdown
    const deposited = transactions
      .filter(t => norm(t.person) === person && t.type === 'deposit')
      .reduce((s, t) => s + parseFloat(t.amount), 0);

    const paidOut = transactions
      .filter(t => norm(t.person) === person && (t.type === 'disbursement' || t.type === 'payout'))
      .reduce((s, t) => s + parseFloat(t.amount), 0);

    const betPnl = BetMath.personBetPnl(bets, field) + BetMath.personAdjustment(transactions, person);

    // Pending exposure
    const pendingBets = bets.filter(b => b.status === 'pending');
    const pendingAmt  = pendingBets.reduce((s, b) => s + parseFloat(b[field]), 0);

    // Rolling P&L
    const cutoff7  = new Date(); cutoff7.setDate(cutoff7.getDate() - 7);   cutoff7.setHours(0,0,0,0);
    const cutoff30 = new Date(); cutoff30.setDate(cutoff30.getDate() - 30); cutoff30.setHours(0,0,0,0);
    const pnl7  = BetMath.personBetPnl(bets.filter(b => new Date(b.placed_at) >= cutoff7),  field);
    const pnl30 = BetMath.personBetPnl(bets.filter(b => new Date(b.placed_at) >= cutoff30), field);

    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : '';
    const sign   = v => v >= 0 ? '+' : '';

    const dayStrip = [5,4,3,2,1].map(i => {
      const db      = BetMath.dayBets(bets, i);
      const pnl     = BetMath.personBetPnl(db, field);
      const won     = db.filter(b => b.status === 'won').length;
      const lost    = db.filter(b => b.status === 'lost').length;
      const push    = db.filter(b => b.status === 'push').length;
      const hasData = db.length > 0;
      const d = new Date(); d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      const rec   = [won > 0 ? `${won}W` : '', lost > 0 ? `${lost}L` : '', push > 0 ? `${push}P` : ''].filter(Boolean).join(' ');
      return `<div class="day-box">
        <div class="day-box-label">${label}</div>
        <div class="day-box-pnl ${pnlCls(pnl)}">${hasData ? sign(pnl) + BetMath.fmt(pnl) : '—'}</div>
        <div class="day-box-rec">${rec || (hasData ? '—' : '')}</div>
      </div>`;
    }).join('');

    const personTxs = transactions.filter(t => norm(t.person) === person);

    document.getElementById(`${person}-content`).innerHTML = `
      <div class="person-hero person-hero-${person}">
        <div class="person-hero-label">${name}</div>
        <div class="person-bankroll">${BetMath.fmt(equity)}</div>
        <div class="person-hero-sub">${pct}% of pool</div>
      </div>

      <div class="person-receipt">
        <div class="person-receipt-title">How You Got Here</div>
        <div class="person-receipt-row">
          <span class="person-receipt-label">Deposited</span>
          <span class="person-receipt-amt">${BetMath.fmt(deposited)}</span>
        </div>
        <div class="person-receipt-row">
          <span class="person-receipt-label">Bet P&amp;L</span>
          <span class="person-receipt-amt ${pnlCls(betPnl)}">${sign(betPnl)}${BetMath.fmt(betPnl)}</span>
        </div>
        ${paidOut > 0 ? `
        <div class="person-receipt-divider"></div>
        <div class="person-receipt-row person-receipt-row-muted">
          <span class="person-receipt-label">Paid Out</span>
          <span class="person-receipt-amt">(${BetMath.fmt(paidOut)})</span>
        </div>` : ''}
        <div class="person-receipt-divider person-receipt-divider-strong"></div>
        <div class="person-receipt-row person-receipt-total">
          <span class="person-receipt-label">$ Bag</span>
          <span class="person-receipt-amt">${BetMath.fmt(equity)}</span>
        </div>
      </div>

      ${pendingAmt > 0 ? `
      <div class="person-pending-bar">
        <span class="person-pending-label">Pending</span>
        <span class="person-pending-text">${pendingBets.length} open bet${pendingBets.length !== 1 ? 's' : ''} · ${BetMath.fmt(pendingAmt)} at risk</span>
      </div>` : ''}

      <div class="person-perf-row">
        <div class="person-perf-chip">
          <span class="person-perf-chip-label">7-Day P&amp;L</span>
          <span class="person-perf-chip-val ${pnlCls(pnl7)}">${sign(pnl7)}${BetMath.fmt(pnl7)}</span>
        </div>
        <div class="person-perf-chip">
          <span class="person-perf-chip-label">30-Day P&amp;L</span>
          <span class="person-perf-chip-val ${pnlCls(pnl30)}">${sign(pnl30)}${BetMath.fmt(pnl30)}</span>
        </div>
      </div>

      <div class="section-label">Last 5 Days</div>
      <div class="day-strip">${dayStrip}</div>

      <div class="section-label">${name}'s Transactions</div>
      ${personTxs.length === 0
        ? '<div class="empty-state">No transactions yet</div>'
        : personTxs.map(t => this.txCardHTML(t)).join('')}
    `;
  },

  txCardHTML(t) {
    const typeLabels = { deposit: 'Deposit', withdrawal: 'To Bank', redeployment: 'Redeployment', disbursement: 'Paid Out', payout: 'Paid Out' };
    const book = t.sportsbooks?.name || '';
    const sub  = t.type === 'withdrawal'    ? (book ? `from ${book}` : '')
               : t.type === 'redeployment'  ? (book ? `bank → ${book}` : 'bank → sportsbook')
               : t.type === 'disbursement'  ? 'from bank'
               : (book ? `· ${book}` : '');
    const amtCls = t.type === 'deposit' ? 'text-green' : t.type === 'disbursement' ? 'text-muted' : '';
    const prefix = t.type === 'deposit' ? '+' : '';
    const dateStr = t.created_at
      ? new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    return `
      <div class="tx-card">
        <div class="tx-left">
          <div class="tx-type-label">${typeLabels[t.type] || t.type}</div>
          <div class="tx-detail">${[sub, dateStr].filter(Boolean).join(' · ')}</div>
          ${t.notes ? `<div class="tx-notes">${t.notes}</div>` : ''}
        </div>
        <div class="tx-amount ${amtCls}">
          ${prefix}${BetMath.fmt(t.amount)}
        </div>
      </div>
    `;
  },

  // ─── Stats View ────────────────────────────────────────

  renderStats() {
    const tab = this.state.statsTab;

    // Render tab bar first, then delegate
    const tabBar = `
      <div class="stats-inner-tabs">
        <button class="stats-inner-tab ${tab === 'overview' ? 'active' : ''}" data-tab="overview">Overview</button>
        <button class="stats-inner-tab ${tab === 'daily' ? 'active' : ''}" data-tab="daily">Daily</button>
      </div>
    `;

    if (tab === 'daily') {
      document.getElementById('stats-content').innerHTML = tabBar + '<div id="recon-content"></div>';
      document.querySelectorAll('.stats-inner-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          this.state.statsTab = btn.dataset.tab;
          this.renderStats();
        });
      });
      this.renderRecon();
      return;
    }

    const { bets, snapshots, sportsbooks, transactions } = this.state;
    const totalSb = BetMath.sportsbookTotal(sportsbooks);
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

    document.getElementById('stats-content').innerHTML = tabBar + `
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

      <div class="stats-action-row">
        <button class="btn-stats-action" id="stats-snap-btn">+ Snapshot</button>
        <button class="btn-stats-action btn-stats-action-tx" id="stats-tx-btn">+ Money Moves</button>
        <button class="btn-stats-action" id="stats-books-btn">Manage Books</button>
      </div>

      <div class="section-label">Sportsbook Balances</div>
      <div class="card">
        ${sportsbooks.map(sb => `
          <div class="bankroll-row">
            <span class="bankroll-name">${sb.name.replace('theScore Bet', 'Score')}</span>
            <span class="bankroll-val">${BetMath.fmt(sb.current_balance)}</span>
          </div>
        `).join('')}
        <div class="bankroll-total-row">
          <span class="bankroll-total-label">Total in Books</span>
          <span class="bankroll-total-val">${BetMath.fmt(totalSb)}</span>
        </div>
      </div>

      <div class="section-label mt-12">By Sport</div>
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
    `;

    document.querySelectorAll('.stats-inner-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.statsTab = btn.dataset.tab;
        this.renderStats();
      });
    });
    document.getElementById('stats-snap-btn')?.addEventListener('click', () => this.showAddSnapshotModal());
    document.getElementById('stats-tx-btn')?.addEventListener('click', () => this.showLogTransactionModal());
    document.getElementById('stats-books-btn')?.addEventListener('click', () => this.showManageBooksModal());
    document.getElementById('perf-card-tap')?.addEventListener('click', () => this.showChartModal());
    this._renderPerfCard();
  },

  // ─── Daily Recon ───────────────────────────────────────

  renderRecon() {
    const { bets, sportsbooks } = this.state;
    const today = this.localDateStr();

    // Build last 5 days (today first)
    const days = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today + 'T12:00:00');
      d.setDate(d.getDate() - i);
      days.push(this.localDateStr(d));
    }

    if (!this.state.reconDate || !days.includes(this.state.reconDate)) {
      this.state.reconDate = today;
    }
    const selDate = this.state.reconDate;

    // Date pills
    const pillLabel = (dateStr) => {
      if (dateStr === today) return 'Today';
      const d = new Date(dateStr + 'T12:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };

    const pillsHtml = days.map(d => `
      <button class="recon-pill ${d === selDate ? 'active' : ''}" data-date="${d}">
        ${pillLabel(d)}
      </button>
    `).join('');

    // Filter bets for selected date
    const dayBets = bets.filter(b => b.placed_at && b.placed_at.split('T')[0] === selDate);

    // Group by sportsbook
    const byBook = {};
    dayBets.forEach(b => {
      const name = b.sportsbooks?.name || 'Unknown';
      if (!byBook[name]) byBook[name] = { bets: [], total: 0, pending: 0, won: 0, lost: 0, push: 0 };
      byBook[name].bets.push(b);
      byBook[name].total += parseFloat(b.total_wager) || 0;
      byBook[name][b.status] = (byBook[name][b.status] || 0) + 1;
    });

    const bookEntries = Object.entries(byBook).sort((a, b) => b[1].total - a[1].total);
    const totalWager  = dayBets.reduce((s, b) => s + (parseFloat(b.total_wager) || 0), 0);

    const statusBadge = (count, type) => count > 0
      ? `<span class="recon-badge recon-badge-${type}">${count}${type === 'pending' ? ' open' : type === 'won' ? ' W' : type === 'lost' ? ' L' : ' P'}</span>`
      : '';

    const bookCards = bookEntries.map(([name, data]) => `
      <div class="recon-book-row">
        <div class="recon-book-left">
          <div class="recon-book-name">${name.replace('theScore Bet', 'Score')}</div>
          <div class="recon-book-badges">
            ${statusBadge(data.pending, 'pending')}
            ${statusBadge(data.won, 'won')}
            ${statusBadge(data.lost, 'lost')}
            ${statusBadge(data.push, 'push')}
          </div>
        </div>
        <div class="recon-book-right">
          <div class="recon-book-count">${data.bets.length} bet${data.bets.length !== 1 ? 's' : ''}</div>
          <div class="recon-book-wager">${BetMath.fmt(data.total)}</div>
        </div>
      </div>
    `).join('');

    const content = dayBets.length === 0
      ? `<div class="recon-empty">No bets entered for this day</div>`
      : `
        <div class="card recon-card">
          ${bookCards}
          <div class="recon-total-row">
            <span class="recon-total-label">${dayBets.length} total bets</span>
            <span class="recon-total-val">${BetMath.fmt(totalWager)}</span>
          </div>
        </div>
      `;

    document.getElementById('recon-content').innerHTML = `
      <div class="recon-pills">${pillsHtml}</div>
      <div class="section-label">${selDate === today ? 'Today' : new Date(selDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</div>
      ${content}
    `;

    document.querySelectorAll('.recon-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.reconDate = btn.dataset.date;
        this.renderRecon();
      });
    });
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
                return ` ${c.dataset.label}: ${sign}${BetMath.fmt(v)}`;
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
      this.navigate('pool');
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
        await this._adjustBookBalance(bet.sportsbook_id, this._betSettleDelta(bet, btn.dataset.result));
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

  showLogTransactionModal(defaultType = 'deposit') {
    const { sportsbooks } = this.state;
    const sbOptions = sportsbooks.map(sb => `<option value="${sb.id}">${sb.name}</option>`).join('');

    this.showModal(`
      <div class="modal-header">Money Moves</div>
      <div class="form-group">
        <label>Type</label>
        <select id="tx-type" class="form-input">
          <option value="deposit"      ${defaultType==='deposit'      ?'selected':''}>Deposit — new money in</option>
          <option value="withdrawal"   ${defaultType==='withdrawal'   ?'selected':''}>Withdrawal — sportsbook → bank</option>
          <option value="redeployment" ${defaultType==='redeployment' ?'selected':''}>Redeploy — bank → sportsbook</option>
          <option value="payout"       ${defaultType==='payout'       ?'selected':''}>Payout — bank → person</option>
        </select>
      </div>
      <div class="form-group" id="tx-person-group">
        <label>Person</label>
        <select id="tx-person" class="form-input">
          <option value="brent">Brent</option>
          <option value="dan">Dan</option>
        </select>
      </div>
      <div class="form-group" id="tx-book-group">
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
      <div id="tx-error" style="display:none;color:var(--red);font-size:13px;margin-bottom:12px;text-align:center"></div>
      <button class="btn-primary-full" id="save-tx">Save</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    const updateFields = () => {
      const type = document.getElementById('tx-type').value;
      // deposit: person + book  |  withdrawal: book only  |  redeploy: book only  |  payout: person only
      document.getElementById('tx-person-group').style.display = (type === 'withdrawal' || type === 'redeployment') ? 'none' : 'block';
      document.getElementById('tx-book-group').style.display   = type === 'payout' ? 'none' : 'block';
    };
    document.getElementById('tx-type').addEventListener('change', updateFields);
    updateFields();

    document.getElementById('save-tx').addEventListener('click', async () => {
      const type   = document.getElementById('tx-type').value;
      const person = document.getElementById('tx-person')?.value || 'brent';
      const sbId   = document.getElementById('tx-sportsbook')?.value;
      const amount = parseFloat(document.getElementById('tx-amount').value);
      const notes  = document.getElementById('tx-notes').value.trim() || null;
      const errEl  = document.getElementById('tx-error');

      if (!amount || amount <= 0) {
        errEl.textContent = 'Enter a valid amount.';
        errEl.style.display = 'block';
        return;
      }

      const btn = document.getElementById('save-tx');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        const tx = { type, amount, notes };
        // deposit/payout are attributed to a person; withdrawal/redeploy are pool-level
        tx.person = (type === 'deposit' || type === 'payout') ? person : 'brent';
        if (type !== 'payout') tx.sportsbook_id = sbId || null;

        await DB.addTransaction(tx);

        // Auto-adjust sportsbook balance
        if (type === 'deposit' || type === 'redeployment') {
          await this._adjustBookBalance(sbId, amount);
        } else if (type === 'withdrawal') {
          await this._adjustBookBalance(sbId, -amount);
        }

        DB.logActivity(this.state.currentUser, 'transaction_added', { type, amount, person: tx.person });
        await this.loadData();
        this.hideModal();
        this.render(this.state.view);
      } catch (err) {
        console.error('Money Moves save failed:', err);
        errEl.textContent = 'Save failed: ' + (err.message || err);
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Save';
      }
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
