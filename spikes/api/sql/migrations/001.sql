-- F01 sintético: DB nueva por candidato, sin acceso a datos reales.
CREATE EXTENSION pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE tenants (
  id text PRIMARY KEY,
  capacity integer NOT NULL CHECK (capacity > 0),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= capacity),
  fail_after_write boolean NOT NULL DEFAULT false
);
CREATE TABLE principals (
  token_hash bytea PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('technician','node','viewer')),
  expires_at timestamptz NOT NULL
);
CREATE TABLE endpoints (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_key text NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,endpoint_key)
);
CREATE TABLE operations (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','applied')),
  observed_at timestamptz,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,endpoint_id) REFERENCES endpoints(tenant_id,id)
);
CREATE TABLE outbox (
  tenant_id text NOT NULL,
  operation_id uuid NOT NULL,
  action text NOT NULL CHECK (action = 'endpoint.configure'),
  delivered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,operation_id),
  FOREIGN KEY (tenant_id,operation_id) REFERENCES operations(tenant_id,id)
);

INSERT INTO tenants(id,capacity,fail_after_write) VALUES
  ('alpha',2,false),('beta',2,false),('race',1,false),('replay',1,false),('failure',2,true);
INSERT INTO principals(token_hash,tenant_id,kind,expires_at)
SELECT digest(token,'sha256'),tenant,kind,now()+interval '1 day' FROM (VALUES
 ('fixture-tech-alpha','alpha','technician'),('fixture-tech-beta','beta','technician'),
 ('fixture-tech-race','race','technician'),('fixture-tech-replay','replay','technician'),
 ('fixture-tech-failure','failure','technician'),('fixture-node-alpha','alpha','node'),
 ('fixture-node-beta','beta','node'),('fixture-viewer-alpha','alpha','viewer')
) AS f(token,tenant,kind);
INSERT INTO principals VALUES (digest('fixture-expired','sha256'),'alpha','technician',now()-interval '1 hour');

