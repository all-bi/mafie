# Nasazení vedle WordPressu na subdoménu

Doporučené uspořádání:

```text
www.example.cz       -> stávající WordPress
mafia.example.cz     -> tato samostatná PHP aplikace
```

## Postup

1. V administraci hostingu založ subdoménu `mafia.example.cz`.
2. Nastav jí samostatný kořenový adresář, například `/subdomains/mafia` nebo `/public_html/mafia` podle hostingu.
3. Pro subdoménu vyber PHP 8.1 nebo novější a aktivuj HTTPS certifikát.
4. Vytvoř prázdnou MySQL/MariaDB databázi a uživatele. Doporučena je databáze oddělená od WordPressu.
5. Přes phpMyAdmin importuj soubor `schema.sql`.
6. Nahraj obsah repozitáře do kořene subdomény.
7. Na serveru zkopíruj `config.example.php` na `config.php` a doplň údaje databáze.
8. Otevři subdoménu v prohlížeči a založ testovací hru alespoň pro tři hráče.

Příklad `config.php`:

```php
<?php
declare(strict_types=1);

return [
    'database' => [
        'dsn' => 'mysql:host=localhost;port=3306;dbname=NAZEV_DATABAZE;charset=utf8mb4',
        'username' => 'UZIVATEL_DATABAZE',
        'password' => 'TAJNE_HESLO',
    ],
];
```

Některé hostingy používají místo `localhost` vlastní adresu databázového serveru.

## Co nenahrávat na GitHub

- skutečný `config.php`;
- export produkční databáze;
- logy serveru;
- přístupová hesla, API klíče nebo zálohy s osobními údaji.

`config.php` už je uveden v `.gitignore`.

## WordPress

Aplikaci nevkládej do `wp-content/plugins` ani `wp-content/themes`. Není to WordPress plugin a WordPress k jejímu běhu nepotřebuje. Sdílení jedné databáze je technicky možné, ale samostatná databáze s vlastním uživatelem je přehlednější a bezpečnější.

## Kontrola po nasazení

- stránka se načte přes HTTPS bez varování;
- lze založit hru a připojit tři různé hráče;
- spuštění hry přidělí každému právě jednu oběť;
- každý hráč vidí pouze svůj stav a svoji oběť;
- funguje zvolený režim potvrzení/odvolání;
- po poslední vraždě se zobrazí výsledky;
- přímé otevření `/config.php`, `/schema.sql` a `/src/` neodhalí obsah souborů.

