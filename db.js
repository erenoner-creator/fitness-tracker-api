const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./workouts.db');

// Create users table with role (admin/user); ALTER for existing DBs
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user'  -- 'user' or 'admin'
  )`);

  // Add role column if table exists without it (SQLite compatible)
  db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`, (err) => {
    // Ignore error if column already exists (common SQLite pattern)
    if (err && !err.message.includes('duplicate column')) {
      console.error('Error adding role column:', err.message);
    }
  });

  // Create workouts table (unchanged)
  db.run(`CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    date TEXT,
    type TEXT,
    duration INTEGER,
    calories INTEGER,
    notes TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Create logs table for application metrics (all endpoints activity)
  // For admin /admin/metrics endpoint
  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT,
    endpoint TEXT,
    user_id INTEGER NULL,
    status_code INTEGER,
    ip TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Create exercises table for multi-exercise workouts (mixture support)
  // Linked to workouts; allows one workout session with multiple exercises
  db.run(`CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER,
    name TEXT NOT NULL,  -- e.g., 'Squats', 'Running'
    sets INTEGER,
    reps INTEGER,
    weight REAL,  -- kg/lbs
    duration INTEGER,  -- seconds/minutes
    calories INTEGER,
    notes TEXT,
    FOREIGN KEY(workout_id) REFERENCES workouts(id) ON DELETE CASCADE
  )`);

  // Create comments table for workout commentability (user-owned)
  // Each workout can have multiple comments; cascade on workout delete
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER,
    user_id INTEGER,
    text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(workout_id) REFERENCES workouts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

module.exports = db;