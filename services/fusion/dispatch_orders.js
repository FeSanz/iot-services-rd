const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectByParamsFromDB} = require("../../models/sql-execute");
const {notifyNewWorkOrders} = require("../websocket/websocket");
const authenticateToken = require('../../middleware/authenticateToken');

// Obtener registros por organizacion y estado
router.get('/dispatchPending/:organization', authenticateToken, async (req, res) => {
    const { organization } = req.params;
    const sqlQuery  = `SELECT
                           wo.work_order_id AS "WorkOrderId",
                           wo.work_order_number AS "WorkOrderNumber",
                           wo.work_definition_id AS "WorkDefinitionId",
                           wo.item_id AS "ItemId",
                           wo.planned_quantity AS "PlannedQuantity",
                           wo.dispatched_quantity AS "DispatchedQuantity",
                           wo.completed_quantity AS "CompletedQuantity",
                           wo.dispatch_pending AS "DispatchPending",
                           wo.scrap_pending AS "ScrapPending",
                           wo.reject_pending AS "RejectPending",
                           wo.type AS "Type",
                           --MACHINE
                           wo.machine_id AS "ResourceId",
                           m.code AS "ResourceCode",
                           --WORK_CENTER
                           wc.work_center_name AS "WorkCenterName",
                           --ITEM
                           i.number AS "ItemNumber",
                           i.description AS "Description",
                           i.uom AS "UoM"
                       FROM MES_WORK_ORDERS wo
                                LEFT JOIN MES_MACHINES m ON m.machine_id = wo.machine_id
                                LEFT JOIN MES_WORK_CENTERS wc ON wc.work_center_id = m.work_center_id
                                LEFT JOIN MES_ITEMS i ON i.item_id = wo.item_id
                       WHERE wo.organization_id = $1
                         AND wo.dispatch_pending > 0
                       ORDER BY wo.work_order_id ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});


// Obtener registros por organizacion y turno
router.get('/dispatchByShiftPending/:organization', authenticateToken, async (req, res) => {
    const { organization, interval } = req.params;

    const sqlQuery  = `
                            WITH execution_filtered AS (
                                SELECT
                                    we.work_order_id,
                                    we.execution_date::date AS exec_date,
                                    we.execution_date::time AS exec_time,
                                    we.ready,
                                    we.scrap,
                                    we.reject
                                FROM mes_work_execution we
                                WHERE we.status = 0
                                )
                            SELECT
                                s.shift_id AS "ShiftId",
                                s.name AS "ShiftName",
                                s.start_time AS "StartTime",
                                s.end_time AS "EndTime",
                                MIN(ef.exec_date) AS "ShiftDate",
                                --WORK_ORDER
                                wo.work_order_id AS "WorkOrderId",
                                wo.work_order_number AS "WorkOrderNumber",
                                wo.work_definition_id AS "WorkDefinitionId",
                                wo.planned_quantity AS "PlannedQuantity",
                                wo.completed_quantity AS "CompletedQuantity",
                                wo.type AS "Type",
                                --MACHINE
                                wo.machine_id AS "ResourceId",
                                m.code AS "ResourceCode",
                                wc.work_center_name AS "WorkCenterName",
                                --ITEM
                                wo.item_id AS "ItemId",
                                i.number AS "ItemNumber",
                                i.description AS "Description",
                                i.uom AS "UoM",
                                --ADVANCE
                                SUM(ef.ready) AS "DispatchPending",
                                SUM(ef.scrap) AS "ScrapPending",
                                SUM(ef.reject) AS "RejectPending"
                            FROM execution_filtered ef
                                     INNER JOIN MES_WORK_ORDERS wo ON wo.work_order_id = ef.work_order_id
                                AND wo.organization_id = $1
                                     INNER JOIN mes_shifts s ON s.organization_id = wo.organization_id
                                AND s.enabled_flag = 'Y'
                                AND (
                                        (s.start_time <= s.end_time
                                            AND ef.exec_time >= s.start_time
                                            AND ef.exec_time < s.end_time)
                                            OR
                                        (s.start_time > s.end_time
                                            AND (ef.exec_time >= s.start_time OR ef.exec_time < s.end_time))
                                        )
                                     LEFT JOIN MES_MACHINES m ON m.machine_id = wo.machine_id
                                     LEFT JOIN MES_WORK_CENTERS wc ON wc.work_center_id = m.work_center_id
                                     LEFT JOIN MES_ITEMS i ON i.item_id = wo.item_id
                            GROUP BY
                                s.shift_id, s.name, s.start_time, s.end_time,
                                wo.work_order_id, wo.work_order_number, wo.work_definition_id,
                                wo.planned_quantity, wo.type, wo.machine_id,
                                m.code, wc.work_center_name,
                                wo.item_id, i.number, i.description, i.uom
                            ORDER BY MIN(ef.exec_date) DESC, s.shift_id, wo.work_order_id;`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por organizacion y estado
router.get('/dispatchByShftInterval/:organization/:interval', authenticateToken, async (req, res) => {
    const { organization, interval } = req.params;

    // Construir la condición WHERE según el intervalo
    let whereConditionInterval = '';

    switch (interval) {
        case 'today':
            whereConditionInterval = 'AND DATE(we.execution_date) = CURRENT_DATE';
            break;
        case '7days':
            whereConditionInterval = "AND we.execution_date >= CURRENT_DATE - INTERVAL '7 days'";
            break;
        case 'week':
            whereConditionInterval = "AND we.execution_date >= DATE_TRUNC('week', CURRENT_DATE)";
            break;
        case '30days':
            whereConditionInterval = "AND we.execution_date >= CURRENT_DATE - INTERVAL '30 days'";
            break;
        case 'month':
            whereConditionInterval = "AND we.execution_date >= DATE_TRUNC('month', CURRENT_DATE)";
            break;
        default:
            // Si no es un intervalo predefinido, devolver error
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Intervalo no válido'
            });
    }

    const sqlQuery  = `
                            WITH execution_filtered AS (
                                SELECT
                                    we.work_order_id,
                                    we.execution_date::date AS exec_date,
                                    we.execution_date::time AS exec_time,
                                    we.ready,
                                    we.scrap,
                                    we.reject
                                FROM mes_work_execution we
                                WHERE we.status = 0
                                  ${whereConditionInterval}
                                )
                            SELECT
                                s.shift_id AS "ShiftId",
                                s.name AS "ShiftName",
                                s.start_time AS "StartTime",
                                s.end_time AS "EndTime",
                                MIN(ef.exec_date) AS "ShiftDate",
                                --WORK_ORDER
                                wo.work_order_id AS "WorkOrderId",
                                wo.work_order_number AS "WorkOrderNumber",
                                wo.work_definition_id AS "WorkDefinitionId",
                                wo.planned_quantity AS "PlannedQuantity",
                                wo.type AS "Type",
                                --MACHINE
                                wo.machine_id AS "ResourceId",
                                m.code AS "ResourceCode",
                                wc.work_center_name AS "WorkCenterName",
                                --ITEM
                                wo.item_id AS "ItemId",
                                i.number AS "ItemNumber",
                                i.description AS "Description",
                                i.uom AS "UoM",
                                --ADVANCE
                                SUM(ef.ready) AS "TotalReady",
                                SUM(ef.scrap) AS "TotalScrap",
                                SUM(ef.reject) AS "TotalReject"
                            FROM execution_filtered ef
                                     INNER JOIN MES_WORK_ORDERS wo ON wo.work_order_id = ef.work_order_id
                                AND wo.organization_id = $1
                                     INNER JOIN mes_shifts s ON s.organization_id = wo.organization_id
                                AND s.enabled_flag = 'Y'
                                AND (
                                        (s.start_time <= s.end_time
                                            AND ef.exec_time >= s.start_time
                                            AND ef.exec_time < s.end_time)
                                            OR
                                        (s.start_time > s.end_time
                                            AND (ef.exec_time >= s.start_time OR ef.exec_time < s.end_time))
                                        )
                                     LEFT JOIN MES_MACHINES m ON m.machine_id = wo.machine_id
                                     LEFT JOIN MES_WORK_CENTERS wc ON wc.work_center_id = m.work_center_id
                                     LEFT JOIN MES_ITEMS i ON i.item_id = wo.item_id
                            GROUP BY
                                s.shift_id, s.name, s.start_time, s.end_time,
                                wo.work_order_id, wo.work_order_number, wo.work_definition_id,
                                wo.planned_quantity, wo.type, wo.machine_id,
                                m.code, wc.work_center_name,
                                wo.item_id, i.number, i.description, i.uom
                            ORDER BY MIN(ef.exec_date) DESC, s.shift_id, wo.work_order_id;`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Obtener OTs por maquina e intervalo de fechas
router.get('/dispatchByShftBetween/:organization/:startDate/:endDate', authenticateToken, async (req, res) => {
    const { organization, startDate, endDate } = req.params;
    // Validar formato de fechas (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Formato de fecha inválido. Use YYYY-MM-DD'
        });
    }

    const sqlQuery  = `
                                WITH execution_filtered AS (
                                    SELECT
                                        we.work_order_id,
                                        we.execution_date::date AS exec_date,
                                        we.execution_date::time AS exec_time,
                                        we.ready,
                                        we.scrap,
                                        we.reject
                                    FROM mes_work_execution we
                                    WHERE we.status = 0
                                    DATE(A.start_date) BETWEEN $2 AND $3
                                    )
                                SELECT
                                    s.shift_id AS "ShiftId",
                                    s.name AS "ShiftName",
                                    s.start_time AS "StartTime",
                                    s.end_time AS "EndTime",
                                    MIN(ef.exec_date) AS "ShiftDate",
                                    --WORK_ORDER
                                    wo.work_order_id AS "WorkOrderId",
                                    wo.work_order_number AS "WorkOrderNumber",
                                    wo.work_definition_id AS "WorkDefinitionId",
                                    wo.planned_quantity AS "PlannedQuantity",
                                    wo.type AS "Type",
                                    --MACHINE
                                    wo.machine_id AS "ResourceId",
                                    m.code AS "ResourceCode",
                                    wc.work_center_name AS "WorkCenterName",
                                    --ITEM
                                    wo.item_id AS "ItemId",
                                    i.number AS "ItemNumber",
                                    i.description AS "Description",
                                    i.uom AS "UoM",
                                    --ADVANCE
                                    SUM(ef.ready) AS "TotalReady",
                                    SUM(ef.scrap) AS "TotalScrap",
                                    SUM(ef.reject) AS "TotalReject"
                                FROM execution_filtered ef
                                         INNER JOIN MES_WORK_ORDERS wo ON wo.work_order_id = ef.work_order_id
                                    AND wo.organization_id = $1
                                         INNER JOIN mes_shifts s ON s.organization_id = wo.organization_id
                                    AND s.enabled_flag = 'Y'
                                    AND (
                                                                        (s.start_time <= s.end_time
                                                                            AND ef.exec_time >= s.start_time
                                                                            AND ef.exec_time < s.end_time)
                                                                            OR
                                                                        (s.start_time > s.end_time
                                                                            AND (ef.exec_time >= s.start_time OR ef.exec_time < s.end_time))
                                                                        )
                                         LEFT JOIN MES_MACHINES m ON m.machine_id = wo.machine_id
                                         LEFT JOIN MES_WORK_CENTERS wc ON wc.work_center_id = m.work_center_id
                                         LEFT JOIN MES_ITEMS i ON i.item_id = wo.item_id
                                GROUP BY
                                    s.shift_id, s.name, s.start_time, s.end_time,
                                    wo.work_order_id, wo.work_order_number, wo.work_definition_id,
                                    wo.planned_quantity, wo.type, wo.machine_id,
                                    m.code, wc.work_center_name,
                                    wo.item_id, i.number, i.description, i.uom
                                ORDER BY MIN(ef.exec_date) DESC, s.shift_id, wo.work_order_id;`;

    const result = await selectByParamsFromDB(sqlQuery, [organization, startDate, endDate]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Exportar el router
module.exports = router;