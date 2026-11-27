#!/usr/bin/env node
// Kouřový test API proti běžícímu serveru (výchozí http://127.0.0.1:8787).
// Použití:  npm run dev   (v jiném terminálu)   a pak   npm run test:smoke
//           BASE_URL=https://app.albiovi.cz npm run test:smoke   (založí testovací hry!)

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
let failures = 0;

async function api(payload, { expectStatus = 200 } = {}) {
  const response = await fetch(`${BASE}/api.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (response.status !== expectStatus) {
    throw new Error(`${payload.action}: čekal jsem ${expectStatus}, přišlo ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function check(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.log(`  ✗ ${message}`); }
}

async function setupGame(killMode, count = 4) {
  const created = await api({ action: 'create', name: `Test ${killMode}`, rule: 'Polibkem', adminName: 'P0', adminPlays: true, killMode, showRoster: false });
  const admin = created.credentials;
  const state = await api({ action: 'state', ...admin });
  const players = [{ name: 'P0', cred: { gameId: admin.gameId, playerToken: admin.playerToken } }];
  for (let i = 1; i < count; i++) {
    const joined = await api({ action: 'join', code: state.game.code.toLowerCase(), name: `P${i}` });
    players.push({ name: `P${i}`, cred: joined.credentials });
  }
  return { admin, code: state.game.code, players };
}

async function targetOf(player) {
  return (await api({ action: 'state', ...player.cred })).player.target;
}

async function verifyCircle(players) {
  const alive = [];
  for (const p of players) {
    const s = await api({ action: 'state', ...p.cred });
    if (s.player.status === 'alive') alive.push({ name: p.name, target: s.player.target?.name ?? p.name });
  }
  const seen = new Set();
  let current = alive[0];
  for (let i = 0; i < alive.length; i++) { seen.add(current.name); current = alive.find(a => a.name === current.target); if (!current) break; }
  return seen.size === alive.length && current?.name === alive[0].name;
}

const byName = (players, name) => players.find(p => p.name === name);

async function main() {
  console.log(`Testuji ${BASE}`);

  console.log('\nZákladní validace');
  await api({ action: 'nic' }, { expectStatus: 404 });
  check(true, 'neznámá akce -> 404');
  await api({ action: 'create', name: '', rule: 'x', adminName: 'y' }, { expectStatus: 400 });
  check(true, 'prázdný název -> 400');
  await api({ action: 'state', gameId: 'nesmysl' }, { expectStatus: 404 });
  check(true, 'neplatné gameId -> 404');
  const bad = await fetch(`${BASE}/api.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  check(bad.status === 400, 'neplatný JSON -> 400');
  const cross = await fetch(`${BASE}/api.php`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  check(cross.status === 403, 'cizí Origin -> 403');

  console.log('\nRegistrace');
  const g = await setupGame('confirm', 4);
  const dup = await fetch(`${BASE}/api.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'join', code: g.code, name: 'p1' }) });
  check(dup.status === 400, 'duplicitní jméno bez ohledu na velikost písmen odmítnuto');
  const tooEarly = await fetch(`${BASE}/api.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', ...g.players[1].cred }) });
  check(tooEarly.status === 403, 'hráč bez admin tokenu nemůže spustit hru');
  let adminState = await api({ action: 'state', ...g.admin });
  check(adminState.roster?.length === 4 && adminState.admin?.canManage === true, 'organizátor vidí soupisku při registraci');

  console.log('\nRežim confirm');
  await api({ action: 'start', ...g.admin });
  check(await verifyCircle(g.players), 'po startu vznikl jeden uzavřený kruh');
  adminState = await api({ action: 'state', ...g.admin });
  check(!adminState.roster && adminState.admin.canManage === false, 'živý organizátor nevidí nic navíc');
  const late = await fetch(`${BASE}/api.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'join', code: g.code, name: 'Pozdě' }) });
  check(late.status === 400, 'po startu nelze se připojit');

  let killer = g.players[0];
  let victim = byName(g.players, (await targetOf(killer)).name);
  const victimTarget = (await targetOf(victim)).name;
  await api({ action: 'report', ...killer.cred });
  let vs = await api({ action: 'state', ...victim.cred });
  check(vs.incoming?.status === 'pending', 'oběť vidí žádost o potvrzení');
  check(!JSON.stringify(vs).includes(killer.cred.playerToken), 'odpověď neobsahuje cizí tokeny');
  await api({ action: 'respond', ...victim.cred, reportId: vs.incoming.id, accepted: false });
  let ks = await api({ action: 'state', ...killer.cred });
  check(ks.rejected?.victimName === victim.name && ks.player.target.name === victim.name, 'odmítnutí: vrah má stále stejnou oběť');
  await api({ action: 'report', ...killer.cred });
  vs = await api({ action: 'state', ...victim.cred });
  await api({ action: 'respond', ...victim.cred, reportId: vs.incoming.id, accepted: true });
  ks = await api({ action: 'state', ...killer.cred });
  check(ks.player.target.name === victimTarget && ks.player.killsCount === 1, 'potvrzení: vrah dostal oběť oběti');
  check(await verifyCircle(g.players), 'kruh je stále uzavřený');

  console.log('\nSouběh (optimistické zamykání)');
  const alive = [];
  for (const p of g.players) if ((await api({ action: 'state', ...p.cred })).player.status === 'alive') alive.push(p);
  const results = await Promise.allSettled(alive.map(p => api({ action: 'report', ...p.cred })));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  check(ok >= 1, `souběžná hlášení: ${ok} uspělo, ostatní odmítnuta s chybou`);
  check(await verifyCircle(g.players), 'kruh přežil souběžné požadavky');

  console.log('\nPředčasné ukončení');
  await api({ action: 'end', ...g.admin });
  const finished = await api({ action: 'state', ...g.admin });
  check(finished.game.status === 'finished' && finished.game.endedReason === 'admin' && finished.stats, 'hra ukončena, statistiky dostupné');

  console.log('\nRežim appeal');
  const a = await setupGame('appeal', 3);
  await api({ action: 'start', ...a.admin });
  killer = a.players[0];
  victim = byName(a.players, (await targetOf(killer)).name);
  await api({ action: 'report', ...killer.cred });
  vs = await api({ action: 'state', ...victim.cred });
  check(vs.player.status === 'dead' && vs.incoming?.status === 'provisional', 'oběť je hned mrtvá a může odvolat');
  await api({ action: 'respond', ...victim.cred, reportId: vs.incoming.id, accepted: false });
  vs = await api({ action: 'state', ...victim.cred });
  ks = await api({ action: 'state', ...killer.cred });
  check(vs.player.status === 'alive' && ks.player.target.name === victim.name, 'odvolání vrátí stav zpět');
  await api({ action: 'report', ...killer.cred });
  const third = byName(a.players, (await targetOf(killer)).name);
  check(third && third.name !== victim.name, 'po další vraždě má vrah novou oběť');
  await api({ action: 'report', ...killer.cred }); // uzavře odvolací lhůtu první vraždy
  ks = await api({ action: 'state', ...killer.cred });
  check(ks.player.target === null, 'poslední dvojice: vrah čeká na odpověď poslední oběti');
  const last = await api({ action: 'state', ...third.cred });
  await api({ action: 'respond', ...third.cred, reportId: last.incoming.id, accepted: true });
  ks = await api({ action: 'state', ...killer.cred });
  check(ks.game.status === 'finished' && ks.stats.winner === killer.name && ks.stats.leaders[0].kills === 2, 'vítěz určen, statistiky sedí');

  console.log('\nRežim instant');
  const n = await setupGame('instant', 3);
  await api({ action: 'start', ...n.admin });
  killer = n.players[1];
  await api({ action: 'report', ...killer.cred });
  await api({ action: 'report', ...killer.cred });
  ks = await api({ action: 'state', ...killer.cred });
  check(ks.game.status === 'finished' && ks.stats.winner === killer.name && ks.stats.timeline.length === 2, 'dvě okamžité vraždy ukončily hru');
  check(ks.stats.windows[0].count === 2 && ks.stats.firstVictim, 'statistiky oken a první oběti');

  console.log('\nOběť sama nahlásí smrt („Byl/a jsem zabit/a“)');
  const d = await setupGame('confirm', 3);
  await api({ action: 'start', ...d.admin });
  const states = await Promise.all(d.players.map(p => api({ action: 'state', ...p.cred })));
  const victimP = d.players[0];
  const killerP = d.players.find((p, i) => states[i].player.target?.name === victimP.name);
  const selfTarget = states[0].player.target.name;
  const died = await api({ action: 'died', ...victimP.cred });
  check(!JSON.stringify(died).includes(killerP.name), 'odpověď neprozradí jméno vraha');
  let vs2 = await api({ action: 'state', ...victimP.cred });
  let ks2 = await api({ action: 'state', ...killerP.cred });
  check(vs2.player.status === 'dead' && !vs2.incoming, 'oběť je mrtvá bez dalšího potvrzování');
  check(ks2.player.target.name === selfTarget && ks2.player.killsCount === 1, 'vrah hned dostal oběť oběti a vraždu navíc');
  // poslední dvojice: vrah nahlásí, oběť místo odpovědi zvolí „Byl/a jsem zabit/a“ -> konec hry
  const lastVictim = d.players.find(p => p.name === selfTarget);
  await api({ action: 'report', ...killerP.cred });
  await api({ action: 'died', ...lastVictim.cred });
  ks2 = await api({ action: 'state', ...killerP.cred });
  check(ks2.game.status === 'finished' && ks2.stats.winner === killerP.name, 'čekající vražda se potvrdí a hra skončí vítězem');
  const deadAgain = await fetch(`${BASE}/api.php`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'died', ...victimP.cred }) });
  check(deadAgain.status === 403, 'mrtvý hráč smrt znovu nahlásit nemůže');

  console.log(failures ? `\n${failures} kontrol selhalo.` : '\nVšechny kontroly prošly.');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
