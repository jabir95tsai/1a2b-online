import { ApiError } from './errors.ts';
import { UUID } from './validation.ts';

const COOKIE = '__Host-1a2b-session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

async function key(secret: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '伺服端身分驗證尚未設定。');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, part => Number.parseInt(part, 16)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function sign(secret: string, value: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(value)));
}
export async function readOwner(request: Request, secret: string, now = Date.now()): Promise<string | null> {
  const values = (request.headers.get('cookie') ?? '').split(';').map(item => item.trim())
    .filter(item => item.startsWith(`${COOKIE}=`));
  if (values.length === 0) return null;
  if (values.length !== 1) throw unauthorized();
  const token = values[0]!.slice(COOKIE.length + 1);
  if (token.length > 200) throw unauthorized();
  const [owner, expires, signature, extra] = token.split('.');
  if (!owner || !UUID.test(owner) || !expires || !/^[0-9]{13}$/.test(expires)
    || !signature || !/^[0-9a-f]{64}$/.test(signature) || extra !== undefined) throw unauthorized();
  const expiresAt = Number(expires);
  if (expiresAt <= now || expiresAt > now + SESSION_SECONDS * 1000 + 60_000) throw unauthorized();
  const valid = await crypto.subtle.verify('HMAC', await key(secret),
    Uint8Array.from(signature.match(/../g)!, part => Number.parseInt(part, 16)),
    new TextEncoder().encode(`session:${owner}.${expires}`));
  if (!valid) throw unauthorized();
  return owner;
}
export function unauthorized(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', '請先建立或重新取得匿名身分。');
}
export async function sessionCookie(owner: string, secret: string, now = Date.now()): Promise<string> {
  const payload = `${owner}.${now + SESSION_SECONDS * 1000}`;
  const signature = await sign(secret, `session:${payload}`);
  return `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}
export function verifyOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin !== null && origin !== new URL(request.url).origin)
    || site === 'cross-site' || site === 'same-site'
    || (request.method !== 'GET' && origin === null)) {
    throw new ApiError(403, 'ORIGIN_REJECTED', '請從本站發送請求。');
  }
}
