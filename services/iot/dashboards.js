const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//Consultar dashboards
router.get('/dashboards/group/:groupId', async (req, res) => {
    const { groupId } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM mes_dashboards WHERE dashboard_group_id = $1 ORDER BY dashboard_id ASC',
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
    const { dashboard_group_id, name, color, parameters, created_by, updated_by } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO mes_dashboards 
            (dashboard_group_id, name, color, parameters, created_date, created_by, updated_date, updated_by) 
            VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP, $5, CURRENT_TIMESTAMP, $6)
            RETURNING *`,
            [dashboard_group_id, name, color, parameters, created_by, updated_by]
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
            items: result.rows[0] });
    } catch (error) {
        console.error('Error al eliminar dashboard:', error);
        res.status(500).json({ error: 'Error al eliminar dashboard' });
    }
});


//actualizar dashboards
router.put('/dashboards/:id', async (req, res) => {
    const dashboardId = req.params.id;
    const { dashboard_group_id, name, color, parameters, updated_by } = req.body;

    try {
        const result = await pool.query(
            `UPDATE mes_dashboards 
             SET dashboard_group_id = $1, name = $2, color = $3, parameters = $4::jsonb, 
                 updated_date = CURRENT_TIMESTAMP, updated_by = $5 
             WHERE dashboard_id = $6 
             RETURNING *`,
            [dashboard_group_id, name, color, parameters, updated_by, dashboardId]
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