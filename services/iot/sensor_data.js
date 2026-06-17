const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const { sensorDataHandler, sensorsDataHandler } = require('../handlers/sensor_data_handler');

const { notifySensorData } = require('../websocket/websocket');

//obtener datos de sensores por dispositivo
router.get('/sensorData/:sensorID', async (req, res) => {
    const { sensorID } = req.params;

    try {
        const query = `
            SELECT s.name AS sensor_name, sd.value, sd.date_time
            FROM mes_sensor_data sd
            JOIN mes_sensors s ON sd.sensor_id = s.sensor_id
            WHERE sd.sensor_id = $1 AND sd.date_time IS NOT NULL
            ORDER BY sd.date_time DESC LIMIT 1
        `;

        const result = await pool.query(query, [sensorID]);

        const sensorName = result.rows[0]?.sensor_name || null;
        const data = result.rows.map(row => ({
            value: row.value,
            time: row.date_time
        }));

        res.status(200).json({
            existError: false,
            message: "OK",
            items: {
                sensor_name: sensorName,
                data: data
            },
            totalResults: result.rows.length
        });

    } catch (error) {
        console.error('Error al obtener datos del sensor:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
    }
});

router.get('/sensorsLatest', async (req, res) => {
    const idsParam = req.query.sensorIDs;

    if (!idsParam) {
        return res.status(400).json({
            existError: true,
            message: 'Debes proporcionar sensorIDs como query string. Ej: /sensorData?sensorIDs=1,2,3',
        });
    }

    const sensorIDs = idsParam.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));

    if (sensorIDs.length === 0) {
        return res.status(400).json({
            existError: true,
            message: 'sensorIDs inválidos. Asegúrate de usar números separados por comas.',
        });
    }

    try {
        const query = `
      SELECT DISTINCT ON (sd.sensor_id)
        sd.sensor_id,
        s.name AS sensor_name,
        sd.value,
        sd.date_time
      FROM mes_sensor_data sd
      JOIN mes_sensors s ON sd.sensor_id = s.sensor_id
      WHERE sd.sensor_id = ANY($1::int[])
        AND sd.date_time IS NOT NULL
      ORDER BY sd.sensor_id, sd.date_time DESC
    `;

        const result = await pool.query(query, [sensorIDs]);

        const items = result.rows.map(row => ({
            sensor_id: row.sensor_id,
            sensor_name: row.sensor_name,
            value: row.value,
            date_time: row.date_time
        }));

        res.status(200).json({
            existError: false,
            message: 'OK',
            items,
            totalResults: items.length
        });

    } catch (error) {
        console.error('Error al obtener datos de sensores:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
    }
});
router.get('/sensorsData', async (req, res) => {
    // 1. Recibir los nuevos parámetros opcionales: period y aggregation
    const { sensors, start, end, limit, period, aggregation } = req.query;

    // Validar que vengan sensores
    if (!sensors) {
        return res.status(400).json({
            errorsExistFlag: false, message: 'Debe enviar el parámetro sensors con una lista de IDs'
        });
    }

    // Separar los IDs
    const sensorIDs = sensors.split(',').map(id => id.trim()).filter(id => id !== '');
    if (sensorIDs.length === 0) {
        return res.status(400).json({
            errorsExistFlag: false, message: 'Debe enviar al menos un sensorID válido'
        });
    }

    // --- NUEVA VALIDACIÓN DE AGREGACIÓN POR PERIODOS ---
    // Si viene 'period' pero NO viene 'aggregation', ignoramos el agrupamiento y devolvemos todo (según tu requerimiento).
    // Pero si viene 'period' y SÍ viene 'aggregation', validamos que la operación sea correcta.
    const usarAgregacion = period && aggregation;
    const agregacionesValidas = ['avg', 'max', 'min', 'median', 'sum', 'count'];

    if (usarAgregacion && !agregacionesValidas.includes(aggregation.toLowerCase())) {
        return res.status(400).json({
            errorsExistFlag: false,
            message: `La agregación '${aggregation}' no es válida. Use una de estas: ${agregacionesValidas.join(', ')}`
        });
    }

    // Lapsos válidos admitidos por Postgres en date_trunc (ej: 'minute', 'hour', 'day', 'week', 'month')
    // Nota: Si desde el UI envías algo como "1 hour", Postgres lo maneja mejor con intervalos, pero para 'date_trunc' pasamos el string limpio.

    try {
        const sensorsData = [];
        for (const sensorID of sensorIDs) {
            const values = [sensorID];
            let whereClause = 'WHERE sd.sensor_id = $1';
            let paramIndex = 2;

            if (start) {
                values.push(start);
                whereClause += ` AND sd.date_time >= $${paramIndex++}`;
            }
            if (end) {
                values.push(end);
                whereClause += ` AND sd.date_time <= $${paramIndex++}`;
            }

            let limitClause = '';
            if (limit) {
                values.push(limit);
                limitClause = `LIMIT $${paramIndex++}`;
            }

            let query = '';

            // 2. CONSTRUCCIÓN DE LA QUERY SEGÚN LOS PARÁMETROS
            if (usarAgregacion) {
                const aggLower = aggregation.toLowerCase();
                let sqlAggregation = '';
                let sqlIdColumn = '';

                // 1. CONDICIÓN DE ID: Solo se mantiene para MAX y MIN, para los demás es null
                if (aggLower === 'max' || aggLower === 'min') {
                    // Buscamos el ID del registro específico que tiene el valor máximo o mínimo
                    sqlIdColumn = `(SELECT sd_sub.sensor_data_id FROM mes_sensor_data sd_sub WHERE sd_sub.sensor_id = sd.sensor_id AND sd_sub.value = ${aggLower === 'max' ? 'MAX(sd.value)' : 'MIN(sd.value)'} LIMIT 1) AS sensor_data_id`;
                } else {
                    sqlIdColumn = 'NULL AS sensor_data_id';
                }

                // Mapeo de operaciones estadísticas
                if (aggLower === 'avg') sqlAggregation = 'AVG(sd.value)::numeric(10,2) AS value';
                else if (aggLower === 'max') sqlAggregation = 'MAX(sd.value) AS value';
                else if (aggLower === 'min') sqlAggregation = 'MIN(sd.value) AS value';
                else if (aggLower === 'sum') sqlAggregation = 'SUM(sd.value) AS value';
                else if (aggLower === 'count') sqlAggregation = 'COUNT(sd.value) AS value';
                else if (aggLower === 'median') {
                    sqlAggregation = 'percentile_cont(0.5) WITHIN GROUP (ORDER BY sd.value) AS value';
                }

                // 2. EXPRESIÓN DE TIEMPO E INTERVALOS (Cálculo de Inicio y Fin del Lapso)
                let timeExpressionStart = '';
                let intervalSeconds = 0;
                let intervalStr = '';

                switch (period) {
                    case 'minute':
                        timeExpressionStart = "date_trunc('minute', sd.date_time)";
                        intervalStr = "1 minute";
                        break;
                    case '5_minutes':
                        timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 300) * 300)";
                        intervalStr = "5 minutes";
                        break;
                    case '15_minutes':
                        timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 900) * 900)";
                        intervalStr = "15 minutes";
                        break;
                    case '30_minutes':
                        timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 1800) * 1800)";
                        intervalStr = "30 minutes";
                        break;
                    case 'hour':
                        timeExpressionStart = "date_trunc('hour', sd.date_time)";
                        intervalStr = "1 hour";
                        break;
                    case '5_hours':
                        timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 18000) * 18000)";
                        intervalStr = "5 hours";
                        break;
                    case 'day':
                        timeExpressionStart = "date_trunc('day', sd.date_time)";
                        intervalStr = "1 day";
                        break;
                    default:
                        timeExpressionStart = "date_trunc('minute', sd.date_time)";
                        intervalStr = "1 minute";
                }

                // La fecha de fin es la fecha de inicio + el intervalo seleccionado
                let timeExpressionEnd = `(${timeExpressionStart} + interval '${intervalStr}')`;

                query = `
                    SELECT 
                        ${sqlIdColumn}, 
                        s.name AS sensor_name, 
                        ${sqlAggregation}, 
                        ${timeExpressionStart} AS date_time,
                        ${timeExpressionEnd} AS date_time_end,
                        'Lapso de: ' || ${timeExpressionStart}::text || ' a ' || ${timeExpressionEnd}::text AS comment
                    FROM mes_sensor_data sd 
                    JOIN mes_sensors s ON sd.sensor_id = s.sensor_id 
                    ${whereClause} 
                    GROUP BY s.name, sd.sensor_id, ${timeExpressionStart}
                    ORDER BY date_time DESC 
                    ${limitClause}`;
            } else {
                // Query original intacta (Cuando NO se agrupa)
                query = `
                    SELECT sd.sensor_data_id, s.name AS sensor_name, sd.value, sd.date_time, sd.comment
                    FROM mes_sensor_data sd 
                    JOIN mes_sensors s ON sd.sensor_id = s.sensor_id 
                    ${whereClause} 
                    ORDER BY sd.date_time DESC 
                    ${limitClause}`;
            }

            const resultado = await pool.query(query, values);

            // Mantenemos EXACTAMENTE tu misma estructura de devolución de datos
            sensorsData.push({
                sensor_id: sensorID,
                sensor_name: resultado.rows[0]?.sensor_name || null,
                data: resultado.rows.map(row => ({
                    id: row.sensor_data_id,
                    value: row.value,
                    comment: row.comment,
                    date_time_end: row.date_time_end,
                    time: row.date_time
                }))
            });
        }

        res.status(200).json({
            errorsExistFlag: false,
            message: "OK",
            totalSensors: sensorsData.length,
            items: sensorsData
        });

    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({
            errorsExistFlag: false,
            message: 'Error al consultar la base de datos'
        });
    }
});

