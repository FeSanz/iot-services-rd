const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

const { notifyToUsers } = require('../websocket/websocket');
//obtener datos de sensores por dispositivo
router.get('/sensorData/:sensorID', async (req, res) => {
    const { sensorID } = req.params;
    const { start, end, limit } = req.query;

    try {
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
            SELECT s.name AS sensor_name, sd.value, sd.date_time FROM mes_sensor_data sd JOIN mes_sensors s ON sd.sensor_id = s.sensor_id 
            ${whereClause} ORDER BY sd.date_time DESC ${limitClause}`, values
        );

        const sensorName = resultado.rows[0]?.sensor_name || null;
        const data = resultado.rows.map(row => ({ value: row.value, time: row.date_time }));

        res.status(201).json({
            existError: false,
            message: "OK",
            sensor_name: sensorName,
            totalResults: resultado.rows.length,
            items: data
        });
    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
    }
});

router.get('/sensorsData', async (req, res) => {
    const { sensors, start, end, limit } = req.query;
    // Validar que vengan sensores
    if (!sensors) {
        return res.status(400).json({ error: 'Debe enviar el parámetro sensors con una lista de IDs' });
    }
    // Separar los IDs
    const sensorIDs = sensors.split(',').map(id => id.trim()).filter(id => id !== '');
    if (sensorIDs.length === 0) {
        return res.status(400).json({ error: 'Debe enviar al menos un sensorID válido' });
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
            existError: false,
            message: "OK",
            totalSensors: sensorsData.length,
            items: sensorsData
        });

    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
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
            return res.status(404).json({ error: 'Sensor no encontrado para ese token y variable' });
        }

        const sensorId = sensorResult.rows[0].sensor_id;

        const result = await pool.query(
            `INSERT INTO mes_sensor_data (sensor_id, value, comment, date_time)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             RETURNING *`,
            [sensorId, value, comment || '']
        );

        const payload = {
            sensorId,
            sensor_var,
            value: result.rows[0].value,
            time: result.rows[0].date_time
        };
        
        notifyToUsers(sensorId, {
            value: payload
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