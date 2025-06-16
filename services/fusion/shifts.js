const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');
const {selectFromDB, selectByParamsFromDB} = require("../../models/sql-execute");

// Obtener registros por organizacion
router.get('/shifts/:organization', async (req, res) => {
    const { organization } = req.params;
    const sqlQuery  = `SELECT s.shift_id AS "ShiftId", s.name AS "Name", s.start_time AS "StartTime", 
                                     s.end_time AS "EndTime", s.duration AS "Duration",
                                      s.enabled_flag AS "EnabledFlag"
                               FROM MES_ORG_SHIFTS os
                                        JOIN MES_SHIFTS s ON os.shift_id = s.shift_id
                               WHERE os.organization_id = $1 
                               ORDER BY s.start_time ASC`;

    const result = await selectByParamsFromDB(sqlQuery, [organization]);
    const statusCode = result.errorsExistFlag ? 500 : 200;
    res.status(statusCode).json(result);
});

//Insertar multiples datos
router.post('/shifts', async (req, res) => {
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

        // Extraer IDs de turnos del payload
        const shiftIds = payload.map(shift => shift.ShiftId);

        // Verificar turnos que ya existen para esta organización
        const existingOrgShifts = await pool.query(`SELECT shift_id FROM MES_ORG_SHIFTS 
                                                    WHERE organization_id = $1 AND shift_id = ANY($2)
                                                    `, [OrganizationId, shiftIds]);

        const existingOrgShiftIds = new Set(existingOrgShifts.rows.map(row => row.shift_id));

        // Filtrar turnos que no existen para esta organización
        const newShifts = payload.filter(shift => !existingOrgShiftIds.has(shift.ShiftId));

        if (newShifts.length === 0) {
            return res.status(200).json({
                errorsExistFlag: false,
                message: 'Todos los turnos proporcionados ya existen para esta organización',
                totalResults: 0
            });
        }

        // Verificar qué turnos ya existen en MES_SHIFTS
        const newShiftIds = newShifts.map(shift => shift.ShiftId);
        const existingShifts = await pool.query(`SELECT shift_id FROM MES_SHIFTS WHERE shift_id = ANY($1)`, [newShiftIds]);

        const existingShiftIds = new Set(existingShifts.rows.map(row => row.shift_id));

        // Separar turnos que necesitan ser insertados en MES_SHIFTS
        const shiftsToInsert = newShifts.filter(shift => !existingShiftIds.has(shift.ShiftId));

        // Insertar nuevos turnos en MES_SHIFTS (batch insert)
        if (shiftsToInsert.length > 0) {
            const shiftValues = [];
            const shiftPlaceholders = shiftsToInsert.map((shift, index) => {
                const base = index * 6;
                shiftValues.push(shift.ShiftId, shift.Name, shift.StartTime, shift.EndTime, shift.Duration, shift.EnabledFlag);
                return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
            });

            await pool.query(`
                INSERT INTO MES_SHIFTS (shift_id, name, start_time, end_time, duration, enabled_flag)
                VALUES ${shiftPlaceholders.join(', ')}
            `, shiftValues);
        }

        // Insertar relaciones organización-turno (batch insert)
        const orgShiftValues = [];
        const orgShiftPlaceholders = newShifts.map((shift, index) => {
            const base = index * 2;
            orgShiftValues.push(OrganizationId, shift.ShiftId);
            return `($${base + 1}, $${base + 2})`;
        });

        await pool.query(`
            INSERT INTO MES_ORG_SHIFTS (organization_id, shift_id)
            VALUES ${orgShiftPlaceholders.join(', ')}
        `, orgShiftValues);

        res.status(201).json({
            errorsExistFlag: false,
            message: `Registrados exitosamente [${newShifts.length}]`,
            totalResults: newShifts.length
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
router.delete('/shifts/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar si el registro existe
        const checkResult = await pool.query('SELECT machine_id FROM MES_SHIFTS WHERE machine_id = $1', [id]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Registro no encontrado',
                totalResults: 0
            });
        }

        await pool.query('DELETE FROM MES_SHIFTS WHERE machine_id = $1', [id]);

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