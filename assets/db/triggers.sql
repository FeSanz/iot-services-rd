--Crear funcion trigger para actualizar fecha-hora en cualquier cambio
CREATE OR REPLACE FUNCTION updated_date()
RETURNS TRIGGER AS
'
BEGIN
    NEW.updated_date = NOW();
    RETURN NEW;
END;
'
LANGUAGE plpgsql;

--Verificar que tabla existe
SELECT proname FROM pg_proc WHERE proname = 'updated_date';

--Asignar el trigger a la tabla (aplica a cualquier tabla con ese campo)
CREATE TRIGGER updated_date_settings
    BEFORE UPDATE ON mes_settings
    FOR EACH ROW
    EXECUTE FUNCTION updated_date();

--Verificar que el trigger se creó correctamente
SELECT trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_table = 'mes_settings';