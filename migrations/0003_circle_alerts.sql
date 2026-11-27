-- Pořadí hráčů v kruhu při startu (pro vizualizaci kruhu ve statistikách)
-- a nastavení hry: komu oznamovat vraždy ostatních.
ALTER TABLE players ADD COLUMN circle_pos INTEGER NULL;
ALTER TABLE games ADD COLUMN kill_alerts TEXT NOT NULL DEFAULT 'none'
    CHECK (kill_alerts IN ('none', 'first', 'every'));
ALTER TABLE games ADD COLUMN kills_announced INTEGER NOT NULL DEFAULT 0;
