const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//obtener usuarios por organización
router.get('/users/:organizationId', async (req, res) => {
    const { organizationId } = req.params;

    try {
        const result = await pool.query(
            'SELECT * FROM mes_users WHERE organization_id = $1',
            [organizationId]
        );

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
router.post('/users', async (req, res) => {
    const { organization_id, role, name, type, password, email, level, rfid, enabled_flag } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO mes_users (organization_id, role, name, type, password, email, level, rfid, enabled_flag) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [organization_id, role, name, type, password, email, level, rfid, enabled_flag || 'Y']
        );

        res.status(201).json({
            errorsExistFlag: false,
            message: 'OK',
            result: result.rows[0]
        });
    } catch (error) {
        console.error('Error al crear usuario:', error);
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});
router.put('/users/:id', async (req, res) => {
    const userId = req.params.id;
    const {        organization_id,        role,        name,        type,        password,        email,        level,        rfid,        enabled_flag    } = req.body;
    try {
        const result = await pool.query(
            `UPDATE mes_users SET organization_id = $1, role = $2, name = $3, type = $4, password = $5, email = $6, level = $7, rfid = $8, enabled_flag = $9 WHERE user_id = $10 RETURNING *`,
            [organization_id, role, name, type, password, email, level, rfid, enabled_flag, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ message: 'Usuario actualizado', result: result.rows[0] });
    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        res.status(500).json({ error: 'Error al actualizar usuario' });
    }
});

router.delete('/users/:id', async (req, res) => {
    const userId = req.params.id;

    try {
        const result = await pool.query(
            'DELETE FROM mes_users WHERE user_id = $1 RETURNING *',
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ message: 'Usuario eliminado', result: result.rows[0] });
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

module.exports = router;