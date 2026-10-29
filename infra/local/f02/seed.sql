-- Datos sintéticos independientes de las fixtures F01 y del modelo productivo.
CREATE SCHEMA f02_fixture;
CREATE TABLE f02_fixture.organizations (
  id text PRIMARY KEY,
  label text NOT NULL
);
CREATE TABLE f02_fixture.endpoints (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL REFERENCES f02_fixture.organizations(id),
  label text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  UNIQUE (organization_id, label)
);
INSERT INTO f02_fixture.organizations VALUES
  ('fixture-alpha', 'Empresa ficticia Alfa'), ('fixture-beta', 'Empresa ficticia Beta');
INSERT INTO f02_fixture.endpoints (organization_id, label, revision) VALUES
  ('fixture-alpha', 'fixture-server-alpha', 1), ('fixture-beta', 'fixture-server-beta', 1);
GRANT USAGE ON SCHEMA f02_fixture TO f02_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA f02_fixture TO f02_reader;
