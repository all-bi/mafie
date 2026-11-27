#!/usr/bin/env node
// Převod MySQL dumpu (mysqldump nebo export z phpMyAdmin) na SQL pro Cloudflare D1.
//
// Použití:
//   node scripts/mysql-to-d1.mjs dump.sql data.d1.sql
//   npx wrangler d1 execute kruh-mafie --remote --file=data.d1.sql
//
// Skript čte jen příkazy INSERT do tabulek games, players a kill_reports
// (struktura se bere z migrations/). Zvládá víceřádkové INSERTy, výpis
// sloupců i bez něj, escapování MySQL (\' \\ \n \0 ...), NULL a čísla.
//
// Převody:
//   * DATETIME(6) '2026-05-01 12:34:56.123456' -> '2026-05-01T12:34:56.123Z' (UTC,
//     aplikace ukládala čas v UTC díky time_zone = '+00:00')
//   * players.name_key se dopočítá (jako v aplikaci)
//   * kruhové cizí klíče (games.admin_player_id, players.target_id) se nejdřív
//     vloží jako NULL a doplní se příkazy UPDATE na konci
//   * games.version = 0

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inputPath = 'dump.sql', outputPath = 'data.d1.sql'] = process.argv;

// Pořadí sloupců v MySQL tabulkách (legacy/schema.sql) — pro INSERTy bez výpisu sloupců.
const MYSQL_COLUMNS = {
  games: ['id', 'code', 'name', 'rule_text', 'status', 'kill_mode', 'show_roster', 'admin_token_hash', 'admin_player_id', 'started_at', 'ended_at', 'ended_reason', 'created_at'],
  players: ['id', 'game_id', 'name', 'token_hash', 'status', 'target_id', 'kills_count', 'joined_at', 'eliminated_at'],
  kill_reports: ['id', 'game_id', 'killer_id', 'victim_id', 'status', 'reported_at', 'resolved_at'],
};
const DATETIME_COLUMNS = new Set(['started_at', 'ended_at', 'created_at', 'joined_at', 'eliminated_at', 'reported_at', 'resolved_at']);

// ---------------------------------------------------------------- parser

/** Najde všechny INSERT příkazy a vrátí { table, columns, rows }. */
function* parseInserts(sql) {
  const re = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?\s*(\(([^)]*)\))?\s*VALUES\s*/gi;
  let match;
  while ((match = re.exec(sql))) {
    const table = match[1].toLowerCase();
    const columns = match[3] ? match[3].split(',').map(c => c.trim().replace(/`/g, '')) : null;
    const { rows, end } = parseValues(sql, re.lastIndex);
    re.lastIndex = end;
    yield { table, columns, rows };
  }
}

/** Přečte (..),(..); od pozice i. Vrací řádky jako pole JS hodnot. */
function parseValues(sql, i) {
  const rows = [];
  const skipWs = () => { while (i < sql.length && /\s/.test(sql[i])) i++; };
  for (;;) {
    skipWs();
    if (sql[i] !== '(') throw new Error(`Očekávána '(' na pozici ${i}`);
    i++;
    const row = [];
    for (;;) {
      skipWs();
      const ch = sql[i];
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        let value = '';
        for (;;) {
          const c = sql[i];
          if (c === undefined) throw new Error('Neukončený řetězec v dumpu.');
          if (c === '\\') {
            const n = sql[i + 1];
            value += { 0: '\0', n: '\n', r: '\r', t: '\t', b: '\b', Z: '\x1a', "'": "'", '"': '"', '\\': '\\' }[n] ?? n;
            i += 2;
          } else if (c === quote && sql[i + 1] === quote) {
            value += quote;
            i += 2;
          } else if (c === quote) {
            i++;
            break;
          } else {
            value += c;
            i++;
          }
        }
        row.push(value);
      } else {
        let token = '';
        while (i < sql.length && !/[,)\s]/.test(sql[i])) token += sql[i++];
        if (/^NULL$/i.test(token)) row.push(null);
        else if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(token)) row.push(Number(token));
        else if (/^_binary$/i.test(token)) continue; // _binary 'xxx' -> přečte se další řetězec
        else throw new Error(`Neznámá hodnota v dumpu: ${token.slice(0, 40)}`);
      }
      skipWs();
      if (sql[i] === ',') { i++; continue; }
      if (sql[i] === ')') { i++; break; }
      throw new Error(`Neočekávaný znak '${sql[i]}' na pozici ${i}`);
    }
    rows.push(row);
    skipWs();
    if (sql[i] === ',') { i++; continue; }
    if (sql[i] === ';') { i++; break; }
    throw new Error(`Očekáván ',' nebo ';' na pozici ${i}`);
  }
  return { rows, end: i };
}

// ------------------------------------------------------------- převody

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(String(value));
  if (!m) throw new Error(`Neplatné datum: ${value}`);
  if (m[1] === '0000') return null;
  const ms = (m[7] ?? '').padEnd(3, '0').slice(0, 3);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
}

/** Stejná funkce jako nameKey() v src/util.ts. */
function nameKey(name) {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  // SQLite: jediný escape je zdvojení apostrofu. Znak NUL odstraníme.
  return `'${String(value).replace(/\0/g, '').replace(/'/g, "''")}'`;
}

