const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');
const admin = require("firebase-admin");

const serviceAccount = {
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
async function sendNotification(organization, title, alert_id, body) {
    try {
        if (!organization || !title || !body || !alert_id) {
            return;
        }

        // Obtener tokens de todos los usuarios de esas organizaciones
        const tokensRes = await pool.query(`
            SELECT ut.token
            FROM mes_user_push_tokens ut
            JOIN mes_users_org uo ON ut.user_id = uo.user_id
            WHERE uo.organization_id = $1
        `, [organization]);

        const tokens = tokensRes.rows.map(r => r.token);

        if (tokens.length === 0) {
            return;
        }

        const invalidTokens = [];
        let successCount = 0;
        let failureCount = 0;

        for (const token of tokens) {
            const message = {
                notification: { title, body },
                data: {
                    route: "/alerts",
                    alertId: String(alert_id)
                },
                token,
                android: {
                    notification: {
                        tag: `alert_${alert_id}`, // 🔑 CLAVE: Mismo tag para actualizar
                        channelId: "alerts_channel"
                    }
                }
            };

            try {
                await admin.messaging().send(message);
                successCount++;
            } catch (err) {
                console.error('Error enviando a token:', token, err.code);
                failureCount++;

                if (
                    err.code === 'messaging/invalid-argument' ||
                    err.code === 'messaging/registration-token-not-registered'
                ) {
                    invalidTokens.push(token);
                }
            }
        }

        // Limpieza en la DB
        if (invalidTokens.length > 0) {
            await pool.query(
                `DELETE FROM mes_user_push_tokens WHERE token = ANY($1::text[])`,
                [invalidTokens]
            );
        }

    } catch (error) {
        console.error('Error al enviar notificación', error);
    }
}

router.post('/registerPushToken', authenticateToken, async (req, res) => {
    const { user_id, model = "UNKNOWN", token } = req.body;

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
                `INSERT INTO mes_user_push_tokens (user_id, token, model, created_at)
         VALUES ($1, $2, $3, NOW())`,
                [user_id, token, model]
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
       SET user_id = $1, user_id = $2, updated_at = NOW()
       WHERE token = $3`,
            [user_id, model, token]
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

router.post('/customNotification', async (req, res) => {
    try {
        const { token, title, body } = req.body;

        if (!token || !title || !body) {
            return res.status(400).json({ existError: true, message: 'token, title y body son requeridos' });
        }
        const message = {
            notification: { title, body },
            data: {
                route: "/alerts",
                alertId: String(failure_id)
            },
            token
        };

        const response = await admin.messaging().send(message);

        res.status(201).json({
            existError: false,
            message: 'Notificación enviada al dispositivo',
            firebaseResponse: response
        });

    } catch (error) {
        console.error('Error al enviar notificación', error);
        res.status(500).json({ error: 'Error al enviar notificación' });
    }
});

module.exports = router;
module.exports.sendNotification = sendNotification