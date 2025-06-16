const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");

//Obtener todas los registros
router.get('/items', async (req, res) => {

    const sqlQuery = `SELECT item_id AS "ItemId", number AS "Number", description AS "Description",
                                    uom AS "UoM", type AS "Type", lot_control AS "LotControl"
                             FROM MES_ITEMS
                             ORDER BY number ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por tipo
router.get('/items/:type', async (req, res) => {
    const { type } = req.params;
    const sqlQuery  = `SELECT item_id AS "ItemId", number AS "Number", description AS "Description",
                              uom AS "UoM", type AS "Type", lot_control AS "LotControl"  
                              FROM MES_ITEMS 
                              WHERE type = $1 ORDER BY number ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [type]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/items', async (req, res) => {
    try {
        const dataFromDB = req.body.items || [];

        if (dataFromDB.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos',
                totalResults: 0
            });
        }

        // Obtener IDs existentes
        const ids = dataFromDB.map((element) => element.ItemId);
        const existingResult = await pool.query('SELECT item_id FROM MES_ITEMS WHERE item_id = ANY($1)', [ids]);
        const existingIds = new Set(existingResult.rows.map(row => row.item_id));

        // Filtrar organizaciones nuevas
        const newItemsDB = dataFromDB.filter(element => !existingIds.has(element.ItemId));

        if (newItemsDB.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = newItemsDB.map((py, index) => {
            const base = index * 6;
            values.push(py.ItemId, py.Number, py.Description, py.UoM, py.Type, py.LotControl);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        await pool.query(`
            INSERT INTO MES_ITEMS (item_id, number, description, uom, type, lot_control)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${newItemsDB.length}]`,
            totalResults: newItemsDB.length,
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


// Eliminar registro por ID
router.delete('/items/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT item_id FROM MES_ITEMS WHERE item_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_ITEMS WHERE item_id = $1', [id]);

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