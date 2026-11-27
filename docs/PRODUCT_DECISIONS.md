# Produktová a technická rozhodnutí

Tento dokument shrnuje podstatná rozhodnutí učiněná při návrhu aplikace. Slouží jako kontext pro další vývoj; není doslovným přepisem konverzace.

## Princip hry

- Každý hráč má právě jednu tajnou oběť.
- Po spuštění hry tvoří vazby vrah–oběť jeden uzavřený kruh zahrnující všechny hráče.
- Po platné vraždě získá vrah jako novou oběť dosavadní oběť zabitého hráče.
- Hra automaticky skončí, jakmile zůstane jediný živý hráč.
- „Vražda“ je pouze smluvený herní úkon v reálném světě, například polibek. Přesná podoba se zadává při založení hry.

## Soukromí a role organizátora

- Hráč standardně zná pouze svoji vlastní oběť.
- Seznam živých a mrtvých je volitelné nastavení; výchozí stav je úplné utajení.
- Statistiky se během aktivní hry nezobrazují. Všechny se odhalí až po skončení.
- Organizátor, který zároveň hraje a je naživu, nemá během hry přístup k informacím navíc.
- Organizátor může hru předčasně ukončit i jako aktivní hráč, ale rozhraní vyžaduje několik výslovných potvrzení včetně napsání slova `UKONČIT`.
- Aplikace neobsahuje rozhodování sporů organizátorem. Vrah a oběť se musí domluvit sami.

## Tři režimy vraždy

Režim se vybere při založení hry a během hry se nemění.

### 1. Povinné potvrzení

- Vrah zvolí „Zabil/a jsem svou oběť“ a akci dvakrát potvrdí.
- Oběť vidí otázku „Byl/a jsi zabit/a?“ s volbami Ano/Ne, ale nevidí jméno vraha.
- Dokud oběť nepotvrdí Ano, vrah nedostane novou oběť.
- Při odpovědi Ne se vrahovi vrátí původní oběť a zobrazí se pokyn, aby situaci s touto osobou vyřešil.

### 2. Možnost odvolání

- Vrah dostane novou oběť ihned po nahlášení vraždy.
- Zabitému hráči se zobrazí otázka „Byl/a jsi zabit/a?“ bez jména vraha.
- Oběť může vraždu odmítnout jen do okamžiku, než stejný vrah nahlásí další vraždu.
- Při odmítnutí se stav vrátí zpět: odmítající hráč znovu ožije a stane se opět obětí původního vraha.
- U poslední dvojice musí poslední oběť reagovat, protože další vražda už nemůže odvolací lhůtu uzavřít.

### 3. Žádná práva oběti

- Vražda platí okamžitě.
- Vrah ihned dostane novou oběť.
- Zabitý hráč nemůže vraždu potvrdit ani odmítnout.

## Ochrana proti omylu

- Před nahlášením vraždy se nejprve ukáže jméno oběti a kontrolní otázka.
- Následuje druhé, výrazné potvrzení.
- Původně zvažovaná časová ochranná lhůta byla odstraněna jako hůře pochopitelná.

## Statistiky po skončení

- vítěz, pokud hra skončila přirozeně;
- první oběť a čas od začátku hry;
- počet vražd každého hráče a pořadí vrahů;
- vrah či shodní vrazi s nejvyšším celkovým počtem vražd;
- nejlepší počet vražd v klouzavém intervalu 1 hodiny, 8 hodin a 1 dne;
- časová osa potvrzených vražd.

Pro časové statistiky se používá okamžik nahlášení vraždy, nikoliv pozdější okamžik potvrzení obětí.

## Technická rozhodnutí

- Aplikace je mobilní webová aplikace a vyžaduje online připojení.
- Aktuální implementace je čisté PHP 8.1+, MySQL/MariaDB, JavaScript a CSS bez Node.js buildu.
- Serverová logika používá databázové transakce a `SELECT ... FOR UPDATE`, aby souběžné požadavky neporušily kruh.
- Přístupové tokeny se generují náhodně a v databázi se ukládají pouze jejich SHA-256 otisky.
- Herní stav vracený API je přizpůsoben konkrétnímu hráči; celý tajný kruh se neposílá klientovi.
- Přihlašovací údaje hráče se ukládají do `localStorage` konkrétního prohlížeče. Proto je doporučeno HTTPS.
- GitHub Pages nebyly použity, protože nespouštějí PHP ani MySQL.
- Doporučené nasazení je samostatná subdoména, například `mafia.example.cz`, s vlastním document rootem a ideálně vlastní databází vedle WordPressu.

## Známé provozní hranice

- Odhlášení nebo vymazání dat prohlížeče odstraní lokálně uložený hráčský token; aplikace zatím nemá samoobslužnou obnovu přístupu.
- Projekt neobsahuje WordPress plugin. Na subdoméně běží jako samostatná PHP aplikace.
- `.htaccess` je určen pro Apache/LiteSpeed. U Nginxu je nutné obdobné blokování citlivých souborů nastavit v konfiguraci serveru.

