const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const { selectByParamsFromDB} = require("../../models/sql-execute");
const authenticateToken = require('../../middleware/authenticateToken');

// Obtener registros por organizacion
router.get('/shifts/:organization', authenticateToken, async (req, res) => {
    const { organization } = req.params;
    const sqlQuery  = `SELECT s.shift_id AS "ShiftId", s.name AS "Name",
                                     s.start_time AS "StartTime", s.end_time AS "EndTime", s.duration AS "Duration",
                                      s.enabled_flag AS "EnabledFlag"
                               FROM MES_SHIFTS s
                               WHERE s.organization_id = $1 
                               ORDER BY s.start_time ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/shifts', authenticateToken, async (req, res) => {
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
                message: 'No se proporcionaron datos de turnos',
                totalResults: 0
            });
        }

        // Obtener existentes
        const shiftsReceived = payload.map((element) => element.Name);
        const shiftsExistResult = await pool.query(`SELECT name FROM MES_SHIFTS 
                                                        WHERE organization_id = $1 AND name = ANY($2)`,
                                                    [OrganizationId, shiftsReceived]);
        const shiftsExisting = new Set(shiftsExistResult.rows.map(row => row.name));

        // Filtrar turnos nuevos
        const shiftsNews = payload.filter(element => !shiftsExisting.has(element.Name));

        if (shiftsNews.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todas los datos proporcionados ya existen',
                totalResults: 0
            });
        }

        // Preparar inserción
        const values = [];
        const placeholders = shiftsNews.map((py, index) => {
            const base = index * 6;
            values.push(py.Name, py.StartTime, py.EndTime, py.Duration, py.EnabledFlag, OrganizationId);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });

        await pool.query(`
            INSERT INTO MES_SHIFTS (name, start_time, end_time, duration, enabled_flag, organization_id)
            VALUES ${placeholders.join(', ')}
        `, values);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrado exitosamente [${shiftsNews.length}]`,
            totalResults: shiftsNews.length,
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


// Eliminar registro por ID de relación organización-turno
router.delete('/shifts/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT shift_id FROM MES_SHIFTS WHERE shift_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_SHIFTS WHERE shift_id = $1', [id]);

        res.json({
            errorsExistFlag: false,
            message: 'Eliminado exitosamente',
            totalResults: 0
        });

    } catch (error) {
        console.error('Error al eliminar:', error);

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