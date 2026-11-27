# Kruh — hra Mafie (PHP + MySQL)

Mobilní webová aplikace pro organizaci společenské hry Mafie. Projekt je napsaný v čistém PHP, JavaScriptu a CSS a používá MySQL nebo MariaDB. Nepotřebuje Node.js, Cloudflare ani sestavení před nahráním na hosting.

Zdrojové soubory můžeš bez problému uložit na GitHub. Samotné **GitHub Pages ale PHP ani MySQL nespouštějí**, takže aplikaci je potřeba vystavit na PHP webhostingu; GitHub může sloužit jako repozitář a zdroj pro nasazení.

## Požadavky

- PHP 8.1 nebo novější,
- rozšíření `pdo_mysql`, `mbstring` a `json`,
- MySQL 8+ nebo MariaDB 10.4+,
- HTTPS pro bezpečné ukládání hráčských přístupů v prohlížeči.

## Instalace na webhosting

1. V administraci hostingu vytvoř prázdnou MySQL databázi a databázového uživatele.
2. Do databáze importuj soubor `schema.sql` (například přes phpMyAdmin).
3. Zkopíruj `config.example.php` jako `config.php`.
4. V `config.php` vyplň server, název databáze, uživatele a heslo.
5. Nahraj projekt do webového adresáře hostingu, například `public_html`.
6. Otevři adresu webu v prohlížeči a založ první hru.

Soubor `config.php` je v `.gitignore`, takže se heslo do databáze nenahraje na GitHub. Přiložený `.htaccess` navíc na Apache zakazuje přístup ke konfiguraci a instalačnímu SQL přes web.

### Příklad konfigurace

```php
<?php
return [
    'database' => [
        'dsn' => 'mysql:host=localhost;port=3306;dbname=kruh;charset=utf8mb4',
        'username' => 'kruh_user',
        'password' => 'silne-heslo',
    ],
];
```

Některé hostingy používají jiný server než `localhost`; přesnou hodnotu najdeš v jejich administraci.

## Lokální spuštění

Připrav lokální MySQL, importuj `schema.sql`, vytvoř `config.php` a spusť:

```powershell
php -S 127.0.0.1:8080
```

Aplikace bude dostupná na `http://127.0.0.1:8080/`.

## Struktura projektu

- `index.php` — hlavní stránka aplikace,
- `api.php` — jediný JSON endpoint,
- `src/GameService.php` — herní pravidla a databázové transakce,
- `src/bootstrap.php` — konfigurace a připojení k MySQL,
- `assets/app.js` — mobilní uživatelské rozhraní,
- `assets/app.css` — vzhled aplikace,
- `schema.sql` — struktura databáze,
- `config.example.php` — vzor konfigurace.

## Bezpečnost a herní tajemství

- Hráčská a administrátorská oprávnění tvoří náhodné tokeny; databáze ukládá jen jejich SHA-256 otisky.
- Každá odpověď API je přizpůsobená konkrétnímu hráči. Celý kruh se neposílá do prohlížeče.
- Změny vražd probíhají v MySQL transakcích se zamčením dotčených záznamů.
- Jména a pravidla se v rozhraní vždy escapují před vložením do HTML.
- Statistiky jsou dostupné až po ukončení hry.

## Aktualizace

Před nahráním nové verze zazálohuj databázi a `config.php`. Pokud budoucí verze obsahuje databázovou migraci, spusť ji před aktualizací PHP souborů.