router.get('/sensorsDataHM', async (req, res) => {
    const { sensors, start, end, limit, aggregation } = req.query;

    if (!sensors) {
        return res.status(400).json({ errorsExistFlag: false, message: 'Debe enviar sensors' });
    }

    // Lista blanca con las 6 funciones solicitadas
    const allowedAggregations = {
        'avg': 'AVG(sd.value)',
        'max': 'MAX(sd.value)',
        'min': 'MIN(sd.value)',
        'median': 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sd.value)',
        'sum': 'SUM(sd.value)',
        'count': 'COUNT(sd.value)'
    };

    const aggFunction = allowedAggregations[aggregation?.toLowerCase()] || allowedAggregations['avg'];

    const sensorIDs = sensors.split(',').map(id => id.trim()).filter(id => id !== '');

    try {
        const sensorsData = [];
        for (const sensorID of sensorIDs) {
            const values = [sensorID, start, end];
            const limitClause = limit ? `LIMIT $4` : '';
            if (limit) values.push(limit);

            const query = `
                SELECT
                    (sd.date_time AT TIME ZONE 'UTC')::date AS day,
                    s.sensor_id,
                    s.name AS sensor_name,
                    EXTRACT(HOUR FROM sd.date_time AT TIME ZONE 'UTC') AS hour,
                    ${aggFunction} AS calculated_value
                FROM mes_sensors s
                INNER JOIN mes_sensor_data sd ON sd.sensor_id = s.sensor_id
                WHERE s.sensor_id = $1
                    AND sd.date_time >= $2::timestamptz
                    AND sd.date_time < $3::timestamptz
                GROUP BY 1, 2, 3, 4
                ORDER BY day DESC, hour ASC
                ${limitClause};
            `;

            const resultado = await pool.query(query, values);

            sensorsData.push({
                sensor_id: sensorID,
                sensor_name: resultado.rows[0]?.sensor_name || null,
                data: resultado.rows.map(row => ({
                    value: row.calculated_value !== null ? parseFloat(row.calculated_value) : 0,
                    time: `${new Date(row.day).toISOString().split('T')[0]}T${String(row.hour || 0).padStart(2, '0')}:00:00Z`
                }))
            });
        }
        res.status(200).json({ errorsExistFlag: false, message: "OK", items: sensorsData });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ errorsExistFlag: false, message: 'Error en la base de datos' });
    }
});