CREATE FUNCTION api_call(method text, path text, auth_header text, idem text, body jsonb)
RETURNS TABLE(http_status integer,payload jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p principals; t tenants; e endpoints; op operations; ident text;
BEGIN
  IF method='GET' AND path='/health' THEN
    RETURN QUERY SELECT 200,jsonb_build_object('status','ok','scope','f01-lab'); RETURN;
  END IF;
  SELECT * INTO p FROM principals WHERE token_hash=digest(substring(auth_header from 8),'sha256')
    AND auth_header LIKE 'Bearer %' AND expires_at>now();
  IF NOT FOUND THEN RETURN QUERY SELECT 401,jsonb_build_object('error','unauthorized'); RETURN; END IF;

  IF method='POST' AND path='/v1/enrollments' THEN
    IF p.kind!='technician' THEN RETURN QUERY SELECT 403,jsonb_build_object('error','forbidden'); RETURN; END IF;
    IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN
      RETURN QUERY SELECT 422,jsonb_build_object('error','invalid_body'); RETURN;
    END IF;
    IF jsonb_typeof(body->'endpoint_key') IS DISTINCT FROM 'string'
      OR (body->>'endpoint_key') !~ '^[A-Za-z0-9_-]{16,120}$'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(body) k WHERE k!='endpoint_key') THEN
      RETURN QUERY SELECT 422,jsonb_build_object('error','invalid_body'); RETURN;
    END IF;
    IF idem !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN QUERY SELECT 400,jsonb_build_object('error','invalid_idempotency_key'); RETURN;
    END IF;
    -- Bloqueo por tenant; el replay se consulta DESPUÉS de adquirirlo.
    SELECT * INTO t FROM tenants WHERE id=p.tenant_id FOR UPDATE;
    SELECT * INTO op FROM operations WHERE tenant_id=p.tenant_id AND idempotency_key=idem::uuid;
    IF FOUND THEN
      SELECT * INTO e FROM endpoints WHERE tenant_id=p.tenant_id AND id=op.endpoint_id;
      IF e.endpoint_key!=body->>'endpoint_key' THEN
        RETURN QUERY SELECT 409,jsonb_build_object('error','idempotency_conflict'); RETURN;
      END IF;
    ELSE
      IF t.used>=t.capacity THEN RETURN QUERY SELECT 409,jsonb_build_object('error','quota_exceeded'); RETURN; END IF;
      IF EXISTS (SELECT 1 FROM endpoints WHERE tenant_id=p.tenant_id AND endpoint_key=body->>'endpoint_key') THEN
        RETURN QUERY SELECT 409,jsonb_build_object('error','endpoint_exists'); RETURN;
      END IF;
      INSERT INTO endpoints(tenant_id,endpoint_key) VALUES(p.tenant_id,body->>'endpoint_key') RETURNING * INTO e;
      INSERT INTO operations(tenant_id,endpoint_id,idempotency_key) VALUES(p.tenant_id,e.id,idem::uuid) RETURNING * INTO op;
      INSERT INTO outbox(tenant_id,operation_id,action) VALUES(p.tenant_id,op.id,'endpoint.configure');
      UPDATE tenants SET used=used+1 WHERE id=p.tenant_id;
      IF t.fail_after_write THEN RAISE EXCEPTION 'synthetic failure'; END IF;
    END IF;
    RETURN QUERY SELECT 202,jsonb_build_object('endpoint_id',e.id,'operation_id',op.id,'status',op.status,'revision',op.revision,'observed_at',op.observed_at); RETURN;
  END IF;

  IF path ~ '^/v1/operations/[0-9a-fA-F-]{36}(/ack)?$' THEN
    ident=split_part(path,'/',4);
    IF ident !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN QUERY SELECT 404,jsonb_build_object('error','not_found'); RETURN;
    END IF;
    IF method='GET' AND path NOT LIKE '%/ack' THEN
      SELECT * INTO op FROM operations WHERE tenant_id=p.tenant_id AND id=ident::uuid;
      IF NOT FOUND THEN RETURN QUERY SELECT 404,jsonb_build_object('error','not_found'); RETURN; END IF;
      RETURN QUERY SELECT 200,jsonb_build_object('operation_id',op.id,'status',op.status,'revision',op.revision,'observed_at',op.observed_at); RETURN;
    END IF;
    IF method='POST' AND path LIKE '%/ack' THEN
      IF p.kind!='node' THEN RETURN QUERY SELECT 403,jsonb_build_object('error','forbidden'); RETURN; END IF;
      IF body IS DISTINCT FROM '{"revision":1,"status":"applied"}'::jsonb THEN
        RETURN QUERY SELECT 409,jsonb_build_object('error','invalid_ack'); RETURN;
      END IF;
      SELECT * INTO op FROM operations WHERE tenant_id=p.tenant_id AND id=ident::uuid FOR UPDATE;
      IF NOT FOUND THEN RETURN QUERY SELECT 404,jsonb_build_object('error','not_found'); RETURN; END IF;
      UPDATE operations SET status='applied' WHERE tenant_id=p.tenant_id AND id=op.id;
      UPDATE outbox SET delivered=true WHERE tenant_id=p.tenant_id AND operation_id=op.id;
      RETURN QUERY SELECT 200,jsonb_build_object('operation_id',op.id,'status','applied','revision',op.revision,'observed_at',NULL); RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 404,jsonb_build_object('error','not_found'); RETURN;
EXCEPTION WHEN OTHERS THEN
  -- El subbloque transaccional revierte también endpoint, cupo y outbox.
  RETURN QUERY SELECT 500,jsonb_build_object('error','internal_error');
END;
$$;
REVOKE ALL ON FUNCTION api_call(text,text,text,text,jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO f01_app;
GRANT EXECUTE ON FUNCTION api_call(text,text,text,text,jsonb) TO f01_app;
