// Herní logika — přepis legacy/src/GameService.php pro Cloudflare D1.
//
// Souběžnost: D1 nepodporuje interaktivní transakce ani SELECT ... FOR UPDATE.
// Každá měnící akce proto:
//   1. načte stav hry (hru, její hráče a otevřená hlášení),
//   2. v paměti spočítá změny a nasbírá prepared statements,
//   3. vše zapíše jedním db.batch(), který D1 provede atomicky jako transakci.
// Prvním příkazem batche je kontrola games.version. Pokud hru mezitím změnil
// jiný požadavek, kontrola selže (CHECK v tabulce concurrency_guard), D1 vrátí
// celý batch zpět a akce se zopakuje nad čerstvými daty.

import {
  DomainError,
  accessToken,
  boolValue,
  gameCode,
  iso,
  isToken,
  isUuid,
  nameKey,
  nowIso,
  phpTrim,
  secureShuffle,
  str,
  text,
  timingSafeEqual,
  tokenHash,
  uuidV4,
} from './util';
import { isAllowedEndpoint, isValidKeys, pushConfigured, type Note, type PushEnv } from './push';

type GameStatus = 'registration' | 'active' | 'finished';
type KillMode = 'confirm' | 'appeal' | 'instant';
type PlayerStatus = 'alive' | 'dead';
type ReportStatus = 'pending' | 'provisional' | 'confirmed' | 'rejected' | 'dismissed' | 'cancelled';

interface GameRow {
  id: string;
  code: string;
  name: string;
  rule_text: string;
  status: GameStatus;
  kill_mode: KillMode;
  show_roster: number;
  admin_token_hash: string;
  admin_player_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  ended_reason: 'winner' | 'admin' | null;
  version: number;
  created_at: string;
}

interface PlayerRow {
  id: string;
  game_id: string;
  name: string;
  name_key: string;
  token_hash: string;
  status: PlayerStatus;
  target_id: string | null;
  kills_count: number;
  joined_at: string;
  eliminated_at: string | null;
}

interface ReportRow {
  id: string;
  game_id: string;
  killer_id: string;
  victim_id: string;
  status: ReportStatus;
  reported_at: string;
  resolved_at: string | null;
}

export type Input = Record<string, unknown>;
type Json = Record<string, unknown>;

const OPEN: ReportStatus[] = ['pending', 'provisional'];
const MAX_ATTEMPTS = 6;

// Řazení stejné jako v MySQL; při shodném čase rozhoduje pořadí vložení.
const PLAYERS_BY_GAME = 'SELECT * FROM players WHERE game_id = ? ORDER BY joined_at, rowid';

function isConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('version_conflict');
}

function isUniqueViolation(error: unknown, columns: string): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed') && error.message.includes(columns);
}

export class GameService {
  /** Upozornění k odeslání po úspěšně zapsané změně (vyzvedne je index.tsx). */
  notifications: { gameId: string; notes: Note[] } | null = null;
  private readonly db: D1Database;

  constructor(private readonly env: PushEnv) {
    this.db = env.DB;
  }

  async handle(input: Input): Promise<Json> {
    switch (str(input.action)) {
      case 'create': return this.createGame(input);
      case 'join': return this.joinGame(input);
      case 'state': return this.state(input);
      case 'start': return this.mutate(input, tx => tx.start(input));
      case 'report': return this.mutate(input, tx => tx.report(input));
      case 'respond': return this.mutate(input, tx => tx.respond(input));
      case 'end': return this.mutate(input, tx => tx.end(input));
      case 'subscribe': return this.subscribe(input);
      case 'unsubscribe': return this.unsubscribe(input);
      case 'transferCreate': return this.transferCreate(input);
      case 'transferRedeem': return this.transferRedeem(input);
      default: throw new DomainError('Neznámá akce.', 404);
    }
  }

  // ---------------------------------------------------------------- create

