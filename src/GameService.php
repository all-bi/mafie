<?php
declare(strict_types=1);

final class GameService
{
    public function __construct(private readonly PDO $pdo)
    {
    }

    public function handle(array $input): array
    {
        $action = (string) ($input['action'] ?? '');
        return match ($action) {
            'create' => $this->createGame($input),
            'join' => $this->joinGame($input),
            'state' => $this->state($input),
            'start' => $this->startGame($input),
            'report' => $this->reportKill($input),
            'respond' => $this->respondToKill($input),
            'end' => $this->endGame($input),
            default => throw new DomainException('Neznámá akce.', 404),
        };
    }

    private function createGame(array $input): array
    {
        $name = $this->text($input['name'] ?? '', 60);
        $rule = $this->text($input['rule'] ?? '', 240);
        $adminName = $this->text($input['adminName'] ?? '', 40);
        if ($name === '' || $rule === '' || $adminName === '') {
            throw new DomainException('Vyplň všechna povinná pole.');
        }

        $killMode = (string) ($input['killMode'] ?? 'confirm');
        if (!in_array($killMode, ['confirm', 'appeal', 'instant'], true)) {
            $killMode = 'confirm';
        }

        $gameId = uuid_v4();
        $adminToken = access_token();
        $adminPlays = bool_value($input['adminPlays'] ?? false);
        $playerId = $adminPlays ? uuid_v4() : null;
        $playerToken = $adminPlays ? access_token() : null;

        $this->pdo->beginTransaction();
        try {
            $code = $this->uniqueCode();
            $stmt = $this->pdo->prepare(
                'INSERT INTO games (id, code, name, rule_text, status, kill_mode, show_roster, admin_token_hash)
                 VALUES (?, ?, ?, ?, \'registration\', ?, ?, ?)'
            );
            $stmt->execute([$gameId, $code, $name, $rule, $killMode, bool_value($input['showRoster'] ?? false) ? 1 : 0, token_hash($adminToken)]);

            if ($playerId !== null && $playerToken !== null) {
                $stmt = $this->pdo->prepare(
                    'INSERT INTO players (id, game_id, name, token_hash, status) VALUES (?, ?, ?, ?, \'alive\')'
                );
                $stmt->execute([$playerId, $gameId, $adminName, token_hash($playerToken)]);
                $stmt = $this->pdo->prepare('UPDATE games SET admin_player_id = ? WHERE id = ?');
                $stmt->execute([$playerId, $gameId]);
            }
            $this->pdo->commit();
        } catch (Throwable $error) {
            $this->pdo->rollBack();
            throw $error;
        }

        return ['credentials' => array_filter([
            'gameId' => $gameId,
            'adminToken' => $adminToken,
            'playerToken' => $playerToken,
        ], static fn (mixed $value): bool => $value !== null)];
    }

    private function joinGame(array $input): array
    {
        $code = strtoupper(trim((string) ($input['code'] ?? '')));
        $name = $this->text($input['name'] ?? '', 40);
        if ($name === '') {
            throw new DomainException('Zadej své jméno.');
        }

        $this->pdo->beginTransaction();
        try {
            $stmt = $this->pdo->prepare('SELECT * FROM games WHERE code = ? FOR UPDATE');
            $stmt->execute([$code]);
            $game = $stmt->fetch();
            if (!$game) {
                throw new DomainException('Hra s tímto kódem neexistuje.', 404);
            }
            if ($game['status'] !== 'registration') {
                throw new DomainException('Registrace do této hry už skončila.');
            }

            $playerId = uuid_v4();
            $playerToken = access_token();
            $stmt = $this->pdo->prepare(
                'INSERT INTO players (id, game_id, name, token_hash, status) VALUES (?, ?, ?, ?, \'alive\')'
            );
            try {
                $stmt->execute([$playerId, $game['id'], $name, token_hash($playerToken)]);
            } catch (PDOException $error) {
                if ($error->getCode() === '23000') {
                    throw new DomainException('Toto jméno už ve hře někdo používá.');
                }
                throw $error;
            }
            $this->pdo->commit();
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $error;
        }

        return ['credentials' => ['gameId' => $game['id'], 'playerToken' => $playerToken]];
    }

    private function state(array $input): array
    {
        [$game, $player, $isAdmin] = $this->context($input);
        $adminIsAlive = false;
        if ($game['admin_player_id']) {
            $stmt = $this->pdo->prepare('SELECT status FROM players WHERE id = ?');
            $stmt->execute([$game['admin_player_id']]);
            $adminIsAlive = $stmt->fetchColumn() === 'alive';
        }
        $canManage = $isAdmin && !($game['status'] === 'active' && $adminIsAlive);

        $response = ['game' => $this->publicGame($game)];
        if ($player) {
            $publicPlayer = $this->publicPlayer($player);
            $publicPlayer['target'] = null;
            if ($player['target_id'] && $player['target_id'] !== $player['id']) {
                $stmt = $this->pdo->prepare('SELECT id, name FROM players WHERE id = ?');
                $stmt->execute([$player['target_id']]);
                $publicPlayer['target'] = $stmt->fetch() ?: null;
            }
            $response['player'] = $publicPlayer;

            $stmt = $this->pdo->prepare(
                "SELECT id, status, reported_at FROM kill_reports
                 WHERE victim_id = ? AND status IN ('pending', 'provisional') ORDER BY reported_at DESC LIMIT 1"
            );
            $stmt->execute([$player['id']]);
            if ($report = $stmt->fetch()) {
                $response['incoming'] = $this->publicReport($report);
            }

            $stmt = $this->pdo->prepare(
                "SELECT id, status, reported_at FROM kill_reports
                 WHERE killer_id = ? AND status IN ('pending', 'provisional') ORDER BY reported_at DESC LIMIT 1"
            );
            $stmt->execute([$player['id']]);
            if ($report = $stmt->fetch()) {
                $response['outgoing'] = $this->publicReport($report);
            }

            $stmt = $this->pdo->prepare(
                "SELECT r.id, r.status, r.reported_at, v.name AS victim_name
                 FROM kill_reports r JOIN players v ON v.id = r.victim_id
                 WHERE r.killer_id = ? AND r.status = 'rejected' ORDER BY r.resolved_at DESC LIMIT 1"
            );
            $stmt->execute([$player['id']]);
            if ($report = $stmt->fetch()) {
                $item = $this->publicReport($report);
                $item['victimName'] = $report['victim_name'];
                $response['rejected'] = $item;
            }
        }

        $rosterVisible = $game['status'] === 'finished'
            || (bool) $game['show_roster']
            || ($isAdmin && ($game['status'] === 'registration' || $canManage));
        if ($rosterVisible) {
            $stmt = $this->pdo->prepare('SELECT * FROM players WHERE game_id = ? ORDER BY joined_at');
            $stmt->execute([$game['id']]);
            $response['roster'] = array_map(fn (array $row): array => $this->publicPlayer($row), $stmt->fetchAll());
        }
        if ($isAdmin) {
            $response['admin'] = ['canManage' => $canManage, 'canEnd' => $game['status'] === 'active'];
        }
        if ($game['status'] === 'finished') {
            $response['stats'] = $this->statistics($game);
        }
        return $response;
    }

    private function startGame(array $input): array
    {
        return $this->transaction(function () use ($input): array {
            $game = $this->lockedGame((string) ($input['gameId'] ?? ''));
            if (!$this->isAdmin($game, (string) ($input['adminToken'] ?? ''))) {
                throw new DomainException('Hru nyní nemůžeš spustit.', 403);
            }
            if ($game['status'] !== 'registration') {
                throw new DomainException('Hra už byla spuštěna.');
            }

            $stmt = $this->pdo->prepare('SELECT * FROM players WHERE game_id = ? ORDER BY joined_at FOR UPDATE');
            $stmt->execute([$game['id']]);
            $players = $stmt->fetchAll();
            if (count($players) < 3) {
                throw new DomainException('Ke spuštění jsou potřeba alespoň 3 hráči.');
            }
            $this->secureShuffle($players);
            $update = $this->pdo->prepare('UPDATE players SET target_id = ? WHERE id = ?');
            foreach ($players as $index => $player) {
                $target = $players[($index + 1) % count($players)];
                $update->execute([$target['id'], $player['id']]);
            }
            $stmt = $this->pdo->prepare("UPDATE games SET status = 'active', started_at = NOW(6) WHERE id = ?");
            $stmt->execute([$game['id']]);
            return ['ok' => true];
        });
    }

    private function reportKill(array $input): array
    {
        return $this->transaction(function () use ($input): array {
            $game = $this->lockedGame((string) ($input['gameId'] ?? ''));
            $player = $this->lockedPlayer($game['id'], (string) ($input['playerToken'] ?? ''));
            if (!$player || $player['status'] !== 'alive') {
                throw new DomainException('Vraždu může zadat pouze živý hráč.', 403);
            }
            if ($game['status'] !== 'active' || !$player['target_id']) {
                throw new DomainException('Nyní nelze zadat vraždu.');
            }

            $stmt = $this->pdo->prepare(
                "SELECT * FROM kill_reports WHERE killer_id = ? AND status IN ('pending', 'provisional')
                 ORDER BY reported_at DESC LIMIT 1 FOR UPDATE"
            );
            $stmt->execute([$player['id']]);
            $previous = $stmt->fetch();
            if ($previous && $previous['status'] === 'pending') {
                throw new DomainException('Nejdřív musí předchozí oběť potvrdit vraždu.');
            }
            if ($previous && $previous['status'] === 'provisional' && $player['target_id'] === $player['id']) {
                throw new DomainException('Poslední oběť musí vraždu potvrdit nebo odmítnout.');
            }
            if ($previous && $previous['status'] === 'provisional') {
                $this->finalizeReport($previous);
            }

            $stmt = $this->pdo->prepare(
                "SELECT id FROM kill_reports WHERE victim_id = ? AND status IN ('pending', 'provisional') LIMIT 1 FOR UPDATE"
            );
            $stmt->execute([$player['id']]);
            if ($stmt->fetch()) {
                throw new DomainException('Nejdřív odpověz na čekající vraždu.');
            }

            $stmt = $this->pdo->prepare("SELECT * FROM players WHERE id = ? AND game_id = ? AND status = 'alive' FOR UPDATE");
            $stmt->execute([$player['target_id'], $game['id']]);
            $victim = $stmt->fetch();
            if (!$victim) {
                throw new DomainException('Tvoje oběť už není dostupná. Obnov stránku.');
            }

            $stmt = $this->pdo->prepare(
                "SELECT * FROM kill_reports WHERE killer_id = ? AND status IN ('pending', 'provisional')
                 ORDER BY reported_at DESC LIMIT 1 FOR UPDATE"
            );
            $stmt->execute([$victim['id']]);
            $victimOutgoing = $stmt->fetch();
            if ($victimOutgoing && $victimOutgoing['status'] === 'pending') {
                throw new DomainException('Tvoje oběť právě čeká na potvrzení jiné vraždy. Zkus to později.');
            }
            if ($victimOutgoing && $victimOutgoing['status'] === 'provisional') {
                $this->finalizeReport($victimOutgoing);
            }

            $stmt = $this->pdo->prepare("UPDATE kill_reports SET status = 'dismissed' WHERE killer_id = ? AND status = 'rejected'");
            $stmt->execute([$player['id']]);
            $reportId = uuid_v4();

            if ($game['kill_mode'] === 'confirm') {
                $stmt = $this->pdo->prepare(
                    "INSERT INTO kill_reports (id, game_id, killer_id, victim_id, status) VALUES (?, ?, ?, ?, 'pending')"
                );
                $stmt->execute([$reportId, $game['id'], $player['id'], $victim['id']]);
            } elseif ($game['kill_mode'] === 'appeal') {
                $stmt = $this->pdo->prepare(
                    "INSERT INTO kill_reports (id, game_id, killer_id, victim_id, status) VALUES (?, ?, ?, ?, 'provisional')"
                );
                $stmt->execute([$reportId, $game['id'], $player['id'], $victim['id']]);
                $stmt = $this->pdo->prepare("UPDATE players SET status = 'dead', eliminated_at = NOW(6) WHERE id = ?");
                $stmt->execute([$victim['id']]);
                $stmt = $this->pdo->prepare('UPDATE players SET target_id = ? WHERE id = ?');
                $stmt->execute([$victim['target_id'], $player['id']]);
            } else {
                $stmt = $this->pdo->prepare(
                    "INSERT INTO kill_reports (id, game_id, killer_id, victim_id, status, resolved_at)
                     VALUES (?, ?, ?, ?, 'confirmed', NOW(6))"
                );
                $stmt->execute([$reportId, $game['id'], $player['id'], $victim['id']]);
                $stmt = $this->pdo->prepare("UPDATE players SET status = 'dead', eliminated_at = NOW(6) WHERE id = ?");
                $stmt->execute([$victim['id']]);
                $stmt = $this->pdo->prepare('UPDATE players SET target_id = ?, kills_count = kills_count + 1 WHERE id = ?');
                $stmt->execute([$victim['target_id'], $player['id']]);
                $this->finishIfWinner($game['id']);
            }
            return ['ok' => true];
        });
    }

    private function respondToKill(array $input): array
    {
        return $this->transaction(function () use ($input): array {
            $game = $this->lockedGame((string) ($input['gameId'] ?? ''));
            $player = $this->lockedPlayer($game['id'], (string) ($input['playerToken'] ?? ''));
            if (!$player) {
                throw new DomainException('Chybí přístup hráče.', 403);
            }

            $stmt = $this->pdo->prepare(
                "SELECT * FROM kill_reports WHERE id = ? AND victim_id = ?
                 AND status IN ('pending', 'provisional') FOR UPDATE"
            );
            $stmt->execute([(string) ($input['reportId'] ?? ''), $player['id']]);
            $report = $stmt->fetch();
            if (!$report) {
                throw new DomainException('Tato vražda už byla uzavřena.');
            }

            if (bool_value($input['accepted'] ?? false)) {
                $this->finalizeReport($report);
            } elseif ($report['status'] === 'provisional') {
                $stmt = $this->pdo->prepare("UPDATE players SET status = 'alive', eliminated_at = NULL WHERE id = ?");
                $stmt->execute([$player['id']]);
                $stmt = $this->pdo->prepare('UPDATE players SET target_id = ? WHERE id = ?');
                $stmt->execute([$player['id'], $report['killer_id']]);
                $stmt = $this->pdo->prepare("UPDATE kill_reports SET status = 'rejected', resolved_at = NOW(6) WHERE id = ?");
                $stmt->execute([$report['id']]);
            } else {
                $stmt = $this->pdo->prepare("UPDATE kill_reports SET status = 'rejected', resolved_at = NOW(6) WHERE id = ?");
                $stmt->execute([$report['id']]);
            }
            return ['ok' => true];
        });
    }

    private function endGame(array $input): array
    {
        return $this->transaction(function () use ($input): array {
            $game = $this->lockedGame((string) ($input['gameId'] ?? ''));
            if (!$this->isAdmin($game, (string) ($input['adminToken'] ?? ''))) {
                throw new DomainException('Hru může ukončit pouze organizátor.', 403);
            }
            if ($game['status'] !== 'active') {
                throw new DomainException('Hra právě neběží.');
            }

            $stmt = $this->pdo->prepare(
                "SELECT * FROM kill_reports WHERE game_id = ? AND status IN ('pending', 'provisional') FOR UPDATE"
            );
            $stmt->execute([$game['id']]);
            foreach ($stmt->fetchAll() as $report) {
                if ($report['status'] === 'provisional') {
                    $update = $this->pdo->prepare("UPDATE players SET status = 'alive', eliminated_at = NULL WHERE id = ?");
                    $update->execute([$report['victim_id']]);
                    $update = $this->pdo->prepare('UPDATE players SET target_id = ? WHERE id = ?');
                    $update->execute([$report['victim_id'], $report['killer_id']]);
                }
                $update = $this->pdo->prepare("UPDATE kill_reports SET status = 'cancelled', resolved_at = NOW(6) WHERE id = ?");
                $update->execute([$report['id']]);
            }
            $stmt = $this->pdo->prepare(
                "UPDATE games SET status = 'finished', ended_at = NOW(6), ended_reason = 'admin' WHERE id = ?"
            );
            $stmt->execute([$game['id']]);
            return ['ok' => true];
        });
    }

    private function finalizeReport(array $report): void
    {
        $stmt = $this->pdo->prepare('SELECT * FROM players WHERE id = ? FOR UPDATE');
        $stmt->execute([$report['victim_id']]);
        $victim = $stmt->fetch();
        if (!$victim) {
            throw new RuntimeException('Oběť nebyla nalezena.');
        }

        if ($report['status'] === 'pending') {
            $stmt = $this->pdo->prepare("UPDATE players SET status = 'dead', eliminated_at = NOW(6) WHERE id = ? AND status = 'alive'");
            $stmt->execute([$report['victim_id']]);
            $stmt = $this->pdo->prepare('UPDATE players SET target_id = ?, kills_count = kills_count + 1 WHERE id = ?');
            $stmt->execute([$victim['target_id'], $report['killer_id']]);
        } else {
            $stmt = $this->pdo->prepare('UPDATE players SET kills_count = kills_count + 1 WHERE id = ?');
            $stmt->execute([$report['killer_id']]);
        }
        $stmt = $this->pdo->prepare("UPDATE kill_reports SET status = 'confirmed', resolved_at = NOW(6) WHERE id = ?");
        $stmt->execute([$report['id']]);
        $this->finishIfWinner($report['game_id']);
    }

    private function finishIfWinner(string $gameId): void
    {
        $stmt = $this->pdo->prepare("SELECT COUNT(*) FROM players WHERE game_id = ? AND status = 'alive'");
        $stmt->execute([$gameId]);
        if ((int) $stmt->fetchColumn() === 1) {
            $stmt = $this->pdo->prepare(
                "UPDATE games SET status = 'finished', ended_at = NOW(6), ended_reason = 'winner'
                 WHERE id = ? AND status = 'active'"
            );
            $stmt->execute([$gameId]);
        }
    }

    private function statistics(array $game): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM players WHERE game_id = ? ORDER BY joined_at');
        $stmt->execute([$game['id']]);
        $players = $stmt->fetchAll();

        $stmt = $this->pdo->prepare(
            "SELECT r.reported_at, r.killer_id, k.name AS killer, v.name AS victim
             FROM kill_reports r
             JOIN players k ON k.id = r.killer_id
             JOIN players v ON v.id = r.victim_id
             WHERE r.game_id = ? AND r.status = 'confirmed' ORDER BY r.reported_at"
        );
        $stmt->execute([$game['id']]);
        $events = $stmt->fetchAll();

        $maxKills = 0;
        foreach ($players as $player) {
            $maxKills = max($maxKills, (int) $player['kills_count']);
        }
        $leaders = [];
        if ($maxKills > 0) {
            foreach ($players as $player) {
                if ((int) $player['kills_count'] === $maxKills) {
                    $leaders[] = ['name' => $player['name'], 'kills' => $maxKills];
                }
            }
        }

        $alive = array_values(array_filter($players, static fn (array $player): bool => $player['status'] === 'alive'));
        $first = $events[0] ?? null;
        $firstVictim = null;
        if ($first && $game['started_at']) {
            $start = new DateTimeImmutable($game['started_at'], new DateTimeZone('UTC'));
            $reported = new DateTimeImmutable($first['reported_at'], new DateTimeZone('UTC'));
            $firstVictim = ['name' => $first['victim'], 'afterMs' => max(0, (int) (($reported->format('U.u') - $start->format('U.u')) * 1000))];
        }

        $windows = [];
        foreach ([['1 hodina', 3600], ['8 hodin', 28800], ['1 den', 86400]] as [$label, $seconds]) {
            $best = 0;
            $names = [];
            foreach ($players as $player) {
                $times = [];
                foreach ($events as $event) {
                    if ($event['killer_id'] === $player['id']) {
                        $times[] = (new DateTimeImmutable($event['reported_at'], new DateTimeZone('UTC')))->getTimestamp();
                    }
                }
                $localBest = 0;
                $left = 0;
                foreach ($times as $right => $time) {
                    while ($time - $times[$left] > $seconds) {
                        $left++;
                    }
                    $localBest = max($localBest, $right - $left + 1);
                }
                if ($localBest > $best) {
                    $best = $localBest;
                    $names = $localBest > 0 ? [$player['name']] : [];
                } elseif ($localBest === $best && $localBest > 0) {
                    $names[] = $player['name'];
                }
            }
            $windows[] = ['label' => $label, 'count' => $best, 'names' => $names];
        }

        return [
            'winner' => $game['ended_reason'] === 'winner' && count($alive) === 1 ? $alive[0]['name'] : null,
            'firstVictim' => $firstVictim,
            'leaders' => $leaders,
            'players' => array_map(fn (array $row): array => $this->publicPlayer($row), $players),
            'windows' => $windows,
            'timeline' => array_map(fn (array $event): array => [
                'killer' => $event['killer'],
                'victim' => $event['victim'],
                'at' => $this->iso($event['reported_at']),
            ], $events),
        ];
    }

