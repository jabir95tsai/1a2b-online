import { ApiError, failure } from './errors.ts';
import { readOwner, sessionCookie, sign, unauthorized, verifyOrigin } from './auth.ts';
import { object, parseCreation, readJson } from './validation.ts';
import { codeFromDigest, onlyKeys, roomCode, roomCreation } from './rooms/validation.ts';
export { SoloGame } from './solo/SoloGame.ts';
export { GameRoom } from './rooms/GameRoom.ts';

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...extra,
  } });
}
async function limit(binding: RateLimit, key: string): Promise<void> {
  if (!(await binding.limit({ key })).success) throw new ApiError(429, 'RATE_LIMITED', '請稍候再試。');
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, version: '1.0.0' });
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (url.search !== '') throw new ApiError(400, 'QUERY_NOT_ALLOWED', 'API 不接受 URL query，請使用 JSON body。');
      verifyOrigin(request);
      if (request.method === 'POST' && url.pathname === '/api/session') {
        const input = object(await readJson(request));
        if (Object.keys(input).length !== 0) throw new ApiError(400, 'INVALID_REQUEST', '此端點不接受身分指定。');
        const ipKey = await sign(env.AUTH_SECRET, `session-ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`);
        await limit(env.SESSION_LIMIT, ipKey);
        let owner: string | null = null;
        try { owner = await readOwner(request, env.AUTH_SECRET); }
        catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
        owner ??= crypto.randomUUID();
        return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(owner, env.AUTH_SECRET) });
      }
      const owner = await readOwner(request, env.AUTH_SECRET);
      if (owner === null) throw unauthorized();
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        const creation = roomCreation(await readJson(request));
        await limit(env.CREATE_LIMIT, `owner:${owner}`);
        await limit(env.CREATE_LIMIT, await sign(env.AUTH_SECRET, `create-ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`));
        for (let attempt = 0; attempt < 8; attempt++) {
          const code = codeFromDigest(await sign(env.AUTH_SECRET, `room:${owner}:${creation.requestId}:${attempt}`));
          if (!code) continue;
          const inviteToken = await sign(env.AUTH_SECRET, `invite:${owner}:${creation.requestId}:${code}`);
          const inviteHash = await sign(env.AUTH_SECRET, `invite-hash:${inviteToken}`);
          const result = await env.GAME_ROOMS.getByName(code).create(owner, { ...creation, code, inviteHash,
            revealOpponentHistory: String(env.REVEAL_OPPONENT_HISTORY) === 'true' });
          if ('error' in result.body && result.body.error.code === 'ROOM_CODE_COLLISION') continue;
          return json('room' in result.body ? { ...result.body, inviteToken } : result.body, result.status);
        }
        throw new ApiError(503, 'ROOM_CODE_UNAVAILABLE', '暫時無法建立房碼，請重試。');
      }
      const roomRoute = /^\/api\/rooms\/([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8})(?:\/(join|actions|ws|invite))?$/.exec(url.pathname);
      if (roomRoute) {
        const code = roomCode(roomRoute[1]);
        const room = env.GAME_ROOMS.getByName(code);
        if (roomRoute[2] === 'join' && request.method === 'POST') {
          await limit(env.JOIN_LIMIT, owner);
          await limit(env.JOIN_IP_LIMIT, await sign(env.AUTH_SECRET, `join-ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`));
          const input = object(await readJson(request));
          onlyKeys(input, ['inviteToken']);
          if (input.inviteToken !== undefined && (typeof input.inviteToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.inviteToken))) throw new ApiError(400, 'INVALID_INVITE', '邀請連結格式錯誤。');
          const hash = input.inviteToken === undefined ? null : await sign(env.AUTH_SECRET, `invite-hash:${input.inviteToken}`);
          const result = await room.join(owner, hash);
          return json(result.body, result.status);
        }
        await limit(env.ACTION_LIMIT, owner);
        if (roomRoute[2] === 'invite' && request.method === 'GET') {
          const metadata = await room.inviteMetadata(owner);
          if (!metadata) throw new ApiError(404, 'ROOM_NOT_FOUND', '房間不存在或已回收。');
          return json({ inviteToken: await sign(env.AUTH_SECRET, `invite:${metadata.creator}:${metadata.requestId}:${code}`) });
        }
        if (roomRoute[2] === 'ws' && request.method === 'GET') {
          if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || request.headers.get('origin') !== url.origin) throw new ApiError(400, 'WEBSOCKET_REQUIRED', '請使用本站 WebSocket 連線。');
          return await room.fetch(new Request('https://room.internal/ws', { headers: { Upgrade: 'websocket', 'X-Room-Owner': owner } }));
        }
        if (roomRoute[2] === 'actions' && request.method === 'POST') {
          const result = await room.action(owner, await readJson(request));
          return json(result.body, result.status);
        }
        if (!roomRoute[2] && request.method === 'GET') {
          const result = await room.view(owner);
          return json(result.body, result.status);
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支援此 HTTP method。');
      }
      if (request.method === 'POST' && url.pathname === '/api/solo') {
        const creation = parseCreation(await readJson(request));
        await limit(env.CREATE_LIMIT, `owner:${owner}`);
        await limit(env.CREATE_LIMIT, await sign(env.AUTH_SECRET, `create-ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`));
        const id = await sign(env.AUTH_SECRET, `solo:${owner}:${creation.requestId}`);
        const result = await env.SOLO_GAMES.getByName(id).create(owner, id, creation);
        return json(result.body, result.status);
      }
      const route = /^\/api\/solo\/([a-f0-9]{64})(\/actions)?$/.exec(url.pathname);
      if (!route) throw new ApiError(404, 'NOT_FOUND', '找不到此端點。');
      await limit(env.ACTION_LIMIT, owner);
      const game = env.SOLO_GAMES.getByName(route[1]!);
      if (!route[2] && request.method === 'GET') {
        const result = await game.view(owner);
        return json(result.body, result.status);
      }
      if (route[2] && request.method === 'POST') {
        const result = await game.action(owner, await readJson(request));
        return json(result.body, result.status);
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支援此 HTTP method。');
    } catch (error) {
      const result = failure(error);
      return json(result.body, result.status, result.status === 429 ? { 'Retry-After': '60' } : {});
    }
  },
} satisfies ExportedHandler<Env>;
