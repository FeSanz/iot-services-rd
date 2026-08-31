-- ============================================================================
-- Bitacora de conversaciones del bot (ETAPA 3).
--
-- Un renglon por turno. Sirve para dos cosas concretas: saber quien pregunto
-- que cuando alguien reclame una cifra, y ver que herramientas se usan de
-- verdad antes de escribir mas.
--
-- NO guarda la llave del LLM ni nada de la credencial. Ni el prompt de sistema.
--
-- Aplicar:  psql -U condor -d condor_db -f assets/db/ai_audit.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS mes_ai_audit (
    audit_id          BIGSERIAL PRIMARY KEY,
    user_id           INTEGER,
    company_id        INTEGER,
    question          TEXT,
    answer            TEXT,
    tools             JSONB,        -- [{nombre, argumentos, error}]
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    elapsed_ms        INTEGER,
    created_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_company_fecha
    ON mes_ai_audit (company_id, created_date DESC);

-- "¿Quien pregunto que?" filtra por usuario -- la razon de ser de la tabla.
CREATE INDEX IF NOT EXISTS idx_ai_audit_user_fecha
    ON mes_ai_audit (user_id, created_date DESC);

-- user_id/company_id SIN llave foranea, a proposito: la bitacora tiene que
-- sobrevivir a que borren al usuario, y una FK convertiria "borrar un usuario"
-- en "no se puede, tiene bitacora". Los valores vienen del alcance resuelto
-- contra la base, no de la peticion.

COMMENT ON TABLE mes_ai_audit IS 'Un renglon por turno de conversacion del bot. Sin credenciales.';

-- El bot no se lee a si mismo.
REVOKE ALL ON mes_ai_audit FROM condor_ai_ro;
