const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");

//Obtener todas los registros
router.get('/resourceMachines', async (req, res) => {

    const sqlQuery = `SELECT machine_id AS "MachineId", organization_id AS "OrganizationId", code AS "Code",
                                    name AS "Name", work_center_id AS "WorkCenterId", work_center AS "WorkCenter",
                                    class AS "Class", token "Token"
                             FROM MES_MACHINES
                             ORDER BY name ASC`;

    const result = await selectFromDB(sqlQuery);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

// Obtener registros por organizacion y centro de trabajo
router.get('/resourceMachines/:organization/:wc', async (req, res) => {
    const { organization, wc } = req.params;

    // Validaciones
    if (!organization && !wc) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Datos de organización y centro de trabajo son requeridos',
            totalResults: 0
        });
    }

    const sqlQuery  = `SELECT machine_id AS "MachineId", organization_id AS "OrganizationId", code AS "Code", 
                                     name AS "Name", work_center_id AS "WorkCenterId", work_center AS "WorkCenter", 
                                     class AS "Class", token "Token"  
                              FROM MES_MACHINES 
                              WHERE organization_id = $1 AND work_center_id = $2`;

    const result = await selectByParamsFromDB(sqlQuery, [organization, wc]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/resourceMachines', async (req, res) => {
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
            values.push(py.OrganizationId, py.Code, py.Name, py.WorkCenterId, py.WorkCenter, py.Class, py.Token);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });

        await pool.query(`
            INSERT INTO MES_MACHINES (organization_id, code, name, work_center_id, work_center, class, token)
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
router.delete('/resourceMachines/:id', async (req, res) => {
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

//Exportar el router
module.exports = router;