  private async createGame(input: Input): Promise<Json> {
    const name = text(input.name, 60);
    const rule = text(input.rule, 240);
    const adminName = text(input.adminName, 40);
    if (name === '' || rule === '' || adminName === '') {
      throw new DomainError('Vyplň všechna povinná pole.');
    }
    if (nameKey(adminName) === '') throw new DomainError('Zadej své jméno.');

    let killMode = str(input.killMode || 'appeal') as KillMode;
    if (!['confirm', 'appeal', 'instant'].includes(killMode)) killMode = 'appeal';

    const gameId = uuidV4();
    const adminToken = accessToken();
    const adminPlays = boolValue(input.adminPlays ?? false);
    const playerId = adminPlays ? uuidV4() : null;
    const playerToken = adminPlays ? accessToken() : null;
    const showRoster = boolValue(input.showRoster ?? false) ? 1 : 0;
    const adminHash = await tokenHash(adminToken);
    const playerHash = playerToken ? await tokenHash(playerToken) : null;
    const now = nowIso();

    for (let attempt = 0; ; attempt++) {
      const code = await this.uniqueCode();
      const statements = [
        this.db.prepare(
          `INSERT INTO games (id, code, name, rule_text, status, kill_mode, show_roster, admin_token_hash, created_at)
           VALUES (?, ?, ?, ?, 'registration', ?, ?, ?, ?)`,
        ).bind(gameId, code, name, rule, killMode, showRoster, adminHash, now),
      ];
      if (playerId && playerHash) {
        statements.push(
          this.db.prepare(
            `INSERT INTO players (id, game_id, name, name_key, token_hash, status, joined_at)
             VALUES (?, ?, ?, ?, ?, 'alive', ?)`,
          ).bind(playerId, gameId, adminName, nameKey(adminName), playerHash, now),
          this.db.prepare('UPDATE games SET admin_player_id = ? WHERE id = ?').bind(playerId, gameId),
        );
      }
      try {
        await this.db.batch(statements);
        break;
      } catch (error) {
        // Vzácná kolize kódu hry mezi kontrolou a zápisem -> zkusit jiný kód.
        if (isUniqueViolation(error, 'games.code') && attempt < 5) continue;
        throw error;
      }
    }

    const credentials: Json = { gameId, adminToken };
    if (playerToken) credentials.playerToken = playerToken;
    return { credentials };
  }

