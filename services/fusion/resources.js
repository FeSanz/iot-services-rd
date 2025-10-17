const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");
const authenticateToken = require('../../middleware/authenticateToken');

//Obtener todas los registros
router.get('/resourceMachines', authenticateToken, async (req, res) => {

    const sqlQuery = `SELECT M.machine_id AS "MachineId",
                                     M.organization_id   AS "OrganizationId",
                                     M.code AS "Code",
                                     M.name AS "Name",
                                     M.class AS "Class",
                                     M.token AS "Token",
                                     WC.work_center_code AS "WorkCenterCode",
                                     WC.work_center_name AS "WorkCenterName",
                                     WC.work_area_code AS "WorkAreaCode",
                                     WC.work_area_name AS "WorAreaName",
                                     WC.fusion_id AS "FusionId" 
                              FROM mes_machines M
                                       LEFT JOIN mes_work_centers WC ON M.work_center_id = WC.work_center_id
                             ORDER BY M.name ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por organizacion y centro de trabajo
router.get('/resourceMachines/:organization/:wc', authenticateToken, async (req, res) => {
    
    const { organization, wc } = req.params;    

    // Validaciones
    if (!organization && !wc) {    
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Datos de organización y centro de trabajo son requeridos',
            totalResults: 0
        });
    }

    const sqlQuery  = `SELECT M.machine_id AS "MachineId",
                              M.organization_id   AS "OrganizationId",
                              M.code AS "Code",
                              M.name AS "Name",
                              M.class AS "Class",
                              M.token AS "Token",
                              WC.work_center_code AS "WorkCenterCode",
                              WC.work_center_name AS "WorkCenterName",
                              WC.work_area_code AS "WorkAreaCode",
                              WC.work_area_name AS "WorAreaName",
                              WC.fusion_id AS "FusionId" 
                       FROM mes_machines M
                                LEFT JOIN mes_work_centers WC ON M.work_center_id = WC.work_center_id
                       WHERE M.organization_id = $1 AND M.work_center_id = $2 ORDER BY M.code ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization, wc]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por organizacion
router.get('/orgResourceMachines/:organization', authenticateToken, async (req, res) => {
    
    const { organization} = req.params;    

    // Validaciones
    if (!organization) {    
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Datos de organización son requeridos',
            totalResults: 0
        });
    }

    const sqlQuery  = `SELECT M.machine_id AS "MachineId",
                                      M.organization_id   AS "OrganizationId",
                                      M.code AS "Code",
                                      M.name AS "Name",
                                      M.class AS "Class",
                                      M.status AS "Status",
                                      M.token AS "Token",
                                      WC.work_center_code AS "WorkCenterCode",
                                      WC.work_center_name AS "WorkCenterName",
                                      WC.work_area_code AS "WorkAreaCode",
                                      WC.work_area_name AS "WorAreaName",
                                      WC.fusion_id AS "FusionId"
                               FROM mes_machines M
                                        LEFT JOIN mes_work_centers WC ON M.work_center_id = WC.work_center_id
                              WHERE M.organization_id = $1 ORDER BY code ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/resourceMachines', authenticateToken, async (req, res) => {
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
        const machinesReceived = payload.map((element) => element.Code);
        const machinesExistResult = await pool.query('SELECT code FROM MES_MACHINES WHERE code = ANY($1)', [machinesReceived]);
        const machinesExisting = new Set(machinesExistResult.rows.map(row => row.code));

        // Filtrar maquinas nuevas
        const machinesNews = payload.filter(element => !machinesExisting.has(element.Code));

        if (machinesNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = machinesNews.map((py, index) => {
            const base = index * 7;
            values.push(py.OrganizationId, py.Code, py.Name, py.WorkCenterId, py.Class, py.Token);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        await pool.query(`
            INSERT INTO MES_MACHINES (organization_id, code, name, work_center_id, class, token)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${machinesNews.length}]`,
            totalResults: machinesNews.length,
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
router.delete('/resourceMachines/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT machine_id FROM MES_MACHINES WHERE machine_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_MACHINES WHERE machine_id = $1', [id]);

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

// Actualizar registro por ID
router.put('/resourceMachines/:id', authenticateToken, async (req, res) => {
    const machineId = req.params.id;
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
        const machinesExistResult = await pool.query('SELECT code FROM MES_MACHINES WHERE code = ANY($1)', [payload.Code]);        
        const machinesExisting = new Set(machinesExistResult.rows.map(row => row.code));

        // Filtrar datos de máquina proporcionada
        const machinesNews = payload.filter(element => !machinesExisting.has(element.Code));

        if (machinesNews.length === 0) {            
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar actualización
        const values = [];
        const placeholders = machinesNews.map((py, index) => {
            const base = index * 6;
            values.push(py.OrganizationId, py.Code, py.Name, py.WorkCenterId, py.Class, py.Token);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });        

        await pool.query(`
            UPDATE MES_MACHINES SET organization_id = $2, code = $3, name = $4, work_center_id = $5, class = $6, token = $7
            WHERE machine_id = $1`,[machineId, values[0], values[1], values[2], values[3], values[4], values[5]]
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: `Máquina actualizada exitosamente [${machinesNews.length}]`,
            totalResults: machinesNews.length,
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