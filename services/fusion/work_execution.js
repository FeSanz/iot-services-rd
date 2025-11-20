const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const { notifyWorkOrdersAdvance } = require("../websocket/websocket");
const authenticateToken = require("../../middleware/authenticateToken");
const {selectByParamsFromDB} = require("../../models/sql-execute");

router.put('/woCompleted/:organizationId', async (req, res) => {
    try {
        const { organizationId } = req.params;
        const { WorkOrderNumber, ExecutionDate, Number, Ready, Scrap, Reject, Tare, Container } = req.body;

        // Validación
        if (!WorkOrderNumber || !ExecutionDate || !Ready || !Number) {
            return res.status(400).json({
                errorsExistFlag: false,
                message: 'Faltan campos requeridos [OT, Fecha, Número, Cantidad]',
                totalResults: 0,
                items: null
            });
        }

        const readyCompleted = parseFloat(Ready);
        if (isNaN(readyCompleted) || readyCompleted <= 0) {
            return res.status(400).json({
                errorsExistFlag: false,
                message: 'La cantidad completada debe ser un número positivo',
                totalResults: 0,
                items: null
            });
        }

        // Verificar OT existe y si el numero de producto ya fue registrado
        const checkQuery = await pool.query(`
                    SELECT wo.work_order_id, wo.planned_quantity, wo.completed_quantity,
                           wo.dispatch_pending, wo.scrap_pending, wo.reject_pending,
                           EXISTS(SELECT 1 FROM MES_WORK_EXECUTION WHERE work_order_id = wo.work_order_id AND number = $3) as number_exists
                    FROM MES_WORK_ORDERS wo
                    WHERE wo.organization_id = $1 AND wo.work_order_number = $2`,
            [organizationId, WorkOrderNumber, Number]
        );

        if (checkQuery.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: false,
                message: 'Orden no encontrada',
                totalResults: 0,
                items: null
            });
        }

        const workOrder = checkQuery.rows[0];

        if (workOrder.number_exists) {
            return res.status(409).json({
                errorsExistFlag: false,
                message: 'El número de producto ya fue registrado',
                totalResults: 0,
                items: null
            });
        }

        const completedTotal = parseFloat(workOrder.completed_quantity || 0) + readyCompleted;
        const plannedQuantity = parseFloat(workOrder.planned_quantity || 0);

        if (completedTotal > plannedQuantity) {
            return res.status(400).json({
                errorsExistFlag: false,
                message: `La cantidad completada (${completedTotal}) excede la cantidad planificada (${plannedQuantity})`,
                totalResults: 0,
                items: null
            });
        }

        // Usar transacción para garantizar integridad
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Insertar ejecución
            await client.query(`
                INSERT INTO MES_WORK_EXECUTION (work_order_id, execution_date, number, ready, scrap, reject, tare, container)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [workOrder.work_order_id, ExecutionDate, Number, readyCompleted, Scrap || 0, Reject || 0, Tare || 0, Container || 0]
            );

            const newStatus = completedTotal === plannedQuantity ? "COMPLETED" : "IN_PROCESS";
            const dispatchPending = parseFloat(workOrder.dispatch_pending || 0) + parseFloat(Ready || 0);
            const scrapPending = parseFloat(workOrder.scrap_pending || 0) + parseFloat(Scrap || 0);
            const rejectPending = parseFloat(workOrder.reject_pending || 0) + parseFloat(Reject || 0);

            // Actualizar orden
            const result = await client.query(`
                UPDATE MES_WORK_ORDERS
                SET completed_quantity = $1, dispatch_pending = $2, scrap_pending = $3, 
                    reject_pending = $4, status = $5
                WHERE work_order_id = $6
                RETURNING work_order_id AS "WorkOrderId", completed_quantity AS "CompletedQuantity", 
                          scrap_pending AS "ScrapPending", reject_pending AS "RejectPending", status AS "Status"`,
                [completedTotal, dispatchPending, scrapPending, rejectPending, newStatus, workOrder.work_order_id]
            );

            await client.query('COMMIT');

            notifyWorkOrdersAdvance(organizationId, {
                totalResults: 1,
                items: {
                    WorkOrderId: result.rows[0].WorkOrderId,
                    CompletedQuantity: result.rows[0].CompletedQuantity,
                    Status: result.rows[0].Status,
                    ExecutionDate,
                    Number,
                    Quantity: Ready
                }
            });

            res.json({
                errorsExistFlag: false,
                message: 'Actualizado exitosamente',
                totalResults: 1,
                items: result.rows[0]
            });

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Error al actualizar:', error);

        if (error.code === '23505') {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'Ya existe un registro con ese código',
                totalResults: 0,
                items: null
            });
        }

        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar: ' + error.message,
            totalResults: 0,
            items: null
        });
    }
});

router.get('/lastWOCompleted/:organizationId', authenticateToken, async (req, res) => {
    const { organizationId } = req.params;
    const sqlQuery  = `SELECT
                           wo.work_order_id AS "WorkOrderId",
                           wo.work_order_number AS "WorkOrderNumber",
                           wo.item_id AS "ItemId",
                           wo.completed_quantity AS "CompletedQuantity",
                           wo.machine_id AS "ResourceId",
                           m.code AS "ResourceCode",
                           i.number AS "ItemNumber",
                           i.description AS "Description",
                           i.uom AS "UoM",
                           -- Últimas 5 ejecuciones TOTALES
                           we.work_execution_id AS "WorkExecutionId",
                           we.execution_date AS "ExecutionDate",
                           we.number AS "ExecutionNumber",
                           we.ready AS "Ready",
                           we.scrap AS "Scrap",
                           we.reject AS "Reject",
                           we.tare AS "Tare",
                           we.container AS "Container"
                       FROM (
                                SELECT
                                    work_execution_id,
                                    work_order_id,
                                    execution_date,
                                    number,
                                    ready,
                                    scrap,
                                    reject,
                                    tare,
                                    container
                                FROM mes_work_execution
                                ORDER BY work_execution_id DESC
                                    LIMIT 5
                            ) we
                                INNER JOIN MES_WORK_ORDERS wo ON we.work_order_id = wo.work_order_id
                                LEFT JOIN MES_MACHINES m ON wo.machine_id = m.machine_id
                                LEFT JOIN MES_ITEMS i ON wo.item_id = i.item_id
                       WHERE wo.organization_id = $1
                         AND wo.status IN ('RELEASED', 'IN_PROCESS')
                       ORDER BY we.work_execution_id DESC;`;

    const result = await selectByParamsFromDB(sqlQuery, [organizationId]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

module.exports = router;