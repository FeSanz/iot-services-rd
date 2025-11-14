const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const { selectFromDB, selectByParamsFromDB } = require("../../models/sql-execute");
const authenticateToken = require('../../middleware/authenticateToken');

// Obtener registros por organizacion
router.get('/workCenters/:organization', authenticateToken, async (req, res) => {
    const { organization } = req.params;
    const sqlQuery = `SELECT work_center_id AS "WorkCenterId", work_center_code AS "WorkCenterCode", work_center_name AS "WorkCenterName",
                                work_area_code AS "WorkAreaCode", work_area_name AS "WorkAreaName", fusion_id AS "FusionId",
                                organization_id AS "OrganizationId" 
                              FROM MES_WORK_CENTERS
                              WHERE organization_id = $1 ORDER BY work_center_code ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/workCenters', authenticateToken, async (req, res) => {
    try {
        const { OrganizationId, items } = req.body;
        const payload = items || [];

        // Validaciones
        if (!OrganizationId) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionó el ID de organización',
                totalResults: 0
            });
        }

        if (payload.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'No se proporcionaron datos de centros de trabajo',
                totalResults: 0
            });
        }

        // Obtener existentes
        const wcRecieved = payload.map((element) => element.WokCenterCode);
        const wcExistResult = await pool.query(`SELECT work_center_code FROM MES_WORK_CENTERS 
                                                    WHERE organization_id = $1 AND work_center_code = ANY($2)`, 
                                                [OrganizationId, wcRecieved]);
        const wcExisting = new Set(wcExistResult.rows.map(row => row.work_center_code));

        // Filtrar wc nuevas
        const wcNews = payload.filter(element => !wcExisting.has(element.WokCenterCode));

        if (wcNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

          // Preparar inserción
        const values = [];
        const placeholders = wcNews.map((py, index) => {
            const base = index * 6;
            values.push(OrganizationId, py.WorkCenterCode, py.WorkCenterName, py.WorkAreaCode, py.WorkAreaName, py.FusionId);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        await pool.query(`
            INSERT INTO MES_WORK_CENTERS (organization_id, work_center_code, work_center_name, work_area_code, work_area_name, fusion_id)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${wcNews.length}]`,
            totalResults: wcNews.length,
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


// Eliminar registro por ID
router.delete('/workCenters/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT work_center_id FROM MES_WORK_CENTERS WHERE work_center_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_WORK_CENTERS WHERE work_center_id = $1', [id]);

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
router.delete('/workCenters', authenticateToken, async (req, res) => {
    try {
        const workCentersId = req.body.items.map(item => item.WorkCenterId);
        const placeholders = workCentersId.map((_, index) => `$${index + 1}`).join(', ');

        // Verificar si el registro existe
        const checkResult = await pool.query(`SELECT work_center_id FROM MES_WORK_CENTERS WHERE work_center_id in (${placeholders})`, workCentersId);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registros no encontrados',
                totalResults: 0
            });
        }
        
        await pool.query(`DELETE FROM MES_WORK_CENTERS WHERE work_center_id in (${placeholders})`, workCentersId);

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

//Actualizar registro por ID 
router.put('/workCenters/:id', authenticateToken, async (req, res) => {
    const workCenterId = req.params.id;
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
        const workCentersExistResult = await pool.query('SELECT work_center_code FROM MES_WORK_CENTERS WHERE work_center_code = ANY($1)', [payload.WorkCenterCode]); 
        const workCentersExisting = new Set(workCentersExistResult.rows.map(row => row.work_center_code));

        // Filtrar datos de máquina proporcionada
        const workCentersNews = payload.filter(element => !workCentersExisting.has(element.work_center_code));

        if (workCentersNews.length === 0) {            
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar actualización
        const values = [];
        const placeholders = workCentersNews.map((py, index) => {
            const base = index * 6;
            values.push(py.OrganizationId, py.WorkCenterCode, py.WorkCenterName, py.WorkAreaCode, py.WorkAreaName);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });        

        await pool.query(`
            UPDATE MES_WORK_CENTERS SET organization_id = $2, work_center_code = $3, work_center_name = $4, work_area_code = $5, work_area_name = $6
            WHERE work_center_id = $1`,[workCenterId, values[0], values[1], values[2], values[3], values[4]]
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: `Centro de trabajo actualizado exitosamente [${workCentersNews.length}]`,
            totalResults: workCentersNews.length,
        });

    } catch (error) {
        console.error('Error al actualizar datos:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar datos: ' + error.message,
            totalResults: 0
        });
    }
});

//Exportar el router
module.exports = router;