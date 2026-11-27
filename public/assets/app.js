(() => {
  'use strict';

  const root = document.getElementById('app');
  const storageKey = 'kruh-php-credentials-v1';
  let credentials = loadCredentials();
  let gameState = null;
  let mode = 'join';
  let busy = false;
  let error = '';
  let killStep = 0;
  let endStep = 0;
  let endText = '';
  let copied = false;

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function loadCredentials() {
    try { return JSON.parse(localStorage.getItem(storageKey)) || null; }
    catch { localStorage.removeItem(storageKey); return null; }
  }

  function saveCredentials(value) {
    credentials = value;
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
  }

  async function api(payload) {
    const response = await fetch('api.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Server nevrátil platnou odpověď.'); }
    if (!response.ok) throw new Error(body.error || 'Něco se nepovedlo.');
    return body;
  }

  async function refresh(quiet = false) {
    if (!credentials) return;
    if (!quiet) busy = true;
    try {
      const known = quiet && gameState && typeof gameState.version === 'number' ? { knownVersion: gameState.version } : {};
      const next = await api({ action: 'state', ...credentials, ...known });
      if (!next.unchanged) gameState = next;
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Nepodařilo se načíst hru.';
    } finally {
      if (!quiet) busy = false;
      render();
    }
  }

  async function act(action, extra = {}) {
    if (!credentials || busy) return;
    busy = true; error = ''; render();
    try {
      await api({ action, ...credentials, ...extra });
      gameState = await api({ action: 'state', ...credentials });
      lastRefresh = Date.now();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Akci se nepodařilo dokončit.';
    } finally { busy = false; render(); schedulePoll(); }
  }

  function brandMark() { return '<div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>'; }

  function renderLanding() {
    const joinCode = esc(new URLSearchParams(location.search).get('kod') || '');
    root.innerHTML = `<main class="landing">
      <section class="hero">${brandMark()}<p class="eyebrow">Společenská hra v reálném světě</p>
        <h1>Jeden kruh.<br><em>Jeden vítěz.</em></h1>
        <p class="lede">Nenápadný průvodce vaší hrou Mafie. Každý zná jen svou oběť. O zbytek se postará Kruh.</p>
      </section>
      <section class="entry-card">
        <div class="tabs" role="tablist">
          <button type="button" data-action="mode-join" class="${mode === 'join' ? 'active' : ''}">Připojit se</button>
          <button type="button" data-action="mode-create" class="${mode === 'create' ? 'active' : ''}">Založit hru</button>
        </div>
        ${mode === 'join' ? `<form id="join-form">
          <label>Kód hry<input name="code" required maxlength="6" value="${joinCode}" placeholder="TŘEBA K7M2PX" autocapitalize="characters"></label>
          <label>Tvoje jméno<input name="name" required maxlength="40" placeholder="Jak tě znají ostatní"></label>
          <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Připojuji…' : 'Vstoupit do kruhu'}</button>
        </form>` : `<form id="create-form">
          <label>Název hry<input name="name" required maxlength="60" placeholder="Letní Mafie 2026"></label>
          <label>Jak probíhá vražda?<textarea name="rule" required maxlength="240">Polibkem na tvář bez přítomnosti svědků.</textarea></label>
          <label>Tvoje jméno<input name="adminName" required maxlength="40" placeholder="Organizátor"></label>
          <label class="check"><input type="checkbox" name="adminPlays" checked><span><b>Hraji také</b><small>Zaživa neuvidíš nic navíc.</small></span></label>
          <fieldset class="mode-picker"><legend>Práva oběti po vraždě</legend>
            <label class="radio"><input type="radio" name="killMode" value="confirm" checked><span><b>Povinné potvrzení</b><small>Nová oběť se ukáže až po potvrzení zabitého hráče.</small></span></label>
            <label class="radio"><input type="radio" name="killMode" value="appeal"><span><b>Možnost odvolání</b><small>Nová oběť se ukáže ihned. Vraždu lze odvolat do další vraždy stejného vraha.</small></span></label>
            <label class="radio"><input type="radio" name="killMode" value="instant"><span><b>Žádná práva oběti</b><small>Vražda platí okamžitě a nelze ji odvolat.</small></span></label>
          </fieldset>
          <label class="check"><input type="checkbox" name="showRoster"><span><b>Zobrazovat živé a mrtvé</b><small>Výchozí je úplné utajení.</small></span></label>
          <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Zakládám…' : 'Založit hru'}</button>
        </form>`}
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      </section>
      <footer class="site-footer">Tajné cíle · Bez průběžných statistik · Pro mobil</footer>
    </main>`;
  }

  function roster(players) {
    return `<section class="card roster"><div class="section-title"><p class="card-label">Hráči</p><span>${players.length}</span></div>
      <ul>${players.map(player => `<li><span class="player-dot ${player.status === 'dead' ? 'dead' : ''}"></span><b>${esc(player.name)}</b><small>${player.status === 'dead' ? 'mrtvý/á' : 've hře'}</small></li>`).join('')}</ul></section>`;
  }

  function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    return [days ? `${days} d` : '', hours ? `${hours} h` : '', `${mins} min`].filter(Boolean).join(' ');
  }

  function results(stats, early) {
    const sorted = [...stats.players].sort((a, b) => b.killsCount - a.killsCount);
    return `<section class="results">
      <div class="result-hero"><p class="eyebrow">${early ? 'Předčasně ukončeno' : 'Vítěz kruhu'}</p><h2>${esc(stats.winner || 'Bez vítěze')}</h2><p>${early ? 'Hra byla ukončena organizátorem.' : 'Poslední hráč, který zůstal naživu.'}</p></div>
      <div class="stat-grid"><article><span>První oběť</span><strong>${esc(stats.firstVictim?.name || '—')}</strong><small>${stats.firstVictim ? `${formatDuration(stats.firstVictim.afterMs)} od startu` : 'Bez vražd'}</small></article>
      <article><span>Nejvíc vražd</span><strong>${esc(stats.leaders.map(item => item.name).join(', ') || '—')}</strong><small>${stats.leaders[0]?.kills || 0} celkem</small></article></div>
      <section class="card"><p class="card-label">Rekordy v čase</p><div class="window-list">${stats.windows.map(item => `<div><span>${esc(item.label)}</span><b>${esc(item.names.join(', ') || '—')}</b><strong>${item.count}</strong></div>`).join('')}</div></section>
      <section class="card"><p class="card-label">Pořadí vrahů</p><ol class="leaderboard">${sorted.map(item => `<li><span>${esc(item.name)}</span><b>${item.killsCount}×</b></li>`).join('')}</ol></section>
      <section class="card"><p class="card-label">Časová osa</p><div class="timeline">${stats.timeline.length ? stats.timeline.map(item => `<div><i></i><span><b>${esc(item.killer)}</b> zabil/a ${esc(item.victim)}<small>${new Date(item.at).toLocaleString('cs-CZ')}</small></span></div>`).join('') : '<p>Ve hře neproběhla žádná potvrzená vražda.</p>'}</div></section>
    </section>`;
  }

  function killModal(game, player) {
    if (!killStep || !player?.target) return '';
    if (killStep === 1) return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><p class="eyebrow">Zkontroluj oběť</p><h2>${esc(player.target.name)}</h2><p>Vraždu zadávej až ve chvíli, kdy skutečně proběhla podle pravidel.</p><div class="modal-actions"><button class="secondary" data-action="kill-cancel">Zpět</button><button class="primary" data-action="kill-next">Ano, proběhla</button></div></section></div>`;
    const message = game.killMode === 'confirm' ? 'Oběť nyní dostane žádost o potvrzení.' : game.killMode === 'appeal' ? 'Novou oběť uvidíš ihned. Předchozí oběť může vraždu odvolat do tvé další vraždy.' : 'Vražda začne okamžitě platit a oběť ji nemůže změnit.';
    return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><p class="eyebrow">Poslední kontrola</p><h2>Potvrdit provedenou vraždu?</h2><p>${esc(message)}</p><div class="modal-actions"><button class="secondary" data-action="kill-cancel">Zrušit</button><button class="primary danger" data-action="kill-confirm">Definitivně potvrdit</button></div></section></div>`;
  }

  function endModal() {
    if (!endStep) return '';
    if (endStep === 1) return `<div class="modal-backdrop"><section class="modal danger-modal" role="dialog" aria-modal="true"><p class="eyebrow">Nebezpečná akce</p><h2>Ukončit hru všem?</h2><p>Hra skončí bez vítěze a odhalí dosavadní výsledky. Tuto akci nelze vrátit.</p><div class="modal-actions"><button class="secondary" data-action="end-cancel">Ne, pokračovat</button><button class="danger-outline" data-action="end-next">Rozumím následkům</button></div></section></div>`;
    if (endStep === 2) return `<div class="modal-backdrop"><section class="modal danger-modal" role="dialog" aria-modal="true"><p class="eyebrow">Druhé potvrzení</p><h2>Napiš UKONČIT</h2><input id="end-text" autocomplete="off" value="${esc(endText)}" placeholder="UKONČIT"><div class="modal-actions"><button class="secondary" data-action="end-cancel">Zrušit</button><button class="danger" data-action="end-final-step" ${endText !== 'UKONČIT' ? 'disabled' : ''}>Pokračovat</button></div></section></div>`;
    return `<div class="modal-backdrop"><section class="modal danger-modal" role="dialog" aria-modal="true"><p class="eyebrow">Poslední potvrzení</p><h2>Opravdu definitivně?</h2><p>Po stisknutí se hra okamžitě uzavře.</p><button class="danger full" data-action="end-confirm">Definitivně ukončit hru</button><button class="link" data-action="end-cancel">Vrátit se do hry</button></section></div>`;
  }

  function renderGame() {
    const { game, player, admin } = gameState;
    const invite = new URL(location.href); invite.search = ''; invite.hash = ''; invite.searchParams.set('kod', game.code);
    let content = '';
    if (game.status === 'registration') {
      content += `<section class="card invite"><p class="card-label">Kód pro přátele</p><div class="code">${esc(game.code)}</div><button class="secondary" data-action="copy">${copied ? 'Odkaz zkopírován' : 'Kopírovat pozvánku'}</button></section>`;
      content += `<section class="card rules"><p class="card-label">Pravidlo vraždy</p><p>${esc(game.rule)}</p></section>`;
      if (gameState.roster) content += roster(gameState.roster);
      if (admin?.canManage) content += `<section class="action-zone"><button class="primary" data-action="start" ${(busy || (gameState.roster?.length || 0) < 3) ? 'disabled' : ''}>Uzavřít registraci a spustit</button>${(gameState.roster?.length || 0) < 3 ? '<small>Ke spuštění jsou potřeba alespoň 3 hráči.</small>' : ''}</section>`;
      else content += '<p class="waiting">Čeká se, až organizátor spustí hru.</p>';
    }
    if (game.status === 'active' && player) {
      if (gameState.incoming) content += `<section class="card death-question"><div class="pulse-ring"></div><p class="eyebrow">Vyžaduje tvoji odpověď</p><h2>Byl/a jsi zabit/a?</h2><p>Potvrď, zda vražda proběhla podle pravidel. Jméno vraha zůstává skryté.</p><div class="two-actions"><button class="primary" data-action="respond-yes">Ano</button><button class="secondary danger-text" data-action="respond-no">Ne</button></div></section>`;
      if (gameState.rejected && player.status === 'alive') content += `<section class="alert warning"><strong>Vyřeš vraždu s hráčem ${esc(gameState.rejected.victimName)}.</strong><span>Po domluvě ji můžeš zadat znovu. Tato osoba je opět tvou obětí.</span></section>`;
      if (gameState.outgoing) content += `<section class="alert waiting-box"><strong>${gameState.outgoing.status === 'pending' ? 'Čeká se na potvrzení oběti.' : 'Předchozí oběť může vraždu odvolat.'}</strong><span>${gameState.outgoing.status === 'provisional' ? 'Jakmile provedeš další vraždu, předchozí už nebude možné odvolat.' : 'Novou oběť získáš po potvrzení.'}</span></section>`;
      if (player.status === 'alive') content += `<section class="target-card"><p class="card-label">Tvoje současná oběť</p><h2>${esc(player.target?.name || 'Čeká se na uzavření vraždy')}</h2><div class="rule-strip"><span>Pravidlo</span><p>${esc(game.rule)}</p></div><button class="kill-button" data-action="kill-open" ${(busy || gameState.incoming || gameState.outgoing?.status === 'pending' || !player.target) ? 'disabled' : ''}>Zabil/a jsem svou oběť</button></section>`;
      else if (!gameState.incoming) content += '<section class="card dead"><div class="dead-mark">×</div><p class="eyebrow">Tvoje hra skončila</p><h2>Byl/a jsi zabit/a.</h2><p>Výsledky se odhalí až po konci celé hry.</p></section>';
      if (gameState.roster) content += roster(gameState.roster);
    }
    if (game.status === 'active' && !player) content += `<section class="card"><p class="card-label">Pohled organizátora</p><h2>Hra právě probíhá.</h2><p>Průběžné statistiky jsou skryté. Hru můžeš pouze předčasně ukončit.</p>${gameState.roster ? roster(gameState.roster) : ''}</section>`;
    if (game.status === 'finished' && gameState.stats) content += results(gameState.stats, game.endedReason === 'admin');

    root.innerHTML = `<main class="app-shell"><header class="topbar"><div class="mini-brand"><i></i><span>Kruh</span></div><span class="status status-${esc(game.status)}">${game.status === 'registration' ? 'Registrace' : game.status === 'active' ? 'Hra běží' : 'Ukončeno'}</span></header>
      <section class="game-head"><p class="eyebrow">${esc(game.code)}</p><h1>${esc(game.name)}</h1>${player ? `<p class="identity">Hraješ jako <strong>${esc(player.name)}</strong></p>` : ''}</section>
      ${error ? `<div class="alert error" role="alert">${esc(error)}</div>` : ''}${content}
      ${admin?.canEnd && game.status === 'active' ? '<section class="admin-zone"><button class="text-danger" data-action="end-open">Předčasně ukončit hru</button></section>' : ''}
      ${game.status !== 'finished' ? `<button class="logout" data-action="refresh" ${busy ? 'disabled' : ''}>Obnovit stav hry</button>` : ''}
      <button class="logout" data-action="logout">Odhlásit toto zařízení</button>
      ${killModal(game, player)}${endModal()}
    </main>`;
    root.dataset.invite = invite.toString();
  }

  function render() {
    if (!credentials) return renderLanding();
    if (!gameState) {
      root.innerHTML = `<main class="loading">${brandMark()}<p>${esc(error || 'Načítám kruh…')}</p><button class="link" data-action="logout">Vrátit se</button></main>`;
      return;
    }
    renderGame();
  }

  root.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.target);
    busy = true; error = ''; render();
    try {
      const payload = event.target.id === 'join-form'
        ? { action: 'join', code: form.get('code'), name: form.get('name') }
        : { action: 'create', name: form.get('name'), rule: form.get('rule'), adminName: form.get('adminName'), adminPlays: form.get('adminPlays') === 'on', killMode: form.get('killMode'), showRoster: form.get('showRoster') === 'on' };
      const response = await api(payload);
      saveCredentials(response.credentials);
      gameState = await api({ action: 'state', ...credentials });
      lastRefresh = Date.now();
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Akce se nepodařila.'; }
    finally { busy = false; render(); schedulePoll(); }
  });

  root.addEventListener('input', event => {
    if (event.target.id === 'end-text') {
      endText = event.target.value.toUpperCase();
      event.target.value = endText;
      const button = root.querySelector('[data-action="end-final-step"]');
      if (button) button.disabled = endText !== 'UKONČIT';
    }
  });

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'mode-join' || action === 'mode-create') { mode = action === 'mode-join' ? 'join' : 'create'; error = ''; render(); }
    if (action === 'copy') { await navigator.clipboard.writeText(root.dataset.invite); copied = true; render(); setTimeout(() => { copied = false; render(); }, 1600); }
    if (action === 'start') await act('start');
    if (action === 'respond-yes') await act('respond', { reportId: gameState.incoming.id, accepted: true });
    if (action === 'respond-no') await act('respond', { reportId: gameState.incoming.id, accepted: false });
    if (action === 'kill-open') { killStep = 1; render(); }
    if (action === 'kill-next') { killStep = 2; render(); }
    if (action === 'kill-cancel') { killStep = 0; render(); }
    if (action === 'kill-confirm') { killStep = 0; await act('report'); }
    if (action === 'end-open') { endStep = 1; render(); }
    if (action === 'end-next') { endStep = 2; endText = ''; render(); setTimeout(() => root.querySelector('#end-text')?.focus(), 0); }
    if (action === 'end-final-step') { endStep = 3; render(); }
    if (action === 'end-cancel') { endStep = 0; endText = ''; render(); }
    if (action === 'end-confirm') { endStep = 0; endText = ''; await act('end'); }
    if (action === 'refresh') { lastRefresh = Date.now(); await refresh(); schedulePoll(); }
    if (action === 'logout') { saveCredentials(null); gameState = null; error = ''; render(); schedulePoll(); }
  });

  // Obnovování stavu dimenzované na free plán Cloudflare (100 000 požadavků/den):
  // 50 hráčů × 24 h s otevřenou aplikací se vejde do limitu.
  //  * živý hráč / organizátor: 1× za minutu, mrtvý hráč: 1× za 5 minut,
  //  * skrytá stránka (jiná aplikace, zamčený telefon) a skončená hra: nic,
  //  * navíc ihned po vlastní akci, při znovuzobrazení stránky (nejvýš 1× za 30 s) a tlačítkem,
  //  * když se nic nezměnilo, server odpoví jen „beze změny“ (levné čtení z D1).
  const POLL_ALIVE_MS = 60 * 1000;
  const POLL_DEAD_MS = 5 * 60 * 1000;
  const SHOW_THROTTLE_MS = 30 * 1000;
  let lastRefresh = 0;
  let pollTimer = null;

  function pollDelay() {
    if (!credentials || document.hidden) return 0;
    if (!gameState) return POLL_ALIVE_MS;
    if (gameState.game?.status === 'finished') return 0;
    if (gameState.player?.status === 'dead' && !gameState.incoming) return POLL_DEAD_MS;
    return POLL_ALIVE_MS;
  }
  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    const interval = pollDelay();
    if (!interval) return;
    const delay = Math.max(1000, lastRefresh + interval - Date.now());
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!busy) { lastRefresh = Date.now(); await refresh(true); }
      schedulePoll();
    }, delay);
  }
  async function refreshOnShow() {
    if (!credentials) return;
    if (document.hidden) { schedulePoll(); return; }
    if (!busy && gameState?.game?.status !== 'finished' && Date.now() - lastRefresh >= SHOW_THROTTLE_MS) {
      lastRefresh = Date.now();
      await refresh(true);
    }
    schedulePoll();
  }
  document.addEventListener('visibilitychange', refreshOnShow);
  window.addEventListener('focus', refreshOnShow);
  window.addEventListener('pageshow', event => { if (event.persisted) refreshOnShow(); });

  render();
  if (credentials) { lastRefresh = Date.now(); refresh().then(schedulePoll); }
})();
