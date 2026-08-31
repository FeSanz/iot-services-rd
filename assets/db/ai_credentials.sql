-- ============================================================================
-- Boveda de llaves del LLM, una por compañia (ETAPA 3.5, plan 7.4).
--
-- Decision del cliente (2026-08-21): la llave del LLM la pone CADA CLIENTE,
-- no Condor. Por eso hace falta esta tabla en vez de una variable de entorno.
--
-- Tabla propia a proposito: mes_settings tiene un endpoint que la devuelve
-- completa en texto plano (plan 7.4), y ahi ya termino expuesta la credencial
-- de Fusion. Ese patron no se repite aqui.
--
-- La llave se guarda cifrada con AES-256-GCM. La llave MAESTRA vive solo en
-- AI_CRED_MASTER_KEY, variable de entorno del servidor -- nunca en esta base.
-- Esa separacion es lo que protege; si las dos mitades vivieran juntas el
-- cifrado seria decorativo.
--
-- Aplicar:  psql -U condor -d condor_db -f assets/db/ai_credentials.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS mes_ai_credentials (
    credential_id   SERIAL PRIMARY KEY,
    company_id      INTEGER  NOT NULL REFERENCES mes_companies(company_id),
    provider        TEXT     NOT NULL,   -- 'groq' | 'openai' | 'ollama'
    model           TEXT,                -- modelo por defecto de esa compañia
    base_url        TEXT,                -- para ollama o un endpoint propio
    ciphertext      BYTEA    NOT NULL,   -- la llave cifrada, jamas texto plano
    iv              BYTEA    NOT NULL,   -- unico por escritura (GCM se rompe si se reusa)
    auth_tag        BYTEA    NOT NULL,   -- etiqueta GCM: detecta manipulacion
    key_version     SMALLINT NOT NULL DEFAULT 1,
    last4           CHAR(4)  NOT NULL,   -- lo unico que se le muestra a la UI
    -- created_by/updated_by sin FK a proposito: son informativos, y la llave de
    -- la compañia no puede depender de que su creador siga existiendo.
    created_by      INTEGER,
    created_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INTEGER,
    updated_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, provider)
);

COMMENT ON TABLE  mes_ai_credentials    IS 'Llaves del LLM por compañia, cifradas con AES-256-GCM. La llave maestra vive en AI_CRED_MASTER_KEY.';
COMMENT ON COLUMN mes_ai_credentials.iv IS 'Vector de inicializacion, distinto en cada escritura. Reusarlo rompe GCM por completo.';

-- El rol del bot NO ve esta tabla. El agente jamas la consulta: la lee el
-- codigo de infraestructura, nunca una tool. Explicito para que no dependa de
-- que nadie se acuerde de no otorgarlo.
REVOKE ALL ON mes_ai_credentials FROM condor_ai_ro;
