# Kruh — hra Mafie (Cloudflare Workers + D1)

Mobilní webová aplikace pro organizaci společenské hry Mafie. Běží zdarma na
**Cloudflare Workers** (free plán) s databází **Cloudflare D1** na adrese
`https://mafie.albiovi.cz`.

- Server: TypeScript + [Hono](https://hono.dev), HTML kostra přes Hono JSX (`src/index.tsx`)
- Herní logika: `src/game.ts` (přepis `legacy/src/GameService.php`)
- Databáze: D1 (SQLite), schéma v `migrations/0001_init.sql`
- Statické soubory: `public/assets/` (Workers Static Assets)
- Konfigurace: `wrangler.jsonc`
- Původní PHP verze: `legacy/` (po otestování smaž)

Adresy zůstaly stejné: `/` (a `/index.php`), `POST /api.php`, `/assets/*`,
pozvánky `/?kod=XXXXXX`.

Herní pravidla a produktová rozhodnutí jsou popsaná v
`legacy/docs/PRODUCT_DECISIONS.md`. Při mazání složky `legacy/` si ten
dokument případně přesuň jinam.

---

## Lokální vývoj

Požadavky: Node.js 20+ (doporučeno 22).

```bash
npm install
npm run dev
```

`npm run dev` nejdřív aplikuje migrace na lokální D1 (`.wrangler/state/`) a
pak spustí `wrangler dev` na `http://127.0.0.1:8787`. Cloudflare účet ani
přihlášení k tomu nepotřebuješ.

Užitečné příkazy:

| Příkaz | Co dělá |
|---|---|
| `npm run typecheck` | kontrola typů TypeScriptu |
| `npm run test:smoke` | kouřový test API proti běžícímu `npm run dev` (všechny tři režimy, souběh, validace) |
| `npm run db:migrate:local` | migrace na lokální D1 |
| `npm run db:migrate:remote` | migrace na produkční D1 |
| `npm run convert-dump -- dump.sql data.d1.sql` | převod MySQL dumpu pro D1 |

---

## Nasazení na Cloudflare krok za krokem

Všechno je na free plánu. Platební kartu není potřeba zadávat.

### 0. Přihlášení

```bash
npx wrangler login
```

### 1. Vytvoření D1 databáze a doplnění ID

```bash
npx wrangler d1 create kruh-mafie
```

Výstup obsahuje `database_id`, například:

```
"database_id": "a1b2c3d4-...."
```

Toto ID vlož do `wrangler.jsonc` místo `00000000-0000-0000-0000-000000000000`,
commitni a pushni. ID není tajný údaj, do repozitáře patří.

(Alternativa: Cloudflare dashboard → **Storage & Databases → D1 SQL Database →
Create**, název `kruh-mafie`, ID zkopíruješ z detailu databáze.)

### 2. Migrace a import dat

Vytvoření tabulek v produkční databázi:

```bash
npm run db:migrate:remote
```

Import dat ze staré MySQL databáze:

1. Na původním hostingu vyexportuj databázi (phpMyAdmin → Export → SQL, nebo
   `mysqldump --no-create-info --skip-extended-insert kruh > dump.sql`).
   Stačí data. Strukturu skript ignoruje.
2. Ulož export jako `dump.sql` do kořene projektu. Je v `.gitignore`, do
   repozitáře se nedostane.
3. Převeď ho:
   ```bash
   npm run convert-dump -- dump.sql data.d1.sql
   ```
   Skript vypíše počty her, hráčů a hlášení a případná upozornění.
4. Nahraj ho do D1:
   ```bash
   npx wrangler d1 execute kruh-mafie --remote --file=data.d1.sql
   ```
5. Kontrola:
   ```bash
   npx wrangler d1 execute kruh-mafie --remote --command "SELECT status, COUNT(*) FROM games GROUP BY status"
   ```

Import spouštěj do prázdné databáze, jen jednou. Pokud se nepovede, smaž data:

```bash
npx wrangler d1 execute kruh-mafie --remote --command "DELETE FROM kill_reports; UPDATE games SET admin_player_id = NULL; DELETE FROM players; DELETE FROM games;"
```

Pak import opakuj. Otisky přístupových tokenů se převádějí beze změny, takže
existující přístupy hráčů zůstanou platné (viz „Co se chová jinak“).

### 3. Secrets

**Žádné secrets nastavovat nemusíš.** Jediný tajný údaj PHP verze bylo heslo
k MySQL a to nahradila vazba (binding) na D1 ve `wrangler.jsonc`, která žádné
heslo nepotřebuje. Aplikace nemá API klíče, e-maily ani podepisované cookies.

Pokud v budoucnu nějaký tajný údaj přibude, nastav ho příkazem
`npx wrangler secret put NAZEV` (nebo v dashboardu **Worker → Settings →
Variables and Secrets**). Pro lokální vývoj ho dej do `.dev.vars`, který je
v `.gitignore`. Do repozitáře nikdy.

### 4. Nasazení přes Git (automatický deploy po pushi)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**
   (Connect to Git).
2. Propoj GitHub účet a vyber repozitář `all-bi/mafie`.
3. Nastavení:
   - **Project name:** `kruh-mafie` (musí se shodovat s `"name"` ve `wrangler.jsonc`)
   - **Production branch:** větev, ze které chceš nasazovat (např. `main` po
     sloučení, nebo `claude/cloudflare` pro test)
   - **Build command:** nech prázdné (závislosti se nainstalují samy)
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** `/`
4. **Save and Deploy.** Každý další push do produkční větve se nasadí sám.

Migrace databáze se při deployi nespouštějí automaticky. Až přibude nový
soubor v `migrations/`, spusť před pushem `npm run db:migrate:remote`.

Ruční nasazení bez Gitu: `npm run deploy`.

### 5. Vlastní doména mafie.albiovi.cz

Zóna `albiovi.cz` už je na Cloudflare a `wrangler.jsonc` obsahuje:

```jsonc
"routes": [{ "pattern": "mafie.albiovi.cz", "custom_domain": true }]
```

Při deployi Cloudflare doménu sám připojí: vytvoří DNS záznam i HTTPS
certifikát. Pokud už v DNS existuje záznam `app` (A, AAAA nebo CNAME),
**nejdřív ho v DNS smaž**, jinak se doména nepřipojí.

Ruční varianta: **Workers & Pages → kruh-mafie → Settings → Domains & Routes →
Add → Custom domain** → `mafie.albiovi.cz`.

Jiná subdoména: změň `pattern` ve `wrangler.jsonc`. Aplikace je dostupná i na
`kruh-mafie.<účet>.workers.dev`. Když to nechceš, nastav `"workers_dev": false`.

---

## Limity free plánu a na co dát pozor

Ověřeno v dokumentaci Cloudflare (listopad 2026):

| Limit | Hodnota | Dopad na aplikaci |
|---|---|---|
| Požadavky na Worker | 100 000 / den | Hlavní omezení, viz níže. Statické soubory (CSS, JS, obrázek) jsou podle Cloudflare zdarma a neomezené. |
| CPU čas | 10 ms / požadavek | Běžný požadavek spotřebuje zlomek. Čekání na D1 se nepočítá. |
| D1 čtení | 5 mil. řádků / den | Jeden dotaz na stav přečte zhruba počet hráčů + 10 řádků. |
| D1 zápisy | 100 000 řádků / den | Nevýznamné. |
| D1 velikost | 500 MB | Nevýznamné. |
| Dotazy na jeden požadavek | 50 (batch = 1) | Aplikace používá nejvýš 4 batche. |

**Obnovování stavu** (cíl: 50 hráčů, 24 hodin hraní denně):

- Živý hráč a organizátor obnovují stav 1× za minutu, mrtvý hráč 1× za 5 minut.
- Skrytá stránka (jiná aplikace, zamčený telefon) a skončená hra se neobnovují vůbec.
- Navíc se stav načte ihned po vlastní akci, při návratu do aplikace
  (nejvýš 1× za 30 s) a tlačítkem „Obnovit stav hry“.
- Když se ve hře od posledního dotazu nic nezměnilo, server odpoví jen „beze
  změny“ a z D1 přečte 2 řádky místo 12–62.

Propočet nejhoršího případu, kdy všech 50 hráčů celých 24 h zírá na otevřenou
aplikaci a nikdo neumře:

| | Výpočet | Výsledek | Limit |
|---|---|---|---|
| Požadavky | 50 × 60/h × 24 h | 72 000 + akce a načtení stránky | 100 000 / den |
| D1 čtení (beze změny) | 72 000 × 2 řádky | ~144 000 | 5 000 000 / den |
| D1 čtení (po změně) | 200 změn × 50 hráčů × 62 řádků | ~620 000 | |

Ve skutečnosti je spotřeba mnohem nižší: mrtví se ptají 5× méně a zamčené
telefony vůbec. Po překročení limitu by Cloudflare až do půlnoci UTC vracel
chybu 1027 / 429. Intervaly se nastavují na začátku sekce obnovování
v `public/assets/app.js` (`POLL_ALIVE_MS`, `POLL_DEAD_MS`).

**CPU:** nejdražší jsou statistiky po skončení hry (počet hráčů × počet vražd).
I pro stovky hráčů jde o jednotky milisekund. Spuštění hry s 25 hráči i souběžné
připojení 25 hráčů zároveň jsem lokálně otestoval. V produkci můžeš CPU čas
sledovat v dashboardu: **Worker → Metrics / Observability**.

**Zálohy:** D1 Time Travel umožňuje obnovit databázi do libovolného okamžiku
za posledních 7 dní (`npx wrangler d1 time-travel restore`). Ruční export:
`npx wrangler d1 export kruh-mafie --remote --output=zaloha.sql`.

---

## Bezpečnost

- Hráčská a organizátorská oprávnění jsou náhodné 256bitové tokeny. Databáze
  ukládá jen jejich SHA-256 otisky. Organizátorský token se porovnává
  v konstantním čase.
- Tokeny posílá klient v těle JSON, ne v cookies, takže CSRF útok nemá čeho
  zneužít. API navíc přijímá jen `Content-Type: application/json` a odmítá
  požadavky s cizí hlavičkou `Origin`.
- Všechny SQL dotazy jsou prepared statements s `.bind()`.
- Vstupy se ořezávají a validují: délka ve znacích, odstranění řídicích znaků,
  formát UUID, tokenu a kódu hry, limit velikosti požadavku 16 kB.
- Výstupy escapuje `public/assets/app.js` (beze změny oproti PHP verzi).
- HTML stránka má stejnou CSP a další bezpečnostní hlavičky jako `index.php`.
- Souběžné požadavky: D1 nemá `SELECT … FOR UPDATE`. Každá změna se proto
  zapisuje jedním atomickým `batch()` s kontrolou verze hry (optimistické
  zamykání). Při kolizi se akce automaticky zopakuje nad čerstvými daty.
  Kruh tak nemůže být porušen.
