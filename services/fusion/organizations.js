const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const { selectFromDB, selectByParamsFromDB } = require("../../models/sql-execute");
const authenticateToken = require('../../middleware/authenticateToken');

//Obtener todas los registros
router.get('/organizations', authenticateToken, async (req, res) => {

    const sqlQuery = `SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId", 
                            coordinates AS "Coordinates", company_id AS "CompanyId"
                             FROM MES_ORGANIZATIONS
                             ORDER BY name ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por compañia
router.get('/organizations/:company', authenticateToken, async (req, res) => {
    const { company } = req.params;
    const sqlQuery = `SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", 
                                bu_id AS "BUId", coordinates AS "Coordinates", company_id AS "CompanyId"
                              FROM MES_ORGANIZATIONS
                              WHERE company_id = $1 ORDER BY code ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [company]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/organizations', authenticateToken, async (req, res) => {
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
        const companyRecieved = payload.map((element) => element.CompanyId);
        const orgExistResult = await pool.query('SELECT code FROM MES_ORGANIZATIONS WHERE code = ANY($1) AND company_id = ANY($2)', [orgRecieved, companyRecieved]);
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
        let paramIndex = 1;

        const placeholders = orgNews.map((py, index) => {
            const rowPlaceholders = [];            

            values.push(py.CompanyId, py.Code, py.Name, py.Location, py.WorkMethod, py.BUId);

            for (let i = 0; i < 6; i++) {
                rowPlaceholders.push(`$${paramIndex++}`);
            }

            const hasValidCoordinates =
                py.Coordinates &&
                typeof py.Coordinates === 'object' &&
                py.Coordinates.lng != null &&
                py.Coordinates.lat != null;

            if (hasValidCoordinates) {
                values.push(py.Coordinates.lng, py.Coordinates.lat);
                rowPlaceholders.push(`point($${paramIndex}, $${paramIndex + 1})`);
                paramIndex += 2;                
            } else {                
                rowPlaceholders.push(`NULL`);                
            }

            return `(${rowPlaceholders.join(', ')})`;

        });

        const result = await pool.query(`
            INSERT INTO MES_ORGANIZATIONS (company_id, code, name, location, work_method, bu_id, coordinates)
            VALUES ${placeholders.join(', ')} RETURNING organization_id
        `, values);

        const insertedIds = result.rows.map(row => row.organization_id);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${orgNews.length}]`,
            totalResults: orgNews.length,
            insertedIds: insertedIds
        });

    } catch (error) {
        console.error('Error al insertar dato:', error);
        await pool.query(`ROLLBACK`);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar dato: ' + error.message,
            totalResults: 0
        });
    }
});


// Actualizar registro por ID
router.put('/organizations/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { Code, Name, Location, WorkMethod, BUId, Coordinates } = req.body;

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
                                        SET code = $1, name = $2, location = $3, work_method = $4, bu_id = $5, coordinates = $7
                                        WHERE organization_id = $6
                                        RETURNING organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId"`,
            [Code, Name, Location, WorkMethod, BUId, id, Coordinates]);

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
router.delete('/organizations/:id', authenticateToken, async (req, res) => {
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

//Eliminar múltiples registros
router.delete('/organizations', authenticateToken, async (req, res) => {
    try {
        const organizationsId = req.body.items.map(item => item.OrganizationId);
        const placeholders = organizationsId.map((_, index) => `$${index + 1}`).join(', ');

        // Verificar si el registro existe
        const checkResult = await pool.query(`SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id in (${placeholders})`, organizationsId);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registros no encontrados',
                totalResults: 0
            });
        }
        
        await pool.query(`DELETE FROM MES_ORGANIZATIONS WHERE organization_id in (${placeholders})`, organizationsId);

        res.json({
            errorsExistFlag: false,
            message: 'Eliminación exitosa',
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