    private function context(array $input): array
    {
        $gameId = (string) ($input['gameId'] ?? '');
        $stmt = $this->pdo->prepare('SELECT * FROM games WHERE id = ?');
        $stmt->execute([$gameId]);
        $game = $stmt->fetch();
        if (!$game) {
            throw new DomainException('Hra nebyla nalezena.', 404);
        }
        $player = $this->playerByToken($gameId, (string) ($input['playerToken'] ?? ''));
        $isAdmin = $this->isAdmin($game, (string) ($input['adminToken'] ?? ''));
        if (!$player && !$isAdmin) {
            throw new DomainException('Přístup do hry vypršel.', 401);
        }
        return [$game, $player, $isAdmin];
    }

    private function lockedGame(string $gameId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM games WHERE id = ? FOR UPDATE');
        $stmt->execute([$gameId]);
        $game = $stmt->fetch();
        if (!$game) {
            throw new DomainException('Hra nebyla nalezena.', 404);
        }
        return $game;
    }

    private function playerByToken(string $gameId, string $token, bool $lock = false): array|false
    {
        if ($token === '') {
            return false;
        }
        $sql = 'SELECT * FROM players WHERE game_id = ? AND token_hash = ?' . ($lock ? ' FOR UPDATE' : '');
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([$gameId, token_hash($token)]);
        return $stmt->fetch();
    }