  private async uniqueCode(): Promise<string> {
    const stmt = this.db.prepare('SELECT 1 AS found FROM games WHERE code = ?');
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = gameCode();
      if (!(await stmt.bind(code).first())) return code;
    }
    throw new Error('Nepodařilo se vytvořit unikátní kód hry.');
  }

  // ------------------------------------------------------------------ join

  private async joinGame(input: Input): Promise<Json> {
    const code = phpTrim(str(input.code)).toUpperCase();
    const name = text(input.name, 40);
    if (name === '' || nameKey(name) === '') throw new DomainError('Zadej své jméno.');

    const game = /^[A-Z0-9]{6}$/.test(code)
      ? await this.db.prepare('SELECT * FROM games WHERE code = ?').bind(code).first<GameRow>()
      : null;
    if (!game) throw new DomainError('Hra s tímto kódem neexistuje.', 404);
    if (game.status !== 'registration') throw new DomainError('Registrace do této hry už skončila.');

    // Připojení nečte nic, co by mohl souběžný požadavek zneplatnit, kromě stavu
    // hry. Vložení je proto podmíněné stavem 'registration' přímo v SQL a zvýší
    // verzi hry, takže souběžné „Spustit hru“ připojení zaznamená a zopakuje se.
    // Souběžná připojení na sebe navzájem nečekají.
    const playerId = uuidV4();
    const playerToken = accessToken();
    let inserted: D1Result;
    try {
      [inserted] = (await this.db.batch([
        this.db.prepare(
          `INSERT INTO players (id, game_id, name, name_key, token_hash, status, joined_at)
           SELECT ?, id, ?, ?, ?, 'alive', ? FROM games WHERE id = ? AND status = 'registration'`,
        ).bind(playerId, name, nameKey(name), await tokenHash(playerToken), nowIso(), game.id),
        this.db.prepare(
          "UPDATE games SET version = version + 1 WHERE id = ? AND status = 'registration'",
        ).bind(game.id),
      ])) as [D1Result];
    } catch (error) {
      if (isUniqueViolation(error, 'players.game_id')) {
        throw new DomainError('Toto jméno už ve hře někdo používá.');
      }
      throw error;
    }
    if (!inserted.meta.changes) throw new DomainError('Registrace do této hry už skončila.');
    return { credentials: { gameId: game.id, playerToken } };
  }

  // ----------------------------------------------------------------- state

  private async state(input: Input): Promise<Json> {
    const gameId = str(input.gameId);
    const playerToken = str(input.playerToken);
    const adminToken = str(input.adminToken);
    if (!isUuid(gameId)) throw new DomainError('Hra nebyla nalezena.', 404);

    const playerHash = isToken(playerToken) ? await tokenHash(playerToken) : null;
    const [gameResult, playerResult] = await this.db.batch([
      this.db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId),
      this.db.prepare('SELECT * FROM players WHERE game_id = ? AND token_hash = ?').bind(gameId, playerHash ?? ''),
    ]);
    const game = (gameResult!.results[0] as GameRow | undefined) ?? null;
    if (!game) throw new DomainError('Hra nebyla nalezena.', 404);
    const player = playerHash ? ((playerResult!.results[0] as PlayerRow | undefined) ?? null) : null;
    const isAdmin = await this.isAdmin(game, adminToken);
    if (!player && !isAdmin) throw new DomainError('Přístup do hry vypršel.', 401);

    // Každá změna hry (připojení, start, vražda, odpověď, konec) zvýší games.version.
    // Pokud klient už má aktuální verzi, stačí odpovědět „beze změny“ — ušetří to
    // většinu čtení z D1 při pravidelném obnovování.
    if (typeof input.knownVersion === 'number' && input.knownVersion === game.version) {
      return { unchanged: true, version: game.version };
    }

    // Druhá dávka: všechno, co závisí na hře/hráči, jedním round-tripem.
    const queries: Record<string, D1PreparedStatement> = {};
    if (game.admin_player_id) {
      queries.admin = this.db.prepare('SELECT status FROM players WHERE id = ?').bind(game.admin_player_id);
    }
    if (player) {
      if (player.target_id && player.target_id !== player.id) {
        queries.target = this.db.prepare('SELECT id, name FROM players WHERE id = ?').bind(player.target_id);
      }
      queries.incoming = this.db.prepare(
        `SELECT id, status, reported_at FROM kill_reports
         WHERE victim_id = ? AND status IN ('pending', 'provisional') ORDER BY reported_at DESC, rowid DESC LIMIT 1`,
      ).bind(player.id);
      queries.outgoing = this.db.prepare(
        `SELECT id, status, reported_at FROM kill_reports
         WHERE killer_id = ? AND status IN ('pending', 'provisional') ORDER BY reported_at DESC, rowid DESC LIMIT 1`,
      ).bind(player.id);
      queries.rejected = this.db.prepare(
        `SELECT r.id, r.status, r.reported_at, v.name AS victim_name
         FROM kill_reports r JOIN players v ON v.id = r.victim_id
         WHERE r.killer_id = ? AND r.status = 'rejected' ORDER BY r.resolved_at DESC, r.rowid DESC LIMIT 1`,
      ).bind(player.id);
    }
    // Soupiska může být viditelná jen v těchto případech (přesná podmínka níže).
    if (game.status === 'finished' || game.show_roster || isAdmin) {
      queries.roster = this.db.prepare(PLAYERS_BY_GAME).bind(game.id);
    }
    if (game.status === 'finished') {
      queries.events = this.db.prepare(
        `SELECT r.reported_at, r.killer_id, k.name AS killer, v.name AS victim
         FROM kill_reports r
         JOIN players k ON k.id = r.killer_id
         JOIN players v ON v.id = r.victim_id
         WHERE r.game_id = ? AND r.status = 'confirmed' ORDER BY r.reported_at, r.rowid`,
      ).bind(game.id);
    }
    const keys = Object.keys(queries);
    const results = keys.length ? await this.db.batch(Object.values(queries)) : [];
    const rows = (key: string): Record<string, unknown>[] => {
      const index = keys.indexOf(key);
      return index === -1 ? [] : (results[index]!.results as Record<string, unknown>[]);
    };

    const adminIsAlive = rows('admin')[0]?.status === 'alive';
    const canManage = isAdmin && !(game.status === 'active' && adminIsAlive);

    const response: Json = { game: publicGame(game), version: game.version };
    if (pushConfigured(this.env)) response.push = { publicKey: this.env.VAPID_PUBLIC_KEY };
    if (player) {
      const target = rows('target')[0];
      response.player = { ...publicPlayer(player), target: target ? { id: target.id, name: target.name } : null };
      const incoming = rows('incoming')[0];
      if (incoming) response.incoming = publicReport(incoming);
      const outgoing = rows('outgoing')[0];
      if (outgoing) response.outgoing = publicReport(outgoing);
      const rejected = rows('rejected')[0];
      if (rejected) response.rejected = { ...publicReport(rejected), victimName: rejected.victim_name };
    }

    const rosterVisible = game.status === 'finished'
      || Boolean(game.show_roster)
      || (isAdmin && (game.status === 'registration' || canManage));
    const players = rows('roster') as unknown as PlayerRow[];
    if (rosterVisible) response.roster = players.map(publicPlayer);
    if (isAdmin) response.admin = { canManage, canEnd: game.status === 'active' };
    if (game.status === 'finished') {
      response.stats = statistics(game, players, rows('events') as unknown as KillEvent[]);
    }
    return response;
  }

  // -------------------------------------------------------------- mutations

  private async mutate(input: Input, action: (tx: GameTx) => void | Promise<void>): Promise<Json> {
    const gameId = str(input.gameId);
    if (!isUuid(gameId)) throw new DomainError('Hra nebyla nalezena.', 404);

    for (let attempt = 1; ; attempt++) {
      const [gameResult, playersResult, reportsResult] = await this.db.batch([
        this.db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId),
        this.db.prepare(PLAYERS_BY_GAME).bind(gameId),
        this.db.prepare(
          `SELECT * FROM kill_reports WHERE game_id = ? AND status IN ('pending', 'provisional', 'rejected')
           ORDER BY reported_at, rowid`,
        ).bind(gameId),
      ]);
      const game = gameResult!.results[0] as GameRow | undefined;
      if (!game) throw new DomainError('Hra nebyla nalezena.', 404);

      const tx = new GameTx(
        this.db,
        game,
        playersResult!.results as unknown as PlayerRow[],
        reportsResult!.results as unknown as ReportRow[],
        await this.hashOrNull(str(input.playerToken)),
        await this.isAdmin(game, str(input.adminToken)),
      );
      await action(tx);
      try {
        await this.db.batch([...this.guard(game), ...tx.statements]);
        if (tx.notes.length) this.notifications = { gameId: game.id, notes: tx.notes };
        return { ok: true };
      } catch (error) {
        if (isConflict(error) && attempt < MAX_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }
        if (isConflict(error)) throw busyError();
        throw error;
      }
    }
  }

  // ---------------------------------------------------------- upozornění

  /** Ověří přístup do hry (hráč nebo organizátor) stejně jako state. */
  private async auth(input: Input): Promise<{ game: GameRow; player: PlayerRow | null; isAdmin: boolean }> {
    const gameId = str(input.gameId);
    if (!isUuid(gameId)) throw new DomainError('Hra nebyla nalezena.', 404);
    const game = await this.db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first<GameRow>();
    if (!game) throw new DomainError('Hra nebyla nalezena.', 404);
    const playerHash = await this.hashOrNull(str(input.playerToken));
    const player = playerHash
      ? await this.db.prepare('SELECT * FROM players WHERE game_id = ? AND token_hash = ?').bind(gameId, playerHash).first<PlayerRow>()
      : null;
    const isAdmin = await this.isAdmin(game, str(input.adminToken));
    if (!player && !isAdmin) throw new DomainError('Přístup do hry vypršel.', 401);
    return { game, player, isAdmin };
  }

  private async subscribe(input: Input): Promise<Json> {
    if (!pushConfigured(this.env)) throw new DomainError('Upozornění nejsou na serveru nastavena.', 503);
    const { game, player } = await this.auth(input);
    const subscription = (input.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = str(subscription.endpoint);
    const p256dh = str(subscription.keys?.p256dh);
    const auth = str(subscription.keys?.auth);
    if (!isAllowedEndpoint(endpoint, this.env) || !isValidKeys(p256dh, auth)) {
      throw new DomainError('Prohlížeč poslal neplatné údaje pro upozornění.');
    }
    // Jedno zařízení (endpoint) patří vždy jen k jedné hře a jednomu hráči.
    await this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, game_id, player_id, role, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET
         game_id = excluded.game_id, player_id = excluded.player_id, role = excluded.role,
         p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
    ).bind(endpoint, game.id, player?.id ?? null, player ? 'player' : 'admin', p256dh, auth, nowIso()).run();
    return { ok: true };
  }

  private async unsubscribe(input: Input): Promise<Json> {
    const { game } = await this.auth(input);
    await this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND game_id = ?')
      .bind(str(input.endpoint), game.id).run();
    return { ok: true };
  }

  // ------------------------------------------------- přenos na jiné zařízení

  private async transferCreate(input: Input): Promise<Json> {
    const { game, player, isAdmin } = await this.auth(input);
    const credentials: Json = { gameId: game.id };
    if (player) credentials.playerToken = str(input.playerToken);
    if (isAdmin) credentials.adminToken = str(input.adminToken);

    const code = transferCode();
    const payload = await sealCredentials(code, JSON.stringify(credentials));
    const now = new Date();
    await this.db.batch([
      this.db.prepare('DELETE FROM transfer_codes WHERE expires_at < ?').bind(now.toISOString()),
      this.db.prepare('INSERT INTO transfer_codes (code_hash, game_id, payload, expires_at) VALUES (?, ?, ?, ?)')
        .bind(await tokenHash(code), game.id, payload, new Date(now.getTime() + TRANSFER_TTL_MS).toISOString()),
    ]);
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInMinutes: TRANSFER_TTL_MS / 60000 };
  }

  private async transferRedeem(input: Input): Promise<Json> {
    const code = phpTrim(str(input.code)).toUpperCase().replace(/[\s-]/g, '');
    const invalid = new DomainError('Kód je neplatný nebo už vypršel.', 404);
    if (!/^[A-Z0-9]{8}$/.test(code)) throw invalid;
    const hash = await tokenHash(code);
    // Smazání a vrácení v jednom příkazu: kód lze použít jen jednou.
    const row = await this.db.prepare(
      'DELETE FROM transfer_codes WHERE code_hash = ? AND expires_at > ? RETURNING payload',
    ).bind(hash, nowIso()).first<{ payload: string }>();
    if (!row) throw invalid;
    const credentials = JSON.parse(await openCredentials(code, row.payload)) as Json;
    return { credentials };
  }

  /** Optimistický zámek: selže, pokud se hra od načtení změnila; jinak zvýší verzi. */
  private guard(game: GameRow): D1PreparedStatement[] {
    return [
      this.db.prepare(
        'INSERT INTO concurrency_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM games WHERE id = ? AND version = ?)',
      ).bind(game.id, game.version),
      this.db.prepare('UPDATE games SET version = version + 1 WHERE id = ?').bind(game.id),
    ];
  }

  private async hashOrNull(token: string): Promise<string | null> {
    return isToken(token) ? tokenHash(token) : null;
  }

  private async isAdmin(game: GameRow, token: string): Promise<boolean> {
    return token !== '' && timingSafeEqual(game.admin_token_hash, await tokenHash(token));
  }
}

