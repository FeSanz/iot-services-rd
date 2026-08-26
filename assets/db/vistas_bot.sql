-- ============================================================================
-- Contrato de datos del bot IA (ETAPA 2).
--
-- El bot NO consulta las tablas: consulta estas vistas. Asi el esquema puede
-- cambiar por debajo sin reescribir tools, y el rol de solo lectura recibe
-- permiso sobre objetos concretos y nada mas (ver rol_readonly.sql).
--
-- REGLA QUE NO SE ROMPE: toda vista expone organization_id. Es la columna
-- sobre la que la capa de alcance (services/ai/scope.js) aplica el filtro.
-- Cinco tablas fuente no la tienen -- mes_kpis, mes_alerts, mes_sensors,
-- mes_sensor_data y mes_work_execution -- asi que el org llega por un join
-- que es INNER a proposito: una fila huerfana no puede quedar con org NULL.
--
-- Aplicar:  psql -U condor -d condor_db -f assets/db/vistas_bot.sql
-- ============================================================================


-- ---------------------------------------------------------------------------
-- v_wo_status -- ordenes de trabajo con item, maquina y centro de trabajo.
-- El org es nativo de mes_work_orders.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_wo_status AS
SELECT w.organization_id,
       o.code                  AS organization_code,
       o.name                  AS organization_name,
       w.work_order_id,
       w.work_order_number,
       w.status,
       w.type,
       w.planned_quantity      AS planned_start_quantity,
       w.dispatched_quantity,
       w.completed_quantity,
       w.scrap_quantity,
       w.reject_quantity,
       w.start_date,
       w.end_date,
       w.lot_number,
       w.item_id,
       i.number                AS item_number,
       i.description           AS item_description,
       i.uom,
       w.machine_id,
       m.code                  AS machine_code,
       m.name                  AS machine_name,
       wc.work_center_id,
       wc.work_center_code,
       wc.work_center_name
  FROM mes_work_orders w
  JOIN mes_organizations o      ON o.organization_id = w.organization_id
  LEFT JOIN mes_items i         ON i.item_id         = w.item_id
  LEFT JOIN mes_machines m      ON m.machine_id      = w.machine_id
  LEFT JOIN mes_work_centers wc ON wc.work_center_id = m.work_center_id;


-- ---------------------------------------------------------------------------
-- v_production_shift -- produccion registrada, atribuida a un turno.
--
-- mes_work_execution NO tiene columna de turno (el plan suponia que si). El
-- turno se calcula: hora local de execution_date contra mes_shifts de la misma
-- organizacion. Eso resuelve la pregunta 6 del cliente: no hay dos fuentes de
-- verdad, solo hay el calculo.
--
-- ZONA HORARIA: las 12 organizaciones estan en Mexico (CDMX / Toluca) y la
-- base corre en UTC. mes_shifts guarda hora de pared local, asi que hay que
-- convertir o TURNO 3 se come casi todo. Es LA perilla de calibracion de esta
-- vista.
-- ponytail: zona horaria fija, columna por organizacion si abren planta fuera.
--
-- El join a mes_shifts es LEFT: solo las organizaciones 2 y 4 tienen turnos
-- configurados, y perder la produccion de las demas seria peor que un NULL.
-- El join que acarrea el org (mes_work_orders) si es INNER.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_production_shift AS
SELECT w.organization_id,
       e.work_execution_id,
       e.work_order_id,
       w.work_order_number,
       w.machine_id,
       e.execution_date,
       -- Texto, no DATE: el driver de pg convierte DATE a un objeto Date en
       -- UTC y el modelo termina viendo "2026-06-18T06:00:00Z", que invita a
       -- equivocarse de dia. Aqui la fecha local es una cadena y punto.
       to_char(t.local_ts, 'YYYY-MM-DD') AS local_date,   -- fecha de calendario
                                                -- local, NO anclada al inicio del turno
       s.shift_id,
       s.name                  AS shift_name,
       s.start_time            AS shift_start,
       s.end_time              AS shift_end,
       e.ready                 AS cajas,
       e.scrap,
       e.reject                AS rechazo,
       e.tare,
       e.container,
       e.number,
       e.status
  FROM mes_work_execution e
  JOIN mes_work_orders w ON w.work_order_id = e.work_order_id
  CROSS JOIN LATERAL (
       SELECT e.execution_date AT TIME ZONE 'America/Mexico_City' AS local_ts
  ) t
  LEFT JOIN mes_shifts s
         ON s.organization_id = w.organization_id
        AND s.enabled_flag    = 'Y'
        AND CASE
              WHEN s.start_time < s.end_time
                THEN t.local_ts::time >= s.start_time AND t.local_ts::time < s.end_time
              ELSE  -- el turno cruza la medianoche (22:00-06:00, 18:00-06:00)
                    t.local_ts::time >= s.start_time OR  t.local_ts::time < s.end_time
            END;


