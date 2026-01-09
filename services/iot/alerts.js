const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const authenticateToken = require('../../middleware/authenticateToken');
const { notifyAlert } = require('../websocket/websocket');
const { sendNotification } = require('./notifications');
const { sendEmailNotification, sendEmailNotificationRepaired } = require('../email/email');
const { selectByParamsFromDB } = require("../../models/sql-execute");

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
    const { organizations, start_date } = req.query;
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
        // Si se envía start_date, agregamos el filtro
        let query = `
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
                m.organization_id = ANY($1)
                AND a.status != 'completed'
        `;

        const params = [orgIds]; // Parametro 1

        if (start_date) {
            query += ` AND a.start_date >= $2 `;
            params.push(start_date); // Parametro 2
        }

        query += ` ORDER BY a.alert_id DESC;`;

        const resultado = await pool.query(query, params);

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
//Finalizar alertas
router.get('/alertsByOrganizations/finaliced', authenticateToken, async (req, res) => {
    const { organizations, startDate, endDate } = req.query;

    // Validar organizations
    if (!organizations) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Parámetro "organizations" requerido (ej. ?organizations=1,2,3)'
        });
    }

    const orgIds = organizations
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

    if (orgIds.length === 0) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'IDs de organización inválidos en "organizations"'
        });
    }

    // Validar fechas solo si existen
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    const hasDates = startDate && endDate;

    if (hasDates) {
        if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Formato de fecha inválido. Use YYYY-MM-DD'
            });
        }
    }

    try {

        let sqlQuery = `
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
                AND a.status = 'completed'
        `;

        const params = [orgIds];

        // Si hay fechas → agregar WHERE
        if (hasDates) {
            sqlQuery += `
                AND DATE(a.start_date) BETWEEN $2 AND $3
                ORDER BY a.repair_time DESC
            `;
            params.push(startDate, endDate);
        } else {
            // Sin fechas → solo últimas 5
            sqlQuery += ` ORDER BY a.repair_time DESC LIMIT 5`;
        }

        const resultado = await pool.query(sqlQuery, params);

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
    const { MachineId, StartDate, Status, FailureId } = req.body; // MachineId sigue siendo el token
    //sendTestEmail('sanchezbrando197@gmail.com');
    try {
        // ✅ VALIDACIONES DE ENTRADA
        if (!MachineId || FailureId === undefined || FailureId === null || Status === undefined || Status === null) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron todos los campos requeridos (MachineId, FailureId, Status)'
            });
        }

        // Validar formato de fecha ISO 8601
        if (StartDate) {
            const parsedDate = new Date(StartDate);
            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({
                    errorsExistFlag: true,
                    message: 'Fecha inválida, se requiere formato ISO 8601'
                });
            }
        }

        // Validar status correctos
        if (Status !== 0 && Status !== 1) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Status inválido, verifique sus datos'
            });
        }

        // ✅ Buscar máquina por token (en lugar de por machine_id)
        const machineResult = await pool.query(
            'SELECT machine_id, organization_id, name FROM mes_machines WHERE token = $1',
            [MachineId]
        );

        if (machineResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: `No existe ninguna máquina con el token proporcionado`
            });
        }

        const { machine_id: machineId, organization_id: orgId, name: machineName } = machineResult.rows[0];

        // ✅ Obtener company_id desde mes_organizations
        const orgResult = await pool.query(
            'SELECT company_id FROM mes_organizations WHERE organization_id = $1',
            [orgId]
        );

        const openAlertCheck = await pool.query(`
            SELECT alert_id
            FROM mes_alerts
            WHERE machine_id = $1
            AND status = 'open'
            LIMIT 1;
        `, [machineId]);

        if (openAlertCheck.rows.length > 0) {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'Ya existe una falla en estado OPEN para esta máquina',
                AlertId: openAlertCheck.rows[0].alert_id
            });
        }

        // Insertar alerta
        const insertResult = await pool.query(`
                INSERT INTO mes_alerts (machine_id, failure_id, start_date, status)
                VALUES ($1, $2, $3, 'open') RETURNING *;
            `, [machineId, FailureId, StartDate]);

        const insertedAlert = insertResult.rows[0];
        // Obtener datos completos
        const dataResult = await pool.query(`
                SELECT a.alert_id,
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
                WHERE a.alert_id = $1;
            `, [insertedAlert.alert_id]);

        // Actualizar estado de máquina
        await pool.query(`UPDATE mes_machines SET "status" = 'Downtime' WHERE machine_id = $1`, [machineId]);

        const payload = dataResult.rows[0];

        // ✅ Notificación WebSocket (siempre se envía)
        try {
            notifyAlert(payload.organization_id, payload, 'new');
        } catch (err) {
            console.error('Error al notificar vía WebSocket:', err);
        }
        if (orgResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'No se encontró la organización o no tiene compañía asociada'
            });
        }

        const { company_id: companyId } = orgResult.rows[0];

        // ✅ Validar configuración de ALERTS_FLAG
        const alertsFlagResult = await pool.query(
            `SELECT value FROM mes_settings 
             WHERE company_id = $1 AND name = 'ALERTS_FLAG'`,
            [companyId]
        );

        if (alertsFlagResult.rows.length == 0 || alertsFlagResult.rows[0].value != 'true') {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Ok'
            });
        }

        // ✅ DOWNTIME - FALLA DETECTADA
        if (Status === 0) {
            // Validar que la falla existe
            const failureCheck = await pool.query(
                'SELECT failure_id FROM mes_failures WHERE failure_id = $1',
                [FailureId]
            );

            if (failureCheck.rows.length === 0) {
                return res.status(404).json({
                    errorsExistFlag: true,
                    message: `La falla con ID ${FailureId} no existe`
                });
            }

            // Validar que no haya alertas abiertas
            const duplicateCheck = await pool.query(`
                SELECT alert_id
                FROM mes_alerts
                WHERE machine_id = $1
                AND status IN ('open', 'assigned', 'attending');
            `, [machineId]);

            if (duplicateCheck.rows.length > 0) {
                return res.status(409).json({
                    errorsExistFlag: true,
                    message: `Ya existe(n) ${duplicateCheck.rows.length} falla(s) activas para la máquina ${machineName}`,
                });
            }


            // ✅ Validar PUSH_FLAG para notificaciones push
            const pushFlagResult = await pool.query(
                `SELECT value FROM mes_settings 
                 WHERE company_id = $1 AND name = 'PUSH_FLAG'`,
                [companyId]
            );

            if (pushFlagResult.rows.length > 0 && pushFlagResult.rows[0].value == 'true') {
                try {
                    await sendNotification(
                        payload.organization_id,
                        "❌ Nueva falla",
                        payload.alert_id,
                        `Máquina: ${payload.machine_name}\nFalla: ${payload.failure_name}`
                    );
                } catch (err) {
                    console.error('Error al enviar notificación push:', err);
                }
            }

            // ✅ Validar EMAIL_FLAG para notificaciones por correo
            const emailFlagResult = await pool.query(
                `SELECT value FROM mes_settings 
                 WHERE company_id = $1 AND name = 'EMAIL_FLAG'`,
                [companyId]
            );

            if (emailFlagResult.rows.length > 0 && emailFlagResult.rows[0].value == 'true') {
                // TODO: Integración futura - Enviar notificación por correo
                try {
                    await sendEmailNotification(
                        payload.organization_id,
                        "❌ Nueva falla",
                        payload.alert_id,
                        `Máquina: ${payload.machine_name}\nFalla: ${payload.failure_name}`
                    );
                } catch (err) {
                    console.error('Error al enviar notificación por correo:', err);
                }
            }

            // Respuesta
            return res.json({
                errorsExistFlag: false,
                message: 'OK',
                totalResults: 1,
                AlertId: payload.alert_id
            });
        }

        // ✅ RUNTIME - MÁQUINA ACTIVA
        else if (Status === 1) {
            const alertsOpen = await pool.query(`
                SELECT alert_id FROM mes_alerts
                WHERE machine_id = $1 AND status IN ('open', 'assigned', 'attending');
            `, [machineId]);

            if (alertsOpen.rows.length > 0) {
                return res.status(409).json({
                    errorsExistFlag: true,
                    message: `La falla aún no ha sido atendida para cambiar el estado`
                });
            }

            await pool.query(`UPDATE mes_machines SET "status" = 'Runtime' WHERE machine_id = $1`, [machineId]);

            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Status actualizado correctamente'
            });
        }

    } catch (error) {
        console.error('Error al crear alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar la alerta en la base de datos'
        });
    }
});
//update notitfications
router.put('/alerts/settings/update', authenticateToken, async (req, res) => {
    const { setting_id, username, value } = req.body;

    // Validar campos necesarios
    if (!setting_id || value === undefined) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Debe enviar setting_id y value en el cuerpo de la petición'
        });
    }

    try {
        const sqlQuery = `
            UPDATE mes_settings
            SET value = $1, updated_date = NOW(), updated_by = $2
            WHERE setting_id = $3
            RETURNING *;
        `;

        const result = await pool.query(sqlQuery, [value, username, setting_id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'No se encontró un setting con ese setting_id'
            });
        }

        return res.json({
            errorsExistFlag: false,
            message: 'Setting actualizado correctamente',
            items: result.rows[0]
        });

    } catch (error) {
        console.error('Error al actualizar setting:', error);

        return res.status(500).json({
            errorsExistFlag: true,
            message: 'Error interno del servidor al actualizar mes_settings'
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
    const { alertId } = req.params;

    try {
        // 1️⃣ Actualizar alerta
        const updateResult = await pool.query(
            `
            UPDATE mes_alerts
            SET status = 'completed',
                repair_time = now(),
                end_date = now()
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

        // 2️⃣ Obtener datos completos para notificación (incluye machine_id)
        const dataResult = await pool.query(
            `
            SELECT 
                a.alert_id,
                a.machine_id,
                m.name AS machine_name,
                f.name AS failure_name,
                m.organization_id
            FROM mes_alerts a
            JOIN mes_machines m ON a.machine_id = m.machine_id
            JOIN mes_failures f ON a.failure_id = f.failure_id
            WHERE a.alert_id = $1;
            `,
            [alertId]
        );

        const payload = dataResult.rows[0];

        // 3️⃣ Obtener company_id desde mes_organizations
        const orgResult = await pool.query(
            'SELECT company_id FROM mes_organizations WHERE organization_id = $1',
            [payload.organization_id]
        );

        let companyId = null;
        if (orgResult.rows.length > 0) {
            companyId = orgResult.rows[0].company_id;
        }

        // ✅ Validar configuración de ALERTS_FLAG
        const alertsFlagResult = await pool.query(
            `SELECT value FROM mes_settings 
             WHERE company_id = $1 AND name = 'ALERTS_FLAG'`,
            [companyId]
        );
        // 4️⃣ Actualizar status de la máquina
        /*await pool.query(
            `
            UPDATE mes_machines
            SET status = 'Runtime'
            WHERE machine_id = $1;
            `,
            [payload.machine_id]
        );*/

        // 5️⃣ Notificar vía WebSocket
        notifyAlert(payload.organization_id, { ...payload, status: "runtime" }, 'update');

        if (alertsFlagResult.rows.length == 0 || alertsFlagResult.rows[0].value != 'true') {
            return res.json({
                errorsExistFlag: false,
                message: 'Estado de alerta y máquina actualizados correctamente',
                totalResults: 1,
                items: [payload]
            });
        }
        // 6️⃣ Validar PUSH_FLAG para notificaciones push
        if (companyId) {
            const pushFlagResult = await pool.query(
                `SELECT value FROM mes_settings 
                 WHERE company_id = $1 AND name = 'PUSH_FLAG'`,
                [companyId]
            );

            if (pushFlagResult.rows.length > 0 && pushFlagResult.rows[0].value == 'true') {

                try {
                    await sendNotification(
                        payload.organization_id,
                        "✅ Falla solucionada",
                        updatedAlert.failure_id,
                        `Máquina: ${payload.machine_name}\nFalla: ${payload.failure_name}`
                    );
                } catch (err) {
                    console.error('Error al enviar notificación push:', err);
                }
            }

            // 7️⃣ Validar EMAIL_FLAG para notificaciones por correo
            const emailFlagResult = await pool.query(
                `SELECT value FROM mes_settings 
                 WHERE company_id = $1 AND name = 'EMAIL_FLAG'`,
                [companyId]
            );

            if (emailFlagResult.rows.length > 0 && emailFlagResult.rows[0].value == 'true') {
                try {
                    await sendEmailNotificationRepaired(
                        payload.organization_id,
                        "✅ Falla solucionada",
                        payload.alert_id,
                        `Máquina: ${payload.machine_name}\nFalla: ${payload.failure_name}`
                    );
                } catch (err) {
                    console.error('Error al enviar notificación por correo:', err);
                }
            }
        }

        // 8️⃣ Responder al cliente
        res.json({
            errorsExistFlag: false,
            message: 'Estado de alerta y máquina actualizados correctamente',
            totalResults: 1,
            items: [payload]
        });

    } catch (error) {
        console.error('Error al actualizar estado de alerta:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar el estado de la alerta o la máquina'
        });
    }
});
//Asignar Falla
router.put('/alerts/:alertId/failure', authenticateToken, async (req, res) => {
    const { alertId } = req.params;
    const { failure_id } = req.body;

    try {
        // 1. Actualizar alerta con nueva falla y estado 'attending'
        const updateResult = await pool.query(
            `UPDATE mes_alerts
             SET failure_id = $1, status = 'attending'
             WHERE alert_id = $2
             RETURNING *;`,
            [failure_id, alertId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Alerta no encontrada'
            });
        }

        // 2. Obtener datos completos para notificación
        const dataResult = await pool.query(
            `SELECT 
                a.alert_id,
                m.name AS machine_name,
                f.name AS failure_name,
                m.organization_id
             FROM mes_alerts a
             JOIN mes_machines m ON a.machine_id = m.machine_id
             LEFT JOIN mes_failures f ON a.failure_id = f.failure_id
             WHERE a.alert_id = $1`,
            [alertId]
        );

        const payload = dataResult.rows[0];

        // 3. Obtener company_id desde mes_organizations
        const orgResult = await pool.query(
            'SELECT company_id FROM mes_organizations WHERE organization_id = $1',
            [payload.organization_id]
        );

        let companyId = null;
        if (orgResult.rows.length > 0) {
            companyId = orgResult.rows[0].company_id;
        }

        // 4. Notificar vía WebSocket
        try {
            notifyAlert(payload.organization_id, payload, 'update');
        } catch (notifyError) {
            console.error('Error al notificar vía WebSocket:', notifyError);
        }


        // ✅ Validar configuración de ALERTS_FLAG
        const alertsFlagResult = await pool.query(
            `SELECT value FROM mes_settings 
             WHERE company_id = $1 AND name = 'ALERTS_FLAG'`,
            [companyId]
        );
        if (alertsFlagResult.rows.length == 0 || alertsFlagResult.rows[0].value != 'true') {
            return res.json({
                errorsExistFlag: false,
                message: 'Ok',
                item: payload
            });
        }
        // 5. Validar PUSH_FLAG para notificaciones push
        if (companyId) {
            const pushFlagResult = await pool.query(
                `SELECT value FROM mes_settings 
                 WHERE company_id = $1 AND name = 'PUSH_FLAG'`,
                [companyId]
            );

            if (pushFlagResult.rows.length > 0 && pushFlagResult.rows[0].value == 'true') {
                try {
                    await sendNotification(
                        payload.organization_id,
                        "❌ Nueva falla (actualizada)",
                        alertId,
                        `Máquina: ${payload.machine_name}\nFalla: ${payload.failure_name}`
                    );
                } catch (notificationError) {
                    console.error('Error al enviar notificación push:', notificationError);
                }
            }
        }

        // 6. Responder al cliente
        res.json({
            errorsExistFlag: false,
            message: 'Ok',
            item: payload
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