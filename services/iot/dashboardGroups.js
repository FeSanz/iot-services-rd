const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');

router.get('/dashboardsGroup/byOrganizations', authenticateToken, async (req, res) => {
    const orgParam = req.query.organizations;

    if (!orgParam) {
        return res.status(400).json({ error: 'Se requiere el parámetro "organizations"' });
    }

    const organizationIds = String(orgParam)
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

    if (organizationIds.length === 0) {
        return res.status(400).json({ error: 'No se proporcionaron IDs de organización válidos' });
    }

    try {
        const result = await pool.query(`
            SELECT 
              g.dashboard_group_id,
              g.name AS group_name,
              g.description,
              g.created_by,
              g.created_date,
              g.organization_id,
              g.index,
              o.name AS organization_name
            FROM mes_dashboards_group g
            INNER JOIN mes_organizations o ON g.organization_id = o.organization_id
            WHERE g.organization_id = ANY($1)
            ORDER BY g.index ASC NULLS LAST
        `, [organizationIds]);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener grupos por organizaciones:', error);
        res.status(500).json({ error: 'Error al consultar dashboard groups por organizaciones' });
    }
});
// Consultar grupos de dashboards por companyId (incluye todos sus dashboards agrupados)
router.get('/dashboardsGroup/company/:companyId', authenticateToken, async (req, res) => {
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
router.post('/dashboardsGroup', authenticateToken, async (req, res) => {
    const { group_name, description, created_by, organization_id } = req.body;

    try {
        // Obtener el último índice actual
        const maxResult = await pool.query(
            `SELECT COALESCE(MAX(index), 0) + 1 AS next_index
             FROM mes_dashboards_group
             WHERE organization_id = $1`,
            [organization_id]
        );

        const nextIndex = maxResult.rows[0].next_index;

        const result = await pool.query(
            `INSERT INTO mes_dashboards_group 
             (name, description, created_by, created_date, organization_id, index) 
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5)
             RETURNING *`,
            [group_name, description, created_by, organization_id, nextIndex]
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
router.delete('/dashboardsGroup/:id', authenticateToken, async (req, res) => {
    const groupId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Primero eliminar todos los dashboards del grupo
        await client.query(
            'DELETE FROM mes_dashboards WHERE dashboard_group_id = $1',
            [groupId]
        );

        // 2. Luego eliminar el grupo
        const result = await client.query(
            'DELETE FROM mes_dashboards_group WHERE dashboard_group_id = $1 RETURNING *',
            [groupId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                errorsExistFlag: true,
                error: 'Grupo no encontrado'
            });
        }

        await client.query('COMMIT');

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            items: result.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al eliminar grupo:', error);
        res.status(500).json({
            errorsExistFlag: true,
            error: 'Error al eliminar grupo de dashboards'
        });
    } finally {
        client.release();
    }
});
//reordenar el grupo de tableros
router.put('/dashboardsGroup/order', authenticateToken, async (req, res) => {
    const { items } = req.body;

    if (!Array.isArray(items)) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Estructura de datos inválida'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        for (const { dashboard_group_id, index } of items) {
            await client.query(
                `UPDATE mes_dashboards_group
                 SET index = $1
                 WHERE dashboard_group_id = $2`,
                [index, dashboard_group_id]
            );
        }

        await client.query('COMMIT');

        res.status(200).json({
            errorsExistFlag: false,
            message: 'OK',
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar orden de grupos:', error);
        res.status(500).json({
            errorsExistFlag: true, error: 'Error al actualizar orden'
        });
    } finally {
        client.release();
    }
});
//actualizar dashboards
router.put('/dashboardsGroup/:id', authenticateToken, async (req, res) => {
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