/** Krátké náhodné čekání před dalším pokusem (čekání se nepočítá do CPU limitu). */
function backoff(attempt: number): Promise<void> {
  const ms = 15 * attempt + Math.floor(Math.random() * 30);
  return new Promise(resolve => setTimeout(resolve, ms));
}

const TRANSFER_TTL_MS = 10 * 60 * 1000;
const TRANSFER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 8 znaků z 32 (40 bitů) — při platnosti 10 minut nelze rozumně uhodnout. */
function transferCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => TRANSFER_ALPHABET[byte & 31]).join('');
}

async function transferKey(code: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('kruh-transfer-v1'), info: new Uint8Array() },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function sealCredentials(code: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await transferKey(code, 'encrypt'), new TextEncoder().encode(plaintext),
  ));
  return btoa(String.fromCharCode(...iv, ...ciphertext));
}

async function openCredentials(code: string, sealed: string): Promise<string> {
  const bytes = Uint8Array.from(atob(sealed), char => char.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) }, await transferKey(code, 'decrypt'), bytes.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

function busyError(): DomainError {
  return new DomainError('Hru právě upravuje někdo jiný. Zkus to prosím znovu.', 409);
}

/**
 * Stav jedné hry v paměti. Metody odpovídají PHP metodám startGame, reportKill,
 * respondToKill, endGame, finalizeReport a finishIfWinner; místo okamžitých
 * UPDATE sbírají prepared statements do jednoho atomického batche.
 */
