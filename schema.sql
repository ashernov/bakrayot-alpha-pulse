CREATE TABLE IF NOT EXISTS universal_memory (
    id            TEXT PRIMARY KEY,
    dedupe_key    TEXT UNIQUE,
    source        TEXT NOT NULL,
    source_id     TEXT,
    intent        TEXT NOT NULL,
    raw_input     TEXT NOT NULL,
    ai_response   TEXT,
    status        TEXT DEFAULT 'ok',
    error_message TEXT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_universal_memory_dedupe    ON universal_memory (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_universal_memory_timestamp ON universal_memory (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_universal_memory_intent    ON universal_memory (intent);
