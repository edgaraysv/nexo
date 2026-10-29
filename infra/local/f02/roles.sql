-- Cuenta pública de ensayo; no identidad ni autorización empresarial productiva.
CREATE ROLE f02_reader LOGIN PASSWORD 'public-f02-reader-fixture-only'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
