CREATE ROLE finbridge_migrate LOGIN PASSWORD 'finbridge_local_migrate';
CREATE ROLE finbridge_app LOGIN PASSWORD 'finbridge_local_app';
CREATE ROLE finbridge_worker LOGIN PASSWORD 'finbridge_local_worker';
ALTER DATABASE finbridge OWNER TO finbridge_migrate;
REVOKE ALL ON DATABASE finbridge FROM PUBLIC;
GRANT CONNECT ON DATABASE finbridge TO finbridge_migrate, finbridge_app, finbridge_worker;

\connect finbridge

ALTER SCHEMA public OWNER TO finbridge_migrate;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO finbridge_app, finbridge_worker;