-- ---------------------------------------------------------------------------
-- v_production_machine -- la misma produccion, atribuida a la maquina.
-- El org viene de mes_work_orders (INNER). mes_machines solo aporta nombres.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_production_machine AS
SELECT w.organization_id,
       e.work_execution_id,
       e.work_order_id,
       w.work_order_number,
       w.machine_id,
       m.code                  AS machine_code,
       m.name                  AS machine_name,
       m.class                 AS machine_class,
       m.status                AS machine_status,
       wc.work_center_code,
       wc.work_center_name,
       e.execution_date,
       e.ready                 AS cajas,
       e.scrap,
       e.reject                AS rechazo,
       e.tare,
       e.container,
       e.status
  FROM mes_work_execution e
  JOIN mes_work_orders w        ON w.work_order_id   = e.work_order_id
  LEFT JOIN mes_machines m      ON m.machine_id      = w.machine_id
  LEFT JOIN mes_work_centers wc ON wc.work_center_id = m.work_center_id;


-- ---------------------------------------------------------------------------
-- v_machine_stops -- paros: alertas con su falla y su maquina.
--
-- mes_alerts no tiene org: llega por mes_machines (INNER). Eso deja fuera 1 de
-- las 546 alertas, la que apunta a una maquina que ya no existe -- correcto,
-- no hay forma de saber de quien es. mes_failures va en LEFT: 4 alertas no
-- tienen falla asignada y siguen siendo paros.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_machine_stops AS
SELECT m.organization_id,
       a.alert_id,
       a.machine_id,
       m.code                  AS machine_code,
       m.name                  AS machine_name,
       wc.work_center_code,
       wc.work_center_name,
       a.status,
       a.start_date,
       a.end_date,
       a.response_time,
       a.repair_time,
       a.run_time,
       ROUND(EXTRACT(EPOCH FROM (a.end_date - a.start_date)) / 60.0, 2) AS duracion_min,
       a.failure_id,
       f.name                  AS failure_name,
       f.type                  AS failure_type,
       f.area                  AS failure_area
  FROM mes_alerts a
  JOIN mes_machines m           ON m.machine_id      = a.machine_id
  LEFT JOIN mes_failures f      ON f.failure_id      = a.failure_id
  LEFT JOIN mes_work_centers wc ON wc.work_center_id = m.work_center_id;


-- ---------------------------------------------------------------------------
-- v_sensor_latest -- ultima lectura de cada sensor.
--
-- El org viaja sensor -> maquina (INNER).
--
-- El LEFT JOIN LATERAL no es adorno: con DISTINCT ON sobre el join plano el
-- planificador recorre las 2.1 M filas y tarda 3.4 s. Asi son 163 busquedas
-- de una fila contra idx_sensor_data_sensor_datetime (sensor_id, date_time
-- DESC), que ya existia. Medido, no supuesto.
--
-- El LEFT mantiene visibles los sensores que nunca han reportado: que un
-- sensor este mudo es justo lo que hay que poder preguntar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sensor_latest AS
SELECT m.organization_id,
       s.sensor_id,
       s.name                  AS sensor_name,
       s.var,
       s.formula,
       s.machine_id,
       m.code                  AS machine_code,
       m.name                  AS machine_name,
       d.value,
       d.date_time             AS last_reading_at,
       d.comment
  FROM mes_sensors s
  JOIN mes_machines m ON m.machine_id = s.machine_id
  LEFT JOIN LATERAL (
       SELECT sd.value, sd.date_time, sd.comment
         FROM mes_sensor_data sd
        WHERE sd.sensor_id = s.sensor_id
        ORDER BY sd.date_time DESC
        LIMIT 1
  ) d ON true;


