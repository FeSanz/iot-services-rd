-- Reportes programados por correo (ETAPA 5, segunda parte).
--
-- La proxima ejecucion vive EN LA TABLA, no en memoria del proceso. Es la
-- diferencia entre un programador que sobrevive a un reinicio y uno que no:
-- Render reinicia el servicio cada dos por tres, y un cron en memoria pierde en
-- silencio lo que le tocaba disparar mientras estaba caido.
--
-- No hay lista de correos: los destinatarios salen de los usuarios de las
-- organizaciones del alcance. Un campo de texto con direcciones seria una via
-- comoda para sacar produccion de la empresa escribiendo un correo ajeno.

CREATE TABLE IF NOT EXISTS mes_ai_report_schedules (
    schedule_id       serial PRIMARY KEY,
    company_id        integer NOT NULL REFERENCES mes_companies(company_id),

    -- De quien es el alcance del reporte. NO es solo auditoria: en cada envio se
    -- vuelve a resolver contra la base, asi que si a este usuario lo deshabilitan
    -- o le quitan organizaciones, el reporte deja de salir. Un programado que
    -- sigue mandando datos con los permisos de alguien que ya no los tiene es
    -- una fuga que nadie mira, porque nadie mira los correos automaticos.
    created_by        integer NOT NULL REFERENCES mes_users(user_id),

    periodicidad      text NOT NULL CHECK (periodicidad IN ('diario', 'semanal', 'mensual')),
    hora_local        time NOT NULL DEFAULT '07:00',
    -- 1 = lunes ... 7 = domingo. Solo lo usa 'semanal'.
    dia_semana        integer CHECK (dia_semana BETWEEN 1 AND 7),

    enabled_flag      char(1) NOT NULL DEFAULT 'Y' CHECK (enabled_flag IN ('Y', 'N')),

    proxima_ejecucion timestamptz NOT NULL,
    ultima_ejecucion  timestamptz,
    -- Que paso la ultima vez, en texto. Sin esto, un programado que lleva un mes
    -- fallando se ve igual que uno que funciona.
    ultimo_resultado  text,

    created_date      timestamptz DEFAULT CURRENT_TIMESTAMP,
    updated_date      timestamptz DEFAULT CURRENT_TIMESTAMP
);

-- El programador pregunta "¿que toca ahora?" cada pocos minutos: que no recorra
-- la tabla entera para descubrir que no toca nada.
CREATE INDEX IF NOT EXISTS idx_ai_schedules_pendientes
    ON mes_ai_report_schedules (proxima_ejecucion)
 WHERE enabled_flag = 'Y';

-- Un programado por compañia y periodicidad. Sin esto, pulsar dos veces "crear"
-- manda el mismo PDF dos veces cada semana y nadie sabe cual borrar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_schedules_unico
    ON mes_ai_report_schedules (company_id, periodicidad);

-- El rol del bot NO la ve: no es un dato de la planta, y ahi dentro esta a quien
-- se le manda que cosa.
REVOKE ALL ON mes_ai_report_schedules FROM condor_ai_ro;
