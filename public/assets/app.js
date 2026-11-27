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
  let transfer = null; // { code, expiresInMinutes } — otevřené okno s kódem přenosu

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

  // Logo: dva překrývající se kruhy (zadní je zčásti schovaný za předním).
  function brandMark() {
    return `<div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 58 42" width="58" height="42" fill="none" stroke="currentColor" stroke-width="1.6">
      <defs><mask id="brand-cut"><rect width="58" height="42" fill="#fff"/><circle cx="21" cy="21" r="20" fill="#000"/></mask></defs>
      <circle cx="36" cy="21" r="20" mask="url(#brand-cut)"/><circle cx="21" cy="21" r="20"/></svg></div>`;
  }

  function renderLanding() {
    const joinCode = esc(new URLSearchParams(location.search).get('kod') || '');
    root.innerHTML = `<main class="landing landing-${mode}">
      <section class="hero">${brandMark()}<p class="eyebrow">Společenská hra v reálném světě</p>
        <h1>Každý má cíl.<br><em>Přežije jeden.</em></h1>
        <p class="lede">Diskrétní průvodce vaší hrou Mafie. Hráči tvoří uzavřený kruh: každý zná jen svou oběť, nikdo svého vraha. Co se stane v rodině, zůstane v rodině.</p>
      </section>
      <section class="entry-card">
        <div class="tabs" role="tablist">
          <button type="button" data-action="mode-join" class="${mode === 'join' ? 'active' : ''}">Připojit se</button>
          <button type="button" data-action="mode-create" class="${mode === 'create' ? 'active' : ''}">Založit hru</button>
        </div>
        ${mode === 'transfer' ? `<form id="transfer-form">
          <p class="hint">Na zařízení, kde už ve hře jsi, zvol „Přenést na jiné zařízení“ a opiš sem kód.</p>
          <label>Kód přenosu<input name="code" required maxlength="9" placeholder="TŘEBA AB3D-7KXQ" autocapitalize="characters" autocomplete="off"></label>
          <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Přenáším…' : 'Pokračovat ve hře'}</button>
          <button type="button" class="link" data-action="mode-join">Zpět</button>
        </form>` : mode === 'join' ? `<form id="join-form">
          <label>Kód hry<input name="code" required maxlength="6" value="${joinCode}" placeholder="TŘEBA K7M2PX" autocapitalize="characters"></label>
          <label>Tvoje jméno<input name="name" required maxlength="40" placeholder="Jak tě znají ostatní"></label>
          <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Připojuji…' : 'Vstoupit do rodiny'}</button>
          <button type="button" class="link" data-action="mode-transfer">Už hraji na jiném zařízení</button>
          ${iosNeedsInstall() ? '<p class="hint">Na iPhonu fungují upozornění jen z ikony na ploše. Nejdřív zvol Sdílet → Přidat na plochu a připoj se až z ikony.</p>' : ''}
        </form>` : `<form id="create-form">
          <div class="field-row">
            <label>Název hry<input name="name" required maxlength="60" placeholder="Letní Mafie 2026"></label>
            <label>Tvoje jméno<input name="adminName" required maxlength="40" placeholder="Organizátor"></label>
          </div>
          <label>Jak probíhá vražda?<textarea name="rule" required maxlength="240" rows="2">Polibkem na holou kůži bez svědků. Svědkem je kterýkoli hráč, živý i mrtvý.</textarea></label>
          <div class="check-row">
            <label class="check"><input type="checkbox" name="adminPlays" checked><span><b>Hraji také</b><small>Zaživa neuvidíš nic navíc.</small></span></label>
            <label class="check"><input type="checkbox" name="showRoster"><span><b>Zobrazovat živé a mrtvé</b><small>Výchozí je úplné utajení.</small></span></label>
          </div>
          <fieldset class="mode-picker"><legend>Práva oběti po vraždě</legend>
            <label class="radio"><input type="radio" name="killMode" value="confirm"><span><b>Povinné potvrzení</b><small>Nová oběť se ukáže až po potvrzení zabitého hráče.</small></span></label>
            <label class="radio"><input type="radio" name="killMode" value="appeal" checked><span><b>Možnost odvolání</b><small>Nová oběť se ukáže ihned. Vraždu lze odvolat do další vraždy stejného vraha.</small></span></label>
            <label class="radio"><input type="radio" name="killMode" value="instant"><span><b>Žádná práva oběti</b><small>Vražda platí okamžitě a nelze ji odvolat.</small></span></label>
          </fieldset>
          <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Zakládám…' : 'Založit hru'}</button>
        </form>`}
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
      </section>
      <footer class="site-footer">Tajné cíle · Žádní svědci · Mlčenlivost</footer>
    </main>`;
  }

  function roster(players, extraClass = '') {
    return `<section class="card roster ${extraClass}"><div class="section-title"><p class="card-label">Hráči</p><span>${players.length}</span></div>
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
      <div class="result-hero"><p class="eyebrow">${early ? 'Předčasně ukončeno' : 'Poslední přeživší'}</p><h2>${esc(stats.winner || 'Bez vítěze')}</h2><p>${early ? 'Hra byla ukončena organizátorem.' : 'Jediný, kdo zůstal naživu.'}</p></div>
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
      content += `<section class="card invite"><div class="invite-row"><div><p class="card-label">Kód pro přátele</p><div class="code">${esc(game.code)}</div></div><button class="secondary" data-action="copy">${copied ? 'Zkopírováno' : 'Kopírovat pozvánku'}</button></div><div class="rule-strip"><span>Pravidlo vraždy</span><p>${esc(game.rule)}</p></div></section>`;
      if (gameState.roster) content += roster(gameState.roster, 'roster-registration');
      const missing = Math.max(0, 3 - (gameState.roster?.length || 0));
      if (admin?.canManage) content += `<section class="action-zone"><button class="primary" data-action="start" ${(busy || missing) ? 'disabled' : ''}>${missing ? `Ke spuštění chybí ${missing === 1 ? '1 hráč' : `${missing} hráči`}` : 'Uzavřít registraci a spustit'}</button></section>`;
      else content += '<p class="waiting">Čeká se, až organizátor spustí hru.</p>';
    }
    if (game.status === 'active' && player) {
      if (gameState.incoming) content += `<section class="card death-question"><div class="pulse-ring"></div><p class="eyebrow">Vyžaduje tvoji odpověď</p><h2>Byl/a jsi zabit/a?</h2><p>Potvrď, zda vražda proběhla podle pravidel. Jméno vraha zůstává skryté.</p><div class="two-actions"><button class="primary" data-action="respond-yes">Ano</button><button class="secondary danger-text" data-action="respond-no">Ne</button></div></section>`;
      if (gameState.rejected && player.status === 'alive') content += `<section class="alert warning"><strong>Oběť vraždu odmítla. Vyřeš to s ní.</strong><span>Po domluvě ji můžeš zadat znovu. Tato osoba je opět tvou obětí.</span></section>`;
      if (gameState.outgoing) content += `<section class="alert waiting-box"><strong>${gameState.outgoing.status === 'pending' ? 'Čeká se na potvrzení oběti.' : 'Předchozí oběť může vraždu odvolat.'}</strong><span>${gameState.outgoing.status === 'provisional' ? 'Jakmile provedeš další vraždu, předchozí už nebude možné odvolat.' : 'Novou oběť získáš po potvrzení.'}</span></section>`;
      if (player.status === 'alive') content += `<section class="target-card"><p class="card-label">Tvoje současná oběť</p>${player.target ? secretName(player.target.name) : '<h2>Čeká se na uzavření vraždy</h2>'}<div class="rule-strip"><span>Pravidlo</span><p>${esc(game.rule)}</p></div><button class="kill-button" data-action="kill-open" ${(busy || gameState.incoming || gameState.outgoing?.status === 'pending' || !player.target) ? 'disabled' : ''}>Zabil/a jsem svou oběť</button></section>`;
      else if (!gameState.incoming) content += '<section class="card dead"><div class="dead-mark">×</div><p class="eyebrow">Tvoje hra skončila</p><h2>Byl/a jsi zabit/a.</h2><p>Výsledky se odhalí až po konci celé hry.</p></section>';
      if (gameState.roster) content += roster(gameState.roster);
    }
    if (game.status === 'active' && !player) content += `<section class="card"><p class="card-label">Pohled organizátora</p><h2>Hra právě probíhá.</h2><p>Průběžné statistiky jsou skryté. Hru můžeš pouze předčasně ukončit.</p>${gameState.roster ? roster(gameState.roster) : ''}</section>`;
    if (game.status === 'finished' && gameState.stats) content += results(gameState.stats, game.endedReason === 'admin');
    content += pushCard(game);

    root.innerHTML = `<main class="app-shell"><header class="topbar"><div class="mini-brand"><i></i><span>Mafie</span></div><span class="status status-${esc(game.status)}">${game.status === 'registration' ? 'Registrace' : game.status === 'active' ? 'Hra běží' : 'Ukončeno'}</span></header>
      <section class="game-head">${game.status === 'registration' ? '' : `<p class="eyebrow">${esc(game.code)}</p>`}<h1>${esc(game.name)}</h1>${player ? `<p class="identity">Hraješ jako <strong>${esc(player.name)}</strong></p>` : ''}</section>
      ${error ? `<div class="alert error" role="alert">${esc(error)}</div>` : ''}${content}
      ${admin?.canEnd && game.status === 'active' ? '<section class="admin-zone"><button class="text-danger" data-action="end-open">Předčasně ukončit hru</button></section>' : ''}
<nav class="footer-links">
      ${game.status !== 'finished' ? `<button class="logout" data-action="refresh" ${busy ? 'disabled' : ''}>Obnovit</button>` : ''}
      ${pushStatus === 'on' && gameState.push && game.status !== 'finished' ? '<button class="logout" data-action="push-disable">Vypnout upozornění</button>' : ''}
      ${game.status !== 'finished' ? '<button class="logout" data-action="transfer-create">Přenést na jiné zařízení</button>' : ''}
      <button class="logout" data-action="logout">Odhlásit</button>
      </nav>
      ${killModal(game, player)}${endModal()}${transferModal()}
    </main>`;
    root.dataset.invite = invite.toString();
    if (!pushSynced && gameState.push) queueMicrotask(syncPush);
  }

  function render() {
    if (!credentials) return renderLanding();
    if (!gameState) {
      root.innerHTML = `<main class="loading">${brandMark()}<p>${esc(error || 'Svolávám rodinu…')}</p><button class="link" data-action="logout">Vrátit se</button></main>`;
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
      if (event.target.id === 'transfer-form') {
        const response = await api({ action: 'transferRedeem', code: form.get('code') });
        saveCredentials(response.credentials);
        gameState = await api({ action: 'state', ...credentials });
        lastRefresh = Date.now();
        mode = 'join';
        pushSynced = false;
        return;
      }
      const payload = event.target.id === 'join-form'
        ? { action: 'join', code: form.get('code'), name: form.get('name') }
        : { action: 'create', name: form.get('name'), rule: form.get('rule'), adminName: form.get('adminName'), adminPlays: form.get('adminPlays') === 'on', killMode: form.get('killMode'), showRoster: form.get('showRoster') === 'on' };
      const response = await api(payload);
      saveCredentials(response.credentials);
      gameState = await api({ action: 'state', ...credentials });
      lastRefresh = Date.now();
      pushSynced = false;
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
    if (action === 'mode-join' || action === 'mode-create' || action === 'mode-transfer') { mode = action.slice(5); error = ''; render(); }
    if (action === 'reveal') toggleReveal();
    if (action === 'motion-enable') await enableMotion();
    if (action === 'push-enable') await enablePush();
    if (action === 'push-disable') await disablePush();
    if (action === 'transfer-create') await createTransfer();
    if (action === 'transfer-close') { transfer = null; render(); }
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
    if (action === 'logout') { forgetPushOnServer(); transfer = null; saveCredentials(null); gameState = null; error = ''; render(); schedulePoll(); }
  });

  // ------------------------------------------------- skryté jméno oběti
  // Jméno oběti je jako PIN v bankovní aplikaci: ve výchozím stavu skryté,
  // ukáže se na 3 s po klepnutí na očičko nebo po otočení telefonu displejem
  // dolů a zpět nahoru. Nikdo tak omylem nezahlédne cizí oběť na displeji.
  const REVEAL_MS = 3000;
  const motionKey = 'kruh-flip-reveal';
  let revealUntil = 0;
  let revealTimer = null;
  let faceDownAt = 0;
  let motionOn = false;
  const motionNeedsPermission = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  const motionSupported = typeof DeviceOrientationEvent !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

  function revealed() { return Date.now() < revealUntil; }

  function eyeIcon(open) {
    return open
      ? '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  }

  function secretName(name) {
    const open = revealed();
    const hint = motionOn ? 'Klepni na očičko nebo otoč telefon displejem dolů a zpět.' : 'Klepni na očičko.';
    return `<div class="secret ${open ? 'open' : ''}">
      <h2>${open ? esc(name) : '<span class="masked" aria-label="Skryto">••••••</span>'}</h2>
      <button type="button" class="reveal" data-action="reveal" aria-label="${open ? 'Skrýt jméno oběti' : 'Zobrazit jméno oběti na 3 sekundy'}">${eyeIcon(!open)}</button>
      ${open ? '<i class="reveal-bar"></i>' : `<small class="reveal-hint">${hint}</small>`}
    </div>${!motionOn && motionSupported && motionNeedsPermission ? '<button type="button" class="link motion-link" data-action="motion-enable">Odkrývat i otočením telefonu</button>' : ''}`;
  }

  function reveal() {
    revealUntil = Date.now() + REVEAL_MS;
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(hideSecret, REVEAL_MS);
    if (navigator.vibrate) navigator.vibrate(15);
    render();
  }

  function hideSecret() {
    revealUntil = 0;
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
    if (credentials && gameState) render();
  }

  function toggleReveal() { if (revealed()) hideSecret(); else reveal(); }

  // Displejem dolů = beta kolem ±180°. Návrat (|beta| < 100°) do 4 s odkryje jméno.
  function onOrientation(event) {
    if (event.beta == null || !gameState?.player?.target || gameState.player.status !== 'alive') return;
    const beta = Math.abs(event.beta);
    const gamma = Math.abs(event.gamma || 0);
    if (beta > 140 && gamma < 40) { faceDownAt = Date.now(); return; }
    if (faceDownAt && beta < 100) {
      const fresh = Date.now() - faceDownAt < 4000;
      faceDownAt = 0;
      if (fresh && !document.hidden) reveal();
    }
  }

  function startMotion() {
    if (motionOn) return;
    window.addEventListener('deviceorientation', onOrientation);
    motionOn = true;
  }

  async function enableMotion() {
    try {
      if (motionNeedsPermission && (await DeviceOrientationEvent.requestPermission()) !== 'granted') {
        error = 'Bez povolení pohybu jde jméno odkrýt jen očičkem.';
        render();
        return;
      }
      try { localStorage.setItem(motionKey, '1'); } catch { /* nic */ }
      startMotion();
      render();
    } catch {
      error = 'Odkrývání otočením se nepodařilo zapnout.';
      render();
    }
  }

  // Android a ostatní bez povolení: rovnou. iOS: až po klepnutí (vyžaduje gesto);
  // když už jednou povoleno, iOS dovolí poslouchat i po načtení stránky.
  if (motionSupported && !motionNeedsPermission) startMotion();
  else if (motionSupported) { try { if (localStorage.getItem(motionKey) === '1') startMotion(); } catch { /* nic */ } }

  document.addEventListener('visibilitychange', () => { if (document.hidden && revealUntil) { revealUntil = 0; faceDownAt = 0; } });

  // ---------------------------------------------------- push upozornění
  // Stav: unsupported | ios-install | default | denied | on
  const pushOffKey = 'kruh-push-off';
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let pushStatus = pushSupported ? 'default' : (isIos && !isStandalone ? 'ios-install' : 'unsupported');
  let pushSynced = false;
  let registrationPromise = null;

  function iosNeedsInstall() { return isIos && !isStandalone; }

  function pushRegistration() {
    if (!registrationPromise) registrationPromise = navigator.serviceWorker.register('/sw.js');
    return registrationPromise;
  }

  function keyBytes(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function sameKey(buffer, base64url) {
    if (!buffer) return false;
    const a = new Uint8Array(buffer); const b = keyBytes(base64url);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function pushOff() { try { return localStorage.getItem(pushOffKey) === '1'; } catch { return false; } }
  function setPushOff(value) { try { value ? localStorage.setItem(pushOffKey, '1') : localStorage.removeItem(pushOffKey); } catch { /* nic */ } }

  /** Přihlásí odběr k aktuální hře (při povolení i po každém přihlášení do hry). */
  async function syncPush() {
    const publicKey = gameState?.push?.publicKey;
    if (pushSynced || !pushSupported || !credentials || !publicKey) return;
    const wanted = Notification.permission === 'denied' ? 'denied' : 'default';
    if (Notification.permission !== 'granted' || pushOff()) {
      if (pushStatus !== wanted) { pushStatus = wanted; render(); }
      return;
    }
    pushSynced = true;
    try {
      const registration = await pushRegistration();
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !sameKey(subscription.options.applicationServerKey, publicKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      }
      await api({ action: 'subscribe', ...credentials, subscription: subscription.toJSON() });
      pushStatus = 'on';
    } catch (cause) {
      // Žádné automatické opakování; uživatel to může zkusit znovu tlačítkem.
      pushStatus = 'default';
      error = cause instanceof Error ? cause.message : 'Upozornění se nepodařilo zapnout.';
    }
    render();
  }

  async function enablePush() {
    if (!pushSupported) return;
    setPushOff(false);
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { pushStatus = permission === 'denied' ? 'denied' : 'default'; render(); return; }
    pushSynced = false;
    await syncPush();
  }

  async function disablePush() {
    setPushOff(true);
    try {
      const registration = await pushRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api({ action: 'unsubscribe', ...credentials, endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
    } catch { /* odběr už neexistuje */ }
    pushStatus = 'default'; pushSynced = false; render();
  }

  /** Při odhlášení zařízení přestane dostávat upozornění z této hry. */
  function forgetPushOnServer() {
    if (!pushSupported || !credentials || pushStatus !== 'on') return;
    const current = credentials;
    pushSynced = false;
    pushRegistration()
      .then(registration => registration.pushManager.getSubscription())
      .then(subscription => subscription && api({ action: 'unsubscribe', ...current, endpoint: subscription.endpoint }))
      .catch(() => {});
  }

  function pushCard(game) {
    if (!gameState.push || game.status === 'finished') return '';
    if (pushStatus === 'on' || pushStatus === 'unsupported') return '';
    const text = 'Dostaneš zprávu, když tě někdo zabije, když máš novou oběť nebo když hra začne či skončí. Jména se ve zprávách neobjevují.';
    if (pushStatus === 'ios-install') {
      return `<section class="card notify"><details><summary><span class="card-label">Upozornění</span><span>Na iPhonu jen z ikony na ploše. <u>Jak na to</u></span></summary>
        <ol class="steps"><li>Klepni níže na <b>Přenést na jiné zařízení</b> a poznamenej si kód.</li><li>V Safari zvol <b>Sdílet → Přidat na plochu</b>.</li><li>Otevři Mafii z plochy, zvol <b>Už hraji na jiném zařízení</b> a zadej kód.</li></ol></details></section>`;
    }
    if (pushStatus === 'denied') {
      return `<section class="card notify"><p class="card-label">Upozornění</p><p>Upozornění jsou v prohlížeči zablokovaná. Povol je v nastavení tohoto webu a stránku obnov.</p></section>`;
    }
    return `<section class="card notify"><p class="card-label">Upozornění</p><p>${text}</p><button class="secondary" data-action="push-enable" ${busy ? 'disabled' : ''}>Zapnout upozornění</button></section>`;
  }

  if (pushSupported) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'kruh-refresh' && credentials && !busy) {
        lastRefresh = Date.now();
        refresh(true).then(schedulePoll);
      }
    });
  }

  // ------------------------------------------------- přenos na jiné zařízení

  async function createTransfer() {
    if (!credentials || busy) return;
    busy = true; error = ''; render();
    try { transfer = await api({ action: 'transferCreate', ...credentials }); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Kód se nepodařilo vytvořit.'; }
    finally { busy = false; render(); }
  }

  function transferModal() {
    if (!transfer) return '';
    return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><p class="eyebrow">Přenos na jiné zařízení</p><h2>Kód přenosu</h2><div class="code">${esc(transfer.code)}</div><p>Na druhém zařízení otevři Mafii, zvol <b>Už hraji na jiném zařízení</b> a zadej tento kód. Platí ${esc(transfer.expiresInMinutes)} minut a jen jednou. Nikomu ho neukazuj — kdo ho zadá, hraje za tebe.</p><button class="secondary full" data-action="transfer-close">Hotovo</button></section></div>`;
  }

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
