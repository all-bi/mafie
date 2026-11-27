// Web Push (RFC 8030) se šifrováním aes128gcm (RFC 8291) a VAPID (RFC 8292),
// implementované čistě přes Web Crypto. Bez externích knihoven.
//
// Upozornění nikdy neobsahují jména ani jiné tajné informace. Text se zobrazí
// i na zamčené obrazovce, proto říká jen „co se stalo“ a detail je v aplikaci.

export interface PushEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Jen pro lokální testy: povolí http://127.0.0.1 jako push endpoint. */
  PUSH_ALLOW_LOCALHOST?: string;
  PUSH_OUTBOX?: DurableObjectNamespace<import('./outbox').PushOutbox>;
}

export type NoteKind =
  | 'kill_confirm'
  | 'kill_appeal'
  | 'kill_instant'
  | 'kill_confirmed'
  | 'victim_reported'
  | 'kill_rejected'
  | 'appeal_rejected'
  | 'game_started'
  | 'kill_first'
  | 'kill_next'
  | 'game_ended';

/** Komu poslat upozornění: konkrétnímu hráči, všem hráčům hry, nebo organizátorovi. */
export interface Note {
  kind: NoteKind;
  playerId?: string;
  allPlayers?: boolean;
  admins?: boolean;
  /** Hráči, kterým se tato zpráva neposílá (např. vrah a oběť u oznámení vraždy). */
  exclude?: string[];
}

export interface PushJob {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: string;
  urgency: 'high' | 'normal';
}

interface SubscriptionRow {
  endpoint: string;
  player_id: string | null;
  role: 'player' | 'admin';
  p256dh: string;
  auth: string;
}

const MESSAGES: Record<NoteKind, { title: string; body: string; urgency: 'high' | 'normal'; priority: number }> = {
  kill_confirm: { title: 'Byl/a jsi zabit/a?', body: 'Potvrď nebo odmítni vraždu v aplikaci.', urgency: 'high', priority: 2 },
  kill_appeal: { title: 'Byl/a jsi zabit/a.', body: 'Pokud vražda neproběhla podle pravidel, můžeš ji v aplikaci odvolat.', urgency: 'high', priority: 2 },
  kill_instant: { title: 'Byl/a jsi zabit/a.', body: 'Tvoje hra skončila. Výsledky uvidíš po konci celé hry.', urgency: 'high', priority: 2 },
  kill_confirmed: { title: 'Vražda potvrzena', body: 'Máš novou oběť. Podívej se do aplikace.', urgency: 'high', priority: 1 },
  victim_reported: { title: 'Oběť nahlásila svou smrt', body: 'Máš novou oběť. Podívej se do aplikace.', urgency: 'high', priority: 1 },
  kill_rejected: { title: 'Oběť vraždu odmítla', body: 'Vyřeš situaci se svou obětí. Zůstává tvým cílem.', urgency: 'high', priority: 1 },
  appeal_rejected: { title: 'Vražda byla odvolána', body: 'Předchozí oběť vraždu odvolala a je opět tvým cílem.', urgency: 'high', priority: 1 },
  kill_first: { title: 'Padla první oběť', body: 'Rodina přišla o prvního člena. Dávej si pozor.', urgency: 'normal', priority: 0 },
  kill_next: { title: 'Padla další oběť', body: 'Kruh se zmenšuje. Dávej si pozor.', urgency: 'normal', priority: 0 },
  game_started: { title: 'Hra začala', body: 'Podívej se, kdo je tvoje oběť.', urgency: 'high', priority: 3 },
  game_ended: { title: 'Hra skončila', body: 'Podívej se na výsledky.', urgency: 'normal', priority: 4 },
};

/** Kolik zpráv poslat přímo v rámci požadavku (každá stojí ~0,8 ms CPU). */
const INLINE_MAX = 3;

