#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<'SQL'
CREATE ROLE f01_app LOGIN PASSWORD 'public-f01-app-only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE f01_typescript;
CREATE DATABASE f01_php;
CREATE DATABASE f01_go;
SQL
for db in f01_typescript f01_php f01_go; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" -f /docker-entrypoint-initdb.d/migrations/001.sql
done
