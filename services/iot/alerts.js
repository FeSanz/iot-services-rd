const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const { notifyNewAlert } = require('../websocket/websocket');

router.get('/alerts/:companyId', authenticateToken, async (req, res) => {
    const { companyId } = req.params;

    try {
        const resultado = await pool.query(`
      SELECT 
        a.alert_id,
        a.machine_id,
        a.failure_id,
        a.status,
        a.start_date,
        a.end_date,
        a.response_time,
        a.repair_time
      FROM mes_alerts a
      JOIN mes_machines m ON a.machine_id = m.machine_id
      JOIN mes_organizations o ON m.organization_id = o.organization_id
      WHERE o.company_id = $1
      ORDER BY a.start_date DESC;
    `, [companyId]);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows
        });
    } catch (error) {
        console.error('Error al obtener alertas:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al consultar alertas de la base de datos'
        });
    }
});

//Obtener alertas por organizaciones
router.get('/alertsByOrganizations', authenticateToken, async (req, res) => {
    const { organizations } = req.query;

    if (!organizations) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Parámetro "organizations" requerido en la query (ej. ?organizations=1,2,3)'
        });
    }

    const orgIds = organizations
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

    if (orgIds.length === 0) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'IDs de organización inválidos en el parámetro "organizations"'
        });
    }

    try {
        const query = `
            SELECT  
                a.alert_id,
                m.name AS machine_name,
                m.organization_id,
                f.area,
                f.type,
                f.name,
                a.status,
                a.start_date,
                a.response_time,
                a.repair_time
            FROM 
                mes_alerts a
            JOIN 
                mes_machines m ON a.machine_id = m.machine_id
            JOIN 
                mes_failures f ON a.failure_id = f.failure_id
            WHERE 
                m.organization_id = ANY($1)
            ORDER BY 
                CASE a.status
                    WHEN 'attend' THEN 1
                    WHEN 'in_progress' THEN 2
                    WHEN 'finaliced' THEN 3
                    ELSE 4
                END,
                a.start_date ASC;
            `;

        const resultado = await pool.query(query, [orgIds]);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: resultado.rows.length,
            items: resultado.rows
        });
    } catch (error) {
        console.error('Error al obtener alertas por organizaciones:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al consultar alertas por organizaciones en la base de datos'
        });
    }
});


//New Alert
router.post('/alerts', authenticateToken, async (req, res) => {
    const { machine_id, failure_id } = req.body;

    try {
        // 1. Insertar alerta
        const insertResult = await pool.query(
            `
      INSERT INTO mes_alerts (
        machine_id, failure_id, status
      ) VALUES ($1, $2, 'attend')
      RETURNING *;
      `,
            [machine_id, failure_id]
        );

        const insertedAlert = insertResult.rows[0];

        // 2. Obtener datos completos para el payload
        const dataResult = await pool.query(
            `
      SELECT 
        a.alert_id,
        f.area,
        m.name AS machine_name,
        f.name,
        m.organization_id,
        a.repair_time,
        a.response_time,
        a.start_date,
        a.status,
        f.type
      FROM mes_alerts a
      JOIN mes_machines m ON a.machine_id = m.machine_id
      JOIN mes_failures f ON a.failure_id = f.failure_id
      WHERE a.alert_id = $1
      `,
            [insertedAlert.alert_id]
        );

        const payload = dataResult.rows[0];

        // 3. Notificar vía WebSocket
        notifyNewAlert(payload.organization_id, payload);

        // 4. Responder al cliente
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: 1,
            items: [payload]
        });

    } catch (error) {
        console.error('Error al crear alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar la alerta en la base de datos'
        });
    }
});


//Attend Alert
router.put('/alerts/:alertId/attend', authenticateToken, async (req, res) => {
    const { alertId } = req.params;

    try {
        const result = await pool.query(
            `
      UPDATE mes_alerts
      SET status = 'in_progress', response_time = now()
      WHERE alert_id = $1
      RETURNING *;
      `,
            [alertId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Alerta no encontrada'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Estado de alerta actualizado correctamente',
            totalResults: 1,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al actualizar estado de alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar el estado de la alerta'
        });
    }
});
//Repair Alert
router.put('/alerts/:alertId/repair', authenticateToken, async (req, res) => {
    const { alertId } = req.params;

    try {
        const result = await pool.query(
            `
      UPDATE mes_alerts
      SET status = 'finaliced', repair_time = now(), end_date = now()
      WHERE alert_id = $1
      RETURNING *;
      `,
            [alertId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Alerta no encontrada'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Estado de alerta actualizado correctamente',
            totalResults: 1,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al actualizar estado de alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar el estado de la alerta'
        });
    }
});


//Delete Alert
router.delete('/alerts/:alertId', authenticateToken, async (req, res) => {
    const { alertId } = req.params;

    try {
        const result = await pool.query(
            `
      DELETE FROM mes_alerts
      WHERE alert_id = $1
      RETURNING *;
      `,
            [alertId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Alerta no encontrada'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Alerta eliminada correctamente',
            totalResults: 1,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al eliminar alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al eliminar la alerta de la base de datos'
        });
    }
});



module.exports = router;