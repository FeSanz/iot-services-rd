const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');

//obtener las máquinas por usuario
router.get('/machines/:userId', authenticateToken, async (req, res) => {
    const { userId } = req.params;

    try {
        const resultado = await pool.query(
            'SELECT m.* FROM mes_user_machines um JOIN mes_machines m ON m.machine_id = um.machine_id WHERE um.user_id = $1;',
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
        res.status(500).json({ errorsExistFlag: true, message: 'Error al consultar la base de datos' });
    }
});
//Obtener máquinas por organizaciones
router.get('/machinesByOrganizations', authenticateToken, async (req, res) => {
    const { organizations } = req.query;

    if (!organizations) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Debe enviar el parámetro "organizations" con IDs separados por coma'
        });
    }

    // Convertir a array de números
    const organizationIds = String(organizations)
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

    if (organizationIds.length === 0) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'No se proporcionaron IDs válidos'
        });
    }

    try {
        const result = await pool.query(
            `
            SELECT
                m.machine_id,
                m.name AS machine_name,
                m.code AS machine_code,
                m.organization_id
            FROM 
                mes_machines m
            JOIN 
                mes_organizations o ON o.organization_id = m.organization_id
            WHERE 
                o.organization_id = ANY($1)
                AND (m.token IS NULL OR m.token = '')
            ORDER BY 
                m.machine_id;
            `,
            [organizationIds]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener máquinas:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al consultar la base de datos'
        });
    }
});

//obtener las máquinas y sus sensores por usuario
router.get('/machinesAndSensors/:userId', authenticateToken, async (req, res) => {
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
        ) FILTER (WHERE s.sensor_id IS NOT NULL),
        '[]'::json
    ) AS sensors
FROM 
    mes_users_machines um
JOIN 
    mes_machines m ON m.machine_id = um.machine_id
LEFT JOIN 
    mes_sensors s ON s.machine_id = m.machine_id
LEFT JOIN LATERAL (
    SELECT sd.value, sd.date_time
    FROM mes_sensor_data sd
    WHERE sd.sensor_id = s.sensor_id
    ORDER BY sd.date_time DESC
    LIMIT 1
) sd ON TRUE
WHERE 
    um.user_id = $1
GROUP BY 
    m.machine_id, m.name, m.code, m.token, m.organization_id
ORDER BY 
    m.name;
