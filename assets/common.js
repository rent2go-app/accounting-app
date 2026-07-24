/* Rent 2 Go — shared UI helpers */
(function () {
  function topbar(active) {
    const links = [
      ['index.html', 'Dashboard'],
      ['ledger.html', 'Ledger'],
      ['budget.html', 'Budget'],
      ['import.html', 'Import'],
    ];
    return `
      <div class="topbar">
        <div class="brand">Rent <span>2</span> Go</div>
        <nav class="nav">
          ${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('')}
        </nav>
        <div class="spacer"></div>
        <button class="btn" id="signout">Sign out</button>
      </div>`;
  }

  function mountTopbar(active) {
    const el = document.getElementById('topbar');
    if (el) el.innerHTML = topbar(active);
    const so = document.getElementById('signout');
    if (so) so.onclick = () => DB.signOut();
  }

  function entityChip(entities, id) {
    const e = entities.find((x) => x.id === id);
    if (!e) return `<span class="chip ghost">—</span>`;
    return `<span class="chip ${e.code}">${e.name.split(' ')[0].replace('GoRentaRide','R2G')}</span>`;
  }

  function setupBanner() {
    return `<div class="banner"><b>Not connected yet.</b> Create the dedicated Rent 2 Go
      Supabase project, then paste its URL + anon key into <code>assets/config.js</code>.
      See <code>README.md</code>. The app runs live the moment that's filled in.</div>`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.UI = { mountTopbar, entityChip, setupBanner, esc };
})();
