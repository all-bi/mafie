#!/usr/bin/env node
// Vygeneruje pár klíčů VAPID pro push upozornění.
// Použití: node scripts/generate-vapid.mjs
const { subtle } = globalThis.crypto;
const b64url = bytes => Buffer.from(bytes).toString('base64url');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await subtle.exportKey('jwk', pair.privateKey);
const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));

console.log(`VAPID_PUBLIC_KEY=${b64url(publicRaw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log(`
Nastavení v Cloudflare (každý příkaz se zeptá na hodnotu, vlož ji z výpisu výše):
  npx wrangler secret put VAPID_PUBLIC_KEY
  npx wrangler secret put VAPID_PRIVATE_KEY

Pro lokální vývoj ulož oba řádky do souboru .dev.vars (je v .gitignore).
Privátní klíč nikomu neposílej a necommituj. Když ho změníš, všichni hráči
musí upozornění zapnout znovu.`);