class GameTx {
  readonly statements: D1PreparedStatement[] = [];
  readonly notes: Note[] = [];
  private readonly players = new Map<string, PlayerRow>();
  private readonly now = nowIso();

  constructor(
    private readonly db: D1Database,
    private readonly game: GameRow,
    private readonly playerList: PlayerRow[],
    private readonly reports: ReportRow[],
    private readonly playerHash: string | null,
    private readonly isAdmin: boolean,
  ) {
    for (const player of playerList) this.players.set(player.id, player);
  }

  private get me(): PlayerRow | null {
    if (!this.playerHash) return null;
    return this.playerList.find(player => player.token_hash === this.playerHash) ?? null;
  }

  private exec(sql: string, ...params: unknown[]): void {
    this.statements.push(this.db.prepare(sql).bind(...params));
  }

  private latestOpen(field: 'killer_id' | 'victim_id', playerId: string): ReportRow | null {
    const open = this.reports.filter(report => report[field] === playerId && OPEN.includes(report.status));
    return open[open.length - 1] ?? null;
  }

  // ------------------------------------------------------------ setters

  private setPlayerStatus(player: PlayerRow, status: PlayerStatus): void {
    player.status = status;
    player.eliminated_at = status === 'dead' ? this.now : null;
    this.exec('UPDATE players SET status = ?, eliminated_at = ? WHERE id = ?', status, player.eliminated_at, player.id);
  }

