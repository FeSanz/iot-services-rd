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
                           i.uom AS "UoM",
                           --EXECUTIONS pendientes (status = 0) de la OT
                           COALESCE((SELECT array_agg(we.work_execution_id)
                                     FROM mes_work_execution we
                                     WHERE we.work_order_id = wo.work_order_id
                                       AND we.status = 0), '{}') AS "WorkExecutionIds"
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

    const sqlQuery  = `WITH execution_local AS (
                                    SELECT
                                        we.work_execution_id,
                                        we.work_order_id,
                                        we.ready,
                                        we.scrap,
                                        we.reject,
                                        -- Conversión UTC -> America/Mexico_City
                                        (we.execution_date AT TIME ZONE 'America/Mexico_City')::date AS exec_date_local,
                                        (we.execution_date AT TIME ZONE 'America/Mexico_City')::time AS exec_time_local
                                    FROM mes_work_execution we
                                    WHERE we.status = 0
                                ),
                                                        execution_shifted AS (
                                                            SELECT
                                                                el.work_execution_id,
                                                                el.work_order_id,
                                                                el.ready,
                                                                el.scrap,
                                                                el.reject,
                                                                s.shift_id,
                                                                s.name        AS shift_name,
                                                                s.start_time,
                                                                s.end_time,
                                                                -- Para turno overnight: si la hora local está antes del end_time,
                                                                -- el turno realmente comenzó el día anterior
                                                                CASE
                                                                    WHEN s.start_time > s.end_time
                                                                        AND el.exec_time_local < s.end_time
                                                                        THEN (el.exec_date_local - INTERVAL '1 day')::date
                                                       ELSE el.exec_date_local
                                END AS shift_date
                                FROM execution_local el
                                    INNER JOIN mes_work_orders wo
                                        ON wo.work_order_id = el.work_order_id
                                       AND wo.organization_id = $1
                                    INNER JOIN mes_shifts s
                                        ON s.organization_id = wo.organization_id
                                       AND s.enabled_flag = 'Y'
                                       AND (
                                            (s.start_time <= s.end_time
                                                AND el.exec_time_local >= s.start_time
                                                AND el.exec_time_local <  s.end_time)
                                            OR
                                            (s.start_time >  s.end_time
                                                AND (el.exec_time_local >= s.start_time
                                                     OR el.exec_time_local <  s.end_time))
                                       )
                            )
                                SELECT
                                    es.shift_id        AS "ShiftId",
                                    es.shift_name      AS "ShiftName",
                                    es.start_time      AS "StartTime",
                                    es.end_time        AS "EndTime",
                                    es.shift_date      AS "ShiftDate",
                                    -- WORK_ORDER
                                    wo.work_order_id        AS "WorkOrderId",
                                    wo.work_order_number    AS "WorkOrderNumber",
                                    wo.work_definition_id   AS "WorkDefinitionId",
                                    wo.planned_quantity     AS "PlannedQuantity",
                                    wo.completed_quantity   AS "CompletedQuantity",
                                    wo.type                 AS "Type",
                                    -- MACHINE
                                    wo.machine_id           AS "ResourceId",
                                    m.code                  AS "ResourceCode",
                                    wc.work_center_name     AS "WorkCenterName",
                                    -- ITEM
                                    wo.item_id              AS "ItemId",
                                    i.number                AS "ItemNumber",
                                    i.description           AS "Description",
                                    i.uom                   AS "UoM",
                                    -- ADVANCE
                                    SUM(es.ready)  AS "DispatchPending",
                                    SUM(es.scrap)  AS "ScrapPending",
                                    SUM(es.reject) AS "RejectPending",
                                    -- IDs de ejecuciones que componen este turno
                                    array_agg(es.work_execution_id) AS "WorkExecutionIds"
                                FROM execution_shifted es
                                         INNER JOIN mes_work_orders wo
                                                    ON wo.work_order_id = es.work_order_id
                                         LEFT  JOIN mes_machines m
                                                    ON m.machine_id = wo.machine_id
                                         LEFT  JOIN mes_work_centers wc
                                                    ON wc.work_center_id = m.work_center_id
                                         LEFT  JOIN mes_items i
                                                    ON i.item_id = wo.item_id
                                GROUP BY
                                    es.shift_id, es.shift_name, es.start_time, es.end_time, es.shift_date,
                                    wo.work_order_id, wo.work_order_number, wo.work_definition_id,
                                    wo.planned_quantity, wo.completed_quantity, wo.type, wo.machine_id,
                                    m.code, wc.work_center_name,
                                    wo.item_id, i.number, i.description, i.uom
                                ORDER BY es.shift_date DESC, es.shift_id, wo.work_order_id;`;

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
                                      AND we.execution_date::date BETWEEN $2 AND $3
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