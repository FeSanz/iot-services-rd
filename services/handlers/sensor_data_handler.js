const pool = require('../../database/pool');
const { notifySensorData } = require('../websocket/websocket');

async function sensorDataHandler(data) {
    const { token, sensor_var, value, comment } = data;

    if (!token || !sensor_var || value === undefined || value === null) {
        return {
            success: false,
            status: 400,
            message: 'Faltan campos: token, sensor_var, value'
        };
    }

    const sensorResult = await pool.query(
        `SELECT s.sensor_id
         FROM mes_sensors s
         JOIN mes_machines m ON s.machine_id = m.machine_id
         WHERE m.token = $1 AND s.var = $2
         LIMIT 1`,
        [token, sensor_var]
    );

    if (sensorResult.rows.length === 0) {
        return {
            success: false,
            status: 404,
            message: 'Sensor no encontrado para ese token y variable'
        };
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

    notifySensorData(sensorId, { data: payload });

    return {
        success: true,
        status: 201,
        message: 'OK',
        data: payload
    };
}

async function sensorsDataHandler(data) {
    const { token, items } = data;

    if (!token || !items || !Array.isArray(items)) {
        return {
            success: false,
            status: 400,
            message: 'Faltan parámetros o estructura incorrecta'
        };
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const machineResult = await client.query(
            `SELECT machine_id FROM mes_machines WHERE token = $1 LIMIT 1`,
            [token]
        );

        if (machineResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return {
                success: false,
                status: 404,
                message: 'Token no válido: máquina no encontrada'
            };
        }

        const machine_id = machineResult.rows[0].machine_id;
        const results = [];

        for (const { sensor_var, value } of items) {
            let sensor_id;

            const sensorQuery = await client.query(`
                SELECT sensor_id FROM mes_sensors
                WHERE machine_id = $1 AND var = $2
                LIMIT 1`,
                [machine_id, sensor_var]
            );

            if (sensorQuery.rowCount === 0) {
                const insertSensorResult = await client.query(`
                    INSERT INTO mes_sensors (var, name, icon, created_by, machine_id)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING sensor_id`,
                    [sensor_var, sensor_var.toUpperCase(), 'help-outline', 'Auto', machine_id]
                );
                sensor_id = insertSensorResult.rows[0].sensor_id;
                results.push({ sensor_var, status: 'Sensor creado automáticamente' });
            } else {
                sensor_id = sensorQuery.rows[0].sensor_id;
            }

            const insertResult = await client.query(`
                INSERT INTO mes_sensor_data (sensor_id, value)
                VALUES ($1, $2)
                RETURNING value, date_time`,
                [sensor_id, value]
            );

            const payload = {
                sensorId: sensor_id,
                sensor_var,
                value: insertResult.rows[0].value,
                time: insertResult.rows[0].date_time
            };

            notifySensorData(sensor_id, { data: payload });

            results.push({ sensor_var, status: 'OK' });
        }

        await client.query('COMMIT');

        return {
            success: true,
            status: 200,
            message: 'OK',
            items: results
        };

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { sensorDataHandler, sensorsDataHandler };
