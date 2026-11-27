-- Odběry push upozornění (Web Push). Jedno zařízení = jeden endpoint = jedna hra.
CREATE TABLE push_subscriptions (
    endpoint   TEXT NOT NULL PRIMARY KEY CHECK (length(endpoint) <= 1024),
    game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id  TEXT NULL REFERENCES players(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('player', 'admin')),
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX push_subscriptions_game_idx ON push_subscriptions (game_id, player_id);

-- Jednorázové kódy pro přenos přístupu na jiné zařízení (např. do aplikace na
-- ploše iPhonu, která má oddělené úložiště od Safari). Kód platí 10 minut.
-- Přístupové údaje jsou zašifrované klíčem odvozeným z kódu (AES-GCM, HKDF);
-- databáze zná jen SHA-256 otisk kódu, takže z ní samotné je přečíst nelze.
CREATE TABLE transfer_codes (
    code_hash  TEXT NOT NULL PRIMARY KEY CHECK (length(code_hash) = 64),
    game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    payload    TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX transfer_codes_expires_idx ON transfer_codes (expires_at);
