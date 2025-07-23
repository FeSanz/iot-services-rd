const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//Consultar dashboards
router.get('/dashboards/group/:groupId', async (req, res) => {
    const { groupId } = req.params;
    try {
        const result = await pool.query(
            `SELECT d.*, dg.organization_id, o.name AS organization_name 
         FROM mes_dashboards d 
         JOIN mes_dashboards_group dg ON d.dashboard_group_id = dg.dashboard_group_id 
         JOIN mes_organizations o ON dg.organization_id = o.organization_id
         WHERE d.dashboard_group_id = $1 
         ORDER BY d.index ASC;`,
            [groupId]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener dashboards:', error);
        res.status(500).json({ error: 'Error al consultar dashboards' });
    }
});


//Agregar nuevo widget
router.post('/dashboards', async (req, res) => {
    const { dashboard_group_id, name, color, border_flag, parameters, created_by, updated_by, index, dateRange } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO mes_dashboards 
            (dashboard_group_id, name, color, border_flag, parameters, index, date_range, created_date, created_by, updated_date, updated_by) 
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CURRENT_TIMESTAMP, $8, CURRENT_TIMESTAMP, $9)
            RETURNING *`,
            [dashboard_group_id, name, color, border_flag, parameters, index ?? 0, dateRange, created_by, updated_by]
        );

        res.status(201).json({
            existError: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al crear dashboard:', error);
        res.status(500).json({ error: 'Error al crear dashboard' });
    }
});

//Eliminar dashboards
router.delete('/dashboards/:id', async (req, res) => {
    const dashboardId = req.params.id;

    try {
        const result = await pool.query(
            'DELETE FROM mes_dashboards WHERE dashboard_id = $1 RETURNING *',
            [dashboardId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Dashboard no encontrado' });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al eliminar dashboard:', error);
        res.status(500).json({ error: 'Error al eliminar dashboard' });
    }
});

// Actualiza el tamaño (colSize) de todos los tableros
router.put('/dashboards/size', async (req, res) => {
    const { dashboard_id, colSize } = req.body;

    if (!dashboard_id || typeof colSize !== 'number') {
        return res.status(400).json({ errorsExistFlag: false, message: 'Debe enviar dashboard_id y colSize válidos' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validar rango permitido, ej: entre 1 y 12
        const size = Math.min(Math.max(colSize, 1), 12);

        await client.query(
            `UPDATE mes_dashboards SET col_size = $1 WHERE dashboard_id = $2`,
            [size, dashboard_id]
        );

        await client.query('COMMIT');

        res.status(200).json({ errorsExistFlag: false, message: 'Tamaño actualizado correctamente' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar tamaño:', error);
        res.status(500).json({ errorsExistFlag: true, message: 'Error al actualizar tamaño del dashboard' });
    } finally {
        client.release();
    }
});


//actualiza las posiciones de todos los tableros
router.put('/dashboards/order', async (req, res) => {
    const { items } = req.body;


    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Debe enviar un arreglo con los índices a actualizar' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const updatePromises = items.map(item =>
            client.query(
                `UPDATE mes_dashboards SET index = $1, updated_date = CURRENT_TIMESTAMP WHERE dashboard_id = $2`,
                [item.index, item.dashboard_id]
            )
        );

        await Promise.all(updatePromises);
        await client.query('COMMIT');

        res.status(200).json({ errorsExistFlag: false, message: 'OK' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar el orden:', error);
        res.status(500).json({ errorsExistFlag: false, error: 'Error al actualizar el orden de dashboards' });
    } finally {
        client.release();
    }
});
//update dateRange
router.put('/dashboards/dateRange', async (req, res) => {
    const { dashboard_id, dateRange } = req.body;

    if (!dateRange) {
        return res.status(400).json({
            errorsExistFlag: true, message: 'Debe proporcionar un valor para dateRange',
        });
    }

    try {
        const result = await pool.query(
            `UPDATE mes_dashboards
       SET date_range = $1,
           updated_date = CURRENT_TIMESTAMP
       WHERE dashboard_id = $2
       RETURNING *`,
            [dateRange, dashboard_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                errorsExistFlag: true, message: 'Dashboard no encontrado',
            });
        }

        res.json({
            errorsExistFlag: false, message: 'OK',
            item: result.rows[0],
        });
    } catch (error) {
        console.error('Error al actualizar dateRange:', error);
        res.status(500).json({
            errorsExistFlag: true, message: 'Error al actualizar el rango de fechas',
        });
    }
});

//actualizar dashboards
router.put('/dashboards/:id', async (req, res) => {
    const dashboardId = req.params.id;
    const { name, color, border_flag, parameters, updated_by } = req.body;

    try {
        const result = await pool.query(
            `UPDATE mes_dashboards 
             SET name = $1, color = $2,  border_flag = $3, parameters = $4::jsonb, 
                 updated_date = CURRENT_TIMESTAMP, updated_by = $5 
             WHERE dashboard_id = $6
             RETURNING *`,
            [name, color, border_flag, parameters, updated_by, dashboardId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                existError: true,
                message: 'Dashboard no encontrado',
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al actualizar dashboard:', error);
        res.status(500).json({ error: 'Error al actualizar dashboard' });
    }
});




module.exports = router;