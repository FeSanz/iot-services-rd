const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const tokenService = require('../../middleware/tokenService');
const pool = require('../../database/pool');

//obtener usuarios por organización
router.get('/users', authenticateToken, async (req, res) => {
    const { organizations, company_id } = req.query;

    try {
        let orgArray = [];

        if (company_id) {
            // Buscar todas las organizaciones que pertenecen a la compañía
            const orgsResult = await pool.query(
                `SELECT organization_id FROM mes_organizations WHERE company_id = $1`,
                [company_id]
            );
            orgArray = orgsResult.rows.map(row => row.organization_id);
        } else if (organizations) {
            orgArray = organizations
                .split(',')
                .map(id => parseInt(id.trim()))
                .filter(id => !isNaN(id));
        }

        if (orgArray.length === 0) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'Se requiere al menos un organization_id válido o un company_id con organizaciones.'
            });
        }

        const query = `
            SELECT 
                u.user_id, u.name, u.email, u.role, u.type, u.level, u.rfid, u.password, u.enabled_flag,
                json_agg(DISTINCT jsonb_build_object('org_id', o.organization_id, 'org_name', o.name, 'org_code', o.code)) AS organizations
            FROM mes_users u
            JOIN mes_users_org uo ON u.user_id = uo.user_id
            JOIN mes_organizations o ON o.organization_id = uo.organization_id
            WHERE o.organization_id = ANY($1)
            GROUP BY u.user_id;
        `;

        const result = await pool.query(query, [orgArray]);
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rows.length,
            items: result.rows
        });

    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error al consultar usuarios' });
    }
});

//Nuevo usuario
router.post('/users', authenticateToken, async (req, res) => {
    const { role, name, type, password, email, enabled_flag, organizations } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // 1. Insertar usuario
        const insertUserResult = await client.query(
            `INSERT INTO mes_users (role, name, type, password, email, enabled_flag)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING user_id`,
            [role, name, type, password, email, enabled_flag || 'Y']
        );
        const user_id = insertUserResult.rows[0].user_id;
        // 2. Insertar relaciones user-org
        for (const org of organizations) {
            const orgId = parseInt(org.org_id);
            if (!isNaN(orgId)) {
                await client.query(
                    `INSERT INTO mes_users_org (user_id, organization_id) VALUES ($1, $2)`,
                    [user_id, orgId]
                );
            }
        }
        await client.query('COMMIT');
        res.status(201).json({
            errorsExistFlag: false,
            message: 'OK',
            user_id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al crear usuario:', error);
        res.status(500).json({ error: 'Error al crear usuario' });
    } finally {
        client.release();
    }
});

// Force logout - Admin solamente
router.get('/force-logout/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);

        if (isNaN(userId)) {
            return res.status(400).json({
                errorsExistFlag: true,
                message: 'ID de usuario inválido'
            });
        }

        tokenService.revokeAllUserTokens(userId);

        res.json({
            errorsExistFlag: false,
            message: `Todas las sesiones del usuario ${userId} han sido cerradas`
        });
    } catch (error) {
        console.error('Error forzando logout:', error);
        res.status(500).json({
            errorsExistFlag: true,
            message: 'Error al cerrar sesiones'
        });
    }
});

router.put('/users/:user_id', authenticateToken, async (req, res) => {
    const { user_id } = req.params;
    const { role, name, type, password, email, enabled_flag, organizations } = req.body;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Actualizar usuario
        await client.query(
            `UPDATE mes_users 
       SET role = $1, name = $2, type = $3, password = $4, email = $5, enabled_flag = $6
       WHERE user_id = $7`,
            [role, name, type, password, email, enabled_flag || 'Y', user_id]
        );


        // 2. Eliminar relaciones antiguas
        await client.query(
            `DELETE FROM mes_users_org WHERE user_id = $1`,
            [user_id]
        );

        // 3. Insertar nuevas relaciones
        for (const org of organizations) {
            const orgId = parseInt(org.org_id);
            if (!isNaN(orgId)) {
                await client.query(
                    `INSERT INTO mes_users_org (user_id, organization_id) VALUES ($1, $2)`,
                    [user_id, orgId]
                );
            }
        }
        await client.query('COMMIT');

        tokenService.revokeAllUserTokens(parseInt(user_id));
        res.status(200).json({
            errorsExistFlag: false,
            message: 'OK',
            user_id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: 'Error al actualizar usuario' });
    } finally {
        client.release();
    }
});

router.put('/users/:user_id/status', authenticateToken, async (req, res) => {
    const { user_id } = req.params;
    userId = parseInt(user_id);
    const { enabled_flag } = req.body;

    if (!['Y', 'N'].includes(enabled_flag)) {
        return res.status(400).json({ error: 'Valor inválido para enabled_flag. Debe ser "Y" o "N".' });
    }

    try {
        const result = await pool.query(
            `UPDATE mes_users SET enabled_flag = $1 WHERE user_id = $2 RETURNING user_id`,
            [enabled_flag, user_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }


        tokenService.revokeAllUserTokens(user_id);
        res.status(200).json({
            errorsExistFlag: false,
            message: 'OK',
            user_id: result.rows[0].user_id
        });
    } catch (error) {
        console.error('Error al actualizar estado del usuario:', error);
        res.status(500).json({ error: 'Error interno al actualizar el estado del usuario' });
    }
});

router.delete('/users/:id', authenticateToken, async (req, res) => {
    const userId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Eliminar relaciones con organizaciones
        await client.query(
            'DELETE FROM mes_users_org WHERE user_id = $1',
            [userId]
        );

        // 2. Eliminar usuario
        const result = await client.query(
            'DELETE FROM mes_users WHERE user_id = $1 RETURNING *',
            [userId]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                errorsExistFlag: true,
                error: 'Usuario no encontrado'
            });
        }

        await client.query('COMMIT');
        res.json({
            errorsExistFlag: false,
            message: 'OK',
            result: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al eliminar usuario:', error);
        res.status(500).json({
            errorsExistFlag: true,
            error: 'Error al eliminar usuario'
        });
    } finally {
        client.release();
    }
});

//Obtener cantidad de usuarios superAdmin
router.get('/userNumber', async (req, res) => {
    try {
        const query = `SELECT COUNT(*) AS user_count FROM MES_USERS WHERE ROLE = 'SuperAdmin'`;

        const result = await pool.query(query);

        res.json({
            errorsExistFlag: false,
            message: 'OK',
            totalResults: result.rowCount,
            items: result.rows[0].user_count
        });

    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error al consultar número de usuarios' });
    }
});
module.exports = router;