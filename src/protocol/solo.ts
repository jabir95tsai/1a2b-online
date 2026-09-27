/** Public protocol only. Never import server state or solver candidates here. */
export type SoloKind = 'A' | 'B-honest' | 'B-oral';
export interface FeedbackView { a: number; b: number }
export interface SoloStepView {
  guess: string;
  feedback: FeedbackView;
  candidatesBefore?: number;
  candidatesAfter?: number;
}
export interface SoloView {
  id: string;
  generation: string;
  revision: number;
  kind: SoloKind;
  status: 'active' | 'finished';
  outcome: 'won' | 'lost' | 'solved' | 'abandoned' | null;
  expiresAt: number;
  steps: number;
  history: SoloStepView[];
  maxGuesses: number | null;
  pendingGuess: string | null;
  candidateCount: number | null;
  answer?: string;
}
export interface ErrorView {
  error: { code: string; message: string; turns?: readonly number[]; irreducible?: boolean };
}
export interface SoloSuccess { game: SoloView; replayed: boolean }