function insert(table, record) {
  const cols = Object.keys(record);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => lit(record[c])).join(', ')});`;
}

// ------------------------------------------------------------------ main

const sql = readFileSync(inputPath, 'utf8');
const data = { games: [], players: [], kill_reports: [] };

for (const { table, columns, rows } of parseInserts(sql)) {
  if (!(table in data)) continue;
  const cols = columns ?? MYSQL_COLUMNS[table];
  for (const row of rows) {
    if (row.length !== cols.length) throw new Error(`Tabulka ${table}: řádek má ${row.length} hodnot, čekáno ${cols.length}.`);
    const record = {};
    cols.forEach((col, index) => {
      const value = row[index];
      record[col] = DATETIME_COLUMNS.has(col) ? toIso(value) : value;
    });
    data[table].push(record);
  }
}

const out = [
  '-- Vygenerováno skriptem scripts/mysql-to-d1.mjs',
  `-- Zdroj: ${inputPath.split(/[\\/]/).pop()}, ${new Date().toISOString()}`,
  `-- games: ${data.games.length}, players: ${data.players.length}, kill_reports: ${data.kill_reports.length}`,
  '',
];
const updates = [];
const warnings = [];

for (const game of data.games) {
  if (game.admin_player_id) updates.push(`UPDATE games SET admin_player_id = ${lit(game.admin_player_id)} WHERE id = ${lit(game.id)};`);
  out.push(insert('games', {
    id: game.id,
    code: game.code,
    name: game.name,
    rule_text: game.rule_text,
    status: game.status,
    kill_mode: game.kill_mode,
    show_roster: Number(game.show_roster) ? 1 : 0,
    admin_token_hash: game.admin_token_hash,
    admin_player_id: null,
    started_at: game.started_at,
    ended_at: game.ended_at,
    ended_reason: game.ended_reason || null,
    version: 0,
    created_at: game.created_at ?? new Date().toISOString(),
  }));
}

const keys = new Map();
for (const player of data.players) {
  let key = nameKey(String(player.name));
  const scoped = `${player.game_id}\u0000${key}`;
  if (keys.has(scoped)) {
    warnings.push(`Hra ${player.game_id}: jména „${keys.get(scoped)}“ a „${player.name}“ mají stejný klíč; druhé dostane rozlišený klíč.`);
    key = `${key}#${player.id.slice(0, 8)}`;
  }
  keys.set(`${player.game_id}\u0000${key}`, player.name);
  if (player.target_id) updates.push(`UPDATE players SET target_id = ${lit(player.target_id)} WHERE id = ${lit(player.id)};`);
  out.push(insert('players', {
    id: player.id,
    game_id: player.game_id,
    name: player.name,
    name_key: key,
    token_hash: player.token_hash,
    status: player.status,
    target_id: null,
    kills_count: Number(player.kills_count) || 0,
    joined_at: player.joined_at ?? new Date().toISOString(),
    eliminated_at: player.eliminated_at,
  }));
}

for (const report of data.kill_reports) {
  out.push(insert('kill_reports', {
    id: report.id,
    game_id: report.game_id,
    killer_id: report.killer_id,
    victim_id: report.victim_id,
    status: report.status,
    reported_at: report.reported_at ?? new Date().toISOString(),
    resolved_at: report.resolved_at,
  }));
}

out.push('', '-- Doplnění kruhových cizích klíčů', ...updates, '');
writeFileSync(outputPath, out.join('\n'), 'utf8');

console.log(`Hotovo: ${outputPath}`);
console.log(`  games: ${data.games.length}, players: ${data.players.length}, kill_reports: ${data.kill_reports.length}`);
for (const warning of warnings) console.warn(`  Upozornění: ${warning}`);
if (!data.games.length) console.warn('  Upozornění: v dumpu nebyly nalezeny žádné hry. Je to opravdu dump databáze aplikace?');
