import { open } from 'react-native-quick-sqlite';
import { GridConfig } from '../algorithm/omrProcessor';

const db = open({ name: 'omr_offline.db' });

export const initDatabase = () => {
  // Sessions store auto-detected grid configs (one per exam/marking session)
  db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    id   TEXT PRIMARY KEY,
    name TEXT,
    config TEXT,
    bubblesPerQuestion INTEGER,
    totalQuestions INTEGER,
    answerKey TEXT,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Results store per-sheet grading outcomes
  db.execute(`CREATE TABLE IF NOT EXISTS results (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId TEXT,
    answers   TEXT,
    score     REAL,
    totalQ    INTEGER,
    date      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // ── Schema migrations (safe on existing installs) ──────────────────────────
  // ALTER TABLE ADD COLUMN throws if column already exists — that's fine, we just ignore it.
  try { db.execute('ALTER TABLE results ADD COLUMN sessionId TEXT'); } catch (_) {}
  try { db.execute('ALTER TABLE results ADD COLUMN totalQ INTEGER'); } catch (_) {}
};

// ── Sessions ──────────────────────────────────────────────────────────────────

export const saveSession = (
  id: string,
  name: string,
  config: GridConfig,
  answerKey: string[],
) => {
  db.execute(
    'INSERT OR REPLACE INTO sessions (id, name, config, bubblesPerQuestion, totalQuestions, answerKey) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, JSON.stringify(config), config.bubblesPerQuestion, config.totalQuestions, JSON.stringify(answerKey)],
  );
};

export const getAllSessions = (): any[] => {
  const r = db.execute('SELECT * FROM sessions ORDER BY createdAt DESC');
  return r.rows?._array ?? [];
};

export const getSession = (id: string): any | null => {
  const r = db.execute('SELECT * FROM sessions WHERE id = ?', [id]);
  const row = r.rows?._array?.[0];
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(row.config),
    answerKey: JSON.parse(row.answerKey),
  };
};

export const deleteSession = (id: string) => {
  db.execute('DELETE FROM sessions WHERE id = ?', [id]);
  db.execute('DELETE FROM results WHERE sessionId = ?', [id]);
};

// ── Results ───────────────────────────────────────────────────────────────────

export const saveResult = (
  sessionId: string,
  answers: Record<number, string>,
  score: number,
  totalQ: number,
) => {
  db.execute(
    'INSERT INTO results (sessionId, answers, score, totalQ) VALUES (?, ?, ?, ?)',
    [sessionId, JSON.stringify(answers), score, totalQ],
  );
};

export const getResultsForSession = (sessionId: string): any[] => {
  const r = db.execute(
    'SELECT * FROM results WHERE sessionId = ? ORDER BY date DESC',
    [sessionId],
  );
  return (r.rows?._array ?? []).map((row: any) => ({
    ...row,
    answers: JSON.parse(row.answers),
  }));
};

export const getAllResults = (): any[] => {
  const r = db.execute('SELECT * FROM results ORDER BY date DESC');
  return (r.rows?._array ?? []).map((row: any) => ({
    ...row,
    answers: JSON.parse(row.answers),
  }));
};

export const deleteResult = (id: number) => {
  db.execute('DELETE FROM results WHERE id = ?', [id]);
};
