-- ============================================================================
-- Rol de solo lectura del bot IA (ETAPA 2, plan 2.4).
--
-- El bot se conecta con este rol, no con el de la aplicacion. Solo ve las 8
-- vistas de vistas_bot.sql: ni una tabla base, y desde luego no mes_users.
--
-- LA CONTRASEÑA NO VA EN ESTE ARCHIVO -- este archivo si se commitea. El rol
-- se crea sin contraseña, que en Postgres significa que no puede conectarse.
-- Quien despliega la pone aparte y la guarda en AI_DATABASE_URL:
--
--   psql -U condor -d condor_db -f assets/db/rol_readonly.sql
--   psql -U condor -d condor_db -c "ALTER ROLE condor_ai_ro PASSWORD '...'"
--
-- Aplicar despues de vistas_bot.sql: los GRANT necesitan que las vistas
-- existan.
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'condor_ai_ro') THEN
        CREATE ROLE condor_ai_ro LOGIN;
    END IF;
END
$$;

-- Cinturon y tirantes: aunque alguien le diera permiso de escritura por error,
-- la sesion entera abre en modo lectura.
ALTER ROLE condor_ai_ro SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE condor_db TO condor_ai_ro;
GRANT USAGE   ON SCHEMA public      TO condor_ai_ro;

-- SOLO las vistas del bot. Ninguna tabla base.
-- Las vistas corren con los permisos de su dueño (condor), asi que esto basta:
-- no hay que otorgar nada sobre mes_*.
GRANT SELECT ON v_wo_status,
                v_production_shift,
                v_production_machine,
                v_machine_stops,
                v_sensor_latest,
                v_shifts,
                v_sensor_readings,
                v_oee
             TO condor_ai_ro;

-- Que no herede nada nuevo por accidente: si mañana alguien crea una tabla,
-- este rol no la ve hasta que se le otorgue a mano.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM condor_ai_ro;
