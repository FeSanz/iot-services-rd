const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const { notifyAlert } = require('../websocket/websocket');
const { sendNotification } = require('./notifications');
const {selectByParamsFromDB} = require("../../models/sql-execute");

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
      ORDER BY a.start_date ORDER BY A.alert_id ASC;
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
router.get('/alertsByOrganizations/pendings', authenticateToken, async (req, res) => {
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
                a.failure_id,
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
                m.organization_id = ANY($1) AND a.status != 'finaliced'
            ORDER BY 
                CASE a.status
                    WHEN '0' THEN 1
                    WHEN 'attend' THEN 2
                    WHEN 'in_progress' THEN 3
                    WHEN 'finaliced' THEN 4
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
router.get('/alertsByOrganizations/finaliced', authenticateToken, async (req, res) => {
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
                m.organization_id = ANY($1) AND a.status = 'finaliced'
            ORDER BY a.repair_time DESC LIMIT 5;
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

//Obtener alertas por maquina e intervalo definido
router.get('/alertsInterval/:id/:interval', authenticateToken, async (req, res) => {
    const { id, interval } = req.params;

    // Construir la condición WHERE según el intervalo
    let whereCondition = '';
    let params = [id];

    switch (interval) {
        case 'today':
            whereCondition = 'AND DATE(A.start_date) = CURRENT_DATE';
            break;
        case '24hours':
            whereCondition = "AND A.start_date >= NOW() - INTERVAL '24 hours'";
            break;
        case '7days':
            whereCondition = "AND A.start_date >= CURRENT_DATE - INTERVAL '7 days'";
            break;
        case 'week':
            whereCondition = "AND A.start_date >= DATE_TRUNC('week', CURRENT_DATE)";
            break;
        case '30days':
            whereCondition = "AND A.start_date >= CURRENT_DATE - INTERVAL '30 days'";
            break;
        case 'month':
            whereCondition = "AND A.start_date >= DATE_TRUNC('month', CURRENT_DATE)";
            break;
        default:
            // Si no es un intervalo predefinido, devolver error
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Intervalo no válido'
            });
    }

    const sqlQuery = `SELECT
                          A.alert_id AS "AlertId",
                          A.failure_id AS "FailureId",
                          F."name" AS "Name",
                          F."type" AS "Type",
                          F."area" AS "Area",
                          A."status" AS "Status",
                          A.start_date AS "StartDate",
                          A.end_date AS "EndDate",
                          --COALESCE(A.end_date, CURRENT_TIMESTAMP) AS "EndDate" --Retornar fecha actual si es NULL
                          A.response_time AS "ResponseDate",
                          A.repair_time AS "RepairDate"
                      FROM mes_alerts A
                      LEFT JOIN mes_failures F ON A.failure_id = F.failure_id
                      WHERE A.machine_id = $1
                      ${whereCondition}
                      ORDER BY A.alert_id ASC`;

    const result = await selectByParamsFromDB(sqlQuery, params);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Obtener alertas por maquina e intervalo de fechas
router.get('/alertsIntervalBetween/:id/:startDate/:endDate', authenticateToken, async (req, res) => {
    const { id, startDate, endDate } = req.params;

    // Validar formato de fechas (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Formato de fecha inválido. Use YYYY-MM-DD'
        });
    }

    const sqlQuery = `SELECT
                          A.alert_id AS "AlertId",
                          A.failure_id AS "FailureId",
                          F."name" AS "Name",
                          F."type" AS "Type",
                          F."area" AS "Area",
                          A."status" AS "Status",
                          A.start_date AS "StartDate",
                          A.end_date AS "EndDate",
                          --COALESCE(A.end_date, CURRENT_TIMESTAMP) AS "EndDate" --Retornar fecha actual si es NULL
                          A.response_time AS "ResponseDate",
                          A.repair_time AS "RepairDate"
                      FROM mes_alerts A
                      LEFT JOIN mes_failures F ON A.failure_id = F.failure_id
                      WHERE A.machine_id = $1
                      AND DATE(A.start_date) BETWEEN $2 AND $3
                      ORDER BY A.alert_id ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [id, startDate, endDate]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//New Alert
router.post('/alerts', async (req, res) => {
    const { MachineId, StartDate, Status, FailureId } = req.body;

    try {
        // ✅ VALIDACIONES DE ENTRADA
        //Validar que todos los campos esenciales
        if (MachineId === undefined || MachineId === null ||
            FailureId === undefined || FailureId === null ||
            Status === undefined || Status === null) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron todos los campos requeridos (MachineId,FailureId,Status)'
            });
        }

        //Validar formato de fecha ISO 8601
        if (StartDate) {
            const parsedDate = new Date(StartDate);
            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({
                    errorsExistFlag: true,
                    message: 'Fecha invalida, se requiere formato ISO 8601'
                });
            }
        }

        //Validar que la máquina existe
        const machineCheck = await pool.query('SELECT machine_id FROM mes_machines WHERE machine_id = $1', [MachineId]);

        if (machineCheck.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: `La máquina con ID ${MachineId} no existe`
            });
        }

        // Validar que la falla existe
        const failureCheck = await pool.query('SELECT failure_id FROM mes_failures WHERE failure_id = $1', [FailureId]);

        if (failureCheck.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: `La falla con ID ${FailureId} no existe`
            });
        }

        //Validar que no exista una alerta abierta reciente duplicada
        const duplicateCheck = await pool.query(`SELECT alert_id FROM mes_alerts WHERE machine_id = $1
                                                  AND status IN ('open', 'assigned', 'attending');`,
                                                 [MachineId]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(409).json({
                errorsExistFlag: true,
                message: `Ya existe(n) ${duplicateCheck.rows.length} falla(s) genéricas para  la máquina ${MachineId}`,
            });
        }

        // ✅ INSERCIÓN DE DATOS
        const insertResult = await pool.query(`INSERT INTO mes_alerts (machine_id, failure_id, start_date, status)
                                                VALUES ($1, $2, $3, 'open') RETURNING *;`,
                                                [MachineId, FailureId, StartDate]
        );

        const insertedAlert = insertResult.rows[0];

        // ✅ OBTENER DATOS COMPLETOS
        const dataResult = await pool.query(
            `SELECT
                 a.alert_id,
                 f.area,
                 m.name AS machine_name,
                 f.name AS failure_name,
                 m.organization_id,
                 a.repair_time,
                 a.response_time,
                 a.start_date,
                 a.status,
                 f.type
             FROM mes_alerts a
                      JOIN mes_machines m ON a.machine_id = m.machine_id
                      LEFT JOIN mes_failures f ON a.failure_id = f.failure_id
             WHERE a.alert_id = $1;`,
            [insertedAlert.alert_id]
        );

        const payload = dataResult.rows[0];

        // ✅ NOTIFICACIONES (con manejo de errores)
        try {
            notifyAlert(payload.organization_id, payload, 'new');
        } catch (notifyError) {
            console.error('Error al notificar vía WebSocket:', notifyError);
        }

        try {
            await sendNotification(
                payload.organization_id,
                "❌ Nueva falla",
                FailureId,
                `Máquina: ${payload.machine_name}\nFalla: ${payload.failure_name}`
            );
        } catch (notificationError) {
            console.error('Error al enviar notificación:', notificationError);
        }

        // ✅ RESPUESTA EXITOSA
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: 1,
            AlertId: payload.alert_id
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
    const { organization_id } = req.body;
    const { alertId, } = req.params;

    try {
        const result = await pool.query(
            `
      UPDATE mes_alerts
      SET status = 'assigned', response_time = now()
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
        const payload = result.rows[0];

        notifyAlert(organization_id, payload, 'update');
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
    const { organization_id } = req.body;
    const { alertId } = req.params;

    try {
        // 1. Actualizar alerta
        const updateResult = await pool.query(
            `
            UPDATE mes_alerts
            SET status = 'completed', repair_time = now(), end_date = now()
            WHERE alert_id = $1
            RETURNING *;
            `,
            [alertId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Alerta no encontrada'
            });
        }

        const updatedAlert = updateResult.rows[0];

        // 2. Obtener datos completos para notificación
        const dataResult = await pool.query(
            `
            SELECT 
                a.alert_id,
                m.name AS machine_name,
                f.name AS failure_name,
                m.organization_id
            FROM mes_alerts a
            JOIN mes_machines m ON a.machine_id = m.machine_id
            JOIN mes_failures f ON a.failure_id = f.failure_id
            WHERE a.alert_id = $1
            `,
            [alertId]
        );

        const payload = dataResult.rows[0];

        // 3. Notificar vía WebSocket
        notifyAlert(payload.organization_id, payload, 'update');

        // 4. Enviar notificación push
        await sendNotification(
            payload.organization_id,
            "✅ Falla solucionada",
            updatedAlert.failure_id,
            "Máquina: " + payload.machine_name + "\nFalla: " + payload.failure_name
        );

        // 5. Responder al cliente
        res.json({
            errorsExistFlag: false,
            message: 'Estado de alerta actualizado correctamente',
            totalResults: 1,
            items: [payload]
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
router.put('/alerts/:alertId/failure', authenticateToken, async (req, res) => {
    const { alertId } = req.params;
    const { failure_id } = req.body; // puedes cambiar el nombre según lo que envíes desde el front

    try {
        const result = await pool.query(
            `
      UPDATE mes_alerts
      SET failure_id = $1, status = 'attending'
      WHERE alert_id = $2
      RETURNING alert_id, failure_id;
      `,
            [failure_id, alertId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Alerta no encontrada'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Ok',
            item: result.rows[0]
        });

    } catch (error) {
        console.error('Error al asociar falla a la alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar la alerta en la base de datos'
        });
    }
});

//Delete Alert
router.delete('/alerts/:alertId', authenticateToken, async (req, res) => {
    const { organization_id } = req.query;
    const { alertId, } = req.params;

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
        const payload = result.rows[0];

        notifyAlert(organization_id, payload, 'delete');
    } catch (error) {
        console.error('Error al eliminar alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al eliminar la alerta de la base de datos'
        });
    }
});



module.exports = router;