const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');
const admin = require("firebase-admin");
const serviceAccount = require("../../firebase_server/firebase-service-account.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
router.post('/notifyTest', async (req, res) => {
    try {
        const { token, title, body } = req.body;

        if (!token || !title || !body) {
            return res.status(400).json({ errorsExistFlag: true, message: 'token, title y body son requeridos' });
        }

        const message = {
            notification: {
                title: title,
                body: body
            },
            token: token // Aquí va el token del dispositivo
        };

        const response = await admin.messaging().send(message);

        res.status(201).json({
            errorsExistFlag: false,
            message: 'Notificación enviada al dispositivo',
            firebaseResponse: response
        });

    } catch (error) {
        console.error('Error al enviar notificación', error);
        res.status(500).json({ error: 'Error al enviar notificación' });
    }
});

router.post('/registerPushToken', authenticateToken, async (req, res) => {
    const { user_id, token } = req.body;

    if (!user_id || !token) {
        return res.status(400).json({
            errorsExistFlag: true,
            message: 'Data is missing'
        });
    }

    try {
        // Revisar si el token ya existe
        const tokenCheck = await pool.query(
            `SELECT user_id FROM mes_user_push_tokens WHERE token = $1`,
            [token]
        );

        if (tokenCheck.rows.length === 0) {
            // Token nuevo → insertarlo
            await pool.query(
                `INSERT INTO mes_user_push_tokens (user_id, token, created_at)
         VALUES ($1, $2, NOW())`,
                [user_id, token]
            );
            return res.json({
                errorsExistFlag: false,
                message: 'Token registrado correctamente'
            });
        }

        const existingUserId = tokenCheck.rows[0].user_id;

        if (existingUserId === user_id) {
            // Token ya registrado para el mismo usuario → no hacer nada
            return res.json({
                errorsExistFlag: false,
                message: 'Token ya registrado para este usuario'
            });
        }

        // Token registrado para otro usuario → reasignarlo al nuevo usuario
        await pool.query(
            `UPDATE mes_user_push_tokens
       SET user_id = $1, updated_at = NOW()
       WHERE token = $2`,
            [user_id, token]
        );

        return res.json({
            errorsExistFlag: false,
            message: 'Token reasignado al nuevo usuario'
        });

    } catch (error) {
        console.error('Error registrando token push:', error);
        return res.status(500).json({
            errorsExistFlag: true,
            message: 'Error interno al registrar token'
        });
    }
});

module.exports = router;