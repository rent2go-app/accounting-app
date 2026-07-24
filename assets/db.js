/* Rent 2 Go — data layer (Supabase client, auth, queries) */
(function () {
  const cfg = window.R2G_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');

  let client = null;
  if (configured && window.supabase) {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  // ---- Auth -----------------------------------------------------------------
  async function getUser() {
    if (!client) return null;
    const { data } = await client.auth.getUser();
    return data ? data.user : null;
  }
  async function signIn(email, password) {
    return client.auth.signInWithPassword({ email, password });
  }
  async function signOut() {
    if (client) await client.auth.signOut();
    location.href = 'login.html';
  }
  // Redirect to login if not authenticated. Returns the user or null.
  async function requireAuth() {
    if (!configured) return null;           // let pages show the setup banner
    const user = await getUser();
    if (!user) { location.href = 'login.html'; return null; }
    return user;
  }

  // ---- Reference data -------------------------------------------------------
  const q = (t) => client.from(t);

  async function refData() {
    const [cur, rates, ent, cat, acc] = await Promise.all([
      q('currencies').select('*').order('sort_order'),
      q('exchange_rates').select('*').order('as_of', { ascending: false }),
      q('entities').select('*').order('sort_order'),
      q('categories').select('*').order('sort_order'),
      q('accounts').select('*').order('sort_order'),
    ]);
    return {
      currencies: cur.data || [],
      rates: rates.data || [],
      entities: ent.data || [],
      categories: cat.data || [],
      accounts: acc.data || [],
    };
  }

  // ---- Transactions ---------------------------------------------------------
  async function listTransactions(filters = {}) {
    let query = q('transactions').select('*').order('tx_date', { ascending: false }).order('id', { ascending: false });
    if (filters.entity_id) query = query.eq('entity_id', filters.entity_id);
    if (filters.category_id) query = query.eq('category_id', filters.category_id);
    if (filters.from) query = query.gte('tx_date', filters.from);
    if (filters.to) query = query.lte('tx_date', filters.to);
    if (filters.search) query = query.ilike('description', `%${filters.search}%`);
    if (filters.limit) query = query.limit(filters.limit);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
  async function addTransaction(row) {
    const { data, error } = await q('transactions').insert(row).select().single();
    if (error) throw error;
    return data;
  }
  async function updateTransaction(id, patch) {
    patch.updated_at = new Date().toISOString();
    const { data, error } = await q('transactions').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  async function deleteTransaction(id) {
    const { error } = await q('transactions').delete().eq('id', id);
    if (error) throw error;
  }

  // ---- Rates management -----------------------------------------------------
  async function setRate(from_code, to_code, rate) {
    const as_of = new Date().toISOString().slice(0, 10);
    const { error } = await q('exchange_rates')
      .upsert({ from_code, to_code, rate, as_of }, { onConflict: 'from_code,to_code,as_of' });
    if (error) throw error;
  }

  // ---- Bank balance snapshots (daily reconciliation) -----------------------
  async function listBankBalances() {
    const { data, error } = await q('bank_balances')
      .select('*').order('as_of', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function setBankBalance(as_of, balance, note) {
    const { error } = await q('bank_balances').upsert(
      { as_of, balance, currency_code: 'USD', note: note || null, updated_at: new Date().toISOString() },
      { onConflict: 'as_of,currency_code' }
    );
    if (error) throw error;
  }
  async function upsertBankBalances(rows) {
    // rows: [{as_of, balance, note}] — used by the XLS importer for daily running totals
    const payload = rows.map(r => ({ as_of: r.as_of, balance: r.balance, currency_code: 'USD',
      note: r.note || null, updated_at: new Date().toISOString() }));
    const { error } = await q('bank_balances').upsert(payload, { onConflict: 'as_of,currency_code' });
    if (error) throw error;
  }

  // ---- Bulk import (XLS/CSV → transactions) --------------------------------
  // Re-runnable: rows sharing a source_ref batch are cleared first, then inserted.
  async function importTransactions(rows, sourceBatch) {
    if (sourceBatch) {
      const { error: delErr } = await q('transactions').delete().like('source_ref', sourceBatch + '%');
      if (delErr) throw delErr;
    }
    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
      const { error } = await q('transactions').insert(rows.slice(i, i + chunk));
      if (error) throw error;
    }
    return rows.length;
  }

  window.DB = {
    configured, client,
    getUser, signIn, signOut, requireAuth,
    refData, listTransactions, addTransaction, updateTransaction, deleteTransaction, setRate,
    listBankBalances, setBankBalance, upsertBankBalances, importTransactions,
    listBudgetPlan, saveBudgetPlan,
  };

  // ---- Budget plan (monthly expected income/expense) -----------------------
  async function listBudgetPlan() {
    const { data, error } = await q('budget_plan').select('*').order('period_month');
    if (error) throw error;
    return data || [];
  }
  async function saveBudgetPlan(period_month, expected_income, expected_expense, note) {
    const { error } = await q('budget_plan').upsert(
      { period_month, expected_income, expected_expense, currency_code: 'USD',
        note: note || null, updated_at: new Date().toISOString() },
      { onConflict: 'period_month' });
    if (error) throw error;
  }
})();
