-- 0000_init_extensions.sql
-- gen_random_uuid() is built into PostgreSQL 13+ core (no pgcrypto needed).
--
-- pgvector is part of the mandated stack (relational + vector in one DB). We enable
-- it defensively: on a pgvector-enabled image (docker-compose / Neon / staging) it
-- installs; on a vanilla Postgres it is skipped with a NOTICE so the core S0-2
-- migrations still run. S0-2 tables do not yet use vector columns — embeddings arrive
-- with entity resolution in Sprint 1 (S1-5).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  RAISE NOTICE 'pgvector extension enabled';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available (%). Skipping; use the pgvector image for embeddings.', SQLERRM;
END
$$;
