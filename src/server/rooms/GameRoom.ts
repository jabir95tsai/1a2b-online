import { DurableObject } from 'cloudflare:workers';
import type { RoomKind, RoomView } from '../../protocol/room.ts';
import { ApiError, failure } from '../errors.ts';
import { uuid } from '../validation.ts';
import { roomAction, roomCode } from './validation.ts';
import { advanceRoom, context, nextDeadline, projectRoom, seatOf, settleLifecycle, startMatch } from './host.ts';
import type { RoomState } from './host.ts';
import { strategyFor } from './registry.ts';

interface Attachment { owner: string; epoch: number; incarnation: string; window: number; messages: number }
type RoomResponse = { status: number; body: { room: RoomView } | ReturnType<typeof failure>['body'] };

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  #read(): RoomState | null {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)');
    const row = this.ctx.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM room WHERE id = 1').toArray()[0];
    if (!row) return null;
    const room: RoomState = JSON.parse(row.snapshot);
    if (room.schemaVersion !== 1) throw new Error('UNSUPPORTED_ROOM_VERSION');
    return room;
  }
  #save(room: RoomState): void {
    const snapshot = JSON.stringify(room);
    if (new TextEncoder().encode(snapshot).byteLength > 1_000_000) throw new ApiError(413, 'ROOM_STORAGE_FULL', '房間紀錄已達容量，請結束並另開房間。');
    this.ctx.storage.sql.exec('INSERT INTO room (id, snapshot) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot', snapshot);
  }
  #require(room: RoomState | null): RoomState {
    if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', '房間不存在或已回收。');
    if (room.life === 'expired') throw new ApiError(410, 'ROOM_EXPIRED', '房間已到期。');
    return room;
  }
  #broadcast(room: RoomState): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment: Attachment | null = ws.deserializeAttachment();
        if (!attachment || attachment.incarnation !== room.incarnation) continue;
        const seat = seatOf(room, attachment.owner);
        if (room.players[seat]!.epoch !== attachment.epoch) continue;
        if (room.life === 'expired') { ws.send(JSON.stringify({ type: 'expired' })); ws.close(4004, 'Room expired'); }
        else ws.send(JSON.stringify({ type: 'room', room: projectRoom(room, attachment.owner, Date.now()) }));
      } catch { /* A failed delivery cannot roll back an already committed move. */ }
    }
  }
  async #run(owner: string, operation: (room: RoomState | null, now: number) => RoomState, status = 200, allowExpired = false): Promise<RoomResponse> {
    try {
      const result = await this.ctx.storage.transaction(async () => {
        const original = this.#read();
        const before = JSON.stringify(original);
        const now = Date.now();
        let room = original ? advanceRoom(original, now) : null;
        let error: ReturnType<typeof failure> | null = null;
        try { room = operation(room ? structuredClone(room) : null, now); }
        catch (caught) { error = failure(caught); }
        if (room && JSON.stringify(room) !== before) {
          room.revision++;
          const alarm = nextDeadline(room, now);
          const oldAlarm = original?.alarmAt;
          room.alarmAt = alarm;
          this.#save(room);
          if (alarm !== oldAlarm) await this.ctx.storage.setAlarm(alarm);
        }
        return { room, error };
      });
      if (result.room) this.#broadcast(result.room);
      if (result.error) return result.error;
      // A waiting-room leave ends the room on purpose; its caller gets the final view instead of ROOM_EXPIRED.
      const room = allowExpired && result.room?.life === 'expired' ? result.room : this.#require(result.room);
      return { status, body: { room: projectRoom(room, owner, Date.now()) } };
    } catch (error) { return failure(error); }
  }
  create(owner: string, input: { code: string; requestId: string; kind: RoomKind; inviteHash: string; revealOpponentHistory: boolean }): Promise<RoomResponse> {
    return this.#run(owner, (existing, now) => {
      const code = roomCode(input.code);
      uuid(input.requestId);
      if (existing) {
        if (existing.players[0].owner !== owner || existing.creationRequestId !== input.requestId) throw new ApiError(409, 'ROOM_CODE_COLLISION', '房碼碰撞。');
        this.#require(existing);
        if (existing.kind !== input.kind) throw new ApiError(409, 'REQUEST_ID_REUSED', '相同建立請求不可切換玩法。');
        return existing;
      }
      return { schemaVersion: 1, code, kind: input.kind, incarnation: crypto.randomUUID(), revision: 0,
        creationRequestId: input.requestId, inviteHash: input.inviteHash, revealOpponentHistory: input.revealOpponentHistory,
        life: 'waiting', gameId: crypto.randomUUID(), matchNumber: 1,
        players: [{ owner, epoch: 0, connected: false, rematch: false }, null], game: null,
        expiresAt: now + 10 * 60_000, emptyDeadline: now + 60_000, alarmAt: null, receipts: [] };
    }, 201);
  }
  join(owner: string, inviteHash: string | null): Promise<RoomResponse> {
    return this.#run(owner, (value, now) => {
      const room = this.#require(value);
      if (inviteHash !== null && inviteHash !== room.inviteHash) throw new ApiError(404, 'ROOM_NOT_FOUND', '邀請無效或已失效。');
      if (room.players.some(player => player?.owner === owner)) return room;
      if (room.life !== 'waiting' || room.players[1] !== null) throw new ApiError(409, 'ROOM_FULL', '房間已滿。');
      room.players[1] = { owner, epoch: 0, connected: false, rematch: false };
      startMatch(room, now);
      return room;
    });
  }
  view(owner: string): Promise<RoomResponse> {
    return this.#run(owner, room => { const value = this.#require(room); seatOf(value, owner); return value; });
  }
  async inviteMetadata(owner: string): Promise<{ creator: string; requestId: string } | null> {
    const result = await this.view(owner);
    if (!('room' in result.body)) return null;
    const room = this.#require(this.#read());
    seatOf(room, owner);
    return { creator: room.players[0].owner, requestId: room.creationRequestId };
  }
  action(owner: string, value: unknown): Promise<RoomResponse> {
    return this.#run(owner, (input, now) => {
      if (input?.life === 'expired') {
        // Only a replayed leave that ended this room may still read it before the alarm deletes it.
        const action = roomAction(value);
        seatOf(input, owner);
        if (action.type === 'leave' && input.receipts.some(item => item.owner === owner && item.id === action.requestId && item.command === JSON.stringify(action))) return input;
      }
      const room = this.#require(input);
      const seat = seatOf(room, owner);
      const player = room.players[seat]!;
      const action = roomAction(value);
      if (room.incarnation !== action.incarnation || player.epoch !== action.connectionEpoch || !player.connected) throw new ApiError(409, 'STALE_CONNECTION', '連線已更新，請重新連線。');
      const receipt = room.receipts.find(item => item.owner === owner && item.id === action.requestId);
      if (receipt) {
        if (receipt.command !== JSON.stringify(action)) throw new ApiError(409, 'REQUEST_ID_REUSED', '相同 requestId 不可用於不同動作。');
        return room;
      }
      if (action.gameId !== room.gameId) throw new ApiError(409, 'STALE_GAME', '此動作屬於上一局。');
      if (action.type === 'rematch') {
        if (room.life !== 'retained') throw new ApiError(409, 'NOT_FINISHED', '本局尚未結束。');
        player.rematch = action.accept;
        if (room.players.every(member => member?.rematch && member.connected)) { room.matchNumber++; startMatch(room, now); }
      } else if (action.type === 'leave' && room.life === 'waiting') {
        room.life = 'expired';
      } else {
        if (!room.game || room.life !== 'active') throw new ApiError(409, 'NOT_PLAYING', '目前無進行中的對局。');
        room.game = strategyFor(room.kind).act(room.game, seat, action, context(room, now));
        settleLifecycle(room, now);
      }
      room.receipts = [...(action.type === 'leave' ? [] : room.receipts), { owner, id: action.requestId, command: JSON.stringify(action) }].slice(-64);
      return room;
    }, 200, true);
  }
  async fetch(request: Request): Promise<Response> {
    // Only the authenticated edge Worker constructs this internal request.
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 400 });
    try { return await this.#openSocket(uuid(request.headers.get('X-Room-Owner'))); }
    catch (error) { const result = failure(error); return Response.json(result.body, { status: result.status }); }
  }
  async #openSocket(owner: string): Promise<Response> {
    const result = await this.#run(owner, (input, now) => {
      const room = this.#require(input);
      const seat = seatOf(room, owner);
      const player = room.players[seat]!;
      player.epoch++; player.connected = true; room.emptyDeadline = null;
      if (room.game) room.game = strategyFor(room.kind).presence(room.game, seat, true, context(room, now));
      if (room.life === 'retained' && room.players.every(member => member?.rematch && member.connected)) { room.matchNumber++; startMatch(room, now); }
      return room;
    });
    if (!('room' in result.body)) return Response.json(result.body, { status: result.status });
    const view = result.body.room;
    const current = this.#read();
    if (!current || current.players[seatOf(current, owner)]!.epoch !== view.connectionEpoch) {
      return Response.json({ error: { code: 'STALE_CONNECTION', message: '另一個視窗已更新連線。' } }, { status: 409 });
    }
    // No await between this attachment and return; a later connection gets a newer epoch.
    const pair = new WebSocketPair();
    const client = pair[0]; const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ owner, epoch: view.connectionEpoch, incarnation: view.incarnation, window: Date.now(), messages: 0 } satisfies Attachment);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment: Attachment | null = ws.deserializeAttachment();
      if (ws !== server && attachment?.owner === owner && attachment.epoch < view.connectionEpoch) {
        try { ws.send(JSON.stringify({ type: 'replaced' })); ws.close(4001, 'Opened in another window'); } catch { /* disconnected */ }
      }
    }
    server.send(JSON.stringify({ type: 'room', room: view }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment: Attachment | null = ws.deserializeAttachment();
    if (!attachment || typeof message !== 'string' || message.length > 128 || message !== 'sync') { ws.close(1008, 'Unsupported message'); return; }
    const now = Date.now();
    if (now - attachment.window > 60_000) { attachment.window = now; attachment.messages = 0; }
    if (++attachment.messages > 20) { ws.close(1008, 'Too many messages'); return; }
    ws.serializeAttachment(attachment);
    const room = this.#read();
    if (!room || room.incarnation !== attachment.incarnation || room.players[seatOf(room, attachment.owner)]!.epoch !== attachment.epoch) { ws.close(4001, 'Stale connection'); return; }
    await this.view(attachment.owner);
  }
  async #closed(ws: WebSocket): Promise<void> {
    const attachment: Attachment | null = ws.deserializeAttachment();
    if (!attachment) return;
    await this.#run(attachment.owner, (room, now) => {
      if (!room || room.incarnation !== attachment.incarnation) throw new ApiError(404, 'ROOM_NOT_FOUND', '房間已回收。');
      const seat = seatOf(room, attachment.owner);
      const player = room.players[seat]!;
      if (player.epoch !== attachment.epoch || !player.connected) return room;
      player.connected = false;
      if (room.players.every(member => !member?.connected)) room.emptyDeadline = now + 60_000;
      if (room.game) room.game = strategyFor(room.kind).presence(room.game, seat, false, context(room, now));
      return room;
    });
  }
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> { await this.#closed(ws); }
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> { await this.#closed(ws); }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const original = this.#read();
      if (!original) { await this.ctx.storage.deleteAll(); return; }
      const now = Date.now();
      const room = advanceRoom(original, now);
      if (room.life === 'expired') { this.#broadcast(room); await this.ctx.storage.deleteAll(); return; }
      room.revision++; room.alarmAt = nextDeadline(room, now);
      this.#save(room);
      await this.ctx.storage.setAlarm(room.alarmAt);
      this.#broadcast(room);
    });
  }
}
