-- init-databases-staging.sql
-- Runs on first postgres-ssd startup only (when data dir is empty).
-- Creates per-service staging databases and users.

-- Bot service (staging)
CREATE DATABASE getouch_bot_stg;
CREATE USER bot_user_stg WITH ENCRYPTED PASSWORD 'bot_stg_secret_change_me';
GRANT ALL PRIVILEGES ON DATABASE getouch_bot_stg TO bot_user_stg;

-- WhatsApp service (staging)
CREATE DATABASE getouch_wa_stg;
CREATE USER wa_user_stg WITH ENCRYPTED PASSWORD 'wa_stg_secret_change_me';
GRANT ALL PRIVILEGES ON DATABASE getouch_wa_stg TO wa_user_stg;

-- API service (staging)
CREATE DATABASE getouch_api_stg;
CREATE USER api_user_stg WITH ENCRYPTED PASSWORD 'api_stg_secret_change_me';
GRANT ALL PRIVILEGES ON DATABASE getouch_api_stg TO api_user_stg;

-- Grant schema access (Postgres 15+ requires explicit grants)
\connect getouch_bot_stg
GRANT ALL ON SCHEMA public TO bot_user_stg;

\connect getouch_wa_stg
GRANT ALL ON SCHEMA public TO wa_user_stg;

\connect getouch_api_stg
GRANT ALL ON SCHEMA public TO api_user_stg;