/** Známé push služby prohlížečů. Na jiné adresy server nic neposílá (ochrana proti SSRF). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function pushConfigured(env: PushEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export function isAllowedEndpoint(endpoint: string, env: PushEnv): boolean {
  if (endpoint.length > 1024) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (env.PUSH_ALLOW_LOCALHOST === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1') return true;
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return PUSH_HOSTS.some(pattern => pattern.test(url.hostname));
}

/** Ověří klíče odběru z prohlížeče (P-256 veřejný klíč 65 B, auth 16 B). */
export function isValidKeys(p256dh: string, auth: string): boolean {
  try {
    const key = b64urlDecode(p256dh);
    return key.length === 65 && key[0] === 4 && b64urlDecode(auth).length === 16;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- odeslání

/**
 * Pošle upozornění odběratelům hry. Volá se přes waitUntil až po úspěšném
 * zápisu změny do D1, takže neblokuje odpověď ani nezpůsobí chybu akce.
 */
export async function dispatch(env: PushEnv, gameId: string, notes: Note[]): Promise<void> {
  if (!notes.length || !pushConfigured(env)) return;
  try {
    const { results } = await env.DB.prepare(
      'SELECT endpoint, player_id, role, p256dh, auth FROM push_subscriptions WHERE game_id = ?',
    ).bind(gameId).all<SubscriptionRow>();

    const jobs: PushJob[] = [];
    for (const sub of results) {
      // Jedna zpráva na zařízení: při více událostech najednou vyhraje ta důležitější.
      let best: NoteKind | null = null;
      for (const note of notes) {
        if (sub.player_id && note.exclude?.includes(sub.player_id)) continue;
        const applies = (note.playerId !== undefined && note.playerId === sub.player_id)
          || (note.allPlayers && sub.role === 'player')
          || (note.admins && sub.role === 'admin');
        if (applies && (!best || MESSAGES[note.kind].priority > MESSAGES[best].priority)) best = note.kind;
      }
      if (!best) continue;
      const message = MESSAGES[best];
      jobs.push({
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        urgency: message.urgency,
        payload: JSON.stringify({ title: message.title, body: message.body, tag: `kruh-${gameId}`, url: '/' }),
      });
    }
    if (!jobs.length) return;

    if (jobs.length <= INLINE_MAX || !env.PUSH_OUTBOX) {
      // Bez fronty (nemělo by nastat) pošleme jen tolik, kolik se vejde do CPU limitu.
      await sendJobs(env, jobs.slice(0, env.PUSH_OUTBOX ? jobs.length : INLINE_MAX));
      return;
    }
    // Hromadné zprávy (začátek/konec hry) rozešle Durable Object po dávkách,
    // každá dávka běží jako samostatné spuštění s vlastním limitem CPU.
    const outbox = env.PUSH_OUTBOX.get(env.PUSH_OUTBOX.idFromName(gameId));
    await outbox.enqueue(jobs);
  } catch (error) {
    console.error('push dispatch failed', error);
  }
}

/** Zašifruje a odešle zprávy; neplatné odběry (404/410) smaže z D1. */
export async function sendJobs(env: PushEnv, jobs: PushJob[]): Promise<void> {
  const gone: string[] = [];
  await Promise.all(jobs.map(async job => {
    try {
      if (!isAllowedEndpoint(job.endpoint, env)) return;
      const body = await encryptPayload(job.p256dh, job.auth, new TextEncoder().encode(job.payload));
      const audience = new URL(job.endpoint).origin;
      const response = await fetch(job.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(env, audience),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '43200',
          Urgency: job.urgency,
        },
        body,
      });
      if (response.status === 404 || response.status === 410) gone.push(job.endpoint);
      else if (!response.ok) console.warn('push rejected', response.status, audience);
      await response.body?.cancel();
    } catch (error) {
      console.error('push send failed', error);
    }
  }));
  if (gone.length) {
    await env.DB.batch(gone.map(endpoint => env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint)));
  }
}

// ------------------------------------------------------------- šifrování

const enc = new TextEncoder();

export function b64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error('invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** RFC 8291 + RFC 8188 (aes128gcm, jeden záznam). */
export async function encryptPayload(
  p256dh: string,
  authSecret: string,
  plaintext: Uint8Array,
  fixed?: { salt: Uint8Array; serverKeys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  const serverKeys = fixed?.serverKeys
    ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as SubtleCryptoDeriveKeyAlgorithm, serverKeys.privateKey, 256),
  );

  const ikm = await hkdf(auth, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = poslední záznam
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

// ------------------------------------------------------------------ VAPID

let signingKey: { source: string; key: CryptoKey } | null = null;
const jwtCache = new Map<string, { value: string; expires: number }>();

async function vapidKey(env: PushEnv): Promise<CryptoKey> {
  const source = `${env.VAPID_PUBLIC_KEY}|${env.VAPID_PRIVATE_KEY}`;
  if (signingKey?.source === source) return signingKey.key;
  const publicKey = b64urlDecode(env.VAPID_PUBLIC_KEY!);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('VAPID_PUBLIC_KEY má neplatný formát.');
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlEncode(publicKey.slice(1, 33)),
      y: b64urlEncode(publicKey.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY!,
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  signingKey = { source, key };
  jwtCache.clear();
  return key;
}

/** Hlavička Authorization: vapid t=<JWT ES256>, k=<veřejný klíč>. JWT se cachuje na 11 h. */
export async function vapidAuthorization(env: PushEnv, audience: string): Promise<string> {
  const key = await vapidKey(env);
  const now = Math.floor(Date.now() / 1000);
  let cached = jwtCache.get(audience);
  if (!cached || cached.expires - 3600 < now) {
    const expires = now + 12 * 3600;
    const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64urlEncode(enc.encode(JSON.stringify({
      aud: audience,
      exp: expires,
      sub: env.VAPID_SUBJECT || 'https://mafie.albiovi.cz',
    })));
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      enc.encode(`${header}.${claims}`),
    ));
    cached = { value: `${header}.${claims}.${b64urlEncode(signature)}`, expires };
    jwtCache.set(audience, cached);
  }
  return `vapid t=${cached.value}, k=${env.VAPID_PUBLIC_KEY}`;
}
