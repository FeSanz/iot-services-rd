const pool = require('../../database/pool');
const { notifyWorkOrdersAdvance } = require('../websocket/websocket');

async function woCompletedHandler(organizationId, data) {
    const { WorkOrderNumber, ExecutionDate, Number, Ready, Scrap, Reject, Tare, Container } = data;

    // ── Validación ──
    if (!WorkOrderNumber || !ExecutionDate || !Ready || !Number) {
        return {
            success: false,
            status: 400,
            message: 'Faltan campos requeridos [OT, Fecha, Número, Cantidad]',
            data: null
        };
    }

    const readyCompleted = parseFloat(Ready);
    if (isNaN(readyCompleted) || readyCompleted <= 0) {
        return {
            success: false,
            status: 400,
            message: 'La cantidad completada debe ser un número positivo',
            data: null
        };
    }

    // ── Verificar OT existe y número no duplicado ──
    const checkQuery = await pool.query(`
        SELECT wo.work_order_id, wo.planned_quantity, wo.completed_quantity,
               wo.dispatch_pending, wo.scrap_pending, wo.reject_pending,
               EXISTS(
                   SELECT 1 FROM MES_WORK_EXECUTION 
                   WHERE work_order_id = wo.work_order_id AND number = $3
               ) as number_exists
        FROM MES_WORK_ORDERS wo
        WHERE wo.organization_id = $1 AND wo.work_order_number = $2`,
        [organizationId, WorkOrderNumber, Number]
    );

    if (checkQuery.rows.length === 0) {
        return {
            success: false,
            status: 404,
            message: 'Orden no encontrada',
            data: null
        };
    }

    const workOrder = checkQuery.rows[0];

    if (workOrder.number_exists) {
        return {
            success: false,
            status: 409,
            message: 'El número de producto ya fue registrado',
            data: null
        };
    }

    const completedTotal = parseFloat(workOrder.completed_quantity || 0) + readyCompleted;
    const plannedQuantity = parseFloat(workOrder.planned_quantity || 0);

    if (completedTotal > plannedQuantity) {
        return {
            success: false,
            status: 400,
            message: `La cantidad completada (${completedTotal}) excede la cantidad planificada (${plannedQuantity})`,
            data: null
        };
    }

    // ── Transacción ──
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            INSERT INTO MES_WORK_EXECUTION 
                (work_order_id, execution_date, number, ready, scrap, reject, tare, container)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                workOrder.work_order_id,
                ExecutionDate,
                Number,
                readyCompleted,
                Scrap || 0,
                Reject || 0,
                Tare || 0,
                Container || 0
            ]
        );

        const newStatus = completedTotal === plannedQuantity ? "COMPLETED" : "IN_PROCESS";
        const dispatchPending = parseFloat(workOrder.dispatch_pending || 0) + parseFloat(Ready || 0);
        const scrapPending = parseFloat(workOrder.scrap_pending || 0) + parseFloat(Scrap || 0);
        const rejectPending = parseFloat(workOrder.reject_pending || 0) + parseFloat(Reject || 0);

        const result = await client.query(`
            UPDATE MES_WORK_ORDERS
            SET completed_quantity = $1, dispatch_pending = $2, scrap_pending = $3,
                reject_pending = $4, status = $5
            WHERE work_order_id = $6
            RETURNING work_order_id AS "WorkOrderId", 
                      completed_quantity AS "CompletedQuantity",
                      scrap_pending AS "ScrapPending", 
                      reject_pending AS "RejectPending", 
                      status AS "Status"`,
            [completedTotal, dispatchPending, scrapPending, rejectPending, newStatus, workOrder.work_order_id]
        );

        await client.query('COMMIT');

        const resultData = result.rows[0];

        // ── Notificar WebSocket ──
        notifyWorkOrdersAdvance(organizationId, {
            totalResults: 1,
            items: {
                WorkOrderId: resultData.WorkOrderId,
                CompletedQuantity: resultData.CompletedQuantity,
                Status: resultData.Status,
                ExecutionDate,
                Number,
                Quantity: Ready
            }
        });

        return {
            success: true,
            status: 200,
            message: 'Actualizado exitosamente',
            data: resultData
        };

    } catch (error) {
        await client.query('ROLLBACK');

        if (error.code === '23505') {
            return {
                success: false,
                status: 409,
                message: 'Ya existe un registro con ese código',
                data: null
            };
        }

        throw error;
    } finally {
        client.release();
    }
}

module.exports = { woCompletedHandler };
