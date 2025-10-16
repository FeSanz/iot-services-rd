const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectByParamsFromDB} = require("../../models/sql-execute");
const authenticateToken = require('../../middleware/authenticateToken');

// Obtener registros por compañia
router.get('/settings/:company', authenticateToken, async (req, res) => {
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

// Validar integración con Fusion
router.get('/settingsFusionExist/:company', authenticateToken, async (req, res) => {
    const { company } = req.params;
    const sqlQuery  = `SELECT COUNT(*) FROM MES_SETTINGS S WHERE S.company_id = $1`;

    const result = await selectByParamsFromDB(sqlQuery, [company]);    
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos de configuracion
router.post('/settingsFusion', authenticateToken, async (req, res) => {
    try {
        const { CompanyId, User, items } = req.body;

        if (!CompanyId || !User || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Faltan datos requeridos: Company, User, o Data está vacío',
                totalResults: 0
            });
        }

        // Verificar si el parametro existe, ya no continuar
        const stgExistResult = await pool.query(`SELECT S.value FROM MES_SETTINGS S 
                                                    WHERE S.company_id = $1 AND S.name = $2`,
                                                [CompanyId, 'FUSION_URL']);
        if (stgExistResult.rows.length >= 1) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Credenciales ya fueron registradas',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = items.map((py, index) => {
            const base = index * 9;
            values.push(CompanyId, py.Name, py.Value, py.Description, 'FUSION', 'Verificado', 'Y', User, User);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, 
                     $${base + 8}, $${base + 9})`;
        });

        await pool.query(`
            INSERT INTO MES_SETTINGS (company_id, name, value, description, type, status, enabled_flag, created_by, updated_by)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${items.length}]`,
            totalResults: items.length
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

// Actualizar credenciales de fusion
router.put('/settingsFusion', authenticateToken, async (req, res) => {
    try {
        const { CompanyId, User, items } = req.body;
        const payload = items || [];

        // Validaciones
        if (!CompanyId || !User) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron todos los datos necesarios',
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


        const fusion = await pool.query(`SELECT S.name, S.value FROM MES_SETTINGS S
                                         WHERE S.company_id = $1 AND S.name IN ('FUSION_CREDENTIALS', 'FUSION_URL')`, [CompanyId]);

        const credentialsDB = fusion.rows.find(row => row.name === 'FUSION_CREDENTIALS')?.value;
        const hostDB = fusion.rows.find(row => row.name === 'FUSION_URL')?.value;

        if (!credentialsDB || !hostDB) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registros no encontrados para actualización',
                totalResults: 0,
                items: null
            });
        }

        const credentialsPY = payload.find(py => py.Name === 'FUSION_CREDENTIALS');
        const hostPY = payload.find(py => py.Name === 'FUSION_URL');

        if (!credentialsPY || !hostPY) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Datos incompletos',
                totalResults: 0
            });
        }

        const result = await pool.query(`
            UPDATE MES_SETTINGS
            SET value = CASE
                            WHEN name = 'FUSION_CREDENTIALS' THEN $1
                            WHEN name = 'FUSION_URL' THEN $2
                            ELSE value
                END,
                status = 'Actualizado',
                updated_by = $3
            WHERE company_id = $4 AND name IN ('FUSION_CREDENTIALS', 'FUSION_URL')
        `, [credentialsPY.Value, hostPY.Value, User, CompanyId]);

        // Verificar que se actualizaron exactamente 2 registros
        if (result.rowCount !== 2) {
            return res.status(404).json({
                errorsExistFlag: true, // Corregido: debe ser true
                message: 'No se encontraron todos los registros para actualizar',
                totalResults: 0
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Actualizado exitosamente',
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