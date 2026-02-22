let _client;

function client() {
  if (!_client) {
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _client;
}

const DB = {
  async getSettings() {
    const { data, error } = await client().from('settings').select('*');
    if (error) throw error;
    return Object.fromEntries(data.map(s => [s.key, s.value]));
  },

  async getSportsbooks() {
    const { data, error } = await client()
      .from('sportsbooks').select('*').order('name');
    if (error) throw error;
    return data;
  },

  async addSportsbook(name, balance = 0) {
    const { data, error } = await client()
      .from('sportsbooks')
      .insert({ name, current_balance: balance })
      .select().single();
    if (error) throw error;
    return data;
  },

  async updateSportsbookBalance(id, balance) {
    const { error } = await client()
      .from('sportsbooks')
      .update({ current_balance: balance })
      .eq('id', id);
    if (error) throw error;
  },

  async getBets() {
    const { data, error } = await client()
      .from('bets')
      .select('*, sportsbooks(name)')
      .order('placed_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async addBet(bet) {
    const { data, error } = await client()
      .from('bets').insert(bet).select().single();
    if (error) throw error;
    return data;
  },

  async deleteBet(id) {
    const { error } = await client().from('bets').delete().eq('id', id);
    if (error) throw error;
  },

  async unsettleBet(id) {
    const { error } = await client()
      .from('bets')
      .update({ status: 'pending', settled_at: null })
      .eq('id', id);
    if (error) throw error;
  },

  async restoreBet(bet) {
    const { sportsbooks, ...betData } = bet; // strip joined field
    const { error } = await client().from('bets').insert(betData);
    if (error) throw error;
  },

  async settleBet(id, status) {
    const { error } = await client()
      .from('bets')
      .update({ status, settled_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  },

  async getTransactions() {
    const { data, error } = await client()
      .from('transactions')
      .select('*, sportsbooks(name)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  // type: 'deposit' | 'withdrawal' | 'disbursement'
  // person: 'brent' | 'dan'
  // sportsbook_id: required for deposit/withdrawal, null for disbursement
  async addTransaction(tx) {
    const { data, error } = await client()
      .from('transactions').insert(tx).select().single();
    if (error) throw error;
    return data;
  },

  async getSnapshots() {
    const { data, error } = await client()
      .from('snapshots')
      .select('*')
      .order('snapshot_date', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async addSnapshot(snap) {
    const { data, error } = await client()
      .from('snapshots')
      .upsert(snap, { onConflict: 'snapshot_date' })
      .select().single();
    if (error) throw error;
    return data;
  },
};
