SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE games (
    id CHAR(36) NOT NULL PRIMARY KEY,
    code CHAR(6) NOT NULL,
    name VARCHAR(60) NOT NULL,
    rule_text VARCHAR(240) NOT NULL,
    status ENUM('registration', 'active', 'finished') NOT NULL DEFAULT 'registration',
    kill_mode ENUM('confirm', 'appeal', 'instant') NOT NULL DEFAULT 'confirm',
    show_roster TINYINT(1) NOT NULL DEFAULT 0,
    admin_token_hash CHAR(64) NOT NULL,
    admin_player_id CHAR(36) NULL,
    started_at DATETIME(6) NULL,
    ended_at DATETIME(6) NULL,
    ended_reason ENUM('winner', 'admin') NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY games_code_uq (code),
    KEY games_admin_player_idx (admin_player_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE players (
    id CHAR(36) NOT NULL PRIMARY KEY,
    game_id CHAR(36) NOT NULL,
    name VARCHAR(40) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    status ENUM('alive', 'dead') NOT NULL DEFAULT 'alive',
    target_id CHAR(36) NULL,
    kills_count INT UNSIGNED NOT NULL DEFAULT 0,
    joined_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    eliminated_at DATETIME(6) NULL,
    UNIQUE KEY players_game_name_uq (game_id, name),
    UNIQUE KEY players_token_uq (token_hash),
    KEY players_target_idx (target_id),
    CONSTRAINT players_game_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    CONSTRAINT players_target_fk FOREIGN KEY (target_id) REFERENCES players(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE games
    ADD CONSTRAINT games_admin_player_fk FOREIGN KEY (admin_player_id) REFERENCES players(id) ON DELETE SET NULL;

CREATE TABLE kill_reports (
    id CHAR(36) NOT NULL PRIMARY KEY,
    game_id CHAR(36) NOT NULL,
    killer_id CHAR(36) NOT NULL,
    victim_id CHAR(36) NOT NULL,
    status ENUM('pending', 'provisional', 'confirmed', 'rejected', 'dismissed', 'cancelled') NOT NULL,
    reported_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    resolved_at DATETIME(6) NULL,
    KEY reports_game_status_idx (game_id, status),
    KEY reports_killer_status_idx (killer_id, status),
    KEY reports_victim_status_idx (victim_id, status),
    CONSTRAINT reports_game_fk FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    CONSTRAINT reports_killer_fk FOREIGN KEY (killer_id) REFERENCES players(id) ON DELETE CASCADE,
    CONSTRAINT reports_victim_fk FOREIGN KEY (victim_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
