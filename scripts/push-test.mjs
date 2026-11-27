#!/usr/bin/env node
// Test push upozornění proti běžícímu `npm run dev` s falešnou push službou.
// Vyžaduje v .dev.vars klíče VAPID (node scripts/generate-vapid.mjs)
// a řádek PUSH_ALLOW_LOCALHOST=1 (jen pro lokální test, nikdy v produkci).
// Spuštění: npm run test:push
import http from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
const B = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '') + '/api.php';
const post = async p => { const r = await fetch(B, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return [r.status, await r.json()]; };
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) process.exitCode = 1; };

// falešná push služba
const devices = new Map(); // path -> {ecdh, auth, inbox}
let gone = new Set();
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const d = devices.get(req.url);
    if (!d || gone.has(req.url)) { res.statusCode = 410; return res.end(); }
    if (!/^vapid t=.+, k=.+/.test(req.headers.authorization || '') || req.headers['content-encoding'] !== 'aes128gcm') { res.statusCode = 400; return res.end(); }
    d.inbox.push(JSON.parse(ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: d.ecdh, authSecret: d.auth }).toString()));
    res.statusCode = 201; res.end();
  });
}).listen(9911);
function device(name) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16);
  const path = '/push/' + name; devices.set(path, { ecdh, auth, inbox: [] });
  return { path, sub: { endpoint: 'http://127.0.0.1:9911' + path, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } } };
}
const inbox = path => devices.get(path).inbox;
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('Odběry');
const [, c] = await post({ action: 'create', name: 'Push', rule: 'x', adminName: 'Org', adminPlays: false, killMode: 'confirm', killAlerts: 'none' });
const admin = c.credentials;
const [, s0] = await post({ action: 'state', ...admin });
ok(s0.push?.publicKey?.length > 80, 'state obsahuje veřejný VAPID klíč');
const adminDev = device('admin');
ok((await post({ action: 'subscribe', ...admin, subscription: adminDev.sub }))[0] === 200, 'organizátor (nehrající) se přihlásil k odběru');
let [st] = await post({ action: 'subscribe', ...admin, subscription: { endpoint: 'https://evil.example/x', keys: adminDev.sub.keys } });
ok(st === 400, 'cizí endpoint (SSRF) odmítnut');
[st] = await post({ action: 'subscribe', gameId: admin.gameId, subscription: adminDev.sub });
ok(st === 401, 'odběr bez přístupu odmítnut');

const players = [];
for (let i = 0; i < 12; i++) {
  const [, j] = await post({ action: 'join', code: s0.game.code, name: 'H' + i });
  const dev = device('h' + i);
  await post({ action: 'subscribe', ...j.credentials, subscription: dev.sub });
  players.push({ name: 'H' + i, cred: j.credentials, path: dev.path });
}

console.log('Začátek hry (12 odběratelů → fronta v Durable Objectu)');
await post({ action: 'start', ...admin });
await wait(2500);
ok(players.every(p => inbox(p.path).length === 1 && inbox(p.path)[0].title === 'Hra začala'), 'všech 12 hráčů dostalo „Hra začala“');
ok(inbox(adminDev.path).length === 0, 'nehrající organizátor zprávu o začátku nedostal');

console.log('Vražda v režimu potvrzení');
const killer = players[0];
const [, ks] = await post({ action: 'state', ...killer.cred });
const victim = players.find(p => p.name === ks.player.target.name);
await post({ action: 'report', ...killer.cred });
await wait(800);
const vMsg = inbox(victim.path).at(-1);
ok(vMsg.title === 'Byl/a jsi zabit/a?' && !JSON.stringify(vMsg).includes(killer.name), 'oběť dostala výzvu bez jména vraha');
const [, vs] = await post({ action: 'state', ...victim.cred });
await post({ action: 'respond', ...victim.cred, reportId: vs.incoming.id, accepted: false });
await wait(800);
ok(inbox(killer.path).at(-1).title === 'Oběť vraždu odmítla', 'vrah dostal „Oběť vraždu odmítla“');
await post({ action: 'report', ...killer.cred });
await wait(500);
const [, vs2] = await post({ action: 'state', ...victim.cred });
await post({ action: 'respond', ...victim.cred, reportId: vs2.incoming.id, accepted: true });
await wait(800);
ok(inbox(killer.path).at(-1).title === 'Vražda potvrzena', 'vrah dostal „Vražda potvrzena“');
const others = players.filter(p => p !== killer && p !== victim);
ok(others.every(p => inbox(p.path).length === 1), 'ostatní hráči nedostali nic');

