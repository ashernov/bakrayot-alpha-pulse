CREATE TABLE IF NOT EXISTS universal_memory (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    intent TEXT NOT NULL,
    raw_input TEXT NOT NULL,
    ai_response TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
