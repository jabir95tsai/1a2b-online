import { CandidateSet } from '../../core/candidates.ts';
import { ApiError } from '../errors.ts';
import type { SoloRecord, SoloState } from './engine.ts';

type Row = { snapshot: string; candidates: ArrayBuffer };
export class SoloRepository {
  readonly #sql: SqlStorage;
  constructor(sql: SqlStorage) { this.#sql = sql; }
  #schema(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS solo_game (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot TEXT NOT NULL,
      candidates BLOB NOT NULL CHECK (length(candidates) = 630)
    )`);
  }
  read(): SoloRecord | null {
    this.#schema();
    const row = this.#sql.exec<Row>('SELECT snapshot, candidates FROM solo_game WHERE id = 1').toArray()[0];
    if (!row) return null;
    const state: SoloState = JSON.parse(row.snapshot);
    if (state.schemaVersion !== 1) throw new Error('UNSUPPORTED_STORAGE_VERSION');
    return { state, candidates: CandidateSet.fromBytes(row.candidates) };
  }
  /** One row, one SQL write; no mutable secondary indexes or per-candidate rows. */
  write(record: SoloRecord, insert = false): number {
    const snapshot = JSON.stringify(record.state);
    if (new TextEncoder().encode(snapshot).byteLength > 1_000_000) {
      throw new ApiError(413, 'GAME_STORAGE_FULL', '本局已達儲存容量，未計入此次動作；請結束後另開新局。');
    }
    const blob = record.candidates.toBytes().buffer;
    const cursor = insert
      ? this.#sql.exec('INSERT INTO solo_game (id, snapshot, candidates) VALUES (1, ?, ?)', snapshot, blob)
      : this.#sql.exec('UPDATE solo_game SET snapshot = ?, candidates = ? WHERE id = 1', snapshot, blob);
    return cursor.rowsWritten;
  }
}
