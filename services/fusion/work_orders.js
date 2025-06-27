const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");

// Obtener registros por organizacion y estado
router.get('/workOrders/:organization', async (req, res) => {
    const { organization } = req.params;
    const sqlQuery  = `SELECT work_order_id AS "WorkOrderId", organization_id AS "OrganizationId", machine_id AS "MachineId",
                                     work_order_number AS "WorkOrderNumber", work_definition_id AS "WorkDefinitionId",
                                     item_id AS "ItemId", planned_quantity AS "PlannedQuantity", completed_quantity "CompletedQuantity",
                                     start_date AS "StartDate", end_date AS "CompletionDate", type AS "Type" 
                              FROM MES_WORK_ORDERS 
                              WHERE organization_id = $1 AND status = 'RELEASED'`;

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
            const base = index * 11;
            values.push(py.OrganizationId, py.MachineId, py.WorkOrderNumber, py.WorkDefinitionId, py.ItemId,
                        py.PlannedQuantity, py.CompletedQuantity, py.Status, py.StartDate, py.CompletionDate);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 
                     $${base + 7}, $${base + 8}, $${base + 9}, 
                     TO_TIMESTAMP($${base + 10}, 'DD/MM/YYYY HH24:MI:SS'), 
                     TO_TIMESTAMP($${base + 11}, 'DD/MM/YYYY HH24:MI:SS'))`;
        });

        await pool.query(`
            INSERT INTO MES_WORK_ORDERS (work_order_id, organization_id, machine_id, work_order_number, work_definition_id, item_id,
                                         planned_quantity, completed_quantity, status, start_date, end_date)
            VALUES ${placeholders.join(', ')}
        `, values);

        //Articulos faltantes por registrar en la DB
        const itemsRecieved = payload.map((element) => element.ItemId);
        const itemsQuery = await pool.query('SELECT item_id FROM MES_ITEMS WHERE item_id = ANY($1)', [itemsRecieved]);
        const itemsExisting = new Set(itemsQuery.rows.map(row => row.item_id));
        const itemsMissing = payload.filter(element => !itemsExisting.has(element.ItemId))

        //Maquinas faltantes por registrar en la DB
        const resourcesRecieved = payload.map((element) => element.ItemId);
        const resourcesQuery = await pool.query('SELECT item_id FROM MES_ITEMS WHERE item_id = ANY($1)', [resourcesRecieved]);
        const resourcesExisting = new Set(resourcesQuery.rows.map(row => row.item_id));
        const resourcesMissing = payload.filter(element => !resourcesExisting.has(element.ItemId))

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${ordersNews.length}]`,
            totalResults: ordersNews.length,
            itemsMissing: itemsMissing,
            resourcesMissing: resourcesMissing
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
        const itemsExistResult = await pool.query(`SELECT item_id AS "ItemId", number AS "Number", description AS "Description", uom AS "UoM" 
                                                    FROM MES_ITEMS 
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
                RETURNING item_id AS "ItemId", number AS "Number", description AS "Description", uom AS "UoM"
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
                Description: foundItem ? foundItem.Description : op.Description,
                UoM: foundItem ? foundItem.UoM : op.UoM,
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