  private setTarget(player: PlayerRow, targetId: string | null, addKill = false): void {
    player.target_id = targetId;
    if (addKill) player.kills_count += 1;
    this.exec(
      'UPDATE players SET target_id = ?, kills_count = ? WHERE id = ?',
      targetId, player.kills_count, player.id,
    );
  }

  private addKill(player: PlayerRow): void {
    player.kills_count += 1;
    this.exec('UPDATE players SET kills_count = ? WHERE id = ?', player.kills_count, player.id);
  }

  private setReportStatus(report: ReportRow, status: ReportStatus, resolved = true): void {
    report.status = status;
    if (resolved) report.resolved_at = this.now;
    this.exec('UPDATE kill_reports SET status = ?, resolved_at = ? WHERE id = ?', status, report.resolved_at, report.id);
  }

  private player(id: string): PlayerRow {
    const player = this.players.get(id);
    if (!player) throw new Error('Hráč nebyl nalezen.');
    return player;
  }

  // ------------------------------------------------------------- actions

  start(_input: Input): void {
    if (!this.isAdmin) throw new DomainError('Hru nyní nemůžeš spustit.', 403);
    if (this.game.status !== 'registration') throw new DomainError('Hra už byla spuštěna.');
    const players = [...this.playerList];
    if (players.length < 3) throw new DomainError('Ke spuštění jsou potřeba alespoň 3 hráči.');

    secureShuffle(players);
    players.forEach((player, index) => {
      this.setTarget(player, players[(index + 1) % players.length]!.id);
    });
    this.game.status = 'active';
    this.game.started_at = this.now;
    this.exec("UPDATE games SET status = 'active', started_at = ? WHERE id = ?", this.now, this.game.id);
    this.notes.push({ kind: 'game_started', allPlayers: true });
  }

