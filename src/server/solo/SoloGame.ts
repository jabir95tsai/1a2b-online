import { DurableObject } from 'cloudflare:workers';
import type { SoloSuccess, ErrorView } from '../../protocol/solo.ts';
import { ApiError, failure } from '../errors.ts';
import { parseCommand, parseCreation } from '../validation.ts';
import { randomAnswer } from '../random.ts';
import { initializeSolo, projectSolo, transitionSolo } from './engine.ts';
import type { SoloRecord } from './engine.ts';
import { SoloRepository } from './repository.ts';

type Result = { status: number; body: SoloSuccess | ErrorView };

export class SoloGame extends DurableObject<Env> {
  readonly #repository: SoloRepository;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#repository = new SoloRepository(ctx.storage.sql);
  }
  #owned(owner: string): SoloRecord {
    const record = this.#repository.read();
    if (!record || record.state.owner !== owner) throw new ApiError(404, 'GAME_NOT_FOUND', '找不到此局。');
    if (record.state.expiresAt <= Date.now()) throw new ApiError(410, 'GAME_EXPIRED', '本局已到期。');
    return record;
  }
  async create(owner: string, id: string, value: unknown): Promise<Result> {
    try {
      const creation = parseCreation(value);
      return await this.ctx.storage.transaction(async () => {
        const existing = this.#repository.read();
        if (existing) {
          const record = this.#owned(owner);
          if (JSON.stringify(record.state.creation) !== JSON.stringify(creation)) {
            throw new ApiError(409, 'REQUEST_ID_REUSED', '相同 requestId 不可用於不同建立設定。');
          }
          return { status: 200, body: { game: projectSolo(record), replayed: true } };
        }
        const record = initializeSolo(id, owner, creation, randomAnswer(), crypto.randomUUID(), Date.now());
        this.#repository.write(record, true);
        await this.ctx.storage.setAlarm(record.state.expiresAt);
        return { status: 201, body: { game: projectSolo(record), replayed: false } };
      });
    } catch (error) { return failure(error); }
  }
  view(owner: string): Result {
    try { return { status: 200, body: { game: projectSolo(this.#owned(owner)), replayed: false } }; }
    catch (error) { return failure(error); }
  }
  async action(owner: string, value: unknown): Promise<Result> {
    try {
      const command = parseCommand(value);
      // Synchronous read/check/reduce/write cannot interleave with another action.
      const result = this.ctx.storage.transactionSync(() => {
        const record = this.#owned(owner);
        if (command.generation !== record.state.generation) throw new ApiError(409, 'STALE_GENERATION', '此動作屬於舊局，請重新讀取。');
        const receipt = record.state.receipts.find(item => item.id === command.requestId);
        if (receipt) {
          if (receipt.command !== JSON.stringify(command)) throw new ApiError(409, 'REQUEST_ID_REUSED', '相同 requestId 不可用於不同動作。');
          return { record, replayed: true, finishedNow: false };
        }
        if (command.expectedRevision !== record.state.revision) throw new ApiError(409, 'STALE_REVISION', '局面已更新，請重新讀取後操作。');
        const next = transitionSolo(record, command, Date.now());
        this.#repository.write(next);
        return { record: next, replayed: false, finishedNow: next.state.status === 'finished' };
      });
      // Finishing shortens retention. Active moves only extend expiresAt in the one row.
      // If the process fails here, retrying any finished action also repairs the alarm.
      if (result.finishedNow || (result.replayed && result.record.state.status === 'finished')) {
        const scheduled = await this.ctx.storage.getAlarm();
        if (scheduled === null || scheduled > result.record.state.expiresAt) await this.ctx.storage.setAlarm(result.record.state.expiresAt);
      }
      return { status: 200, body: { game: projectSolo(result.record), replayed: result.replayed } };
    } catch (error) { return failure(error); }
  }
  async alarm(): Promise<void> {
    // deleteAll is forbidden inside storage transactions. Block only this rare
    // cleanup lifecycle operation so renewal cannot race the expiry check.
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = this.#repository.read();
      if (record && record.state.expiresAt > Date.now()) {
        await this.ctx.storage.setAlarm(record.state.expiresAt);
      } else {
        // deleteAll reclaims SQLite storage; schema is recreated lazily if requested again.
        await this.ctx.storage.deleteAll();
      }
    });
  }
}
