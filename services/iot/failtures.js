const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');

//obtener fallas
router.get('/failuresByCompany/:companyId', authenticateToken, authenticateToken, async (req, res) => {
    const { companyId } = req.params;

    try {
        const result = await pool.query(
            `SELECT area, name, type, failure_id FROM mes_failures WHERE company_id = $1 ORDER BY failure_id;`,
            [companyId]
        );

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener fallas:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al consultar la base de datos'
        });
    }
});
//Fallas por organización
router.get('/failuresByOrganizations', authenticateToken, authenticateToken, async (req, res) => {
    const { organizations } = req.query;

    if (!organizations) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Parámetro "organizations" requerido en la query (ej. ?organizations=1,2,3)'
        });
    }

    const orgIds = organizations
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));

    if (orgIds.length === 0) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'IDs de organización inválidos en el parámetro "organizations"'
        });
    }

    try {
        const query = `
      SELECT DISTINCT f.*
      FROM mes_failures f
      JOIN mes_alerts a ON f.failure_id = a.failure_id
      JOIN mes_machines m ON a.machine_id = m.machine_id
      WHERE m.organization_id = ANY($1)
      ORDER BY f.failure_id;
    `;

        const result = await pool.query(query, [orgIds]);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al obtener fallas por organizaciones:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al consultar fallas por organizaciones en la base de datos'
        });
    }
});

//Nueva Falla
router.post('/failures', authenticateToken, authenticateToken, async (req, res) => {
    const { company_id, name, type, area } = req.body;

    try {
        const result = await pool.query(
            `
      INSERT INTO mes_failures (company_id, name, type, area)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
      `,
            [company_id, name, type, area]
        );

        res.json({
            errorsExistFlag: false,
            message: 'Falla creada correctamente',
            totalResults: 1,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al insertar falla:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al insertar en la base de datos'
        });
    }
});

//Actualizar Falla
router.put('/failures/:failureId', authenticateToken, authenticateToken, async (req, res) => {
    const { failureId } = req.params;
    const { name, type, area } = req.body;

    try {
        const result = await pool.query(
            `
      UPDATE mes_failures
      SET name = $1, type = $2, area = $3
      WHERE failure_id = $4
      RETURNING *;
      `,
            [name, type, area, failureId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Falla no encontrada'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Falla actualizada correctamente',
            totalResults: 1,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al actualizar falla:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al actualizar en la base de datos'
        });
    }
});

//Eliminar Falla
router.delete('/failures/:failureId', authenticateToken, authenticateToken, async (req, res) => {
    const { failureId } = req.params;

    try {
        const result = await pool.query(
            `DELETE FROM mes_failures WHERE failure_id = $1 RETURNING *;`,
            [failureId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                errorsExistFlag: true,
                message: 'Falla no encontrada'
            });
        }

        res.json({
            errorsExistFlag: false,
            message: 'Falla eliminada correctamente',
            totalResults: 1,
            items: result.rows
        });
    } catch (error) {
        console.error('Error al eliminar falla:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al eliminar de la base de datos'
        });
    }
});

module.exports = router;