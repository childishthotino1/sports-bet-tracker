const App = {
  state: {
    view: 'pool',
    betFilter: 'pending',
    betBookFilter: 'all',
    sportsbooks: [],
    bets: [],
    transactions: [],
    settings: {},
    snapshots: [],
    activityLog: [],
    v1: null,               // lazy-loaded {bets, transactions, snapshots}
    loaded: false,
    undoStack: [],          // [{type, bet, result}] — last 3 actions
    currentUser: 'brent',   // 'brent' | 'dan' — set on PIN entry
  },

  _miniChart: null,
  _fullChart: null,
  _v1Chart: null,

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
    const titles = { pool: 'Home', bets: 'Bets', brent: 'Brent', dan: 'Dan', summary: 'Summary', v1: 'Season 1' };
    document.getElementById('header-title').textContent = titles[view] || view;
    // FAB only where adding a bet makes sense
    document.getElementById('fab-add-bet').classList.toggle('hidden', !['pool', 'bets'].includes(view));
    this.render(view);
  },

  render(view) {
    const map = {
      pool:    () => this.renderPool(),
      bets:    () => this.renderBets(),
      brent:   () => this.renderPerson('brent'),
      dan:     () => this.renderPerson('dan'),
      summary: () => this.renderSummary(),
      v1:      () => this.renderV1(),
    };
    if (!map[view]) return;
    try {
      map[view]();
    } catch (e) {
      console.error(`render(${view}) failed:`, e);
      const containers = { pool: 'pool-content', bets: 'bets-list', brent: 'brent-content', dan: 'dan-content', summary: 'summary-content', v1: 'v1-content' };
      const el = containers[view] ? document.getElementById(containers[view]) : null;
      if (el) el.innerHTML = `<div class="empty-state" style="color:var(--red)">Error loading view: ${e.message}</div>`;
    }
  },

  // ─── Pool View ─────────────────────────────────────────

  renderPool() {
    const { sportsbooks, bets, transactions } = this.state;

    const totalSb = BetMath.sportsbookTotal(sportsbooks);
    const bank    = BetMath.bankBalance(transactions);

    // Real ledger values — never rescaled to force-fit the shared cash total.
    const brentEq = BetMath.personEquity(transactions, bets, 'brent');
    const danEq   = BetMath.personEquity(transactions, bets, 'dan');

    const allTimePnl = BetMath.poolBetPnl(bets) + BetMath.poolAdjustment(transactions);
    const openBets   = bets.filter(b => b.status === 'pending');
    const atRisk     = openBets.reduce((s, b) => s + parseFloat(b.total_wager), 0);

    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : '';
    const sign   = v => v >= 0 ? '+' : '';

    // Dan's pending exposure — money of his currently riding on open bets
    const danAtRisk = openBets.reduce((s, b) => s + parseFloat(b.his_wager), 0);

    const isFresh = bets.length === 0 && transactions.length === 0;

    // Dan-first: the number this app exists to answer is "what is Dan owed?"
    document.getElementById('pool-content').innerHTML = `
      <div class="pool-hero pool-hero-dan">
        <div class="pool-label">Dan's Equity</div>
        <div class="pool-amount">${BetMath.fmt(danEq)}</div>
        <div class="pool-sub">what Dan's owed if we settled today${danAtRisk > 0 ? ` · ${BetMath.fmt(danAtRisk)} riding` : ''}</div>
      </div>

      ${isFresh ? `
      <div class="fresh-card">
        <div class="fresh-title">Fresh season 🐣</div>
        <div class="fresh-sub">Log Dan's deposit to fund the books, then add your first shared bet with the + button.</div>
      </div>` : ''}

      <div class="metric-grid">
        <div class="metric">
          <div class="metric-label">My Cut</div>
          <div class="metric-value">${BetMath.fmt(brentEq)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Shared in Books</div>
          <div class="metric-value">${BetMath.fmt(totalSb)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Shared in Bank</div>
          <div class="metric-value ${bank > 0 ? 'text-gold' : ''}">${BetMath.fmt(bank)}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Season P&amp;L</div>
          <div class="metric-value ${pnlCls(allTimePnl)}">${sign(allTimePnl)}${BetMath.fmt(allTimePnl)}</div>
        </div>
      </div>

      <div class="pool-actions">
        <button class="action-btn action-btn-primary" id="btn-money-moves">＄ Money Moves</button>
        <button class="action-btn" id="btn-manage-books">Manage Books</button>
      </div>

      ${openBets.length > 0 ? `
        <div class="section-label">Open Bets <span class="badge badge-pending">${openBets.length}</span><span class="section-label-right">${BetMath.fmt(atRisk)} at risk</span></div>
        ${openBets.map(b => this.betRowHTML(b)).join('')}
      ` : `<div class="all-settled">All bets settled ✓</div>`}
    `;

    this.attachBetRowHandlers();
    document.getElementById('btn-money-moves')?.addEventListener('click', () => this.showLogTransactionModal());
    document.getElementById('btn-manage-books')?.addEventListener('click', () => this.showManageBooksModal());
  },

  // ─── Bet Row ───────────────────────────────────────────

  _sportClass(sport) {
    const map = { NBA:'sport-nba', NFL:'sport-nfl', NHL:'sport-nhl', MLB:'sport-mlb', NCAAB:'sport-ncaab', CBB:'sport-ncaab', CFB:'sport-cfb', NCAAF:'sport-cfb' };
    return map[(sport || '').toUpperCase()] || 'sport-other';
  },

  betRowHTML(b) {
    const boosted    = BetMath.boostedOdds(parseInt(b.base_odds), parseFloat(b.boost_pct));
    const isPending  = b.status === 'pending';
    const baseOdds   = parseInt(b.base_odds);
    const boostPct   = parseFloat(b.boost_pct);
    const danWager   = parseFloat(b.his_wager);
    const brentWager = parseFloat(b.my_wager);
    const totalW     = parseFloat(b.total_wager);
    const date       = new Date(b.placed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    let oddsHtml = '';
    if (baseOdds !== 0) {
      oddsHtml = boostPct > 0
        ? `<span class="br-sep">·</span><span class="br-odds"><span class="br-odds-base">${BetMath.fmtOdds(baseOdds)}</span><span class="br-odds-arrow">›</span><span class="br-odds-boosted">${BetMath.fmtOdds(boosted)}</span><span class="boost-tag-xs">+${boostPct}%</span></span>`
        : `<span class="br-sep">·</span><span class="br-odds"><span class="br-odds-boosted">${BetMath.fmtOdds(boosted)}</span></span>`;
    }

    const wagerParts = [];
    if (danWager > 0)   wagerParts.push(`<span class="br-dan">D ${BetMath.fmt(danWager)}</span>`);
    if (brentWager > 0) wagerParts.push(`<span class="br-brent">B ${BetMath.fmt(brentWager)}</span>`);
    const wagersHtml = wagerParts.join(`<span class="br-sep">·</span>`);

    let payoutHtml = '';
    if (b.status === 'won') {
      const totalRet    = BetMath.totalReturn(totalW, boosted);
      const parts = [];
      if (danWager > 0)   parts.push(`<span class="br-profit">D +${BetMath.fmt(BetMath.splitReturn(totalRet, totalW, danWager) - danWager)}</span>`);
      if (brentWager > 0) parts.push(`<span class="br-profit">B +${BetMath.fmt(BetMath.splitReturn(totalRet, totalW, brentWager) - brentWager)}</span>`);
      payoutHtml = `<div class="bet-row-l3 br-payout-row">${parts.join(`<span class="br-sep">·</span>`)}</div>`;
    }

    let actionHtml;
    if (isPending) {
      actionHtml = `
        <div class="settle-grid">
          <button class="settle-btn settle-w" data-id="${b.id}" data-result="won">W</button>
          <button class="settle-btn settle-l" data-id="${b.id}" data-result="lost">L</button>
          <button class="settle-btn settle-p" data-id="${b.id}" data-result="push">P</button>
        </div>`;
    } else {
      const cls = { won: 'badge-won', lost: 'badge-lost', push: 'badge-push', void: 'badge-void' }[b.status] || '';
      const lbl = { won: 'WON', lost: 'LOST', push: 'PUSH', void: 'VOID' }[b.status] || b.status;
      actionHtml = `<span class="badge ${cls}">${lbl}</span>`;
    }

    return `
      <div class="bet-row bet-row-${b.status}" data-bet-id="${b.id}">
        <div class="bet-row-info" data-sheet-id="${b.id}">
          <div class="bet-row-l1">
            <span class="bet-row-sport-badge ${this._sportClass(b.sport)}">${b.sport}</span>
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
        <div class="bet-row-action">
          ${actionHtml}
          <button class="br-more-btn" data-sheet-id="${b.id}" title="Manage bet">⋯</button>
        </div>
      </div>
    `;
  },

  attachBetRowHandlers() {
    document.querySelectorAll('.settle-btn[data-result]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        btn.disabled = true;
        await this.handleSettle(btn.dataset.id, btn.dataset.result);
      });
    });
    document.querySelectorAll('[data-sheet-id]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const bet = this.state.bets.find(b => b.id === el.dataset.sheetId);
        if (bet) this.showBetSheet(bet);
      });
    });
  },

  // ─── Bet Actions (settle / void / reopen / delete) ─────

  async handleSettle(betId, result) {
    const bet = this.state.bets.find(b => b.id === betId);
    if (!bet) return;

    this.state.undoStack.unshift({ type: result === 'delete' ? 'delete' : 'settle', bet, result });
    if (this.state.undoStack.length > 3) this.state.undoStack.pop();

    if (result === 'delete') {
      await DB.deleteBet(betId);
      // Only a pending bet's stake is still "in" the book; settled bets
      // already had their delta applied.
      if (bet.status === 'pending') {
        await this._adjustBookBalance(bet.sportsbook_id, parseFloat(bet.total_wager));
      }
      DB.logActivity(this.state.currentUser, 'bet_deleted', {
        bet_id: bet.id, sport: bet.sport, description: bet.description, sportsbook: bet.sportsbooks?.name,
      });
    } else {
      await DB.settleBet(betId, result);
      await this._adjustBookBalance(bet.sportsbook_id, this._betSettleDelta(bet, result));
      DB.logActivity(this.state.currentUser, result === 'void' ? 'bet_voided' : 'bet_settled', {
        bet_id: bet.id, sport: bet.sport, description: bet.description, result, sportsbook: bet.sportsbooks?.name,
      });
    }
    await this.loadData();
    this.render(this.state.view);
    this._showUndoToast();
  },

  async handleReopen(bet) {
    await DB.unsettleBet(bet.id);
    await this._adjustBookBalance(bet.sportsbook_id, -this._betSettleDelta(bet, bet.status));
    DB.logActivity(this.state.currentUser, 'bet_reopened', {
      bet_id: bet.id, sport: bet.sport, description: bet.description, prior: bet.status,
    });
    await this.loadData();
    this.render(this.state.view);
  },

  showBetSheet(bet) {
    const boosted   = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
    const isPending = bet.status === 'pending';
    const statusLbl = { pending: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void' }[bet.status];

    this.showModal(`
      <div class="modal-header">Manage Bet</div>
      <div class="sheet-bet-info">
        <div class="sheet-bet-title"><span class="bet-row-sport-badge ${this._sportClass(bet.sport)}">${bet.sport}</span> ${bet.description}</div>
        <div class="sheet-bet-sub">${bet.sportsbooks?.name || ''} · ${BetMath.fmtOdds(boosted)}${parseFloat(bet.boost_pct) > 0 ? ` (+${parseFloat(bet.boost_pct)}% boost)` : ''} · ${BetMath.fmt(bet.total_wager)} · <span class="badge badge-${bet.status}">${statusLbl}</span></div>
      </div>
      ${isPending ? `
        <div class="settle-btns">
          <button class="btn-settle btn-won"  data-result="won">Won</button>
          <button class="btn-settle btn-lost" data-result="lost">Lost</button>
          <button class="btn-settle btn-push" data-result="push">Push</button>
        </div>` : ''}
      <div class="sheet-actions">
        <button class="sheet-action-btn" id="sheet-edit">✎ &nbsp;Edit Bet</button>
        ${isPending
          ? `<button class="sheet-action-btn" id="sheet-void">⊘ &nbsp;Void Bet <span class="sheet-action-hint">book cancelled it — refund stake</span></button>`
          : `<button class="sheet-action-btn" id="sheet-reopen">↺ &nbsp;Reopen <span class="sheet-action-hint">undo ${statusLbl?.toLowerCase()} and make it open again</span></button>`}
        <button class="sheet-action-btn sheet-action-danger" id="sheet-delete">✕ &nbsp;Delete Bet</button>
      </div>
      <button class="btn-cancel-modal" id="modal-cancel">Close</button>
    `);

    document.querySelectorAll('.btn-settle').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        this.hideModal();
        await this.handleSettle(bet.id, btn.dataset.result);
      });
    });
    document.getElementById('sheet-edit').addEventListener('click', () => {
      this.hideModal();
      setTimeout(() => this.showBetFormModal(bet), 120);
    });
    document.getElementById('sheet-void')?.addEventListener('click', async () => {
      this.hideModal();
      await this.handleSettle(bet.id, 'void');
    });
    document.getElementById('sheet-reopen')?.addEventListener('click', async () => {
      this.hideModal();
      await this.handleReopen(bet);
    });
    document.getElementById('sheet-delete').addEventListener('click', async () => {
      this.hideModal();
      await this.handleSettle(bet.id, 'delete');
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
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
    const labels = { won: 'Won', lost: 'Lost', push: 'Push', void: 'Voided', delete: 'Deleted' };
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
      this.state.undoStack = [];
    }, 5000);
  },

  async _handleUndo() {
    const entry = this.state.undoStack.shift();
    if (!entry) return;

    try {
      if (entry.type === 'delete') {
        await DB.restoreBet(entry.bet);
        if (entry.bet.status === 'pending') {
          await this._adjustBookBalance(entry.bet.sportsbook_id, -parseFloat(entry.bet.total_wager));
        }
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
        this._showUndoToast();
      } else {
        clearTimeout(this._undoTimer);
        document.getElementById('undo-toast')?.classList.remove('visible');
      }
    } catch (err) {
      console.error('Undo failed:', err);
    }
  },

  // Sportsbook balance delta when a pending bet resolves.
  // void behaves like push in the ledger: the stake comes back.
  _betSettleDelta(bet, result) {
    if (result === 'lost') return 0;
    const boosted = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct) || 0);
    return result === 'won'
      ? BetMath.totalReturn(parseFloat(bet.total_wager), boosted)
      : parseFloat(bet.total_wager); // push / void: refund wager
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

    // Only offer filters for books this season's bets actually use
    const usedIds = new Set(this.state.bets.map(b => b.sportsbook_id));
    const books = this.state.sportsbooks.filter(sb => usedIds.has(sb.id));
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
      list.innerHTML = '<div class="empty-state">No bets yet — hit + to add one</div>';
      return;
    }

    list.innerHTML = filtered.map(b => this.betRowHTML(b)).join('');
    this.attachBetRowHandlers();
  },

  renderActivityFeed() {
    const log = this.state.activityLog;
    if (!log.length) return '<div class="empty-state">No recent activity</div>';

    return log.flatMap(entry => {
      const user    = entry.user_name === 'brent' ? 'Brent' : 'Dan';
      const userCls = entry.user_name === 'brent' ? 'act-user-brent' : 'act-user-dan';
      const d       = entry.details || {};
      const time    = this.relativeTime(new Date(entry.created_at));

      if (entry.action === 'bets_placed') {
        return (d.bets || []).map(b => `<div class="activity-row">
            <span class="act-user-badge ${userCls}">${user}</span>
            <div class="act-body">
              <span class="act-label">Added Bet</span>
              <span class="bet-row-sport-badge ${this._sportClass(b.sport)}">${b.sport || ''}</span>
              ${b.sportsbook ? `<span class="act-book">${b.sportsbook}</span>` : ''}
            </div>
            <span class="act-time">${time}</span>
          </div>`);
      }

      if (entry.action === 'bet_settled' && (d.result === 'won' || d.result === 'lost')) {
        const resCls   = d.result === 'won' ? 'act-res-w' : 'act-res-l';
        const resLabel = d.result === 'won' ? 'W' : 'L';
        return [`<div class="activity-row">
          <span class="act-user-badge ${userCls}">${user}</span>
          <div class="act-body">
            <span class="act-label">Marked Bet <span class="act-res ${resCls}">${resLabel}</span></span>
            <span class="bet-row-sport-badge ${this._sportClass(d.sport)}">${d.sport || ''}</span>
            ${d.sportsbook ? `<span class="act-book">${d.sportsbook}</span>` : ''}
          </div>
          <span class="act-time">${time}</span>
        </div>`];
      }

      if (entry.action === 'bet_voided') {
        return [`<div class="activity-row">
          <span class="act-user-badge ${userCls}">${user}</span>
          <div class="act-body">
            <span class="act-label">Voided Bet</span>
            <span class="bet-row-sport-badge ${this._sportClass(d.sport)}">${d.sport || ''}</span>
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

    const deposited = transactions
      .filter(t => norm(t.person) === person && t.type === 'deposit')
      .reduce((s, t) => s + parseFloat(t.amount), 0);

    const paidOut = transactions
      .filter(t => norm(t.person) === person && (t.type === 'disbursement' || t.type === 'payout'))
      .reduce((s, t) => s + parseFloat(t.amount), 0);

    const betPnl = BetMath.personBetPnl(bets, field) + BetMath.personAdjustment(transactions, person);

    const pendingBets = bets.filter(b => b.status === 'pending' && parseFloat(b[field]) > 0);
    const pendingAmt  = pendingBets.reduce((s, b) => s + parseFloat(b[field]), 0);

    const cutoff7  = new Date(); cutoff7.setDate(cutoff7.getDate() - 7);   cutoff7.setHours(0,0,0,0);
    const cutoff30 = new Date(); cutoff30.setDate(cutoff30.getDate() - 30); cutoff30.setHours(0,0,0,0);
    const pnl7  = BetMath.personBetPnl(bets.filter(b => new Date(b.placed_at) >= cutoff7),  field);
    const pnl30 = BetMath.personBetPnl(bets.filter(b => new Date(b.placed_at) >= cutoff30), field);

    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : '';
    const sign   = v => v >= 0 ? '+' : '';

    const statement = this._statementEvents(person);

    document.getElementById(`${person}-content`).innerHTML = `
      <div class="person-hero person-hero-${person}">
        <div class="person-hero-label">${name}</div>
        <div class="person-bankroll">${BetMath.fmt(equity)}</div>
        <div class="person-hero-sub">${pct}% of pool</div>
      </div>

      <div class="person-receipt">
        <div class="person-receipt-title">Season 2 Receipt</div>
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

      <div class="section-label">${name}'s Statement</div>
      ${statement.length === 0
        ? '<div class="empty-state">Nothing yet — deposits and settled bets will show up here</div>'
        : `<div class="card statement-card">
             <div class="stmt-header"><span></span><span class="stmt-delta">+/−</span><span class="stmt-bal">Balance</span></div>
             ${statement.map(e => this.statementRowHTML(e)).join('')}
           </div>`}
    `;
  },

  // Bank-statement view of one person's equity: deposits, their cut of every
  // settled bet, adjustments, payouts — with a running balance. This is the
  // transparency layer for "your money is in my account".
  _statementEvents(person) {
    const { bets, transactions } = this.state;
    const norm  = p => BetMath._norm(p);
    const field = person === 'dan' ? 'his_wager' : 'my_wager';

    const events = [];
    for (const t of transactions) {
      if (norm(t.person) !== person) continue;
      const amt = parseFloat(t.amount);
      if (t.type === 'deposit') {
        events.push({ date: t.created_at, label: 'Deposit', sub: t.sportsbooks?.name || '', delta: amt, kind: 'deposit' });
      } else if (t.type === 'adjustment') {
        events.push({ date: t.created_at, label: 'Adjustment', sub: t.notes || '', delta: amt, kind: 'adjustment' });
      } else if (t.type === 'payout' || t.type === 'disbursement') {
        events.push({ date: t.created_at, label: 'Paid Out', sub: t.notes || '', delta: -amt, kind: 'payout' });
      }
    }
    for (const b of bets) {
      if (BetMath._noPnl(b.status)) continue;      // pending/push/void: no equity change
      if (parseFloat(b[field]) <= 0) continue;      // not their bet
      events.push({
        date: b.settled_at || b.placed_at,
        label: `${b.status === 'won' ? 'Won' : 'Lost'} · ${b.description}`,
        sub: `${b.sport} · ${b.sportsbooks?.name?.replace('theScore Bet', 'Score') || ''}`,
        delta: BetMath.personBetPnl([b], field),
        kind: b.status,
      });
    }

    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    let bal = 0;
    for (const e of events) { bal += e.delta; e.balance = bal; }
    return events.reverse(); // newest first
  },

  statementRowHTML(e) {
    const deltaCls = e.delta > 0 ? 'text-green' : e.delta < 0 ? 'text-red' : 'text-muted';
    const sign     = e.delta >= 0 ? '+' : '';
    const date     = new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `
      <div class="stmt-row">
        <div class="stmt-info">
          <div class="stmt-label">${e.label}</div>
          <div class="stmt-sub">${[date, e.sub].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="stmt-delta ${deltaCls}">${sign}${BetMath.fmt(e.delta)}</div>
        <div class="stmt-bal">${BetMath.fmt(e.balance)}</div>
      </div>
    `;
  },


  // ─── Summary View ──────────────────────────────────────

  _breakdownRows(bets, keyFn) {
    const groups = {};
    bets.forEach(b => {
      const k = keyFn(b) || 'Other';
      if (!groups[k]) groups[k] = [];
      groups[k].push(b);
    });
    return Object.entries(groups)
      .map(([label, list]) => {
        const rec = BetMath.record(list);
        return { label, count: list.length, rec, pnl: BetMath.poolBetPnl(list) };
      })
      .sort((a, b) => b.count - a.count);
  },

  _breakdownHTML(rows) {
    const max = rows[0]?.count || 1;
    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : 'text-muted';
    const sign   = v => v > 0 ? '+' : '';
    return `
      <div class="bd-header"><span></span><span></span><span class="bd-rec">W–L</span><span class="bd-pnl">P&amp;L</span></div>
      ${rows.map(r => `
        <div class="bd-row">
          <div class="bd-label">${r.label.replace('theScore Bet', 'Score')}</div>
          <div class="bd-track"><div class="bd-fill" style="width:${Math.round(r.count / max * 100)}%"></div></div>
          <div class="bd-rec">${r.rec.won}–${r.rec.lost}</div>
          <div class="bd-pnl ${pnlCls(r.pnl)}">${sign(r.pnl)}${BetMath.fmt(r.pnl)}</div>
        </div>`).join('')}
    `;
  },

  renderSummary() {
    const { bets, snapshots, sportsbooks, transactions } = this.state;
    const totalSb = BetMath.sportsbookTotal(sportsbooks);
    // Empty unused books (V1 leftovers) stay out of the day-to-day view;
    // they're still reachable via Manage Books.
    const usedBookIds = new Set(bets.map(b => b.sportsbook_id));
    const activeBooks = sportsbooks.filter(sb => parseFloat(sb.current_balance) !== 0 || usedBookIds.has(sb.id));
    const rec     = BetMath.record(bets);
    const roi     = BetMath.poolRoi(bets);
    const streaks = BetMath.streaks(bets);
    const pnl     = BetMath.poolBetPnl(bets);

    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : '';
    const sign   = v => v >= 0 ? '+' : '';

    const streakChip = streaks.currentType
      ? `<div class="streak-chip ${streaks.currentType === 'won' ? 'streak-hot' : 'streak-cold'}">
           ${streaks.currentType === 'won' ? '🔥' : '🥶'} ${streaks.current}${streaks.currentType === 'won' ? 'W' : 'L'} streak
         </div>`
      : '';

    document.getElementById('summary-content').innerHTML = `
      <div class="perf-card" id="perf-card-tap">
        <div class="perf-card-top">
          <div>
            <div class="perf-label">Season 2 Performance</div>
            <div class="perf-growth" id="perf-growth-text">Loading chart…</div>
          </div>
          <span class="perf-caret">›</span>
        </div>
        <div class="perf-chart-wrap">
          <canvas id="mini-chart"></canvas>
        </div>
      </div>

      <div class="stats-hero">
        <div class="sh-stat">
          <div class="sh-num ${pnlCls(pnl)}">${sign(pnl)}${BetMath.fmt(pnl)}</div>
          <div class="sh-lbl">Bet P&amp;L</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num">${rec.won}<span class="sh-w">W</span> ${rec.lost}<span class="sh-l">L</span>${rec.push > 0 ? ` ${rec.push}<span>P</span>` : ''}</div>
          <div class="sh-lbl">Record</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num">${rec.winPct}%</div>
          <div class="sh-lbl">Win Rate</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num ${pnlCls(roi)}">${sign(roi)}${roi.toFixed(1)}%</div>
          <div class="sh-lbl">ROI</div>
        </div>
      </div>

      <div class="streak-row">
        ${streakChip}
        ${streaks.bestW > 0 ? `<div class="streak-chip">Best run ${streaks.bestW}W</div>` : ''}
        ${rec.pending > 0 ? `<div class="streak-chip"><span class="badge badge-pending">${rec.pending}</span> open</div>` : ''}
        ${rec.void > 0 ? `<div class="streak-chip">${rec.void} voided</div>` : ''}
      </div>

      <div class="stats-action-row">
        <button class="btn-stats-action" id="stats-snap-btn">+ Snapshot</button>
        <button class="btn-stats-action btn-stats-action-alt" id="stats-tx-btn">＄ Money Moves</button>
        <button class="btn-stats-action" id="stats-books-btn">Manage Books</button>
      </div>

      <div class="section-label">Shared Balances</div>
      <div class="card">
        ${(activeBooks.length ? activeBooks : sportsbooks).map(sb => `
          <div class="bankroll-row">
            <span class="bankroll-name">${sb.name.replace('theScore Bet', 'Score')}</span>
            <span class="bankroll-val">${BetMath.fmt(sb.current_balance)}</span>
          </div>
        `).join('')}
        <div class="bankroll-total-row">
          <span class="bankroll-total-label">Total Shared in Books</span>
          <span class="bankroll-total-val">${BetMath.fmt(totalSb)}</span>
        </div>
      </div>

      ${bets.length > 0 ? `
      <div class="section-label mt-12">By Sport</div>
      <div class="card">${this._breakdownHTML(this._breakdownRows(bets, b => (b.sport || '').toUpperCase()))}</div>

      <div class="section-label mt-12">By Sportsbook</div>
      <div class="card">${this._breakdownHTML(this._breakdownRows(bets, b => b.sportsbooks?.name))}</div>
      ` : ''}

      <button class="v1-link-card" id="v1-link">
        <div>
          <div class="v1-link-title">Season 1 · Closed</div>
          <div class="v1-link-sub">Sep 2025 – Aug 2026 · full review</div>
        </div>
        <span class="perf-caret">›</span>
      </button>
    `;

    document.getElementById('stats-snap-btn')?.addEventListener('click', () => this.showAddSnapshotModal());
    document.getElementById('stats-tx-btn')?.addEventListener('click', () => this.showLogTransactionModal());
    document.getElementById('stats-books-btn')?.addEventListener('click', () => this.showManageBooksModal());
    document.getElementById('perf-card-tap')?.addEventListener('click', () => this.showChartModal());
    document.getElementById('v1-link')?.addEventListener('click', () => this.navigate('v1'));
    this._renderPerfCard();
  },

  // ─── V1 Season Review (read-only) ─────────────────────

  async renderV1() {
    const el = document.getElementById('v1-content');
    if (!this.state.v1) {
      el.innerHTML = '<div class="empty-state">Loading Season 1…</div>';
      try {
        this.state.v1 = await DB.getV1Bundle();
      } catch (e) {
        el.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load V1 data: ${e.message}</div>`;
        return;
      }
      if (this.state.view !== 'v1') return; // user navigated away while loading
    }

    const { bets, transactions, snapshots } = this.state.v1;
    const rec     = BetMath.record(bets);
    const pnl     = BetMath.poolBetPnl(bets);
    const streaks = BetMath.streaks(bets);

    const deposits = transactions.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount), 0);
    const payouts  = transactions.filter(t => (t.type === 'payout' || t.type === 'disbursement'));
    const paidBrent = payouts.filter(t => BetMath._norm(t.person) === 'brent').reduce((s, t) => s + parseFloat(t.amount), 0);
    const paidDan   = payouts.filter(t => BetMath._norm(t.person) === 'dan').reduce((s, t) => s + parseFloat(t.amount), 0);
    const totalWagered = bets.reduce((s, b) => s + parseFloat(b.total_wager), 0);
    const totalPaid    = paidBrent + paidDan;
    const adjustments  = BetMath.poolAdjustment(transactions);

    // The season's headline: what actually came back vs. what went in
    const earnings    = totalPaid - deposits;
    const earningsPct = deposits > 0 ? earnings / deposits * 100 : 0;

    const pnlCls = v => v > 0 ? 'text-green' : v < 0 ? 'text-red' : '';
    const sign   = v => v >= 0 ? '+' : '';

    el.innerHTML = `
      <button class="v1-back" id="v1-back">‹ Summary</button>

      <div class="v1-hero">
        <div class="v1-hero-badge">SEASON 1 · CLOSED</div>
        <div class="v1-hero-pnl ${pnlCls(earnings)}">${sign(earnings)}${BetMath.fmt(earnings)}</div>
        <div class="v1-hero-sub">earnings — ${BetMath.fmt(totalPaid)} paid out on ${BetMath.fmt(deposits)} deposited</div>
      </div>

      <div class="stats-hero">
        <div class="sh-stat">
          <div class="sh-num ${pnlCls(earningsPct)}">${sign(earningsPct)}${earningsPct.toFixed(0)}%</div>
          <div class="sh-lbl">Return</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num">${rec.won}<span class="sh-w">W</span> ${rec.lost}<span class="sh-l">L</span>${rec.push > 0 ? ` ${rec.push}<span>P</span>` : ''}</div>
          <div class="sh-lbl">Record</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num">${rec.winPct}%</div>
          <div class="sh-lbl">Win Rate</div>
        </div>
        <div class="sh-stat">
          <div class="sh-num">${streaks.bestW}W</div>
          <div class="sh-lbl">Best Run</div>
        </div>
      </div>

      <div class="section-label">Final Settlement</div>
      <div class="person-receipt">
        <div class="person-receipt-row">
          <span class="person-receipt-label">Total Deposited</span>
          <span class="person-receipt-amt">${BetMath.fmt(deposits)}</span>
        </div>
        <div class="person-receipt-row">
          <span class="person-receipt-label">Bet P&amp;L (${rec.total.toLocaleString()} bets · ${BetMath.fmt(totalWagered)} wagered)</span>
          <span class="person-receipt-amt ${pnlCls(pnl)}">${sign(pnl)}${BetMath.fmt(pnl)}</span>
        </div>
        <div class="person-receipt-row">
          <span class="person-receipt-label">Promos &amp; Adjustments</span>
          <span class="person-receipt-amt ${pnlCls(adjustments)}">${sign(adjustments)}${BetMath.fmt(adjustments)}</span>
        </div>
        <div class="person-receipt-divider"></div>
        <div class="person-receipt-row">
          <span class="person-receipt-label">Paid Out — Brent</span>
          <span class="person-receipt-amt">${BetMath.fmt(paidBrent)}</span>
        </div>
        <div class="person-receipt-row">
          <span class="person-receipt-label">Paid Out — Dan</span>
          <span class="person-receipt-amt">${BetMath.fmt(paidDan)}</span>
        </div>
        <div class="person-receipt-divider person-receipt-divider-strong"></div>
        <div class="person-receipt-row person-receipt-total">
          <span class="person-receipt-label">Net Earnings</span>
          <span class="person-receipt-amt ${pnlCls(earnings)}">${sign(earnings)}${BetMath.fmt(earnings)}</span>
        </div>
        <div class="person-receipt-row person-receipt-row-muted">
          <span class="person-receipt-label">Season closed out</span>
          <span class="person-receipt-amt text-green">✓ $0.00</span>
        </div>
      </div>

      ${snapshots.length > 1 ? `
      <div class="section-label mt-12">Pool Over Time</div>
      <div class="card v1-chart-card">
        <div class="v1-chart-wrap"><canvas id="v1-chart"></canvas></div>
      </div>` : ''}

      <div class="section-label mt-12">By Sport</div>
      <div class="card">${this._breakdownHTML(this._breakdownRows(bets, b => (b.sport || '').toUpperCase()))}</div>

      <div class="section-label mt-12">By Sportsbook</div>
      <div class="card">${this._breakdownHTML(this._breakdownRows(bets, b => b.sportsbooks?.name))}</div>
    `;

    document.getElementById('v1-back').addEventListener('click', () => this.navigate('summary'));
    if (snapshots.length > 1) requestAnimationFrame(() => this._renderV1Chart(snapshots));
  },

  _renderV1Chart(snapshots) {
    const canvas = document.getElementById('v1-chart');
    if (!canvas || !window.Chart) return;
    if (this._v1Chart) { this._v1Chart.destroy(); this._v1Chart = null; }

    const ctx  = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, 'rgba(57,135,229,0.4)');
    grad.addColorStop(1, 'rgba(57,135,229,0)');

    this._v1Chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: snapshots.map(s => new Date(s.snapshot_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
        datasets: [{
          label: 'Pool Balance',
          data: snapshots.map(s => parseFloat(s.cash)),
          borderColor: '#3987e5', backgroundColor: grad,
          fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 6, borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#10141a', borderColor: '#2a323d', borderWidth: 1,
            titleColor: '#9aa7b4', bodyColor: '#f2f5f8', padding: 10,
            callbacks: { label: c => ` ${BetMath.fmt(c.parsed.y)}` },
          },
        },
        scales: {
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, border: { display: false },
               ticks: { color: '#64748b', font: { size: 10 }, callback: v => '$' + (v/1000).toFixed(0) + 'k' } },
          x: { grid: { display: false }, border: { display: false },
               ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 6 } },
        },
      },
    });
  },

  // ─── Season 2 performance charts ───────────────────────

  _renderPerfCard() {
    const { snapshots } = this.state;
    const el = document.getElementById('perf-growth-text');
    if (!snapshots || snapshots.length < 2) {
      if (el) el.textContent = 'Add snapshots to see the chart';
      return;
    }

    const first   = parseFloat(snapshots[0].cash);
    const current = parseFloat(snapshots[snapshots.length - 1].cash);
    const pct     = first > 0 ? ((current - first) / first * 100).toFixed(0) : '0';
    if (el) el.textContent = `${BetMath.fmt(first)} → ${BetMath.fmt(current)}  ·  ${pct >= 0 ? '+' : ''}${pct}%`;

    const canvas = document.getElementById('mini-chart');
    if (!canvas) return;

    if (this._miniChart) { this._miniChart.destroy(); this._miniChart = null; }

    const ctx  = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 70);
    grad.addColorStop(0, 'rgba(57,135,229,0.45)');
    grad.addColorStop(1, 'rgba(57,135,229,0)');

    this._miniChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: snapshots.map(() => ''),
        datasets: [{ data: snapshots.map(s => parseFloat(s.cash)), borderColor: '#3987e5', backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
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
        <button class="btn-primary-full" id="add-snap-btn">+ Add Snapshot</button>
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
    const pct      = first > 0 ? ((last - first) / first * 100).toFixed(0) : '0';

    this.showModal(`
      <div class="chart-modal-header">
        <div>
          <div class="chart-modal-title">Season 2 Performance</div>
          <div class="chart-modal-sub">${new Date(snapshots[0].snapshot_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} – Today</div>
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
          <div class="chart-stat-val ${pct >= 0 ? 'text-green' : 'text-red'}">${pct >= 0 ? '+' : ''}${pct}%</div>
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
    const labels   = snapshots.map(s => new Date(s.snapshot_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    const cashLine = snapshots.map(s => parseFloat(s.cash));

    const depositBars = [], withdrawalBars = [];
    for (let i = 0; i < snapshots.length; i++) {
      const from = i === 0 ? new Date(0) : new Date(snapshots[i-1].snapshot_date + 'T23:59:59');
      const to   = new Date(snapshots[i].snapshot_date + 'T23:59:59');
      const deps = transactions.filter(t => t.type === 'deposit'    && new Date(t.created_at) >= from && new Date(t.created_at) <= to).reduce((s, t) => s + parseFloat(t.amount), 0);
      const wdrs = transactions.filter(t => t.type === 'withdrawal' && new Date(t.created_at) >= from && new Date(t.created_at) <= to).reduce((s, t) => s + parseFloat(t.amount), 0);
      depositBars.push(deps);
      withdrawalBars.push(wdrs);
    }

    const grad = ctx.createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, 'rgba(57,135,229,0.5)');
    grad.addColorStop(1, 'rgba(57,135,229,0.02)');

    this._fullChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line', label: 'Pool Balance',
            data: cashLine,
            borderColor: '#3987e5', backgroundColor: grad,
            fill: true, tension: 0.4, borderWidth: 2.5,
            pointBackgroundColor: '#3987e5', pointBorderColor: '#0b0e12',
            pointBorderWidth: 2, pointRadius: 4, pointHoverRadius: 7,
            yAxisID: 'y', order: 0,
          },
          {
            type: 'bar', label: 'Deposits',
            data: depositBars,
            backgroundColor: 'rgba(12,163,12,0.4)', borderColor: 'rgba(12,163,12,0.7)',
            borderWidth: 1, borderRadius: 4,
            yAxisID: 'y', order: 1,
          },
          {
            type: 'bar', label: 'Withdrawn',
            data: withdrawalBars.map(w => -w),
            backgroundColor: 'rgba(230,103,103,0.4)', borderColor: 'rgba(230,103,103,0.7)',
            borderWidth: 1, borderRadius: 4,
            yAxisID: 'y', order: 2,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 700, easing: 'easeInOutQuart' },
        scales: {
          y: {
            position: 'left',
            grid: { color: 'rgba(255,255,255,0.05)' },
            border: { display: false },
            ticks: { color: '#64748b', font: { size: 11 }, callback: v => '$' + (Math.abs(v) >= 1000 ? (v/1000).toFixed(1) + 'k' : v) },
          },
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 35 },
          },
        },
        plugins: {
          legend: {
            labels: { color: '#f2f5f8', font: { size: 12 }, usePointStyle: true, pointStyle: 'circle', padding: 14 },
          },
          tooltip: {
            backgroundColor: '#10141a', borderColor: '#2a323d', borderWidth: 1,
            titleColor: '#9aa7b4', titleFont: { weight: '700' },
            bodyColor: '#f2f5f8', padding: 12,
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

  // ─── Modals ────────────────────────────────────────────

  showModal(html) {
    document.getElementById('modal-content').innerHTML = `<div class="modal-drag"></div>` + html;
    document.getElementById('modal').classList.remove('hidden');
  },

  hideModal() {
    document.getElementById('modal').classList.add('hidden');
    document.getElementById('modal-content').innerHTML = '';
  },

  // ─── Add / Edit Bet (one form, two modes) ──────────────

  showBetFormModal(bet = null) {
    const isEdit  = !!bet;
    const today   = this.localDateStr();
    const dateVal = isEdit && bet.placed_at ? this.localDateStr(new Date(bet.placed_at)) : today;
    // BetMGM is where nearly all shared bets live — preselect it for new bets
    const selectedId = isEdit ? bet.sportsbook_id : this.state.sportsbooks.find(sb => sb.name === 'BetMGM')?.id;
    const sbOptions = this.state.sportsbooks.map(sb =>
      `<option value="${sb.id}" ${sb.id === selectedId ? 'selected' : ''}>${sb.name}</option>`
    ).join('');

    this.showModal(`
      <div class="modal-header">${isEdit ? 'Edit Bet' : 'Add Bet'}</div>
      <div class="form-row-2">
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="bet-date" class="form-input" value="${dateVal}">
        </div>
        <div class="form-group">
          <label>Sport</label>
          <input type="text" id="bet-sport" class="form-input" value="${isEdit ? bet.sport : ''}" placeholder="NFL" autocapitalize="characters" spellcheck="false">
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="bet-desc" class="form-input" value="${isEdit ? bet.description : ''}" placeholder="Ravens ML" spellcheck="false">
      </div>
      <div class="form-group">
        <label>Sportsbook</label>
        <select id="bet-book" class="form-input">${sbOptions}</select>
      </div>
      <div class="form-row-2">
        <div class="form-group">
          <label>Base Odds</label>
          <input type="number" id="bet-odds" class="form-input" value="${isEdit ? bet.base_odds : ''}" placeholder="+150 / -110" inputmode="numeric">
        </div>
        <div class="form-group">
          <label>Boost %</label>
          <input type="number" id="bet-boost" class="form-input" value="${isEdit ? parseFloat(bet.boost_pct) : 0}" step="0.1" inputmode="decimal">
        </div>
      </div>
      <div class="form-group">
        <label>Total Wager ($)</label>
        <input type="number" id="bet-total" class="form-input" value="${isEdit ? parseFloat(bet.total_wager).toFixed(2) : ''}" placeholder="0.00" step="0.01" inputmode="decimal">
      </div>
      <div class="form-row-2">
        <div class="form-group">
          <label>Dan's Cut ($)</label>
          <input type="number" id="bet-dan" class="form-input" value="${isEdit ? parseFloat(bet.his_wager).toFixed(2) : ''}" placeholder="0.00" step="0.01" inputmode="decimal">
        </div>
        <div class="form-group">
          <label>Brent's Cut</label>
          <input type="text" id="bet-brent" class="form-input" value="${isEdit ? parseFloat(bet.my_wager).toFixed(2) : ''}" disabled>
        </div>
      </div>
      <div id="bet-form-error" class="form-error" style="display:none"></div>
      <button class="btn-primary-full" id="save-bet">${isEdit ? 'Save Changes' : 'Place Bet'}</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    // Brent's cut is always derived: total − Dan
    const syncBrent = () => {
      const total = parseFloat(document.getElementById('bet-total').value) || 0;
      const dan   = parseFloat(document.getElementById('bet-dan').value) || 0;
      document.getElementById('bet-brent').value = (Math.round((total - dan) * 100) / 100).toFixed(2);
    };
    document.getElementById('bet-total').addEventListener('input', syncBrent);
    document.getElementById('bet-dan').addEventListener('input', syncBrent);

    document.getElementById('save-bet').addEventListener('click', async () => {
      const placedAt    = document.getElementById('bet-date').value;
      const sport       = document.getElementById('bet-sport').value.trim().toUpperCase();
      const description = document.getElementById('bet-desc').value.trim();
      const sbId        = document.getElementById('bet-book').value;
      const base_odds   = parseInt(document.getElementById('bet-odds').value);
      const boost_pct   = parseFloat(document.getElementById('bet-boost').value) || 0;
      const total_wager = parseFloat(document.getElementById('bet-total').value);
      const his_wager   = parseFloat(document.getElementById('bet-dan').value) || 0;
      const errEl       = document.getElementById('bet-form-error');

      const fail = msg => { errEl.textContent = msg; errEl.style.display = 'block'; };

      if (!sport || !description) return fail('Sport and description are required.');
      if (isNaN(base_odds) || base_odds === 0) return fail('Enter the base odds (e.g. +150 or -110).');
      if (isNaN(total_wager) || total_wager <= 0) return fail('Enter a valid total wager.');
      if (his_wager < 0 || his_wager > total_wager) return fail("Dan's cut must be between $0 and the total.");
      const my_wager = Math.round((total_wager - his_wager) * 100) / 100;
      errEl.style.display = 'none';

      const btn = document.getElementById('save-bet');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        if (isEdit) {
          // Reconcile book balance for any change to wager/odds/boost/book
          const netEffect = (b, status) =>
            -parseFloat(b.total_wager) + (status === 'pending' ? 0 : this._betSettleDelta(b, status));
          const oldNet = netEffect(bet, bet.status);
          const newNet = netEffect({ total_wager, base_odds, boost_pct }, bet.status);

          if (sbId === bet.sportsbook_id) {
            await this._adjustBookBalance(sbId, newNet - oldNet);
          } else {
            await this._adjustBookBalance(bet.sportsbook_id, -oldNet);
            await this._adjustBookBalance(sbId, newNet);
          }

          await DB.updateBet(bet.id, {
            sport, description, sportsbook_id: sbId,
            base_odds, boost_pct, total_wager,
            his_wager, my_wager,
            placed_at: new Date(placedAt + 'T12:00:00').toISOString(),
          });
          DB.logActivity(this.state.currentUser, 'bet_edited', { bet_id: bet.id, sport, description });
        } else {
          const sbName = this.state.sportsbooks.find(s => s.id === sbId)?.name;
          await DB.addBet({
            sport, description, sportsbook_id: sbId,
            base_odds, boost_pct, total_wager,
            his_wager, my_wager,
            status: 'pending',
            placed_at: placedAt === today ? new Date().toISOString() : new Date(placedAt + 'T12:00:00').toISOString(),
          });
          await this._adjustBookBalance(sbId, -total_wager);
          DB.logActivity(this.state.currentUser, 'bets_placed', {
            bets: [{ sport, sportsbook: sbName }],
          });
        }
        await this.loadData();
        this.hideModal();
        this.render(this.state.view);
      } catch (err) {
        fail('Save failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = isEdit ? 'Save Changes' : 'Place Bet';
      }
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  // ─── Snapshots / Books / Money Moves ───────────────────

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
      <div class="pikkit-warning">⚠️ Enter the <strong>shared</strong> money in each book — not what the sportsbook apps show. Your solo (Pikkit) bets aren't tracked here; differences get split 50/50 with Dan as corrections.</div>
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

      // Reconcile drift as a split adjustment so it lands in both equities
      // instead of silently shifting the pool total.
      const oldCash = this.state.sportsbooks.reduce((s, sb) => s + parseFloat(sb.current_balance), 0);
      const delta = Math.round((cash - oldCash) * 100) / 100;

      await DB.addSnapshot({ snapshot_date, cash, at_risk, book_balances });
      await Promise.all(bookUpdates.map(({ id, val }) => DB.updateSportsbookBalance(id, val)));

      if (delta !== 0) {
        const half      = Math.round((delta / 2) * 100) / 100;
        const otherHalf = delta - half; // absorbs any odd cent
        const notes     = `Snapshot reconciliation ${snapshot_date}`;
        await DB.addTransaction({ type: 'adjustment', person: 'brent', amount: half, notes });
        await DB.addTransaction({ type: 'adjustment', person: 'dan', amount: otherHalf, notes });
      }

      await DB.updateSetting('books_last_updated', new Date().toISOString());
      await this.loadData();
      this.hideModal();
      this.navigate('summary');
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showUpdateBalanceModal(sbId, sbName, currentBal) {
    this.showModal(`
      <div class="modal-header">Update Balance</div>
      <div class="modal-sub">${sbName}</div>
      <div class="pikkit-warning">⚠️ Shared money only — <strong>not</strong> the balance the ${sbName} app shows. Your solo (Pikkit) bets live in the same wallet but aren't tracked here; any difference you enter gets split 50/50 with Dan as a correction.</div>
      <div class="form-group">
        <label>Shared Balance ($)</label>
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
      const delta = Math.round((val - parseFloat(currentBal)) * 100) / 100;
      await DB.updateSportsbookBalance(sbId, val);
      if (delta !== 0) {
        // Log the correction as a pool-level adjustment split evenly
        const half = Math.round((delta / 2) * 100) / 100;
        const otherHalf = delta - half;
        const notes = `Balance correction: ${sbName} ${BetMath.fmt(currentBal)} → ${BetMath.fmt(val)}`;
        await DB.addTransaction({ type: 'adjustment', person: 'brent', amount: half, sportsbook_id: sbId, notes });
        await DB.addTransaction({ type: 'adjustment', person: 'dan', amount: otherHalf, sportsbook_id: sbId, notes });
      }
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
      <button class="btn-secondary-full" id="add-sb-btn">+ Add Sportsbook</button>
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

  showLogTransactionModal(defaultType = 'deposit') {
    const { sportsbooks } = this.state;
    const sbOptions = sportsbooks.map(sb => `<option value="${sb.id}" ${sb.name === 'BetMGM' ? 'selected' : ''}>${sb.name}</option>`).join('');

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
          <option value="dan" selected>Dan</option>
          <option value="brent">Brent</option>
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
      <div id="tx-error" class="form-error" style="display:none"></div>
      <button class="btn-primary-full" id="save-tx">Save</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    const updateFields = () => {
      const type = document.getElementById('tx-type').value;
      document.getElementById('tx-person-group').style.display = (type === 'withdrawal' || type === 'redeployment') ? 'none' : 'block';
      document.getElementById('tx-book-group').style.display   = type === 'payout' ? 'none' : 'block';
    };
    document.getElementById('tx-type').addEventListener('change', updateFields);
    updateFields();

    document.getElementById('save-tx').addEventListener('click', async () => {
      const type   = document.getElementById('tx-type').value;
      const person = document.getElementById('tx-person')?.value || 'dan';
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
        tx.person = (type === 'deposit' || type === 'payout') ? person : 'brent';
        if (type !== 'payout') tx.sportsbook_id = sbId || null;

        await DB.addTransaction(tx);

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

  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => App.navigate(btn.dataset.view));
  });

  document.getElementById('fab-add-bet').addEventListener('click', () => App.showBetFormModal());

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

  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      App.state.betFilter = tab.dataset.filter;
      App.renderBets();
    });
  });

  document.getElementById('modal').addEventListener('click', e => {
    if (e.target.id === 'modal') App.hideModal();
  });
});
