const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByIdFromDB} = require("../../models/sql-execute");

//Obtener todas los registros
router.get('/organizations', async (req, res) => {

    const sqlQuery = `SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId"
                             FROM MES_ORGANIZATIONS
                             ORDER BY name ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener un registro por ID
router.get('/organizations/:id', async (req, res) => {
    const { id } = req.params;
    const sqlQuery  = `SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId" 
                             FROM MES_ORGANIZATIONS
                             WHERE organization_id = $1`;

    const result = await selectByIdFromDB(sqlQuery, id);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/organizations', async (req, res) => {
    try {
        const organizations = req.body.items || [];

        if (organizations.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos',
                totalResults: 0
            });
        }

        // Obtener IDs existentes
        const orgIds = organizations.map(org => org.OrganizationId);
        const existingResult = await pool.query(
            'SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id = ANY($1)',
            [orgIds]
        );
        const existingIds = new Set(existingResult.rows.map(row => row.organization_id));

        // Filtrar organizaciones nuevas
        const newOrganizations = organizations.filter(org => !existingIds.has(org.OrganizationId));

        if (newOrganizations.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = newOrganizations.map((org, index) => {
            const base = index * 6;
            values.push(org.OrganizationId, org.Code, org.Name, org.Location, org.WorkMethod, org.BUId);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        await pool.query(`
            INSERT INTO MES_ORGANIZATIONS (organization_id, code, name, location, work_method, bu_id)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${newOrganizations.length}]`,
            totalResults: newOrganizations.length,
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