`,
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
        res.status(500).json({ errorsExistFlag: true, message: 'Error al consultar la base de datos' });
    }
});
router.get('/machinesAndSensorsByCompany/:companyId', authenticateToken, async (req, res) => {
    const { companyId } = req.params;

    try {
        const resultado = await pool.query(
            `
      SELECT
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
              ) FILTER (WHERE s.sensor_id IS NOT NULL),
              '[]'::json
          ) AS sensors
      FROM 
          mes_machines m
      JOIN 
          mes_organizations o ON o.organization_id = m.organization_id
      LEFT JOIN 
          mes_sensors s ON s.machine_id = m.machine_id
      LEFT JOIN LATERAL (
          SELECT sd.value, sd.date_time
          FROM mes_sensor_data sd
          WHERE sd.sensor_id = s.sensor_id
          ORDER BY sd.date_time DESC
          LIMIT 1
      ) sd ON TRUE
      WHERE 
          o.company_id = $1 AND m.token IS NOT NULL AND m.token <> ''
      GROUP BY 
          m.machine_id, m.name, m.code, m.token, m.organization_id
      ORDER BY 
          m.machine_id;
      `,
            [companyId]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows
        });
    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({ errorsExistFlag: true, message: 'Error al consultar la base de datos' });
    }
});
router.get('/machinesAndSensorsByOrganizations', authenticateToken, async (req, res) => {
    const { organizations } = req.query;

    if (!organizations) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Debe enviar el parámetro "organizations" con IDs separados por coma'
        });
    }

    // Convertir a array de números
    const organizationIds = String(organizations)
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

    if (organizationIds.length === 0) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'No se proporcionaron IDs válidos'
        });
    }

    try {
        const resultado = await pool.query(
            `
            SELECT
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
                    ) FILTER (WHERE s.sensor_id IS NOT NULL),
                    '[]'::json
                ) AS sensors
            FROM 
                mes_machines m
            JOIN 
                mes_organizations o ON o.organization_id = m.organization_id
            LEFT JOIN 
                mes_sensors s ON s.machine_id = m.machine_id
            LEFT JOIN LATERAL (
                SELECT sd.value, sd.date_time
                FROM mes_sensor_data sd
                WHERE sd.sensor_id = s.sensor_id
                ORDER BY sd.date_time DESC
                LIMIT 1
            ) sd ON TRUE
            WHERE 
                o.organization_id = ANY($1)
                AND m.token IS NOT NULL AND m.token <> ''
            GROUP BY 
                m.machine_id, m.name, m.code, m.token, m.organization_id
            ORDER BY 
                m.machine_id;
            `,
            [organizationIds]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows
        });
    } catch (error) {
        console.error('Error al obtener datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al consultar la base de datos'
        });
    }
});
//obtener una máquina
router.get('/machine/:machId', authenticateToken, async (req, res) => {
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
        res.status(500).json({ errorsExistFlag: true, message: 'Error al consultar la base de datos' });
    }
});
//agregar nueva máquina
router.post('/machines', authenticateToken, async (req, res) => {
    const { organization_id, code, name, token, machine_class } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO MES_MACHINES(organization_id, code, name, token, class
            ) VALUES($1, $2, $3, $4, $5)
        RETURNING * `,
            [organization_id, code, name, token, machine_class]
        );
        res.status(201).json({
            errorsExistFlag: false,
            message: "OK",
            result: result.rows[0]
        });
    } catch (err) {
        console.error('Error al crear máquina', err);
        res.status(500).json({
            errorsExistFlag: true,
            message: "Error",
        });
    }
});
//actualizar máquina
router.put('/machines/:id', authenticateToken, async (req, res) => {
    const machineId = req.params.id;
    const { machine_name, sensors } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Actualizar solo el nombre de la máquina
        const updateMachine = await client.query(
            `UPDATE mes_machines
             SET name = $1
             WHERE machine_id = $2
             RETURNING *`,
            [machine_name, machineId]
        );

        if (updateMachine.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ errorsExistFlag: true, message: 'Máquina no encontrada' });
        }

        // 2. Procesar sensores
        for (const sensor of sensors) {
            const { sensor_id, sensor_name, sensor_icon, sensor_var } = sensor;

            if (sensor_id) {
                // Si tiene ID, actualizar
                await client.query(
                    `UPDATE mes_sensors
                     SET name = $1, icon = $2, var = $3
                     WHERE sensor_id = $4 AND machine_id = $5`,
                    [sensor_name, sensor_icon, sensor_var, sensor_id, machineId]
                );
            } else {
                // Si no tiene ID, insertar uno nuevo
                await client.query(
                    `INSERT INTO mes_sensors (machine_id, name, icon, var)
                     VALUES ($1, $2, $3, $4)`,
                    [machineId, sensor_name, sensor_icon, sensor_var]
                );
            }
        }

        await client.query('COMMIT');
        res.json({
            errorsExistFlag: false,
            message: 'OK'
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar máquina y sensores:', err);
        res.status(500).json({ errorsExistFlag: true, message: 'Error al actualizar máquina y sensores' });
    } finally {
        client.release();
    }
});
//Eliminar máquina
router.delete('/machines/:id', authenticateToken, async (req, res) => {
    const machineId = req.params.id; // Cambié el nombre de la variable
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. Primero eliminar datos de sensores
        await client.query(`
            DELETE FROM mes_sensor_data 
            WHERE sensor_id IN (
                SELECT sensor_id FROM mes_sensors WHERE machine_id = $1
            )
        `, [machineId]);
        
        // 2. Luego eliminar los sensores
        await client.query(`
            DELETE FROM mes_sensors WHERE machine_id = $1
        `, [machineId]);
        
        // 3. Finalmente eliminar la máquina
        const result = await client.query(
            'DELETE FROM mes_machines WHERE machine_id = $1 RETURNING *',
            [machineId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Máquina no encontrada'
            });
        }

        await client.query('COMMIT');
        
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al eliminar máquina:', error);
        res.status(500).json({ 
            errorsExistFlag: true, 
            message: 'Error al eliminar máquina' 
        });
    } finally {
        client.release();
    }
});
module.exports = router;