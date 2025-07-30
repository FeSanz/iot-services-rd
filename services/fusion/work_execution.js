const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {notifyWorkOrdersAdvance} = require("../websocket/websocket");

//Actualizar Completado OT
router.put('/woCompleted/:organizationId', async (req, res) => {
    try {
        const { organizationId } = req.params;
        const { WorkOrderNumber, ExecutionDate, Number, Ready, Scrap, Reject, Tare, Container } = req.body;

        // Validación de datos importantes
        if (!WorkOrderNumber || !ExecutionDate || !Ready || !Number) {
            return res.status(400).json({
                errorsExistFlag: false,
                message: 'Faltan campos requeridos [OT, Fecha, Número, Cantidad]',
                totalResults: 0,
                items: null
            });
        }

        // Validar que Ready sea un número válido
        const readyCompleted = parseFloat(Ready);
        if (isNaN(readyCompleted) || readyCompleted <= 0) {
            return res.status(400).json({
                errorsExistFlag: false,
                message: 'La cantidad completada debe ser un número positivo',
                totalResults: 0,
                items: null
            });
        }

        // Verificar si la OT existe
        const workOrderDB = await pool.query('SELECT work_order_id, planned_quantity, completed_quantity FROM MES_WORK_ORDERS WHERE organization_id = $1 AND work_order_number = $2', [organizationId, WorkOrderNumber]);

        if (workOrderDB.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: false,
                message: 'Orden no encontrada',
                totalResults: 0,
                items: null
            });
        }

        const workOrder = workOrderDB.rows[0];
        // Verificar si el numero de producto ya fue registrado
        const existingExecution  = await pool.query('SELECT work_execution_id FROM MES_WORK_EXECUTION WHERE work_order_id = $1 AND number = $2', [workOrder.work_order_id, Number]);

        if (existingExecution.rows.length > 0) {
            return res.status(404).json({
                errorsExistFlag: false,
                message: 'El número de producto ya fue registrado',
                totalResults: 0,
                items: null
            });
        }

        const completed_total = parseFloat(workOrder.completed_quantity || 0) + readyCompleted;
        if (completed_total <= parseFloat(workOrder.planned_quantity || 0)) {
            // Insertar nueva ejecución
            const insertWorkExecution = await pool.query(`
                INSERT INTO MES_WORK_EXECUTION (work_order_id, execution_date, number, ready, scrap, reject, tare, container)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING work_execution_id`,
                [workOrder.work_order_id, ExecutionDate, Number, readyCompleted, Scrap || 0, Reject || 0, Tare || 0, Container || 0]);

            // Determinar el nuevo estado
            const newStatus = completed_total === parseFloat(workOrder.planned_quantity || 0) ? "COMPLETED" : "IN_PROCESS";

            // Actualizar la orden de trabajo
            const result = await pool.query(`
                UPDATE MES_WORK_ORDERS
                SET completed_quantity = $1, status = $2
                WHERE work_order_id = $3
                RETURNING work_order_id AS "WorkOrderId", completed_quantity AS "CompletedQuantity", status AS "Status"`,
                [completed_total, newStatus, workOrder.work_order_id]);

            notifyWorkOrdersAdvance(organizationId, {
                totalResults: 1,
                items: {
                    WorkOrderId: result.rows[0].WorkOrderId,
                    CompletedQuantity: result.rows[0].CompletedQuantity,
                    Status: result.rows[0].Status,
                    ExecutionDate: ExecutionDate,
                    Number: Number,
                    Quantity: Ready,
                }
            });

            res.json({
                errorsExistFlag: false,
                message: 'Actualizado exitosamente',
                totalResults: 1,
                items: result.rows[0]
            });
        } else {
            // La cantidad excede lo planificado
            return res.status(400).json({
                errorsExistFlag: false,
                message: `La cantidad completada (${completed_total}) excede la cantidad planificada (${workOrder.planned_quantity})`,
                totalResults: 0,
                items: null
            });
        }

    } catch (error) {
        console.error('Error al actualizar: ', error);

        // Manejar error de código duplicado
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

module.exports = router;