const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");

// Obtener registros por organizacion y estado
router.get('/workOrders/:organization/:statusOrder', async (req, res) => {
    const { organization, statusOrder } = req.params;
    const sqlQuery  = `SELECT work_order_id AS "WorkOrderId", organization_id AS "OrganizationId", machine_id AS "MachineId",
                                     work_order_number AS "WorkOrderNumber", work_definition_id AS "WorkDefinitionId",
                                     item_id AS "ItemId", planned_quantity AS "PlannedQuantity", completed_quantity "CompletedQuantity",
                                     start_date AS "StartDate", end_date AS "CompletionDate"
                              FROM MES_WORK_ORDERS 
                              WHERE organization_id = $1 AND status = $2`;

    const result = await selectByParamsFromDB(sqlQuery, [organization, statusOrder]);
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

        // Obtener IDs existentes
        const ids = payload.map((element) => element.WorkOrderId);
        const existingResult = await pool.query('SELECT work_order_id FROM MES_WORK_ORDERS WHERE work_order_id = ANY($1)', [ids]);
        const existingIds = new Set(existingResult.rows.map(row => row.work_order_id));

        // Filtrar ordenes nuevas
        const newItemsDB = payload.filter(element => !existingIds.has(element.WorkOrderId));

        if (newItemsDB.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        const values = [];
        const placeholders = newItemsDB.map((py, index) => {
            const base = index * 11;
            values.push(py.WorkOrderId, py.OrganizationId, py.MachineId, py.WorkOrderNumber, py.WorkDefinitionId, py.ItemId,
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
            message: `Registrado exitosamente [${newItemsDB.length}]`,
            totalResults: newItemsDB.length,
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

//Exportar el router
module.exports = router;