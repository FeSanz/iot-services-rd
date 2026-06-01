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
    const { sensors, start, end, limit } = req.query;
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
            const resultado = await pool.query(`
                SELECT s.name AS sensor_name, sd.value, sd.date_time 
                FROM mes_sensor_data sd 
                JOIN mes_sensors s ON sd.sensor_id = s.sensor_id 
                ${whereClause} 
                ORDER BY sd.date_time DESC ${limitClause}`, values
            );
            sensorsData.push({
                sensor_id: sensorID,
                sensor_name: resultado.rows[0]?.sensor_name || null,
                data: resultado.rows.map(row => ({
                    value: row.value,
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

module.exports = router;