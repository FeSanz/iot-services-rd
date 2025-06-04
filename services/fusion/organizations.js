const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//Obtener todas las organizaciones
router.get('/organizations', async (req, res) => {
    try {
        const result = await pool.query(`SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId"
                                         FROM MES_ORGANIZATIONS
                                         ORDER BY name ASC`);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });

    } catch (error) {
        console.error('Error al obtener organizaciones: ', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al obtener organizaciones: ' + error.message,
            totalResults: 0,
            items: null
        });
    }
});

// Obtener una organización por ID
router.get('/organizations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(`SELECT organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId" 
                                         FROM MES_ORGANIZATIONS
                                         WHERE organization_id = $1`, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Organización no encontrada',
                totalResults: 0,
                items: null
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: 1,
            items: result.rows[0]
        });

    } catch (error) {
        console.error('Error al obtener organización: ', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al obtener organización: ' + error.message,
            totalResults: 0,
            items: null
        });
    }
});

// Insertar nueva organización
/*router.post('/organizations', async (req, res) => {
    try {
        const { OrganizationId, Code, Name, Location, WorkMethod, BUId } = req.body;

        // Validación básica
        if (!OrganizationId || !Code || !Name) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Los campos Id, Código y Nombre son requeridos',
                totalResults: 0,
                items: null
            });
        }

        // Verificar si ya existe una organización con ese ID
        const checkResult = await pool.query('SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id = $1', [OrganizationId]);

        if (checkResult.rows.length > 0) {
            return res.status(409).json({
                errorsExistFlag: true,
                message: `Ya existe una organización con ese ID [${OrganizationId}]`,
                totalResults: 0,
                items: null
            });
        }

        const result = await pool.query(`INSERT INTO MES_ORGANIZATIONS (organization_id, code, name, location, work_method, bu_id)
                                        VALUES ($1, $2, $3, $4, $5, $6)
                                        RETURNING organization_id AS "OrganizationId", code AS "Code", name AS "Name", location AS "Location", work_method AS "WorkMethod", bu_id AS "BUId"`,
                                        [OrganizationId, Code, Name, Location, WorkMethod, BUId]);

        res.status(201).json({
            errorsExistFlag: false,
            message: 'Organización creada exitosamente',
            totalResults: 1,
            items: result.rows[0]
        });

    } catch (error) {
        console.error('Error al insertar organización: ', error);

        // Manejar error de código duplicado (si existe constraint unique)
        if (error.code === '23505') {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'Ya existe una organización con ese código',
                totalResults: 0,
                items: null
            });
        }

        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar organización: ' + error.message,
            totalResults: 0,
            items: null
        });
    }
});*/

router.post('/organizations', async (req, res) => {
    try {
        const organizations = req.body.items || [];

        if (organizations.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron organizaciones',
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
                message: 'Todas las organizaciones ya existen',
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
            message: `Organizaciones registradas [${newOrganizations.length} ]`,
            totalResults: newOrganizations.length,
        });

    } catch (error) {
        console.error('Error al insertar organizaciones:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar organizaciones: ' + error.message,
            totalResults: 0
        });
    }
});


// Actualizar organización
router.put('/organizations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { Code, Name, Location, WorkMethod, BUId } = req.body;

        // Validación básica
        if (!Code || !Name) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Los campos Code y Name son requeridos',
                totalResults: 0,
                items: null
            });
        }

        // Verificar si la organización existe
        const checkResult = await pool.query('SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Organización no encontrada',
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
            message: 'Organización actualizada exitosamente',
            totalResults: 1,
            items: result.rows[0]
        });

    } catch (error) {
        console.error('Error al actualizar organización: ', error);

        // Manejar error de código duplicado
        if (error.code === '23505') {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'Ya existe una organización con ese código',
                totalResults: 0,
                items: null
            });
        }

        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar organización: ' + error.message,
            totalResults: 0,
            items: null
        });
    }
});

// Eliminar organización
router.delete('/organizations/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si la organización existe
        const checkResult = await pool.query('SELECT organization_id FROM MES_ORGANIZATIONS WHERE organization_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Organización no encontrada',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_ORGANIZATIONS WHERE organization_id = $1', [id]);

        res.json({
            errorsExistFlag: false,
            message: 'Organización eliminada exitosamente',
            totalResults: 0
        });

    } catch (error) {
        console.error('Error al eliminar organización: ', error);

        // Manejar error de constraint de foreign key
        if (error.code === '23503') {
            return res.status(409).json({
                errorsExistFlag: true,
                message: 'No se puede eliminar la organización porque está siendo utilizada por otros registros',
                totalResults: 0
            });
        }

        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al eliminar organización: ' + error.message,
            totalResults: 0
        });
    }
});

//Exportar el router
module.exports = router;