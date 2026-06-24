const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const { selectByParamsFromDB } = require('../../models/sql-execute');
const authenticateToken = require('../../middleware/authenticateToken');

// Deriva el status a partir del conteo de errores y el desglose por sección
function deriveStatus(errorsCount, errorsByPayload) {
    if (!errorsCount || errorsCount === 0) return 'SUCCESS';
    const hasSuccessfulSection = errorsByPayload &&
        Object.values(errorsByPayload).some(v => v === 0);
    return hasSuccessfulSection ? 'PARTIAL_ERROR' : 'ERROR';
}

// Guardar snapshot de despacho (resultado del envío a Oracle realizado por el frontend)
router.post('/workDispatch/batch', authenticateToken, async (req, res) => {
    const {
        WorkOrderId,
        WorkOrderNumber,
        OrganizationId,
        OrganizationCode,
        WorkExecutionIds,
        CreatedBy,
        ErrorsCount,
        ErrorsByPayload,
        Operations,
        Resources,
        Materials,
        Outputs
    } = req.body;

    if (!WorkOrderId || !WorkOrderNumber || !OrganizationCode) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'WorkOrderId, WorkOrderNumber y OrganizationCode son requeridos',
            totalResults: 0,
            items: null
        });
    }

    const hasContent = [Operations, Resources, Materials, Outputs]
        .some(arr => Array.isArray(arr) && arr.length > 0);

    if (!hasContent) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Se requiere al menos un elemento en Operations, Resources, Materials u Outputs',
            totalResults: 0,
            items: null
        });
    }

    const executionIds = Array.isArray(WorkExecutionIds) && WorkExecutionIds.length > 0
        ? WorkExecutionIds
        : null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (executionIds) {
            // 1. Validar que todos los WorkExecutionIds existen, pertenecen a la OT y están pendientes (status = 0)
            const { rows: execRows } = await client.query(
                `SELECT work_execution_id, status
                 FROM mes_work_execution
                 WHERE work_execution_id = ANY($1)
                   AND work_order_id = $2`,
                [executionIds, WorkOrderId]
            );

            if (execRows.length !== executionIds.length) {
                const foundIds = execRows.map(r => r.work_execution_id);
                const missingIds = executionIds.filter(id => !foundIds.includes(id));
                await client.query('ROLLBACK');
                return res.status(400).json({
                    errorsExistFlag: true,
                    message: `Los siguientes WorkExecutionIds no existen o no pertenecen a la orden ${WorkOrderNumber}: [${missingIds.join(', ')}]`,
                    totalResults: 0,
                    items: null
                });
            }

            // status = 0 o NULL se considera pendiente; cualquier otro valor ya fue procesado
            const alreadyProcessed = execRows
                .filter(r => r.status !== 0 && r.status !== null)
                .map(r => r.work_execution_id);

            if (alreadyProcessed.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    errorsExistFlag: true,
                    message: `Los siguientes WorkExecutionIds ya fueron procesados: [${alreadyProcessed.join(', ')}]`,
                    totalResults: 0,
                    items: null
                });
            }

            // 2. Marcar ejecuciones como procesadas (status 0 o NULL → 1)
            await client.query(
                `UPDATE mes_work_execution
                 SET status = 1
                 WHERE work_execution_id = ANY($1)
                   AND work_order_id = $2
                   AND (status = 0 OR status IS NULL)`,
                [executionIds, WorkOrderId]
            );
        }

        // 3. Sumar la cantidad despachada desde las operaciones y actualizar mes_work_orders
        if (Array.isArray(Operations) && Operations.length > 0) {
            const totalDispatchedQuantity = Operations.reduce(
                (sum, op) => sum + (Number(op.TransactionQuantity) || 0), 0
            );

            if (totalDispatchedQuantity > 0) {
                await client.query(
                    `UPDATE mes_work_orders
                     SET dispatched_quantity = COALESCE(dispatched_quantity, 0) + $2
                     WHERE work_order_id = $1`,
                    [WorkOrderId, totalDispatchedQuantity]
                );
            }
        }

        // 4. Registrar el snapshot completo del despacho
        const status = deriveStatus(ErrorsCount, ErrorsByPayload);

        const { rows } = await client.query(`
            INSERT INTO mes_work_dispatch (
                work_order_id, organization_id, work_execution_ids,
                status, errors_count, errors_by_payload, request_payload, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING
                work_dispatch_id    AS "WorkDispatchId",
                work_order_id       AS "WorkOrderId",
                organization_id     AS "OrganizationId",
                work_execution_ids  AS "WorkExecutionIds",
                status              AS "Status",
                errors_count        AS "ErrorsCount",
                errors_by_payload   AS "ErrorsByPayload",
                created_date        AS "CreatedDate",
                created_by          AS "CreatedBy"`,
            [
                WorkOrderId,
                OrganizationId ?? null,
                JSON.stringify(executionIds ?? []),
                status,
                ErrorsCount ?? 0,
                ErrorsByPayload ? JSON.stringify(ErrorsByPayload) : null,
                JSON.stringify(req.body),
                CreatedBy ?? null
            ]
        );

        await client.query('COMMIT');

        res.status(201).json({
            errorsExistFlag: false,
            message: `Despacho registrado con status: ${status}`,
            totalResults: 1,
            items: rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[DISPATCH] Error al guardar despacho:', error.message);
        res.status(500).json({
            errorsExistFlag: true,
            message: error.message,
            totalResults: 0,
            items: null
        });
    } finally {
        client.release();
    }
});

