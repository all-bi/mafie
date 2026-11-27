-- Kruh — hra Mafie: schéma pro Cloudflare D1 (SQLite).
-- Převedeno z legacy/schema.sql (MySQL/InnoDB).
--
-- Rozdíly oproti MySQL:
--  * ENUM            -> TEXT s CHECK omezením
--  * TINYINT(1)      -> INTEGER s CHECK (0/1)
--  * DATETIME(6)     -> TEXT v ISO 8601 UTC s milisekundami ('2026-11-27T12:34:56.789Z')
--  * utf8mb4_unicode_ci (jméno bez ohledu na velikost písmen a diakritiku)
--                    -> sloupec players.name_key + UNIQUE index
--  * SELECT ... FOR UPDATE -> optimistické zamykání přes games.version
--                    a tabulku concurrency_guard (viz src/db.ts)

CREATE TABLE games (
    id               TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 36),
    code             TEXT    NOT NULL CHECK (length(code) = 6),
    name             TEXT    NOT NULL,
    rule_text        TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'registration'
                             CHECK (status IN ('registration', 'active', 'finished')),
    kill_mode        TEXT    NOT NULL DEFAULT 'confirm'
                             CHECK (kill_mode IN ('confirm', 'appeal', 'instant')),
    show_roster      INTEGER NOT NULL DEFAULT 0 CHECK (show_roster IN (0, 1)),
    admin_token_hash TEXT    NOT NULL CHECK (length(admin_token_hash) = 64),
    admin_player_id  TEXT    NULL REFERENCES players(id) ON DELETE SET NULL,
    started_at       TEXT    NULL,
    ended_at         TEXT    NULL,
    ended_reason     TEXT    NULL CHECK (ended_reason IS NULL OR ended_reason IN ('winner', 'admin')),
    version          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX games_code_uq ON games (code);
CREATE INDEX games_admin_player_idx ON games (admin_player_id);

CREATE TABLE players (
    id            TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 36),
    game_id       TEXT    NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name          TEXT    NOT NULL,
    name_key      TEXT    NOT NULL,
    token_hash    TEXT    NOT NULL CHECK (length(token_hash) = 64),
    status        TEXT    NOT NULL DEFAULT 'alive' CHECK (status IN ('alive', 'dead')),
    target_id     TEXT    NULL REFERENCES players(id) ON DELETE SET NULL,
    kills_count   INTEGER NOT NULL DEFAULT 0 CHECK (kills_count >= 0),
    joined_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    eliminated_at TEXT    NULL
);

CREATE UNIQUE INDEX players_game_name_uq ON players (game_id, name_key);
CREATE UNIQUE INDEX players_token_uq ON players (token_hash);
CREATE INDEX players_target_idx ON players (target_id);
CREATE INDEX players_game_joined_idx ON players (game_id, joined_at);

CREATE TABLE kill_reports (
    id          TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 36),
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    killer_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    victim_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    status      TEXT NOT NULL
                CHECK (status IN ('pending', 'provisional', 'confirmed', 'rejected', 'dismissed', 'cancelled')),
    reported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at TEXT NULL
);

CREATE INDEX reports_game_status_idx ON kill_reports (game_id, status);
CREATE INDEX reports_killer_status_idx ON kill_reports (killer_id, status);
CREATE INDEX reports_victim_status_idx ON kill_reports (victim_id, status);

-- Pomocná tabulka pro optimistické zamykání. Do tabulky se nikdy nic
-- nezapíše: pokus o vložení řádku (ok = 0) znamená, že hru mezitím změnil
-- jiný požadavek, CHECK selže a D1 vrátí celý batch zpět.
CREATE TABLE concurrency_guard (
    ok INTEGER NOT NULL,
    CONSTRAINT version_conflict CHECK (ok = 1)
);