  report(_input: Input): void {
    const me = this.me;
    if (!me || me.status !== 'alive') throw new DomainError('Vraždu může zadat pouze živý hráč.', 403);
    if (this.game.status !== 'active' || !me.target_id) throw new DomainError('Nyní nelze zadat vraždu.');

    const previous = this.latestOpen('killer_id', me.id);
    if (previous?.status === 'pending') throw new DomainError('Nejdřív musí předchozí oběť potvrdit vraždu.');
    if (previous?.status === 'provisional' && me.target_id === me.id) {
      throw new DomainError('Poslední oběť musí vraždu potvrdit nebo odmítnout.');
    }
    if (previous?.status === 'provisional') this.finalize(previous);

    if (this.latestOpen('victim_id', me.id)) throw new DomainError('Nejdřív odpověz na čekající vraždu.');

    const victim = this.players.get(me.target_id);
    if (!victim || victim.status !== 'alive') throw new DomainError('Tvoje oběť už není dostupná. Obnov stránku.');

    const victimOutgoing = this.latestOpen('killer_id', victim.id);
    if (victimOutgoing?.status === 'pending') {
      throw new DomainError('Tvoje oběť právě čeká na potvrzení jiné vraždy. Zkus to později.');
    }
    if (victimOutgoing?.status === 'provisional') this.finalize(victimOutgoing);

    for (const report of this.reports) {
      if (report.killer_id === me.id && report.status === 'rejected') this.setReportStatus(report, 'dismissed', false);
    }

    const reportId = uuidV4();
    if (this.game.kill_mode === 'confirm') {
      this.insertReport(reportId, me.id, victim.id, 'pending');
      this.notes.push({ kind: 'kill_confirm', playerId: victim.id });
    } else if (this.game.kill_mode === 'appeal') {
      this.insertReport(reportId, me.id, victim.id, 'provisional');
      this.notes.push({ kind: 'kill_appeal', playerId: victim.id });
      this.setPlayerStatus(victim, 'dead');
      this.setTarget(me, victim.target_id);
    } else {
      this.insertReport(reportId, me.id, victim.id, 'confirmed', this.now);
      this.notes.push({ kind: 'kill_instant', playerId: victim.id });
      this.setPlayerStatus(victim, 'dead');
      this.setTarget(me, victim.target_id, true);
      this.finishIfWinner();
    }
  }

  respond(input: Input): void {
    const me = this.me;
    if (!me) throw new DomainError('Chybí přístup hráče.', 403);

    const reportId = str(input.reportId);
    const report = this.reports.find(item => item.id === reportId && item.victim_id === me.id && OPEN.includes(item.status));
    if (!report) throw new DomainError('Tato vražda už byla uzavřena.');

    if (boolValue(input.accepted ?? false)) {
      if (report.status === 'pending') this.notes.push({ kind: 'kill_confirmed', playerId: report.killer_id });
      this.finalize(report);
    } else if (report.status === 'provisional') {
      this.setPlayerStatus(me, 'alive');
      this.setTarget(this.player(report.killer_id), me.id);
      this.setReportStatus(report, 'rejected');
      this.notes.push({ kind: 'appeal_rejected', playerId: report.killer_id });
    } else {
      this.setReportStatus(report, 'rejected');
      this.notes.push({ kind: 'kill_rejected', playerId: report.killer_id });
    }
  }

  end(_input: Input): void {
    if (!this.isAdmin) throw new DomainError('Hru může ukončit pouze organizátor.', 403);
    if (this.game.status !== 'active') throw new DomainError('Hra právě neběží.');

    for (const report of this.reports.filter(item => OPEN.includes(item.status))) {
      if (report.status === 'provisional') {
        const victim = this.player(report.victim_id);
        this.setPlayerStatus(victim, 'alive');
        this.setTarget(this.player(report.killer_id), victim.id);
      }
      this.setReportStatus(report, 'cancelled');
    }
    this.game.status = 'finished';
    this.exec(
      "UPDATE games SET status = 'finished', ended_at = ?, ended_reason = 'admin' WHERE id = ?",
      this.now, this.game.id,
    );
    this.notes.push({ kind: 'game_ended', allPlayers: true, admins: true });
  }

  // ------------------------------------------------------------- helpers