-- ---------------------------------------------------------------------------
-- v_shifts -- los turnos configurados, con su organizacion.
--
-- mes_shifts YA trae organization_id, asi que la vista casi no hace nada. Existe
-- porque el rol del bot solo tiene permiso sobre vistas: la tool que contesta
-- "que turno esta corriendo" necesitaba leer la tabla y la base se lo negaba,
-- que es justo lo que tiene que pasar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_shifts AS
SELECT s.organization_id,
       o.code                  AS organization_code,
       o.name                  AS organization_name,
       s.shift_id,
       s.name                  AS shift_name,
       s.start_time,
       s.end_time,
       s.duration              AS horas,
       s.enabled_flag
  FROM mes_shifts s
  JOIN mes_organizations o ON o.organization_id = s.organization_id;


-- ---------------------------------------------------------------------------
-- v_sensor_readings -- el historico completo de lecturas, con su organizacion.
--
-- v_sensor_latest solo trae la ultima; para graficar una tendencia hace falta
-- la serie. Son 2.1 M filas, asi que la vista NO agrega nada: filtra y ya. El
-- submuestreo lo hace la tool, que es quien sabe cuantos puntos caben.
--
-- El org viaja sensor -> maquina (INNER), igual que en v_sensor_latest.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sensor_readings AS
SELECT m.organization_id,
       d.sensor_data_id,
       d.sensor_id,
       s.name                  AS sensor_name,
       s.var,
       s.machine_id,
       m.code                  AS machine_code,
       m.name                  AS machine_name,
       d.value,
       d.date_time,
       d.comment
  FROM mes_sensor_data d
  JOIN mes_sensors s  ON s.sensor_id  = d.sensor_id
  JOIN mes_machines m ON m.machine_id = s.machine_id;


-- ---------------------------------------------------------------------------
-- v_oee -- OEE ya calculado por el MES.
--
-- OJO: mes_kpis esta VACIA en produccion (0 filas al 2026-08-21). La vista es
-- correcta y devuelve 0 filas; sirve el dia que alguien empiece a poblar la
-- tabla. No se inventa el OEE a partir de otras tablas: falta el tiempo
-- planeado de produccion y el ciclo ideal, sin eso el numero seria mentira.
--
-- k.peroformance es un typo REAL del esquema. Se corrige con alias aqui,
-- nunca renombrando la columna base (rompe al MES).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_oee AS
SELECT m.organization_id,
       k.kpi_id,
       k.machine_id,
       m.code                  AS machine_code,
       m.name                  AS machine_name,
       k.work_order_id,
       k.kpi_date,
       k.availability,
       k.peroformance          AS performance,
       k.quality,
       k.me,
       k.mtta,
       k.mtbf,
       k.mttr
  FROM mes_kpis k
  JOIN mes_machines m ON m.machine_id = k.machine_id;


-- ---------------------------------------------------------------------------
COMMENT ON VIEW v_wo_status          IS 'Ordenes de trabajo con item, maquina y centro de trabajo.';
COMMENT ON VIEW v_production_shift   IS 'Produccion registrada por turno; el turno se calcula por hora local contra mes_shifts.';
COMMENT ON VIEW v_production_machine IS 'Produccion registrada por maquina.';
COMMENT ON VIEW v_machine_stops      IS 'Paros de maquina: alertas con su falla, duracion en minutos.';
COMMENT ON VIEW v_sensor_latest      IS 'Ultima lectura de cada sensor, con su maquina.';
COMMENT ON VIEW v_shifts             IS 'Turnos configurados por organizacion.';
COMMENT ON VIEW v_sensor_readings    IS 'Historico completo de lecturas. Sin agregar: el submuestreo lo hace la tool.';
COMMENT ON VIEW v_oee                IS 'OEE del MES (mes_kpis). VACIA en produccion al 2026-08-21.';