// Obtener despachos por orden de trabajo
router.get('/workDispatch/byWorkOrder/:workOrderId', authenticateToken, async (req, res) => {
    const { workOrderId } = req.params;
    const sqlQuery = `
        SELECT
            wd.work_dispatch_id     AS "WorkDispatchId",
            wd.work_order_id        AS "WorkOrderId",
            wo.work_order_number    AS "WorkOrderNumber",
            wd.organization_id      AS "OrganizationId",
            wd.work_execution_ids   AS "WorkExecutionIds",
            wd.status               AS "Status",
            wd.errors_count         AS "ErrorsCount",
            wd.errors_by_payload    AS "ErrorsByPayload",
            wd.request_payload      AS "RequestPayload",
            wd.created_date         AS "CreatedDate",
            wd.created_by           AS "CreatedBy",
            wd.updated_date         AS "UpdatedDate"
        FROM mes_work_dispatch wd
        INNER JOIN mes_work_orders wo ON wo.work_order_id = wd.work_order_id
        WHERE wd.work_order_id = $1
        ORDER BY wd.created_date DESC`;

    const result = await selectByParamsFromDB(sqlQuery, [workOrderId]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener despachos por organización con filtro opcional de Status
router.get('/workDispatch/byOrganization/:organizationId', authenticateToken, async (req, res) => {
    const { organizationId } = req.params;
    const { Status } = req.query;

    const params = [organizationId];
    let filters = '';

    if (Status) {
        const statusValidos = ['SUCCESS', 'PARTIAL_ERROR', 'ERROR'];
        if (!statusValidos.includes(Status)) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: `Status inválido. Valores permitidos: ${statusValidos.join(', ')}`,
                totalResults: 0,
                items: null
            });
        }
        params.push(Status);
        filters += ` AND wd.status = $${params.length}`;
    }

    const sqlQuery = `
        SELECT
            wd.work_dispatch_id     AS "WorkDispatchId",
            wd.work_order_id        AS "WorkOrderId",
            wo.work_order_number    AS "WorkOrderNumber",
            wd.organization_id      AS "OrganizationId",
            wd.work_execution_ids   AS "WorkExecutionIds",
            wd.status               AS "Status",
            wd.errors_count         AS "ErrorsCount",
            wd.errors_by_payload    AS "ErrorsByPayload",
            wd.created_date         AS "CreatedDate",
            wd.updated_date         AS "UpdatedDate"
        FROM mes_work_dispatch wd
        INNER JOIN mes_work_orders wo ON wo.work_order_id = wd.work_order_id
        WHERE wd.organization_id = $1
        ${filters}
        ORDER BY wd.created_date DESC`;

    const result = await selectByParamsFromDB(sqlQuery, params);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Historial de despachos por organización con intervalo predefinido
router.get('/workDispatch/history/:organizationId/interval/:interval', authenticateToken, async (req, res) => {
    const { organizationId, interval } = req.params;
    const { Status } = req.query;

    let dateFilter = '';
    switch (interval) {
        case 'today':
            dateFilter = "AND wd.created_date >= CURRENT_DATE AND wd.created_date < CURRENT_DATE + INTERVAL '1 day'";
            break;
        case '7days':
            dateFilter = "AND wd.created_date >= CURRENT_DATE - INTERVAL '7 days'";
            break;
        case 'week':
            dateFilter = "AND wd.created_date >= DATE_TRUNC('week', CURRENT_DATE)";
            break;
        case '30days':
            dateFilter = "AND wd.created_date >= CURRENT_DATE - INTERVAL '30 days'";
            break;
        case 'month':
            dateFilter = "AND wd.created_date >= DATE_TRUNC('month', CURRENT_DATE)";
            break;
        default:
            return res.status(400).json({ errorsExistFlag: true, message: 'Intervalo no válido. Use: today, 7days, week, 30days, month', totalResults: 0, items: null });
    }

    const params = [organizationId];
    let statusFilter = '';
    if (Status) {
        const validStatus = ['SUCCESS', 'PARTIAL_ERROR', 'ERROR'];
        if (!validStatus.includes(Status)) {
            return res.status(400).json({ errorsExistFlag: true, message: `Status inválido. Valores permitidos: ${validStatus.join(', ')}`, totalResults: 0, items: null });
        }
        params.push(Status);
        statusFilter = `AND wd.status = $${params.length}`;
    }

    // Filtrar primero por organización en mes_work_orders (usa idx_work_orders_org),
    // luego unir despachos — evita scan completo en mes_work_dispatch
    const sqlQuery = `
        SELECT
            wd.work_dispatch_id                                         AS "WorkDispatchId",
            wo.work_order_id                                            AS "WorkOrderId",
            wo.work_order_number                                        AS "WorkOrderNumber",
            wo.item_id                                                  AS "ItemId",
            i.number                                                    AS "ItemNumber",
            i.description                                               AS "Description",
            i.uom                                                       AS "UoM",
            wd.status                                                   AS "Status",
            wd.errors_count                                             AS "ErrorsCount",
            wd.errors_by_payload                                        AS "ErrorsByPayload",
            wd.work_execution_ids                                       AS "WorkExecutionIds",
            wd.created_date                                             AS "CreatedDate",
            wd.created_by                                               AS "CreatedBy",
            u.name                                                      AS "CreatedByName",
            (SELECT COALESCE(SUM((op->>'TransactionQuantity')::numeric), 0)
             FROM jsonb_array_elements(wd.request_payload->'Operations') AS op) AS "DispatchedQuantity"
        FROM mes_work_orders wo
        INNER JOIN mes_work_dispatch wd ON wd.work_order_id = wo.work_order_id
        LEFT JOIN mes_items i ON i.item_id = wo.item_id
        LEFT JOIN mes_users u ON u.user_id = wd.created_by
        WHERE wo.organization_id = $1
          ${dateFilter}
          ${statusFilter}
        ORDER BY wo.work_order_id, wd.created_date DESC`;

    const result = await selectByParamsFromDB(sqlQuery, params);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Historial de despachos por organización con rango de fechas específico
router.get('/workDispatch/history/:organizationId/between/:startDate/:endDate', authenticateToken, async (req, res) => {
    const { organizationId, startDate, endDate } = req.params;
    const { Status } = req.query;

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
        return res.status(400).json({ errorsExistFlag: true, message: 'Formato de fecha inválido. Use YYYY-MM-DD', totalResults: 0, items: null });
    }

    // $2 = startDate (inclusive), $3 = endDate (inclusive hasta fin del día)
    const params = [organizationId, startDate, endDate];
    let statusFilter = '';
    if (Status) {
        const validStatus = ['SUCCESS', 'PARTIAL_ERROR', 'ERROR'];
        if (!validStatus.includes(Status)) {
            return res.status(400).json({ errorsExistFlag: true, message: `Status inválido. Valores permitidos: ${validStatus.join(', ')}`, totalResults: 0, items: null });
        }
        params.push(Status);
        statusFilter = `AND wd.status = $${params.length}`;
    }

    const sqlQuery = `
        SELECT
            wd.work_dispatch_id                                         AS "WorkDispatchId",
            wo.work_order_id                                            AS "WorkOrderId",
            wo.work_order_number                                        AS "WorkOrderNumber",
            wo.item_id                                                  AS "ItemId",
            i.number                                                    AS "ItemNumber",
            i.description                                               AS "Description",
            i.uom                                                       AS "UoM",
            wd.status                                                   AS "Status",
            wd.errors_count                                             AS "ErrorsCount",
            wd.errors_by_payload                                        AS "ErrorsByPayload",
            wd.work_execution_ids                                       AS "WorkExecutionIds",
            wd.created_date                                             AS "CreatedDate",
            wd.created_by                                               AS "CreatedBy",
            u.name                                                      AS "CreatedByName",
            (SELECT COALESCE(SUM((op->>'TransactionQuantity')::numeric), 0)
             FROM jsonb_array_elements(wd.request_payload->'Operations') AS op) AS "DispatchedQuantity"
        FROM mes_work_orders wo
        INNER JOIN mes_work_dispatch wd ON wd.work_order_id = wo.work_order_id
        LEFT JOIN mes_items i ON i.item_id = wo.item_id
        LEFT JOIN mes_users u ON u.user_id = wd.created_by
        WHERE wo.organization_id = $1
          AND wd.created_date >= $2::date
          AND wd.created_date <  $3::date + INTERVAL '1 day'
          ${statusFilter}
        ORDER BY wo.work_order_id, wd.created_date DESC`;

    const result = await selectByParamsFromDB(sqlQuery, params);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener detalle de un despacho por ID
router.get('/workDispatch/:workDispatchId', authenticateToken, async (req, res) => {
    const { workDispatchId } = req.params;
    const sqlQuery = `
        SELECT
            wd.work_dispatch_id     AS "WorkDispatchId",
            wd.work_order_id        AS "WorkOrderId",
            wo.work_order_number    AS "WorkOrderNumber",
            wd.organization_id      AS "OrganizationId",
            wd.work_execution_ids   AS "WorkExecutionIds",
            wd.status               AS "Status",
            wd.errors_count         AS "ErrorsCount",
            wd.errors_by_payload    AS "ErrorsByPayload",
            wd.request_payload      AS "RequestPayload",
            wd.created_date         AS "CreatedDate",
            wd.created_by           AS "CreatedBy",
            wd.updated_date         AS "UpdatedDate"
        FROM mes_work_dispatch wd
        INNER JOIN mes_work_orders wo ON wo.work_order_id = wd.work_order_id
        WHERE wd.work_dispatch_id = $1`;

    const result = await selectByParamsFromDB(sqlQuery, [workDispatchId]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

module.exports = router;
