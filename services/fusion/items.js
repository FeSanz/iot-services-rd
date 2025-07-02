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

// Obtener registros por compañoa y tipo
router.get('/items/:company/:type', async (req, res) => {
    const { company, type } = req.params;

    // Validaciones
    if (!company && !type) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Datos de compañía y tipo son requeridos',
            totalResults: 0
        });
    }

    const baseQuery = `SELECT item_id AS "ItemId", company_id AS "Company", number AS "Number", description AS "Description",
                                     uom AS "UoM", type AS "Type", lot_control AS "LotControl"
                              FROM MES_ITEMS
                              WHERE company_id= $1 ORDER BY number ASC`;
    let sqlQuery;
    let queryParams;

    if (type === 'Todos') {
        sqlQuery = `${baseQuery} ORDER BY number ASC`;
        queryParams = [company];
    } else {
        sqlQuery = `${baseQuery} AND type = $2 ORDER BY number ASC`;
        queryParams = [company, type];
    }

    const result = await selectByParamsFromDB(sqlQuery, queryParams);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/items', async (req, res) => {
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
        const itemsExistResult = await pool.query(`SELECT number FROM MES_ITEMS 
                                                        WHERE company_id= $1 AND number = ANY($2)`,
                                                   [CompanyId, itemsReceived]);
        const itemsExisting = new Set(itemsExistResult.rows.map(row => row.number));

        // Filtrar articulos nuevos
        const itemsNews = payload.filter(element => !itemsExisting.has(element.Number));

        if (itemsNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = itemsNews.map((py, index) => {
            const base = index * 6;
            values.push(py.Number, py.Description, py.UoM, py.Type, py.LotControl, CompanyId);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        await pool.query(`
            INSERT INTO MES_ITEMS (number, description, uom, type, lot_control, company_id)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${itemsNews.length}]`,
            totalResults: itemsNews.length,
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