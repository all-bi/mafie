# Nahrání balíčku na GitHub

## Přes webové rozhraní

1. Na GitHubu vytvoř nový prázdný repozitář.
2. Rozbal distribuční ZIP na počítači.
3. V repozitáři vyber **Add file -> Upload files**.
4. Nahraj obsah rozbalené složky, ne samotný ZIP.
5. Potvrď commit.

Soubor `config.php` v balíčku úmyslně není. V repozitáři je pouze bezpečný vzor `config.example.php`.

## Přes Git

```powershell
git init
git add .
git commit -m "Initial PHP MySQL version"
git branch -M main
git remote add origin https://github.com/UZIVATEL/REPOZITAR.git
git push -u origin main
```

GitHub slouží jako úložiště zdrojového kódu. GitHub Pages tuto aplikaci nespustí, protože nepodporují PHP ani MySQL.

