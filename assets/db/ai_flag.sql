-- Interruptor del asistente IA, por compañia (ETAPA 4).
--
-- No hay migracion de esquema: es una fila mas en mes_settings, con la misma
-- forma que ALERTS_FLAG / PUSH_FLAG / EMAIL_FLAG. Llega al frontend en el login
-- dentro de userData.Company.Settings, asi que la burbuja no necesita endpoint.
--
-- OJO: los settings solo se refrescan al iniciar sesion. Encender el bot para
-- una compañia le pide a sus usuarios volver a entrar.
--
--   psql -f backend/assets/db/ai_flag.sql -v company=1

-- La secuencia de mes_settings viene ATRASADA en produccion (setval en 13 con
-- max(setting_id) = 16, medido el 2026-08-27 contra el volcado real): alguna
-- carga metio filas con id explicito sin avanzarla. Cualquier INSERT sin id
-- -- el nuestro, y tambien el de la pantalla de ajustes del propio MES --
-- revienta con "duplicate key". Se alinea antes de insertar; es idempotente y
-- de paso deja arreglado ese hueco. Reportado aparte al equipo MES.
SELECT setval(
    pg_get_serial_sequence('mes_settings', 'setting_id'),
    GREATEST((SELECT COALESCE(max(setting_id), 1) FROM mes_settings), 1)
);

INSERT INTO mes_settings (company_id, name, value, description, type, status, enabled_flag, created_by, updated_by)
SELECT :company, 'AI_FLAG', 'false', 'Asistente IA disponible para la compañia', 'AI', 'Verificado', 'Y', 'bot-ia', 'bot-ia'
WHERE NOT EXISTS (
    SELECT 1 FROM mes_settings WHERE company_id = :company AND name = 'AI_FLAG'
);

-- Encender:  UPDATE mes_settings SET value = 'true'  WHERE name = 'AI_FLAG' AND company_id = <id>;
-- Apagar:    UPDATE mes_settings SET value = 'false' WHERE name = 'AI_FLAG' AND company_id = <id>;
