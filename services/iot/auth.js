const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Credenciales incompletas' });
    }

    try {
        // 1. Buscar al usuario
        const userResult = await pool.query(`
            SELECT user_id, role, password, name, type, level, enabled_flag
            FROM mes_users
            WHERE email = $1
        `, [email]);

        if (userResult.rowCount === 0) {
            return res.status(401).json({ errorsExistFlag: true, message: 'Usuario no encontrado' });
        }

        const user = userResult.rows[0];

        // 2. Verificar contraseña
        const validPassword = password == user.password;
        if (!validPassword) {
            return res.status(401).json({ errorsExistFlag: true, message: 'Usuario no válido' });
        }

        // 3. Verificar si está habilitado
        if (user.enabled_flag !== 'Y') {
            return res.status(403).json({errorsExistFlag: true, message: 'Cuenta desactivada' });
        }

        // 4. Obtener organizaciones del usuario
        const orgsResult = await pool.query(`
            SELECT o.organization_id, o.code, o.name, o.location
            FROM mes_users_org uo
            JOIN mes_organizations o ON o.organization_id = uo.organization_id
            WHERE uo.user_id = $1
        `, [user.user_id]);

        // 5. Construir respuesta
        return res.json({
            errorsExistFlag: false,
            message: 'OK',
            user: {
                userId: user.user_id,
                email: user.email,
                rol: user.rol,
                name: user.name,
                type: user.type,
                level: user.level,
                organizations: orgsResult.rows
            }
        });
    } catch (error) {
        console.error('Error en login:', error);
        return res.status(500).json({ message: 'Error en el servidor' });
    }
});

module.exports = router;
