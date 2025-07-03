const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectByParamsFromDB} = require("../../models/sql-execute");

// Obtener registros por compañia
router.get('/settings/:company', async (req, res) => {
    const { company } = req.params;
    const sqlQuery  = `SELECT S.setting_id AS "SettingId", S.name AS "Name", S.value AS "Value", S.description AS "Description", S.type AS "Type",
                                S.status AS "Status", S.enabled_flag AS "EnabledFlag", S.created_by AS "CreatedBy", S.created_date AS "CreatedDate", 
                                S.updated_by AS "UpdatedBy", S.updated_date AS "UpdateDate" 
                              FROM MES_SETTINGS S 
                              WHERE S.company_id = $1 ORDER BY S.type ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [company]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/settings', async (req, res) => {
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
        const stgRecieved = payload.map((element) => element.value);
        const stgExistResult = await pool.query('SELECT S.value FROM MES_SETTING S WHERE  S.company_id = CompanyId AND S.name = Name AND S.value = ANY($1)', [stgRecieved]);
        const stgExisting = new Set(stgExistResult.rows.map(row => row.value));

        // Filtrar nuevos
        const stgNews = payload.filter(element => !stgExisting.has(element.Value));

        if (stgNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todos los datos de integración ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = stgNews.map((py, index) => {
            const base = index * 7;
            values.push(py.CompanyId, py.Name, py.Value, py.Description, py.Type, py.Status, py.EnableFlag, py.CreatedBy, py.UpdateBy);
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

//Exportar el router
module.exports = router;