console.log('Neplatný odběr se smaže');
gone.add(others[0].path);

console.log('Konec hry');
await post({ action: 'end', ...admin });
await wait(3000);
ok(inbox(adminDev.path).at(-1)?.title === 'Hra skončila', 'organizátor dostal „Hra skončila“');
ok(players.filter(p => p.path !== others[0].path).every(p => inbox(p.path).at(-1).title === 'Hra skončila'), 'všichni hráči dostali „Hra skončila“');

const [, ts] = await post({ action: 'transferCreate', ...players[1].cred });
ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(ts.code), `kód přenosu ${ts.code}`);
const [s1, tr] = await post({ action: 'transferRedeem', code: ts.code.toLowerCase() });
ok(s1 === 200 && tr.credentials.playerToken === players[1].cred.playerToken, 'kód přenosu vrátil přístup');
const [s2] = await post({ action: 'transferRedeem', code: ts.code });
ok(s2 === 404, 'kód přenosu nejde použít podruhé');

console.log('Oznamování vražd (nastavení hry) a průběžné statistiky');
for (const alerts of ['first', 'every']) {
  const [, c2] = await post({ action: 'create', name: 'Oznámení ' + alerts, rule: 'x', adminName: 'Org', adminPlays: false, killMode: 'instant', killAlerts: alerts });
  const adm = c2.credentials;
  const [, st] = await post({ action: 'state', ...adm });
  ok(st.game.killAlerts === alerts, `hra uložila killAlerts=${alerts}`);
  const admDev = device('adm-' + alerts);
  await post({ action: 'subscribe', ...adm, subscription: admDev.sub });
  const ps = [];
  for (let i = 0; i < 5; i++) {
    const [, j] = await post({ action: 'join', code: st.game.code, name: 'Q' + i });
    const dev = device(alerts + i);
    await post({ action: 'subscribe', ...j.credentials, subscription: dev.sub });
    ps.push({ cred: j.credentials, path: dev.path, name: 'Q' + i });
  }
  await post({ action: 'start', ...adm });
  await wait(2500);
  const killer = ps[0];
  const [, s1] = await post({ action: 'state', ...killer.cred });
  const v1 = ps.find(p => p.name === s1.player.target.name);
  await post({ action: 'report', ...killer.cred });
  await wait(2500);
  const bystanders = ps.filter(p => p !== killer && p !== v1);
  ok(bystanders.every(p => inbox(p.path).at(-1)?.title === 'Padla první oběť'), `[${alerts}] ostatní dostali „Padla první oběť“`);
  ok(inbox(admDev.path).at(-1)?.title === 'Padla první oběť', `[${alerts}] organizátor dostal oznámení`);
  ok(inbox(killer.path).at(-1)?.title === 'Hra začala' && inbox(v1.path).at(-1)?.title === 'Byl/a jsi zabit/a.', `[${alerts}] vrah oznámení nedostal, oběť dostala svou zprávu`);
  const before = bystanders.map(p => inbox(p.path).length);
  await post({ action: 'report', ...killer.cred });
  await wait(2500);
  const v2 = bystanders.find(p => inbox(p.path).at(-1)?.title?.startsWith('Byl/a'));
  const others2 = bystanders.filter(p => p !== v2);
  const got = others2.filter((p) => inbox(p.path).length > before[bystanders.indexOf(p)]);
  if (alerts === 'first') ok(got.length === 0, '[first] druhá vražda se neoznamuje');
  else ok(got.length === others2.length && others2.every(p => inbox(p.path).at(-1).title === 'Padla další oběť'), '[every] druhá vražda: „Padla další oběť“');
  const [, live] = await post({ action: 'state', ...adm });
  ok(live.stats?.live === true && live.stats.kills.length === 2 && live.stats.circle?.length === 5, `[${alerts}] nehrající organizátor vidí průběžné statistiky a kruh`);
  const [, ps1] = await post({ action: 'state', ...ps[3].cred });
  ok(!ps1.stats, `[${alerts}] hráč během hry statistiky nevidí`);
  if (alerts === 'every') {
    const [sd] = await post({ action: 'delete', ...ps[1].cred });
    ok(sd === 403, 'hráč nemůže hru smazat');
    const [sd2] = await post({ action: 'delete', ...adm });
    const [sg] = await post({ action: 'state', ...adm });
    ok(sd2 === 200 && sg === 404, 'organizátor hru smazal (hra už neexistuje)');
  }
}
server.close();
