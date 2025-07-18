const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectByParamsFromDB} = require("../../models/sql-execute");
const { notifyWorkOrderChanges } = require('../../services/websocket/websocket');
const {notifyWorkOrders} = require("../websocket/websocket");

// Obtener registros por organizacion y estado
router.get('/workOrders/:organization', async (req, res) => {
    const { organization } = req.params;
    const sqlQuery  = `SELECT
                               wo.work_order_id AS "WorkOrderId",
                               wo.work_order_number AS "WorkOrderNumber",
                               wo.work_definition_id AS "WorkDefinitionId",
                               wo.item_id AS "ItemId",
                               wo.planned_quantity AS "PlannedQuantity",
                               wo.dispatched_quantity AS "DispatchedQuantity",
                               wo.completed_quantity AS "CompletedQuantity",
                               wo.start_date AS "StartDate",
                               wo.end_date AS "CompletionDate",
                               wo."status"AS "Status",
                               wo.type AS "Type",
                               -- Datos de MES_MACHINES
                               wo.machine_id AS "ResourceId",
                               m.code AS "ResourceCode",
                               m.work_center_id AS "WorkCenterId",
                               m.work_center AS "WorkCenter",
                               -- Datos de MES_ITEMS
                               wo.item_id AS "ItemId",
                               i.number AS "ItemNumber",
                               i.description AS "Description",
                               i.uom AS "UoM"
                           FROM MES_WORK_ORDERS wo
                                    LEFT JOIN MES_MACHINES m ON wo.machine_id = m.machine_id
                                    LEFT JOIN MES_ITEMS i ON wo.item_id = i.item_id
                           WHERE wo.organization_id = $1
                             AND (wo.status = 'RELEASED' OR wo.status = 'IN_PROCESS')
                           ORDER BY wo.work_order_id ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/workOrders', async (req, res) => {
    try {
        const payload = req.body.items || [];

        if (payload.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos',
                totalResults: 0
            });
        }

        // Obtener existentes
        const ordersReceived = payload.map((element) => element.WorkOrderNumber);
        const ordersExistResult = await pool.query(`SELECT work_order_number FROM MES_WORK_ORDERS 
                                                    WHERE work_order_number = ANY($1)`,
                                                    [ordersReceived]);
        const ordersExisting = new Set(ordersExistResult.rows.map(row => row.work_order_number));

        // Filtrar ordenes nuevas
        const ordersNews = payload.filter(element => !ordersExisting.has(element.WorkOrderNumber));

        if (ordersNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        const values = [];
        const placeholders = ordersNews.map((py, index) => {
            const base = index * 12;
            values.push(py.OrganizationId, py.MachineId, py.WorkOrderNumber, py.WorkDefinitionId, py.ItemId,
                        py.PlannedQuantity, py.DispatchedQuantity, py.CompletedQuantity, py.Status, py.StartDate,
                        py.CompletionDate, py.Type);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 
                     $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
        });

        const insertResult = await pool.query(`
            INSERT INTO MES_WORK_ORDERS (organization_id, machine_id, work_order_number, work_definition_id, item_id,
                                         planned_quantity, dispatched_quantity, completed_quantity, status, start_date,
                                         end_date, type)
            VALUES ${placeholders.join(', ')}
                RETURNING work_order_id, organization_id, machine_id, work_order_number, item_id, planned_quantity, 
            dispatched_quantity, completed_quantity, status, start_date, end_date, work_definition_id, type
        `, values);

        // Obtener datos completos de las órdenes insertadas con JOIN para máquinas e ítems
        const workOrderIds = insertResult.rows.map(row => row.work_order_id);

        const completeOrdersResult = await pool.query(`
            SELECT 
                wo.work_order_id,
                wo.organization_id,
                wo.machine_id,
                wo.work_order_number,
                wo.item_id,
                wo.planned_quantity,
                wo.dispatched_quantity,
                wo.completed_quantity,
                wo.status,
                wo.start_date,
                wo.end_date,
                -- Datos de la máquina
                m.code as machine_code,
                m.name as machine_name,
                m.work_center_id,
                m.work_center,
                -- Datos del ítem/producto
                i.number as item_number,
                i.description as item_description,
                i.uom as item_uom
            FROM MES_WORK_ORDERS wo
            LEFT JOIN MES_MACHINES m ON wo.machine_id = m.machine_id
            LEFT JOIN MES_ITEMS i ON wo.item_id = i.item_id
            WHERE wo.work_order_id = ANY($1)
            ORDER BY wo.work_order_id
        `, [workOrderIds]);

        // Agrupar por organización y notificar
        const organizationIds = [...new Set(insertResult.rows.map(order => order.organization_id))];

        organizationIds.forEach(orgId => {
            const orgOrders = completeOrdersResult.rows.filter(row => row.organization_id === orgId);

            notifyWorkOrders(orgId, {
                totalResults: orgOrders.length,
                items: orgOrders.map(row => ({
                    OrganizationId: row.organization_id,
                    // Datos de la orden de trabajo
                    WorkOrderId: row.work_order_id,
                    WorkOrderNumber: row.work_order_number,
                    PlannedQuantity: row.planned_quantity,
                    DispatchedQuantity: row.dispatched_quantity,
                    CompletedQuantity: row.completed_quantity,
                    Status: row.status,
                    StartDate: row.start_date,
                    CompletionDate: row.end_date,
                    // Datos de la máquina
                    ResourceId: row.machine_id,
                    ResourceCode: row.machine_code,
                    WorkCenterId: row.work_center_id,
                    WorkCenter: row.work_center,
                    // Datos del ítem/producto
                    ItemId: row.item_id,
                    ItemNumber: row.item_number,
                    Description: row.item_description,
                    UoM: row.item_uom
                }))
            });
        });

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${ordersNews.length}]`,
            totalResults: ordersNews.length,
        });

    } catch (error) {
        console.error('Error al insertar datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar datos: ' + error.message,
            totalResults: 0
        });
    }
});


