<?php
declare(strict_types=1);

header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
header('Referrer-Policy: same-origin');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
?>
<!doctype html>
<html lang="cs">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f2efe7">
    <meta name="description" content="Soukromý organizátor hry Mafie pro přátele.">
    <meta property="og:title" content="Kruh">
    <meta property="og:description" content="Jeden kruh. Jeden vítěz.">
    <meta property="og:image" content="assets/og.png">
    <title>Kruh — hra Mafie</title>
    <link rel="stylesheet" href="assets/app.css">
    <script src="assets/app.js" defer></script>
</head>
<body>
    <div id="app" aria-live="polite"></div>
    <noscript>Pro používání aplikace je potřeba povolit JavaScript.</noscript>
</body>
</html>
