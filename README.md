# Kruh — hra Mafie (Cloudflare Workers + D1)

Mobilní webová aplikace pro organizaci společenské hry Mafie. Běží zdarma na
**Cloudflare Workers** (free plán) s databází **Cloudflare D1** na adrese
`https://mafie.albiovi.cz`.

- Server: TypeScript + [Hono](https://hono.dev), HTML kostra přes Hono JSX (`src/index.tsx`)
- Herní logika: `src/game.ts` (přepis `legacy/src/GameService.php`)
- Databáze: D1 (SQLite), schéma v `migrations/0001_init.sql`
- Statické soubory: `public/` (Workers Static Assets), service worker `public/sw.js`
- Push upozornění: `src/push.ts` (Web Push bez knihoven), fronta `src/outbox.ts` (Durable Object)
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
| `npm run vapid` | vygeneruje klíče pro push upozornění |
| `npm run test:push` | test push upozornění s falešnou push službou (viz níže) |

Push upozornění lokálně: spusť `npm run vapid`, oba řádky `VAPID_…` ulož do
souboru `.dev.vars` a pro `npm run test:push` přidej i řádek
`PUSH_ALLOW_LOCALHOST=1`. Ten povolí posílání na falešnou push službu na
127.0.0.1, proto **nikdy nepatří do produkce**. Bez klíčů aplikace běží
normálně, jen tlačítko „Zapnout upozornění“ se nezobrazí.

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

### 3. Secrets (klíče pro push upozornění)

Jediné tajné údaje jsou klíče VAPID, kterými server podepisuje push upozornění.
Heslo k databázi už potřeba není, D1 se připojuje přes binding ve `wrangler.jsonc`.

1. Vygeneruj klíče:
   ```bash
   npm run vapid
   ```
2. Ulož je do Cloudflare. Každý příkaz se zeptá na hodnotu, vlož ji z výpisu:
   ```bash
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```
   (nebo v dashboardu: **Workers & Pages → kruh-mafie → Settings → Variables
   and Secrets → Add → Secret**)

| Secret | Co to je |
|---|---|
| `VAPID_PUBLIC_KEY` | veřejný klíč (posílá se i prohlížečům) |
| `VAPID_PRIVATE_KEY` | privátní klíč, **nikdy ho necommituj ani neposílej** |

`VAPID_SUBJECT` (kontakt pro push služby) je veřejný a je ve `wrangler.jsonc`
v sekci `vars`. Secrets se při nasazování z Gitu zachovávají a stačí je
nastavit jednou. Když privátní klíč změníš, hráči musí upozornění zapnout
znovu (aplikace to při dalším otevření udělá sama, pokud už mají povolení).

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

První nasazení vytvoří i Durable Object `PushOutbox` (frontu hromadných
upozornění). Je zdarma na free plánu, s úložištěm SQLite.

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
| Podpožadavky (fetch) | 50 / spuštění | Push zprávy se posílají nejvýš po 6 v jednom spuštění. |
| Durable Objects | 100 000 požadavků / den | Jen fronta hromadných upozornění: zhruba 10 spuštění na začátek nebo konec hry. |

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

**CPU:** nejdražší jsou statistiky po skončení hry (počet hráčů × počet vražd)
a šifrování push zpráv (asi 0,8 ms na zprávu). Zprávy pro 1–3 lidi (vražda,
potvrzení) se pošlou přímo. Hromadné zprávy (začátek a konec hry pro 50 hráčů
zabere ~40 ms CPU) se uloží do Durable Objectu a ten je rozešle po 6. Každá
dávka běží jako samostatné spuštění alarmu s vlastním limitem 10 ms. Všem
dorazí do pár sekund. Spuštění hry s 25 hráči i souběžné připojení 25 hráčů
jsem lokálně otestoval. V produkci můžeš CPU čas sledovat v dashboardu:
**Worker → Metrics / Observability**.

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

---

## Push upozornění

Hráč si je zapne tlačítkem „Zapnout upozornění“ ve hře. Zprávy nikdy
neobsahují jména, protože se zobrazují i na zamčené obrazovce:

| Komu | Kdy | Text |
|---|---|---|
| všem hráčům | hra začala | Hra začala — Podívej se, kdo je tvoje oběť. |
| oběti | vražda (potvrzení / odvolání / okamžitě) | Byl/a jsi zabit/a? … / Byl/a jsi zabit/a. … |
| vrahovi | oběť potvrdila | Vražda potvrzena — Máš novou oběť. |
| vrahovi | oběť odmítla / odvolala | Oběť vraždu odmítla / Vražda byla odvolána |
| všem + organizátorovi | hra skončila | Hra skončila — Podívej se na výsledky. |

Když je aplikace otevřená, upozornění ji zároveň hned obnoví.

**iPhone:** iOS posílá upozornění jen aplikaci přidané na plochu (iOS 16.4+).
Aplikace na ploše má oddělené úložiště od Safari, proto přibyl **přenos na jiné
zařízení**: ve hře „Přenést na jiné zařízení“ vytvoří jednorázový kód (platí
10 minut) a na úvodní stránce se zadá přes „Už hraji na jiném zařízení“.
Funguje i pro přechod na nový telefon. Nejjednodušší je přidat Kruh na plochu
ještě před připojením do hry.

**Bezpečnost:** server posílá zprávy jen na adresy známých push služeb
(Google, Apple, Mozilla, Microsoft), jiné adresy odběru odmítne. Neplatné
odběry (telefon odinstaloval prohlížeč a podobně) maže automaticky. Kód
přenosu je jednorázový a přístupové údaje k němu jsou v D1 zašifrované klíčem
odvozeným z kódu, který server neukládá.
