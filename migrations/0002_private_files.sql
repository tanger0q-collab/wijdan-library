CREATE TABLE objects (key TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, tag TEXT NOT NULL);
CREATE TABLE object_parts (object_key TEXT NOT NULL, chunk INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(object_key,chunk));
CREATE TABLE multipart_jobs (id TEXT PRIMARY KEY, object_key TEXT NOT NULL, type TEXT NOT NULL, started INTEGER NOT NULL);
CREATE TABLE multipart_sizes (job TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(job,part));
