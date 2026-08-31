-- ============================================================================
-- Marcha atras COMPLETA del bot IA: deja la base como estaba antes de aplicar
-- vistas_bot.sql, rol_readonly.sql, ai_credentials.sql, ai_audit.sql,
-- ai_flag.sql y ai_report_schedules.sql.
--
--   psql -U condor -d condor_db -f assets/db/rollback_bot.sql
--
-- Lo que el bot agrega es TODO aditivo -- 8 vistas, 3 tablas, 1 rol y una fila
-- en mes_settings -- salvo UNA cosa, que es la unica que toca un permiso que ya
-- existia: el REVOKE CREATE ON SCHEMA public FROM PUBLIC de rol_readonly.sql.
-- Por eso este archivo NO es un simple DROP: hay que devolver ese permiso.
--
-- Por lo mismo, para dar marcha atras no hace falta restaurar un respaldo: no
-- se modifica ni se borra ni una fila del MES. El respaldo previo sigue siendo
-- obligatorio, pero como red, no como el plan.
--
-- DESTRUCTIVO en un solo sentido: se pierden la bitacora de preguntas
-- (mes_ai_audit), las llaves cifradas de los clientes (mes_ai_credentials) y
-- los reportes programados. Si se piensa volver a instalar, respaldar esas
-- tres tablas antes:
--   pg_dump -t mes_ai_audit -t mes_ai_credentials -t mes_ai_report_schedules
-- ============================================================================

BEGIN;

-- 1. La fila del interruptor. Es la unica escritura del bot en una tabla del
--    MES, y se borra por nombre: no se toca ningun otro setting.
DELETE FROM mes_settings WHERE name = 'AI_FLAG';

-- 2. Las tres tablas propias, con sus indices (caen con la tabla).
DROP TABLE IF EXISTS mes_ai_report_schedules;
DROP TABLE IF EXISTS mes_ai_audit;
DROP TABLE IF EXISTS mes_ai_credentials;

-- 3. Las 8 vistas. CASCADE no hace falta: nada del MES depende de ellas.
DROP VIEW IF EXISTS v_oee;
DROP VIEW IF EXISTS v_sensor_readings;
DROP VIEW IF EXISTS v_shifts;
DROP VIEW IF EXISTS v_sensor_latest;
DROP VIEW IF EXISTS v_machine_stops;
DROP VIEW IF EXISTS v_production_machine;
DROP VIEW IF EXISTS v_production_shift;
DROP VIEW IF EXISTS v_wo_status;

-- 4. El rol de solo lectura. Primero sus permisos, o Postgres se niega a
--    borrarlo mientras algo dependa de el. DROP OWNED limpia tambien las
--    default privileges que lo mencionan, por eso no se deshace nada a mano.
--    OJO: DROP OWNED exige superusuario o ser admin del rol -- la prueba en
--    contenedor corrio como postgres; en produccion, correrlo con ese poder.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'condor_ai_ro') THEN
        EXECUTE format('REVOKE ALL ON DATABASE %I FROM condor_ai_ro', current_database());
        REVOKE ALL ON SCHEMA public FROM condor_ai_ro;
        DROP OWNED BY condor_ai_ro;
        DROP ROLE condor_ai_ro;
    END IF;
END
$$;

-- 5. Lo unico que NO era aditivo: rol_readonly.sql le quito a PUBLIC el permiso
--    de crear objetos en el esquema public. En PostgreSQL 15+ ese permiso ya
--    viene quitado de fabrica, asi que devolverlo puede dejar la base MENOS
--    cerrada de lo que la deja una instalacion limpia.
--
--    Descomentar SOLO si la base es PostgreSQL 14 o anterior, o si se comprobo
--    que algo del MES creaba tablas con un usuario sin permisos propios:
--
-- GRANT CREATE ON SCHEMA public TO PUBLIC;

COMMIT;

-- Comprobacion despues de correrlo: las tres consultas deben dar cero filas.
--   SELECT viewname FROM pg_views  WHERE viewname LIKE 'v\_%';
--   SELECT tablename FROM pg_tables WHERE tablename LIKE 'mes\_ai\_%';
--   SELECT rolname FROM pg_roles   WHERE rolname = 'condor_ai_ro';
