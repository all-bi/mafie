import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { GameService, type Input } from './game';
import { DomainError } from './util';

type Env = {
  Bindings: {
    DB: D1Database;
    ASSETS: Fetcher;
  };
};

const app = new Hono<Env>();

// Stejné bezpečnostní hlavičky jako v legacy/index.php.
const PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const MAX_BODY_BYTES = 16 * 1024;

// ------------------------------------------------------------------ HTML

/** Odpovídá HTML kostře z legacy/index.php. Celé UI vykresluje assets/app.js. */
const Page: FC = () => (
  <html lang="cs">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#f2efe7" />
      <meta name="description" content="Soukromý organizátor hry Mafie pro přátele." />
      <meta property="og:title" content="Kruh" />
      <meta property="og:description" content="Jeden kruh. Jeden vítěz." />
      <meta property="og:image" content="assets/og.png" />
      <title>Kruh — hra Mafie</title>
      <link rel="stylesheet" href="assets/app.css" />
      <script src="assets/app.js" defer></script>
    </head>
    <body>
      <div id="app" aria-live="polite"></div>
      <noscript>Pro používání aplikace je potřeba povolit JavaScript.</noscript>
    </body>
  </html>
);

const renderPage = (c: Context<Env>) => {
  for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value);
  return c.html(`<!doctype html>\n${(<Page />).toString()}`);
};

app.get('/', renderPage);
app.get('/index.php', renderPage);

// ------------------------------------------------------------------- API

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const apiError = (message: string, status = 400) => jsonResponse({ error: message }, status);

/** Požadavek z jiného webu (Origin nesedí s hostitelem) odmítneme. */
function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin || origin === 'null') return origin === 'null';
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

app.all('/api.php', async c => {
  if (c.req.method !== 'POST') {
    const response = apiError('Použij metodu POST.', 405);
    response.headers.set('Allow', 'POST');
    return response;
  }
  if (isCrossOrigin(c.req.raw)) return apiError('Požadavek z jiného webu není povolen.', 403);

  const contentType = c.req.header('Content-Type') ?? '';
  const declaredLength = Number(c.req.header('Content-Length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return apiError('Požadavek je příliš velký.', 413);

  let input: Input;
  try {
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return apiError('Požadavek je příliš velký.', 413);
    if (raw !== '' && !contentType.toLowerCase().startsWith('application/json')) {
      return apiError('Požadavek musí být ve formátu JSON.', 415);
    }
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
    input = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Input) : {};
  } catch {
    return apiError('Požadavek nemá platný JSON.', 400);
  }

  try {
    return jsonResponse(await new GameService(c.env.DB).handle(input));
  } catch (error) {
    if (error instanceof DomainError) {
      const status = error.status >= 400 && error.status <= 599 ? error.status : 400;
      return apiError(error.message, status);
    }
    console.error(error);
    if (error instanceof Error && /D1_|SQLITE|D1 /i.test(error.message)) {
      return apiError('Databáze momentálně není dostupná.', 503);
    }
    return apiError('Něco se nepovedlo. Zkus to prosím znovu.', 500);
  }
});

// Všechno ostatní (statické soubory obslouží Cloudflare ještě před Workerem).
app.notFound(c => c.text('Stránka nenalezena.', 404, { 'X-Content-Type-Options': 'nosniff' }));

app.onError((error, c) => {
  console.error(error);
  return c.text('Něco se nepovedlo.', 500);
});

export default app;
