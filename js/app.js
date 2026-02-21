const App = {
  state: {
    view: 'dashboard',
    betFilter: 'pending',
    sportsbooks: [],
    bets: [],
    transactions: [],
    settings: {},
    loaded: false,
  },

  pinEntry: '',

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
    const [sportsbooks, bets, transactions, settings] = await Promise.all([
      DB.getSportsbooks(),
      DB.getBets(),
      DB.getTransactions(),
      DB.getSettings(),
    ]);
    this.state.sportsbooks = sportsbooks;
    this.state.bets = bets;
    this.state.transactions = transactions;
    this.state.settings = settings;
  },

  // ─── PIN ─────────────────────────────────────────────────

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
    if (this.pinEntry.length === 4) {
      setTimeout(() => this.checkPin(), 150);
    }
  },

  updatePinDots() {
    for (let i = 0; i < 4; i++) {
      document.getElementById(`dot-${i}`).classList.toggle('filled', i < this.pinEntry.length);
    }
  },

  async checkPin() {
    if (!this.state.loaded) {
      await this.loadData();
      this.state.loaded = true;
    }
    if (this.pinEntry === this.state.settings.pin) {
      document.getElementById('pin-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      this.navigate('dashboard');
    } else {
      const err = document.getElementById('pin-error');
      err.classList.remove('hidden');
      this.pinEntry = '';
      this.updatePinDots();
      setTimeout(() => err.classList.add('hidden'), 1800);
    }
  },

  // ─── NAVIGATION ──────────────────────────────────────────

  navigate(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    const navBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (navBtn) navBtn.classList.add('active');
    this.state.view = view;
    const titles = { dashboard: 'Dashboard', bets: 'Bets', 'add-bet': 'New Bet', sportsbooks: 'Sportsbooks', transactions: 'Log' };
    document.getElementById('header-title').textContent = titles[view] || view;
    this.render(view);
  },

  render(view) {
    const map = {
      dashboard: () => this.renderDashboard(),
      bets: () => this.renderBets(),
      'add-bet': () => this.renderAddBetForm(),
      sportsbooks: () => this.renderSportsbooks(),
      transactions: () => this.renderTransactions(),
    };
    if (map[view]) map[view]();
  },

  // ─── DASHBOARD ───────────────────────────────────────────

  renderDashboard() {
    const { sportsbooks, bets, transactions, settings } = this.state;
    const friendEquity = BetMath.friendEquity(transactions, bets);
    const friendPending = BetMath.friendPendingExposure(bets);
    const myPending = BetMath.myPendingExposure(bets);
    const totalBalance = BetMath.totalBalance(sportsbooks);
    const myEquity = BetMath.myEquity(totalBalance, friendEquity);
    const pendingBets = bets.filter(b => b.status === 'pending');
    const myName = settings.my_name || 'Me';
    const friendName = settings.friend_name || 'Friend';

    document.getElementById('dashboard-content').innerHTML = `
      <div class="total-bankroll">
        <div class="total-label">Total Bankroll</div>
        <div class="total-amount">${BetMath.fmt(totalBalance)}</div>
      </div>

      <div class="equity-row">
        <div class="equity-card">
          <div class="equity-name">${myName}</div>
          <div class="equity-amount">${BetMath.fmt(myEquity)}</div>
          ${myPending > 0 ? `<div class="equity-risk">At risk: ${BetMath.fmt(myPending)}</div>` : '<div class="equity-risk">&nbsp;</div>'}
        </div>
        <div class="equity-card">
          <div class="equity-name">${friendName}</div>
          <div class="equity-amount">${BetMath.fmt(friendEquity)}</div>
          ${friendPending > 0 ? `<div class="equity-risk">At risk: ${BetMath.fmt(friendPending)}</div>` : '<div class="equity-risk">&nbsp;</div>'}
        </div>
      </div>

      <div class="section-label">Sportsbooks</div>
      <div class="card">
        ${sportsbooks.length === 0 ? '<div class="empty-state">No sportsbooks added</div>' : sportsbooks.map(sb => `
          <div class="sb-row">
            <span class="sb-name">${sb.name}</span>
            <span class="sb-balance">${BetMath.fmt(sb.current_balance)}</span>
          </div>
        `).join('')}
      </div>

      <div class="section-label">
        Open Bets ${pendingBets.length > 0 ? `<span class="badge">${pendingBets.length}</span>` : ''}
      </div>
      ${pendingBets.length === 0
        ? '<div class="empty-state">No open bets</div>'
        : pendingBets.map(b => this.betCardHTML(b)).join('')}
    `;
    this.attachBetCardHandlers();
  },

  // ─── BETS LIST ───────────────────────────────────────────

  renderBets() {
    const filter = this.state.betFilter;
    document.querySelectorAll('.filter-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.filter === filter);
    });
    const filtered = filter === 'all'
      ? this.state.bets
      : this.state.bets.filter(b => b.status === filter);
    document.getElementById('bets-list').innerHTML = filtered.length === 0
      ? '<div class="empty-state">No bets</div>'
      : filtered.map(b => this.betCardHTML(b)).join('');
    this.attachBetCardHandlers();
  },

  betCardHTML(bet) {
    const boosted = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
    const statusLabels = { won: 'WON', lost: 'LOST', push: 'PUSH', pending: 'OPEN' };
    const statusClasses = { won: 'badge-won', lost: 'badge-lost', push: 'badge-push', pending: 'badge-pending' };
    const isPending = bet.status === 'pending';

    let payoutLine = '';
    if (bet.status === 'won') {
      const totalRet = BetMath.totalReturn(parseFloat(bet.total_wager), boosted);
      const hisRet = BetMath.splitReturn(totalRet, parseFloat(bet.total_wager), parseFloat(bet.his_wager));
      const myRet = BetMath.splitReturn(totalRet, parseFloat(bet.total_wager), parseFloat(bet.my_wager));
      payoutLine = `<div class="bet-payout">His: ${BetMath.fmt(hisRet)} · Mine: ${BetMath.fmt(myRet)}</div>`;
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
          <span>His ${BetMath.fmt(bet.his_wager)}</span>
          <span>Mine ${BetMath.fmt(bet.my_wager)}</span>
        </div>
        ${payoutLine}
        ${isPending ? '<div class="tap-hint">Tap to settle</div>' : ''}
      </div>
    `;
  },

  attachBetCardHandlers() {
    document.querySelectorAll('.bet-card-pending').forEach(card => {
      card.addEventListener('click', () => {
        const bet = this.state.bets.find(b => b.id === card.dataset.betId);
        if (bet) this.showSettleModal(bet);
      });
    });
  },

  // ─── ADD BET FORM ────────────────────────────────────────

  renderAddBetForm() {
    const select = document.getElementById('bet-sportsbook');
    select.innerHTML = this.state.sportsbooks.map(sb =>
      `<option value="${sb.id}">${sb.name}</option>`
    ).join('');
  },

  updateBetPreview() {
    const totalWager = parseFloat(document.getElementById('bet-total-wager').value);
    const hisWager = parseFloat(document.getElementById('bet-his-wager').value);
    const oddsVal = parseInt(document.getElementById('bet-odds').value);
    const boostPct = parseFloat(document.getElementById('bet-boost').value) || 0;
    const sign = document.getElementById('odds-sign').textContent.trim();
    const preview = document.getElementById('bet-preview');

    if (!totalWager || !hisWager || !oddsVal || hisWager >= totalWager) {
      preview.classList.add('hidden');
      return;
    }

    const baseOdds = sign === '-' ? -oddsVal : oddsVal;
    const myWager = totalWager - hisWager;
    const boosted = BetMath.boostedOdds(baseOdds, boostPct);
    const totalReturn = BetMath.totalReturn(totalWager, boosted);
    const hisReturn = BetMath.splitReturn(totalReturn, totalWager, hisWager);
    const myReturn = BetMath.splitReturn(totalReturn, totalWager, myWager);

    document.getElementById('preview-my-wager').textContent = BetMath.fmt(myWager);
    document.getElementById('preview-boosted-odds').textContent = BetMath.fmtOdds(boosted);
    document.getElementById('preview-boost-row').style.display = boostPct > 0 ? 'flex' : 'none';
    document.getElementById('preview-his-return').textContent = BetMath.fmt(hisReturn);
    document.getElementById('preview-my-return').textContent = BetMath.fmt(myReturn);
    document.getElementById('preview-total-return').textContent = BetMath.fmt(totalReturn);
    preview.classList.remove('hidden');
  },

  async submitAddBet() {
    const totalWager = parseFloat(document.getElementById('bet-total-wager').value);
    const hisWager = parseFloat(document.getElementById('bet-his-wager').value);
    const oddsVal = parseInt(document.getElementById('bet-odds').value);
    const sign = document.getElementById('odds-sign').textContent.trim();
    const baseOdds = sign === '-' ? -oddsVal : oddsVal;
    const myWager = parseFloat((totalWager - hisWager).toFixed(2));

    if (!totalWager || !hisWager || !oddsVal || hisWager >= totalWager) {
      alert('Please fill in all fields. His wager must be less than total.');
      return;
    }

    const submitBtn = document.querySelector('#add-bet-form .btn-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      await DB.addBet({
        sportsbook_id: document.getElementById('bet-sportsbook').value,
        sport: document.getElementById('bet-sport').value.trim(),
        description: document.getElementById('bet-description').value.trim(),
        boost_pct: parseFloat(document.getElementById('bet-boost').value) || 0,
        total_wager: totalWager,
        his_wager: hisWager,
        my_wager: myWager,
        base_odds: baseOdds,
        notes: document.getElementById('bet-notes').value.trim() || null,
      });
      await this.loadData();
      document.getElementById('add-bet-form').reset();
      document.getElementById('odds-sign').textContent = '+';
      document.getElementById('bet-boost').value = '0';
      document.getElementById('bet-preview').classList.add('hidden');
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      this.navigate('dashboard');
    } catch (err) {
      alert('Error saving bet: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Place Bet';
    }
  },

  // ─── SPORTSBOOKS ─────────────────────────────────────────

  renderSportsbooks() {
    const list = document.getElementById('sportsbooks-list');
    list.innerHTML = this.state.sportsbooks.map(sb => `
      <div class="sb-card" data-sb-id="${sb.id}" data-sb-name="${sb.name}" data-sb-bal="${sb.current_balance}">
        <div>
          <div class="sb-card-name">${sb.name}</div>
          <div class="sb-card-balance">${BetMath.fmt(sb.current_balance)}</div>
        </div>
        <button class="btn-update">Update</button>
      </div>
    `).join('');

    document.querySelectorAll('.sb-card .btn-update').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.sb-card');
        this.showUpdateBalanceModal(card.dataset.sbId, card.dataset.sbName, card.dataset.sbBal);
      });
    });
  },

  // ─── TRANSACTIONS ────────────────────────────────────────

  renderTransactions() {
    const list = document.getElementById('transactions-list');
    const { transactions, settings } = this.state;
    if (transactions.length === 0) {
      list.innerHTML = '<div class="empty-state">No transactions logged</div>';
      return;
    }
    list.innerHTML = transactions.map(t => `
      <div class="tx-card">
        <div class="tx-left">
          <div class="tx-type-label">${t.type.charAt(0).toUpperCase() + t.type.slice(1)}</div>
          <div class="tx-detail">${t.person === 'friend' ? (settings.friend_name || 'Friend') : (settings.my_name || 'Me')} · ${t.sportsbooks?.name || ''}</div>
          ${t.notes ? `<div class="tx-notes">${t.notes}</div>` : ''}
        </div>
        <div class="tx-amount ${t.type === 'deposit' ? 'text-green' : 'text-red'}">
          ${t.type === 'deposit' ? '+' : '-'}${BetMath.fmt(t.amount)}
        </div>
      </div>
    `).join('');
  },

  // ─── MODALS ──────────────────────────────────────────────

  showModal(html) {
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal').classList.remove('hidden');
  },

  hideModal() {
    document.getElementById('modal').classList.add('hidden');
    document.getElementById('modal-content').innerHTML = '';
  },

  showSettleModal(bet) {
    const boosted = BetMath.boostedOdds(parseInt(bet.base_odds), parseFloat(bet.boost_pct));
    const totalReturn = BetMath.totalReturn(parseFloat(bet.total_wager), boosted);
    const hisReturn = BetMath.splitReturn(totalReturn, parseFloat(bet.total_wager), parseFloat(bet.his_wager));
    const myReturn = BetMath.splitReturn(totalReturn, parseFloat(bet.total_wager), parseFloat(bet.my_wager));

    this.showModal(`
      <div class="modal-header">Settle Bet</div>
      <div class="settle-info">
        <div class="settle-title">${bet.sport} · ${bet.description}</div>
        <div class="settle-sub">${bet.sportsbooks?.name} · ${BetMath.fmtOdds(boosted)}${bet.boost_pct > 0 ? ` (+${bet.boost_pct}% boost)` : ''}</div>
        <div class="settle-wagers">
          <span>Total ${BetMath.fmt(bet.total_wager)}</span>
          <span>His ${BetMath.fmt(bet.his_wager)}</span>
          <span>Mine ${BetMath.fmt(bet.my_wager)}</span>
        </div>
      </div>
      <div class="settle-if-won">
        <div class="settle-if-label">If Won</div>
        <div class="settle-if-row">
          <span>${this.state.settings.friend_name || 'Friend'}</span>
          <strong class="text-green">${BetMath.fmt(hisReturn)}</strong>
        </div>
        <div class="settle-if-row">
          <span>${this.state.settings.my_name || 'Me'}</span>
          <strong class="text-green">${BetMath.fmt(myReturn)}</strong>
        </div>
      </div>
      <div class="settle-btns">
        <button class="btn-settle btn-won" data-result="won">Won</button>
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

  showUpdateBalanceModal(sbId, sbName, currentBalance) {
    this.showModal(`
      <div class="modal-header">Update Balance</div>
      <div class="modal-sub">${sbName}</div>
      <div class="form-group">
        <label>Current Balance ($)</label>
        <input type="number" id="new-balance" value="${parseFloat(currentBalance).toFixed(2)}" step="0.01" inputmode="decimal" class="form-input">
      </div>
      <button class="btn-primary-full" id="save-balance">Save</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);
    document.getElementById('new-balance').focus();
    document.getElementById('new-balance').select();

    document.getElementById('save-balance').addEventListener('click', async () => {
      const val = parseFloat(document.getElementById('new-balance').value);
      if (isNaN(val)) return;
      await DB.updateSportsbookBalance(sbId, val);
      await this.loadData();
      this.hideModal();
      this.render(this.state.view);
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showAddSportsbookModal() {
    this.showModal(`
      <div class="modal-header">Add Sportsbook</div>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="new-sb-name" placeholder="ESPN Bet, DraftKings..." class="form-input">
      </div>
      <div class="form-group">
        <label>Current Balance ($)</label>
        <input type="number" id="new-sb-balance" value="0" step="0.01" inputmode="decimal" class="form-input">
      </div>
      <button class="btn-primary-full" id="save-sb">Add Sportsbook</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);
    document.getElementById('new-sb-name').focus();

    document.getElementById('save-sb').addEventListener('click', async () => {
      const name = document.getElementById('new-sb-name').value.trim();
      const balance = parseFloat(document.getElementById('new-sb-balance').value) || 0;
      if (!name) return;
      await DB.addSportsbook(name, balance);
      await this.loadData();
      this.hideModal();
      this.renderSportsbooks();
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },

  showAddTransactionModal() {
    const { sportsbooks, settings } = this.state;
    this.showModal(`
      <div class="modal-header">Log Transaction</div>
      <div class="form-group">
        <label>Type</label>
        <select id="tx-type" class="form-input">
          <option value="deposit">Deposit (money in)</option>
          <option value="withdrawal">Withdrawal (money out)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Person</label>
        <select id="tx-person" class="form-input">
          <option value="friend">${settings.friend_name || 'Friend'}</option>
          <option value="me">${settings.my_name || 'Me'}</option>
        </select>
      </div>
      <div class="form-group">
        <label>Sportsbook</label>
        <select id="tx-sportsbook" class="form-input">
          ${sportsbooks.map(sb => `<option value="${sb.id}">${sb.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Amount ($)</label>
        <input type="number" id="tx-amount" placeholder="0.00" step="0.01" inputmode="decimal" class="form-input">
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <input type="text" id="tx-notes" placeholder="" class="form-input">
      </div>
      <button class="btn-primary-full" id="save-tx">Save</button>
      <button class="btn-cancel-modal" id="modal-cancel">Cancel</button>
    `);

    document.getElementById('save-tx').addEventListener('click', async () => {
      const amount = parseFloat(document.getElementById('tx-amount').value);
      if (!amount || amount <= 0) return;
      await DB.addTransaction({
        type: document.getElementById('tx-type').value,
        person: document.getElementById('tx-person').value,
        sportsbook_id: document.getElementById('tx-sportsbook').value,
        amount,
        notes: document.getElementById('tx-notes').value.trim() || null,
      });
      await this.loadData();
      this.hideModal();
      this.renderTransactions();
    });
    document.getElementById('modal-cancel').addEventListener('click', () => this.hideModal());
  },
};

// ─── BOOT ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // Bottom nav
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => App.navigate(btn.dataset.view));
  });

  // Bet filters
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      App.state.betFilter = tab.dataset.filter;
      App.renderBets();
    });
  });

  // Add bet form
  document.getElementById('add-bet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    App.submitAddBet();
  });

  // Live preview triggers
  ['bet-total-wager', 'bet-his-wager', 'bet-odds', 'bet-boost'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => App.updateBetPreview());
  });

  // Odds sign toggle
  document.getElementById('odds-sign').addEventListener('click', () => {
    const btn = document.getElementById('odds-sign');
    btn.textContent = btn.textContent.trim() === '+' ? '−' : '+';
    App.updateBetPreview();
  });

  // Sport chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('bet-sport').value = chip.dataset.value;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      App.updateBetPreview();
    });
  });

  // Sportsbook buttons
  document.getElementById('add-sportsbook-btn').addEventListener('click', () => App.showAddSportsbookModal());
  document.getElementById('add-transaction-btn').addEventListener('click', () => App.showAddTransactionModal());

  // Modal backdrop dismiss
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') App.hideModal();
  });
});
