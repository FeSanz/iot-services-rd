const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");

//Obtener todas los registros
router.get('/organizations', async (req, res) => {

    const sqlQuery = `SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId", 
                            coordinates AS "Coordinates", company_id AS "CompanyId"
                             FROM MES_ORGANIZATIONS
                             ORDER BY name ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por compañia
router.get('/organizations/:company', async (req, res) => {
    const { company } = req.params;
    const sqlQuery  = `SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", 
                                bu_id AS "BUId", coordinates AS "Coordinates"
                              FROM MES_ORGANIZATIONS
                              WHERE company_id = $1 ORDER BY code ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [company]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/organizations', async (req, res) => {
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
        const orgRecieved = payload.map((element) => element.Code);
        const orgExistResult = await pool.query('SELECT code FROM MES_ORGANIZATIONS WHERE code = ANY($1)', [orgRecieved]);
        const orgExisting = new Set(orgExistResult.rows.map(row => row.code));

        // Filtrar organizaciones nuevas
        const orgNews = payload.filter(element => !orgExisting.has(element.Code));

        if (orgNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = orgNews.map((py, index) => {
            const base = index * 7;
            values.push(py.CompanyId, py.Code, py.Name, py.Location, py.WorkMethod, py.BUId, py.Coordinates);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });

        await pool.query(`
            INSERT INTO MES_ORGANIZATIONS (company_id, code, name, location, work_method, bu_id, coordinates)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${orgNews.length}]`,
            totalResults: orgNews.length,
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


// Actualizar registro por ID
router.put('/organizations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { Code, Name, Location, WorkMethod, BUId } = req.body;

        // Validación básica
        if (!Code || !Name) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Faltan campos requeridos',
                totalResults: 0,
                items: null
            });
        }

        // Verificar si la organización existe
        const checkResult = await pool.query('SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0,
                items: null
            });
        }

        const result = await pool.query(`UPDATE MES_ORGANIZATIONS 
                                        SET code = $1, name = $2, location = $3, work_method = $4, bu_id = $5
                                        WHERE organization_id = $6
                                        RETURNING organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId"`,
                                        [Code, Name, Location, WorkMethod, BUId, id]);

        res.json({
            errorsExistFlag: false,
            message: 'Actualizado exitosamente',
            totalResults: 1,
            items: result.rows[0]
        });

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

// Eliminar registro por ID
router.delete('/organizations/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_ORGANIZATIONS WHERE organization_id = $1', [id]);

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