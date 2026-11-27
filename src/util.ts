// Pomocné funkce — náhrady za PHP funkce z legacy/src/bootstrap.php.

/** Chyba, jejíž zpráva se smí zobrazit uživateli (obdoba PHP DomainException). */
export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte];
  return out;
}

/** uuid_v4() */
export function uuidV4(): string {
  return crypto.randomUUID();
}

/** access_token(): 32 náhodných bajtů jako 64 hex znaků. */
export function accessToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** token_hash(): SHA-256 jako 64 hex znaků (shodné s PHP hash('sha256', ...)). */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/** hash_equals(): porovnání v konstantním čase. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** random_int(0, max) bez zkreslení (rejection sampling). */
export function randomInt(max: number): number {
  if (max <= 0) return 0;
  const range = max + 1;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value < limit) return value % range;
  }
}

/** Fisher–Yates s kryptograficky bezpečnou náhodou (secureShuffle). */
export function secureShuffle<T>(items: T[]): void {
  for (let index = items.length - 1; index > 0; index--) {
    const swap = randomInt(index);
    [items[index], items[swap]] = [items[swap]!, items[index]!];
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** game_code() */
export function gameCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length - 1)];
  return code;
}

/** Aktuální čas ve formátu ukládaném do DB. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** iso(): normalizuje uložený čas na 'Y-m-d\TH:i:s.v\Z'. */
export function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** PHP (string) přetypování pro skalární hodnoty z JSONu. Pole/objekty -> ''. */
export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === true) return '1';
  return '';
}

/** PHP trim() — jen znaky " \t\n\r\0\x0B", ne všechny Unicode mezery. */
export function phpTrim(value: string): string {
  return value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

// Řídicí znaky kromě tabulátoru a konců řádků (v PHP verzi se nefiltrovaly).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]', 'g');

/** text(): trim + ořez na maxLength znaků (Unicode code pointů, jako mb_substr). */
export function text(value: unknown, maxLength: number): string {
  const cleaned = phpTrim(str(value)).replace(CONTROL_CHARS, '');
  const chars = Array.from(cleaned.normalize('NFC'));
  return phpTrim(chars.slice(0, maxLength).join(''));
}

/** bool_value(): filter_var($value, FILTER_VALIDATE_BOOL). */
export function boolValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

/**
 * Klíč pro unikátnost jména ve hře. Napodobuje MySQL kolaci utf8mb4_unicode_ci:
 * nerozlišuje velikost písmen ani diakritiku („Petr“ = „petr“ = „Pétr“).
 */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
export function isToken(value: string): boolean {
  return TOKEN_RE.test(value);
}
