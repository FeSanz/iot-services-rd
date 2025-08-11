const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');

//obtener los sensores por usuarios
router.get('/sensors/:machineId', authenticateToken, async (req, res) => {
    const { machineId } = req.params;

    try {
        const result = await pool.query(
            'SELECT * FROM mes_sensors WHERE machine_id = $1',
            [machineId]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener sensores:', error);
        res.status(500).json({ error: 'Error al consultar sensores' });
    }
});


//agregar nuevo dispositivo
router.post('/sensors/:machine_id', authenticateToken, async (req, res) => {
    const { machine_id } = req.params;
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No se recibieron sensores para insertar.' });
    }
    try {
        const insertedSensors = [];
        for (const item of items) {
            const { sensor_name, sensor_var, sensor_icon, created_by, updated_by } = item;

            const result = await pool.query(
                `INSERT INTO mes_sensors (
                    name, var, icon, machine_id, created_date, created_by, updated_date, updated_by
                ) VALUES (
                    $1, $2, $3, $4, CURRENT_TIMESTAMP, $5, CURRENT_TIMESTAMP, $6
                ) RETURNING *`,
                [sensor_name, sensor_var, sensor_icon, machine_id, created_by, updated_by]
            );

            insertedSensors.push(result.rows[0]);
        }

        res.status(201).json({
            existError: false,
            message: 'Sensores creados',
            insertedCount: insertedSensors.length,
            items: insertedSensors
        });

    } catch (error) {
        console.error('Error al crear sensores:', error);
        res.status(500).json({ error: 'Error al crear sensores' });
    }
});


//actualizar sensor
router.put('/sensors/:id', authenticateToken, async (req, res) => {
    const sensorId = req.params.id;
    const { name, var: variable, icon, machine_id, updated_by } = req.body;
    try {
        const result = await pool.query(`UPDATE mes_sensors SET name = $1, var = $2, icon = $3, machine_id = $4, updated_date = CURRENT_TIMESTAMP, updated_by = $5 WHERE sensor_id = $6 RETURNING *`,
            [name, variable, icon, machine_id, updated_by, sensorId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                existError: true,
                message: 'Sensor no encontrado',
            });
        }
        res.status(201).json({
            existError: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al actualizar sensor:', error);
        res.status(500).json({ error: 'Error al actualizar sensor' });
    }
});
//Eliminar Sensor
router.delete('/sensors/:id', authenticateToken, async (req, res) => {
    const sensorId = req.params.id;

    try {
        const result = await pool.query(
            'DELETE FROM mes_sensors WHERE sensor_id = $1 RETURNING *',
            [sensorId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                existError: true,
                message: 'Sensor no encontrado'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al eliminar sensor:', error);
        res.status(500).json({ error: 'Error al eliminar sensor' });
    }
});
module.exports = router;