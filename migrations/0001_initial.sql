CREATE TABLE accounts (role TEXT PRIMARY KEY, key_hash TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL, device TEXT NOT NULL);
CREATE TABLE login_attempts (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, changed INTEGER NOT NULL);
CREATE INDEX record_changes ON records(changed, id);
CREATE INDEX record_kind ON records(kind);
CREATE TABLE history (id TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL, changed INTEGER NOT NULL, PRIMARY KEY(id, rev));
CREATE TRIGGER keep_history BEFORE UPDATE ON records
WHEN OLD.kind IN ('item', 'annotation', 'prefs')
BEGIN
  INSERT INTO history VALUES (OLD.id, OLD.rev, OLD.data, OLD.changed);
END;
CREATE TABLE deleted_blobs (key TEXT PRIMARY KEY);
CREATE TABLE uploads (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, started INTEGER NOT NULL);
CREATE TABLE library_index (item TEXT NOT NULL, page INTEGER NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(item,page));
CREATE VIRTUAL TABLE search_index USING fts5(item UNINDEXED, page UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE backups (id TEXT PRIMARY KEY, created INTEGER NOT NULL, size INTEGER NOT NULL);
