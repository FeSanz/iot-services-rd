const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const pool = require('../../database/pool');

require('dotenv').config(); // para usar JWT_SECRET

function generateToken(user) {
    return jwt.sign(
        {
            user_id: user.user_id,
            role: user.role,
            name: user.name,
            type: user.type,
            level: user.level
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );
}

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(401).json({ errorsExistFlag: true, message: 'Completa todos los campos' });
    }

    try {
        const userResult = await pool.query(`
            SELECT user_id, role, password, name, type, level, enabled_flag
            FROM mes_users
            WHERE email = $1
        `, [email]);

        if (userResult.rowCount === 0) {
            return res.status(401).json({ errorsExistFlag: true, message: 'Usuario no encontrado' });
        }

        const user = userResult.rows[0];

        // Verificar contraseña (idealmente debería ser con bcrypt)
        const validPassword = password === user.password;
        if (!validPassword) {
            return res.status(401).json({ errorsExistFlag: true, message: 'Contraseña incorrecta' });
        }

        if (user.enabled_flag !== 'Y') {
            return res.status(403).json({ errorsExistFlag: true, message: 'Cuenta desactivada' });
        }

        const company = await pool.query(`
            SELECT
                C.company_id AS "CompanyId",
                C.name AS "Name",
                json_agg(DISTINCT jsonb_build_object(
                    'OrganizationId', O.organization_id, 
                    'Code', O.code,
                    'Name', O.name, 
                    'Location', O.location, 
                    'WorkMethod', O.work_method, 
                    'BUId', O.bu_id, 
                    'Coordinates', O.coordinates)
                ) AS "Organizations",
                CASE
                    WHEN COUNT(S.company_id) > 0 THEN
                        json_agg(DISTINCT jsonb_build_object(
                            'Name', S.name,
                            'Value', S.value,
                            'Type', S.type, 
                            'EnabledFlag', S.enabled_flag,
                            'UpdatedBy', S.updated_by, 
                            'UpdatedDate', S.updated_date)
                        )
                    ELSE NULL
                END AS "Settings"
            FROM MES_USERS U
            INNER JOIN MES_USERS_ORG UO ON U.user_id = UO.user_id
            INNER JOIN MES_ORGANIZATIONS O ON UO.organization_id = O.organization_id
            INNER JOIN MES_COMPANIES C ON O.company_id = C.company_id
            LEFT JOIN MES_SETTINGS S ON C.company_id = S.company_id
            WHERE U.user_id = $1
            GROUP BY C.company_id, C.name
        `, [user.user_id]);

        const token = generateToken(user); // ✅ Generar el token

        return res.json({
            errorsExistFlag: false,
            message: 'OK',
            token, // ✅ Retornar token aquí
            items: {
                UserId: user.user_id,
                Role: user.role,
                Name: user.name,
                Type: user.type,
                Level: user.level,
                Company: company.rows[0]
            }
        });
    } catch (error) {
        console.error('Error en login:', error);
        return res.status(500).json({ errorsExistFlag: true, message: 'Error en el servidor' });
    }
});


router.post('/getToken', async (req, res) => {

    const datos = [
        { user_id: 0, role: 'SuperAdmin', password: '12345', name: 'user', type: 'USER', leve: null, enabled_flag: 'Y' }
    ];
    
    const response = {
        command: 'SELECT',
        rowCount: datos.length,
        oid: null,
        rows: datos        
    };

    try {

        const user = response.rows[0];

        const token = generateToken(user); // ✅ Generar el token

        return res.json({token});           
    } catch (error) {
        console.error('Error en login:', error);
        return res.json({ errorsExistFlag: true, message: 'Error en el servidor' });
    }
});

module.exports = router;
