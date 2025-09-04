const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

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
    const { sensors, start, end, limit } = req.query;

    if (!sensors) {
        return res.status(400).json({
            errorsExistFlag: false,
            message: 'Debe enviar el parámetro sensors con una lista de IDs'
        });
    }

    const sensorIDs = sensors.split(',').map(id => id.trim()).filter(id => id !== '');
    if (sensorIDs.length === 0) {
        return res.status(400).json({
            errorsExistFlag: false,
            message: 'Debe enviar al menos un sensorID válido'
        });
    }

    try {
        const sensorsData = [];

        for (const sensorID of sensorIDs) {
            const values = [sensorID, start, end];
            let limitClause = '';

            if (limit) {
                values.push(limit);
                limitClause = `LIMIT $4`;
            }

            const resultado = await pool.query(`
                WITH date_series AS (
                    SELECT generate_series($2::timestamp, $3::timestamp, '1 day')::date AS day
                )
                SELECT 
                    ds.day,
                    s.sensor_id,
                    s.name AS sensor_name,
                    EXTRACT(HOUR FROM sd.date_time) AS hour,
                    AVG(sd.value) AS avg_value
                FROM date_series ds
                CROSS JOIN mes_sensors s
                LEFT JOIN mes_sensor_data sd
                    ON sd.sensor_id = s.sensor_id
                    AND sd.date_time::date = ds.day
                WHERE s.sensor_id = $1
                GROUP BY ds.day, s.sensor_id, s.name, hour
                ORDER BY ds.day DESC, hour ASC
                ${limitClause};
            `, values);

            // Transformar resultados en el formato esperado
            const groupedData = resultado.rows.map(row => {
                const dayStr = new Date(row.day).toISOString().split('T')[0]; // YYYY-MM-DD
                const hour = row.hour !== null ? row.hour : 0;

                return {
                    value: row.avg_value !== null ? parseFloat(row.avg_value) : 0,
                    time: `${dayStr}T${String(hour).padStart(2, '0')}:00:00Z`
                };
            });

            sensorsData.push({
                sensor_id: sensorID,
                sensor_name: resultado.rows[0]?.sensor_name || null,
                data: groupedData
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

//Insertar datos de sensores por arreglo
router.post('/sensorsData', async (req, res) => {
    const { token, items } = req.body;

    if (!token || !items || !Array.isArray(items)) {
        return res.status(400).json({
            errorsExistFlag: false,
            message: 'Faltan parámetros o estructura incorrecta'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const results = [];

        // Obtener la máquina por token
        const machineResult = await client.query(
            `SELECT machine_id FROM mes_machines WHERE token = $1 LIMIT 1`,
            [token]
        );

        if (machineResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                errorsExistFlag: false,
                message: 'Token no válido: máquina no encontrada'
            });
        }

        const machine_id = machineResult.rows[0].machine_id;

        for (const { sensor_var, value } of items) {
            let sensor_id;

            // 1. Buscar el sensor por var y machine_id
            const sensorQuery = await client.query(`
                SELECT sensor_id FROM mes_sensors
                WHERE machine_id = $1 AND var = $2
                LIMIT 1
            `, [machine_id, sensor_var]);

            if (sensorQuery.rowCount === 0) {
                // 2. Sensor no existe, lo creamos
                const insertSensorResult = await client.query(`
                    INSERT INTO mes_sensors (var, name, icon, created_by, machine_id)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING sensor_id
                `, [
                    sensor_var,
                    sensor_var.toUpperCase(),
                    'help-outline',
                    'Auto',
                    machine_id
                ]);
                sensor_id = insertSensorResult.rows[0].sensor_id;
                results.push({ sensor_var, status: 'Sensor creado automáticamente' });
            } else {
                sensor_id = sensorQuery.rows[0].sensor_id;
            }

            // 3. Insertar el dato del sensor
            const insertResult = await client.query(`
                INSERT INTO mes_sensor_data (sensor_id, value)
                VALUES ($1, $2)
                RETURNING value, date_time
            `, [sensor_id, value]);

            const payload = {
                sensorId: sensor_id,
                sensor_var,
                value: insertResult.rows[0].value,
                time: insertResult.rows[0].date_time
            };

            // 4. Notificar a los usuarios suscritos a este sensor
            notifySensorData(sensor_id, { data: payload });

            results.push({ sensor_var, status: 'OK' });
        }

        await client.query('COMMIT');

        res.status(200).json({
            errorsExistFlag: false,
            message: 'OK',
            items: results
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al guardar datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al guardar en base de datos'
        });
    } finally {
        client.release();
    }
});

//agregar nuevo dato de sensor
router.post('/sensorData', async (req, res) => {
    const { token, sensor_var, value, comment } = req.body;
    try {
        // 1️⃣ Obtener sensor_id a partir de token + sensor_var
        const sensorResult = await pool.query(
            `SELECT s.sensor_id
             FROM mes_sensors s
             JOIN mes_machines m ON s.machine_id = m.machine_id
             WHERE m.token = $1 AND s.var = $2
             LIMIT 1`,
            [token, sensor_var]
        );

        if (sensorResult.rows.length === 0) {
            return res.status(404).json({
                message: 'Sensor no encontrado para ese token y variable'
            });
        }

        const sensorId = sensorResult.rows[0].sensor_id;

        const result = await pool.query(
            `INSERT INTO mes_sensor_data (sensor_id, value, comment)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [sensorId, value, comment || '']
        );

        const payload = {
            sensorId,
            sensor_var,
            value: result.rows[0].value,
            time: result.rows[0].date_time
        };

        notifySensorData(sensorId, {
            data: payload
        });

        res.status(201).json({
            errorsExistFlag: false
        });

    } catch (error) {
        console.error('Error al insertar dato de sensor:', error);
        res.status(500).json({ error: 'Error al insertar dato de sensor' });
    }
});

module.exports = router;