// Eliminar registro por ID
router.delete('/workOrders/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT work_order_id FROM MES_WORK_ORDERS WHERE work_order_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_WORK_ORDERS WHERE work_order_id = $1', [id]);

        res.json({
            errorsExistFlag: false,
            message: 'Eliminado exitosamente',
            totalResults: 0
        });

    } catch (error) {
        console.error('Error al eliminar : ', error);

        // Manejar error de constraint de foreign key
        if (error.code === '23503') {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'No se puede eliminar porque está siendo utilizado por otros registros',
                totalResults: 0
            });
        }

        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al eliminar: ' + error.message,
            totalResults: 0
        });
    }
});

//Consultar maquinas por orden
router.post('/workOrdersMachines', async (req, res) => {
    try {
        const payload = req.body.items || [];

        if (payload.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos',
                totalResults: 0
            });
        }

        // Obtener existentes
        const machinesReceived = payload.map((element) => element.MachineCode);
        const machinesExistResult = await pool.query('SELECT machine_id, code FROM MES_MACHINES WHERE code = ANY($1)', [machinesReceived]);
        const machinesMap = new Map(machinesExistResult.rows.map(row => [row.code, row.machine_id]));

        // Construir resultado solo con máquinas existentes
        const validMachines = [];

        payload.forEach(item => {
            const machineId = machinesMap.get(item.MachineCode);

            if (machineId) {
                validMachines.push({
                    MachineId: machineId,
                    Code: item.MachineCode,
                    workOrderNumber: item.WorkOrderNumber
                });
            }
        });

        res.status(201).json({
            errorsExistFlag: false,
            message: `Ok`,
            totalResults: validMachines.length,
            items: validMachines
        });

    } catch (error) {
        console.error('Error al procesar máquinas de OT:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error interno del servidor',
            totalResults: 0
        });
    }
});

//Obtener articulos de fabricacion por orden
router.post('/WorkOrdersItems', async (req, res) => {
    try {
        const { CompanyId, items } = req.body;
        const payload = items || [];

        // Validaciones
        if (!CompanyId) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionó el ID de compañia',
                totalResults: 0
            });
        }

        if (payload.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos',
                totalResults: 0
            });
        }

        // Obtener existentes
        const itemsReceived = payload.map((element) => element.Number);
        const itemsExistResult = await pool.query(`SELECT item_id AS "ItemId", number AS "Number" FROM MES_ITEMS 
                                                   WHERE company_id= $1 AND number = ANY($2)`,
                                                   [CompanyId, itemsReceived]);
        const itemsExisting = new Map(itemsExistResult.rows.map(row => [row.Number, row]));

        // Filtrar articulos nuevos
        const itemsNews = payload.filter(element => !itemsExisting.has(element.Number));

        // Insertar artículos nuevos si existen
        let newItemsWithIds = [];
        if (itemsNews.length > 0) {
            const values = [];
            const placeholders = itemsNews.map((py, index) => {
                const base = index * 4;
                values.push(py.Number, py.Description, py.UoM, CompanyId);
                return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
            });

            // Insertar y obtener los IDs generados
            const insertNewItems = await pool.query(`
                INSERT INTO MES_ITEMS (number, description, uom, company_id)
                VALUES ${placeholders.join(', ')}
                RETURNING item_id AS "ItemId", number AS "Number"
            `, values);

            newItemsWithIds = insertNewItems.rows;
        }

        // Construir respuesta combinanda existentes y nuevos
        const responseItems = payload.map(op => {
            // Buscar en existentes
            let foundItem = itemsExisting.get(op.Number);

            // Si no está en existentes, buscar en los recién insertados
            if (!foundItem) {
                foundItem = newItemsWithIds.find(newItem => newItem.Number === op.Number);
            }

            // Usar datos de la DB si existe, sino usar los enviados
            return {
                ItemId: foundItem ? foundItem.ItemId : null,
                Number: op.Number,
                WorkOrderNumber: op.WorkOrderNumber
            };
        });

        res.status(200).json({
            errorsExistFlag: false,
            message: itemsNews.length > 0 ?
                `Nuevos: ${itemsNews.length} , Existentes: ${payload.length - itemsNews.length} ` : `Todos existentes`,
            totalResults: payload.length,
            items: responseItems,
        });

    } catch (error) {
        console.error('Error al insertar dato:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar dato: ' + error.message,
            totalResults: 0
        });
    }
});


//Exportar el router
module.exports = router;