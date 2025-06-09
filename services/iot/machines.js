const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//obtener las máquinas por usuario
router.get('/machines/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const resultado = await pool.query(
            'SELECT * FROM mes_machines WHERE user_id = $1',
            [userId]
        );
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows
        });
    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
    }
});
//obtener las máquinas y sus sensores por usuario
router.get('/machinesAndSensors/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const resultado = await pool.query(
            `SELECT
                m.machine_id,
            m.name AS machine_name,
            m.token AS token,
            m.code AS machine_code,
            m.organization_id,
            COALESCE(
                json_agg(
                    json_build_object(
                        'sensor_id', s.sensor_id,
                        'sensor_name', s.name,
                        'sensor_icon', s.icon,
                        'sensor_var', s.var,
                        'last_value', sd.value,
                        'last_date_time', sd.date_time
                    )
                ) FILTER(WHERE s.sensor_id IS NOT NULL), '[]':: json
            ) AS sensors
FROM 
    mes_machines m
LEFT JOIN 
    mes_sensors s ON s.machine_id = m.machine_id
LEFT JOIN LATERAL(
                SELECT sd.value, sd.date_time
    FROM mes_sensor_data sd
    WHERE sd.sensor_id = s.sensor_id
    ORDER BY sd.date_time DESC
    LIMIT 1
            ) sd ON TRUE
WHERE 
    m.user_id = $1
GROUP BY 
    m.machine_id, m.name, m.code, m.token, m.organization_id
ORDER BY 
    m.name;`
            ,
            [userId]
        );
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows
        });
    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
    }
});

//obtener una máquina
router.get('/machine/:machId', async (req, res) => {
    const { machId } = req.params;

    try {
        const resultado = await pool.query(
            'SELECT * FROM mes_machines WHERE machine_id = $1',
            [machId]
        );
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows[0] || []
        });
    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({ error: 'Error al consultar la base de datos' });
    }
});

//agregar nueva máquina
router.post('/machines', async (req, res) => {
    const { user_id, organization_id, code, name, token, work_center_id, work_center, machine_class } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO MES_MACHINES(user_id, organization_id, code, name, token, work_center_id, work_center, class
            ) VALUES($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING * `,
            [user_id, organization_id, code, name, token, work_center_id, work_center, machine_class]
        );

        res.status(201).json({
            existError: false,
            message: "OK",
            result: result.rows[0]
        });
    } catch (err) {
        console.error('Error al crear máquina', err);
        res.status(500).json({
            existError: true,
            message: "Error",
        });
    }
});

//actualizar máquina
router.put('/machines/:id', async (req, res) => {
    const machineId = req.params.id;
    const {
        user_id,
        organization_id,
        code,
        name,
        work_center_id,
        work_center,
        machine_class
    } = req.body;

    try {
        const result = await pool.query(
            `UPDATE MES_MACHINES
             SET user_id = $1,
            organization_id = $2,
            code = $3,
            name = $4,
            work_center_id = $5,
            work_center = $6,
            class = $7
             WHERE machine_id = $8
        RETURNING * `,
            [user_id, organization_id, code, name, work_center_id, work_center, machine_class, machineId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Máquina no encontrada' });
        }

        res.json({ message: 'Máquina actualizada correctamente', result: result.rows[0] });
    } catch (err) {
        console.error('Error al actualizar máquina:', err);
        res.status(500).json({ error: 'Error al actualizar máquina' });
    }
});

//Eliminar máquina
router.delete('/machines/:id', async (req, res) => {
    const sensorId = req.params.id;

    try {
        const result = await pool.query(
            'DELETE FROM MES_MACHINES WHERE machine_id = $1 RETURNING *',
            [sensorId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                existError: true,
                message: 'Máquina no encontrado'
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