-- Cambiar a UTC de forma permanente
ALTER SYSTEM SET timezone = 'UTC';
ALTER SYSTEM SET timezone = 'America/Mexico_City';


-- Recargar la configuración
SELECT pg_reload_conf();

SHOW config_file;
SHOW timezone;
SELECT NOW();