const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//Consultar grupos de dashboards
router.get('/dashboardsGroup/:organizationId', async (req, res) => {
    const { organizationId } = req.params;
    try {
        const result = await pool.query(
            `SELECT * FROM mes_dashboards_group 
             WHERE organization_id = $1 
             ORDER BY dashboard_group_id ASC`,
            [organizationId]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener grupos:', error);
        res.status(500).json({ error: 'Error al consultar dashboard groups' });
    }
});

// Consultar grupos de dashboards por companyId (incluye todos sus dashboards agrupados)
router.get('/dashboardsGroup/company/:companyId', async (req, res) => {
    const { companyId } = req.params;

    try {
        const result = await pool.query(`
            SELECT 
              g.dashboard_group_id,
              g.name AS group_name,
              g.description,
              g.created_by,
              g.created_date,
              g.organization_id,
              o.name AS organization_name
            FROM mes_dashboards_group g
            INNER JOIN mes_organizations o ON g.organization_id = o.organization_id
            LEFT JOIN mes_dashboards d ON d.dashboard_group_id = g.dashboard_group_id
            WHERE o.company_id = $1
            GROUP BY g.dashboard_group_id, g.name, g.description, g.created_by, g.created_date, g.organization_id, o.name
            ORDER BY g.dashboard_group_id ASC
        `, [companyId]);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener grupos por compañía:', error);
        res.status(500).json({ error: 'Error al consultar dashboard groups por compañía' });
    }
});

//Agregar nuevo grupo de dashboards
router.post('/dashboardsGroup', async (req, res) => {
    const { group_name, description, created_by, organization_id } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO mes_dashboards_group 
             (name, description, created_by, created_date, organization_id) 
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
             RETURNING *`,
            [group_name, description, created_by, organization_id]
        );

        res.status(201).json({
            existError: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al crear grupo de dashboards:', error);
        res.status(500).json({ error: 'Error al crear grupo de dashboards' });
    }
});

//Eliminar dashboards
router.delete('/dashboardsGroup/:id', async (req, res) => {
    const groupId = req.params.id;

    try {
        const result = await pool.query(
            `DELETE FROM mes_dashboards_group 
             WHERE dashboard_group_id = $1 
             RETURNING *`,
            [groupId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Grupo no encontrado' });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al eliminar grupo:', error);
        res.status(500).json({ error: 'Error al eliminar grupo de dashboards' });
    }
});

//actualizar dashboards
router.put('/dashboardsGroup/:id', async (req, res) => {
    const groupId = req.params.id;
    const { group_name, description } = req.body;

    try {
        const result = await pool.query(
            `UPDATE mes_dashboards_group 
             SET name = $1, description = $2 
             WHERE dashboard_group_id = $3 
             RETURNING *`,
            [group_name, description, groupId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                existError: true,
                message: 'Grupo no encontrado'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        console.error('Error al actualizar grupo:', error);
        res.status(500).json({ error: 'Error al actualizar grupo de dashboards' });
    }
});

module.exports = router;