-- init-databases.sql
-- Runs on first Postgres startup only (when data dir is empty).
-- Creates per-service databases and users.

-- Bot service
CREATE DATABASE getouch_bot;
CREATE USER bot_user WITH ENCRYPTED PASSWORD 'bot_secret_change_me';
GRANT ALL PRIVILEGES ON DATABASE getouch_bot TO bot_user;

-- WhatsApp service
CREATE DATABASE getouch_wa;
CREATE USER wa_user WITH ENCRYPTED PASSWORD 'wa_secret_change_me';
GRANT ALL PRIVILEGES ON DATABASE getouch_wa TO wa_user;

-- API service
CREATE DATABASE getouch_api;
CREATE USER api_user WITH ENCRYPTED PASSWORD 'api_secret_change_me';
GRANT ALL PRIVILEGES ON DATABASE getouch_api TO api_user;

-- Grant schema access (Postgres 15+ requires explicit grants)
\connect getouch_bot
GRANT ALL ON SCHEMA public TO bot_user;

\connect getouch_wa
GRANT ALL ON SCHEMA public TO wa_user;

\connect getouch_api
GRANT ALL ON SCHEMA public TO api_user;