  private insertReport(id: string, killerId: string, victimId: string, status: ReportStatus, resolvedAt: string | null = null): void {
    const report: ReportRow = {
      id, game_id: this.game.id, killer_id: killerId, victim_id: victimId, status, reported_at: this.now, resolved_at: resolvedAt,
    };
    this.reports.push(report);
    this.exec(
      `INSERT INTO kill_reports (id, game_id, killer_id, victim_id, status, reported_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, this.game.id, killerId, victimId, status, this.now, resolvedAt,
    );
  }

  private finalize(report: ReportRow): void {
    const victim = this.player(report.victim_id);
    const killer = this.player(report.killer_id);
    if (report.status === 'pending') {
      if (victim.status === 'alive') this.setPlayerStatus(victim, 'dead');
      this.setTarget(killer, victim.target_id, true);
    } else {
      this.addKill(killer);
    }
    this.setReportStatus(report, 'confirmed');
    this.finishIfWinner();
  }

  private finishIfWinner(): void {
    const alive = this.playerList.filter(player => player.status === 'alive').length;
    if (alive === 1 && this.game.status === 'active') {
      this.game.status = 'finished';
      this.exec(
        "UPDATE games SET status = 'finished', ended_at = ?, ended_reason = 'winner' WHERE id = ? AND status = 'active'",
        this.now, this.game.id,
      );
      this.notes.push({ kind: 'game_ended', allPlayers: true, admins: true });
    }
  }
}

// --------------------------------------------------------------- výstupy

interface KillEvent {
  reported_at: string;
  killer_id: string;
  killer: string;
  victim: string;
}

function publicGame(game: GameRow): Json {
  return {
    id: game.id,
    code: game.code,
    name: game.name,
    rule: game.rule_text,
    status: game.status,
    killMode: game.kill_mode,
    showRoster: Boolean(game.show_roster),
    startedAt: iso(game.started_at),
    endedAt: iso(game.ended_at),
    endedReason: game.ended_reason,
  };
}

function publicPlayer(player: PlayerRow): Json {
  return {
    id: player.id,
    name: player.name,
    status: player.status,
    killsCount: Number(player.kills_count),
    eliminatedAt: iso(player.eliminated_at),
  };
}

function publicReport(report: Record<string, unknown>): Json {
  return {
    id: report.id,
    status: report.status,
    reportedAt: iso(report.reported_at as string | null),
  };
}

function statistics(game: GameRow, players: PlayerRow[], events: KillEvent[]): Json {
  const maxKills = players.reduce((max, player) => Math.max(max, Number(player.kills_count)), 0);
  const leaders = maxKills > 0
    ? players.filter(player => Number(player.kills_count) === maxKills).map(player => ({ name: player.name, kills: maxKills }))
    : [];

  const alive = players.filter(player => player.status === 'alive');
  const first = events[0];
  let firstVictim: Json | null = null;
  if (first && game.started_at) {
    const afterMs = Date.parse(first.reported_at) - Date.parse(game.started_at);
    firstVictim = { name: first.victim, afterMs: Math.max(0, Math.trunc(afterMs)) };
  }

  // Nejvíc vražd jednoho hráče v klouzavém okně (posuvné okno nad seřazenými časy).
  const windows = ([['1 hodina', 3600], ['8 hodin', 28800], ['1 den', 86400]] as const).map(([label, seconds]) => {
    let best = 0;
    let names: string[] = [];
    for (const player of players) {
      const times = events
        .filter(event => event.killer_id === player.id)
        .map(event => Math.floor(Date.parse(event.reported_at) / 1000));
      let localBest = 0;
      let left = 0;
      times.forEach((time, right) => {
        while (time - times[left]! > seconds) left++;
        localBest = Math.max(localBest, right - left + 1);
      });
      if (localBest > best) {
        best = localBest;
        names = localBest > 0 ? [player.name] : [];
      } else if (localBest === best && localBest > 0) {
        names.push(player.name);
      }
    }
    return { label, count: best, names };
  });

  return {
    winner: game.ended_reason === 'winner' && alive.length === 1 ? alive[0]!.name : null,
    firstVictim,
    leaders,
    players: players.map(publicPlayer),
    windows,
    timeline: events.map(event => ({ killer: event.killer, victim: event.victim, at: iso(event.reported_at) })),
  };
}