// ===============================================
// POST /sensorsData  Refactorizado
// ===============================================
router.post('/sensorsData', async (req, res) => {
    try {
        const result = await sensorsDataHandler(req.body);

        res.status(result.status).json({
            errorsExistFlag: !result.success,
            message: result.message,
            items: result.items || null
        });

    } catch (error) {
        console.error('Error al guardar datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al guardar en base de datos'
        });
    }
});

// ===============================================
// POST /sensorData  Refactorizado
// ===============================================
router.post('/sensorData', async (req, res) => {
    try {
        const result = await sensorDataHandler(req.body);

        if (!result.success) {
            return res.status(result.status).json({
                errorsExistFlag: true,
                message: result.message
            });
        }

        res.status(result.status).json({
            errorsExistFlag: false
        });

    } catch (error) {
        console.error('Error al insertar dato de sensor:', error);
        res.status(500).json({ error: 'Error al insertar dato de sensor' });
    }
});
router.delete('/sensorData/:id', async (req, res) => {
    const { id } = req.params;

    // Validar que el ID sea proporcionado y sea un número válido
    if (!id || isNaN(id)) {
        return res.status(400).json({
            errorsExistFlag: true, // Cambiado a true porque representa un error de validación de cliente
            message: 'Debe proporcionar un ID de dato de sensor válido en la URL'
        });
    }

    try {
        // Ejecutar la consulta de eliminación
        const resultado = await pool.query(
            'DELETE FROM mes_sensor_data WHERE sensor_data_id = $1 RETURNING *',
            [id]
        );

        // Si rows.length es 0, significa que el registro no existía en la base de datos
        if (resultado.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: `No se encontró ningún registro con el ID ${id}`
            });
        }

        // Respuesta exitosa respetando tu formato habitual
        res.status(200).json({
            errorsExistFlag: false,
            message: `Registro con ID ${id} eliminado correctamente`,
            deletedItem: {
                id: resultado.rows[0].sensor_data_id,
                sensor_id: resultado.rows[0].sensor_id,
                value: resultado.rows[0].value,
                time: resultado.rows[0].date_time
            }
        });

    } catch (error) {
        console.error('Error al eliminar el dato del sensor:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al procesar la eliminación en la base de datos'
        });
    }
});
module.exports = router;