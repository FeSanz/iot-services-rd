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

-- La base NO se nombra a mano: en local es condor_db y en produccion mes_kj12,
-- y un GRANT contra un nombre que no existe aborta el archivo entero.
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO condor_ai_ro', current_database());
END
$$;

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

-- En Postgres < 15, PUBLIC trae CREATE sobre el esquema public de fabrica: un
-- rol "de solo lectura" podria crear tablas. Se revoca de PUBLIC (revocarselo
-- solo al rol no sirve: lo heredaria igual). En 15+ es un no-op, y el dueño de
-- la base no lo pierde -- aqui los unicos roles son condor (dueño) y este.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Que no herede nada nuevo por accidente: si mañana alguien crea una tabla,
-- este rol no la ve hasta que se le otorgue a mano.
-- OJO: ALTER DEFAULT PRIVILEGES solo cubre lo que cree QUIEN CORRE ESTE
-- ARCHIVO; una tabla creada por otro rol no lo hereda -- aunque tampoco se
-- otorga sola, este REVOKE es cinturon, no muralla.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM condor_ai_ro;