    private function lockedPlayer(string $gameId, string $token): array|false
    {
        return $this->playerByToken($gameId, $token, true);
    }

    private function isAdmin(array $game, string $token): bool
    {
        return $token !== '' && hash_equals($game['admin_token_hash'], token_hash($token));
    }

    private function transaction(callable $callback): array
    {
        $this->pdo->beginTransaction();
        try {
            $result = $callback();
            $this->pdo->commit();
            return $result;
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $error;
        }
    }

    private function uniqueCode(): string
    {
        $stmt = $this->pdo->prepare('SELECT 1 FROM games WHERE code = ?');
        for ($attempt = 0; $attempt < 20; $attempt++) {
            $code = game_code();
            $stmt->execute([$code]);
            if (!$stmt->fetchColumn()) {
                return $code;
            }
        }
        throw new RuntimeException('Nepodařilo se vytvořit unikátní kód hry.');
    }

    private function secureShuffle(array &$items): void
    {
        for ($index = count($items) - 1; $index > 0; $index--) {
            $swap = random_int(0, $index);
            [$items[$index], $items[$swap]] = [$items[$swap], $items[$index]];
        }
    }

    private function publicGame(array $game): array
    {
        return [
            'id' => $game['id'],
            'code' => $game['code'],
            'name' => $game['name'],
            'rule' => $game['rule_text'],
            'status' => $game['status'],
            'killMode' => $game['kill_mode'],
            'showRoster' => (bool) $game['show_roster'],
            'startedAt' => $this->iso($game['started_at']),
            'endedAt' => $this->iso($game['ended_at']),
            'endedReason' => $game['ended_reason'],
        ];
    }

    private function publicPlayer(array $player): array
    {
        return [
            'id' => $player['id'],
            'name' => $player['name'],
            'status' => $player['status'],
            'killsCount' => (int) $player['kills_count'],
            'eliminatedAt' => $this->iso($player['eliminated_at']),
        ];
    }

    private function publicReport(array $report): array
    {
        return [
            'id' => $report['id'],
            'status' => $report['status'],
            'reportedAt' => $this->iso($report['reported_at']),
        ];
    }

    private function iso(?string $value): ?string
    {
        if (!$value) {
            return null;
        }
        return (new DateTimeImmutable($value, new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    private function text(mixed $value, int $maxLength): string
    {
        return mb_substr(trim((string) $value), 0, $maxLength);
    }
}
