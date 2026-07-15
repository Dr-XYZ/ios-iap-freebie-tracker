-- apps Table: Stores metadata of tracked iOS apps
CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,          -- App Store ID (e.g. "123456789")
    name TEXT NOT NULL,
    developer TEXT,
    icon_url TEXT,
    category TEXT,
    store_url TEXT,
    last_updated INTEGER          -- Epoch timestamp (seconds)
);

-- iap_items Table: Stores IAP items for each app with their price status
CREATE TABLE IF NOT EXISTS iap_items (
    id TEXT PRIMARY KEY,          -- Format: app_id:name (unique identifier since product_id is not public on web)
    app_id TEXT NOT NULL,
    name TEXT NOT NULL,
    current_price REAL,           -- Current price (e.g. 0.00 for free)
    original_price REAL,          -- Historical normal price (highest price observed)
    currency TEXT,                -- E.g. "TWD", "USD"
    is_free INTEGER DEFAULT 0,    -- Boolean flag (1 = free, 0 = paid)
    last_updated INTEGER,         -- Epoch timestamp (seconds)
    FOREIGN KEY(app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- price_history Table: Logs price changes for analytics
CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iap_id TEXT NOT NULL,
    price REAL NOT NULL,
    recorded_at INTEGER NOT NULL, -- Epoch timestamp (seconds)
    FOREIGN KEY(iap_id) REFERENCES iap_items(id) ON DELETE CASCADE
);
