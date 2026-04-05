import { open } from 'react-native-quick-sqlite';

const db = open({ name: 'omr_offline.db' });

export const initDatabase = () => {
  db.execute('CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, content TEXT)');
  db.execute('CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, content TEXT)');
  db.execute('CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, answers TEXT, score REAL, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
};

export const saveTemplate = (id: string, content: any) => {
  db.execute('INSERT OR REPLACE INTO templates (id, content) VALUES (?, ?)', [id, JSON.stringify(content)]);
};

export const saveResult = (studentId: string, answers: any, score: number) => {
  db.execute('INSERT INTO results (student_id, answers, score) VALUES (?, ?, ?)', [studentId, JSON.stringify(answers), score]);
};

export const getAllResults = () => {
  const result = db.execute('SELECT * FROM results ORDER BY date DESC');
  return result.rows?._array || [];
};

export const deleteResult = (id: number) => {
  db.execute('DELETE FROM results WHERE id = ?', [id]);
};
