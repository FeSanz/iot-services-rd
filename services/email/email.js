const nodemailer = require('nodemailer');
const pool = require('../../database/pool');

// Configuración del transportador de Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true', // true para 465, false para otros puertos
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Verificar la conexión SMTP al iniciar
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ Error en la configuración SMTP:', error);
    } else {
    }
});

/**
 * Envía notificación por correo electrónico
 * @param {number} organizationId - ID de la organización
 * @param {string} subject - Asunto del correo
 * @param {number} alertId - ID de la alerta
 * @param {string} message - Mensaje del correo
 */
async function sendEmailNotification(organizationId, subject, alertId, message) {
    try {
        // Obtener correos de usuarios de la organización a través de mes_users_org
        const emailsResult = await pool.query(`
            SELECT DISTINCT u.email, u.name
            FROM mes_users u
            INNER JOIN mes_users_org uo ON u.user_id = uo.user_id
            WHERE uo.organization_id = $1 
            AND u.email IS NOT NULL
            AND u.email != ''
            AND u.enabled_flag = 'Y'
        `, [organizationId]);

        if (emailsResult.rows.length === 0) {
            console.warn(`⚠️ No se encontraron correos activos para la organización ${organizationId}`);
            return {
                success: false,
                message: 'No hay destinatarios disponibles'
            };
        }

        const recipients = emailsResult.rows.map(row => row.email);
        // Plantilla HTML del correo
        const htmlContent = `
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        background-color: #f4f4f4;
                        margin: 0;
                        padding: 0;
                    }
                    .container {
                        max-width: 600px;
                        margin: 20px auto;
                        background-color: #ffffff;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        overflow: hidden;
                    }
                    .header {
                        background-color: #dc3545;
                        color: #ffffff;
                        padding: 20px;
                        text-align: center;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content {
                        padding: 30px;
                        color: #333333;
                    }
                    .alert-info {
                        background-color: #f8f9fa;
                        border-left: 4px solid #dc3545;
                        padding: 15px;
                        margin: 20px 0;
                    }
                    .alert-info p {
                        margin: 8px 0;
                        line-height: 1.6;
                    }
                    .alert-id {
                        font-weight: bold;
                        color: #dc3545;
                        font-size: 18px;
                    }
                    .footer {
                        background-color: #f8f9fa;
                        padding: 20px;
                        text-align: center;
                        font-size: 12px;
                        color: #6c757d;
                    }
                    .btn {
                        display: inline-block;
                        padding: 12px 24px;
                        margin: 20px 0;
                        background-color: #dc3545;
                        color: #ffffff;
                        text-decoration: none;
                        border-radius: 4px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>🚨 ${subject}</h1>
                    </div>
                    <div class="content">
                        <p>Se ha detectado una nueva falla en el sistema MES:</p>
                        <div class="alert-info">
                            <p class="alert-id">ID de Alerta: #${alertId}</p>
                            <p>${message.replace(/\n/g, '<br>')}</p>
                        </div>
                        <p>Por favor, revisa el sistema y atiende esta alerta lo antes posible.</p>
                        <!-- Opcional: Agregar enlace al sistema -->
                        <!-- <a href="https://tu-sistema.com/alerts/${alertId}" class="btn">Ver Alerta</a> -->
                    </div>
                    <div class="footer">
                        <p>Este es un mensaje automático del sistema MES.</p>
                        <p>Por favor, no respondas a este correo.</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        // Configuración del correo
        const mailOptions = {
            from: `"Sistema MES" <${process.env.SMTP_USER}>`,
            to: recipients.join(', '),//recipients[0],//enviar solo al primer correo
            subject: subject,
            text: `${subject}\n\nID de Alerta: #${alertId}\n\n${message}`,
            html: htmlContent
        };

        // Enviar correo
        const info = await transporter.sendMail(mailOptions);
/*
        console.log(`✅ Correo enviado exitosamente: ${info.messageId}`);
        console.log(`📧 Destinatarios: ${recipients.length} usuario(s)`);*/

        return {
            success: true,
            messageId: info.messageId,
            recipients: recipients.length
        };

    } catch (error) {
        console.error('❌ Error al enviar correo electrónico:', error);
        throw error;
    }
}

async function sendEmailNotificationRepaired(organizationId, subject, alertId, message) {
    try {
        // Obtener correos de usuarios de la organización a través de mes_users_org
        const emailsResult = await pool.query(`
            SELECT DISTINCT u.email, u.name
            FROM mes_users u
            INNER JOIN mes_users_org uo ON u.user_id = uo.user_id
            WHERE uo.organization_id = $1 
            AND u.email IS NOT NULL
            AND u.email != ''
            AND u.enabled_flag = 'Y'
        `, [organizationId]);

        if (emailsResult.rows.length === 0) {
            console.warn(`⚠️ No se encontraron correos activos para la organización ${organizationId}`);
            return {
                success: false,
                message: 'No hay destinatarios disponibles'
            };
        }

        const recipients = emailsResult.rows.map(row => row.email);

        // Plantilla HTML del correo para falla solucionada
        const htmlContent = `
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        background-color: #f4f4f4;
                        margin: 0;
                        padding: 0;
                    }
                    .container {
                        max-width: 600px;
                        margin: 20px auto;
                        background-color: #ffffff;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        overflow: hidden;
                    }
                    .header {
                        background-color: #28a745;
                        color: #ffffff;
                        padding: 20px;
                        text-align: center;
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 24px;
                    }
                    .content {
                        padding: 30px;
                        color: #333333;
                    }
                    .alert-info {
                        background-color: #f8f9fa;
                        border-left: 4px solid #28a745;
                        padding: 15px;
                        margin: 20px 0;
                    }
                    .alert-info p {
                        margin: 8px 0;
                        line-height: 1.6;
                    }
                    .alert-id {
                        font-weight: bold;
                        color: #28a745;
                        font-size: 18px;
                    }
                    .footer {
                        background-color: #f8f9fa;
                        padding: 20px;
                        text-align: center;
                        font-size: 12px;
                        color: #6c757d;
                    }
                    .btn {
                        display: inline-block;
                        padding: 12px 24px;
                        margin: 20px 0;
                        background-color: #28a745;
                        color: #ffffff;
                        text-decoration: none;
                        border-radius: 4px;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>✅ ${subject}</h1>
                    </div>
                    <div class="content">
                        <p>La falla ha sido solucionada exitosamente:</p>
                        <div class="alert-info">
                            <p class="alert-id">ID de Alerta: #${alertId}</p>
                            <p>${message.replace(/\n/g, '<br>')}</p>
                        </div>
                        <p>La máquina ha vuelto a estado operativo (Runtime).</p>
                        <!-- Opcional: Agregar enlace al sistema -->
                        <!-- <a href="https://tu-sistema.com/alerts/${alertId}" class="btn">Ver Detalles</a> -->
                    </div>
                    <div class="footer">
                        <p>Este es un mensaje automático del sistema MES.</p>
                        <p>Por favor, no respondas a este correo.</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        // Configuración del correo (solo al primer destinatario para pruebas)
        const mailOptions = {
            from: `"Sistema MES" <${process.env.SMTP_USER}>`,
            to: recipients.join(', '), // Solo enviar al primer correo
            subject: subject,
            text: `${subject}\n\nID de Alerta: #${alertId}\n\n${message}\n\nLa máquina ha vuelto a estado operativo.`,
            html: htmlContent
        };

        // Enviar correo
        const info = await transporter.sendMail(mailOptions);

        /*console.log(`✅ Correo de reparación enviado exitosamente: ${info.messageId}`);
        console.log(`📧 Destinatario (prueba): ${recipients[0]}`);
        console.log(`⚠️ Modo prueba: enviado solo a 1 de ${recipients.length} usuario(s)`);*/

        return {
            success: true,
            messageId: info.messageId,
            recipients: 1,
            testMode: true,
            totalAvailable: recipients.length
        };

    } catch (error) {
        console.error('❌ Error al enviar correo de reparación:', error);
        throw error;
    }
}
/**
 * Envía correo de prueba
 * @param {string} email - Correo de prueba
 */
async function sendTestEmail(email) {
    try {
        const mailOptions = {
            from: `"Sistema MES" <${process.env.SMTP_USER}>`,
            to: email,
            subject: '✅ Prueba de configuración SMTP',
            text: 'Si recibes este correo, la configuración de notificaciones por email está funcionando correctamente.',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>✅ Configuración exitosa</h2>
                    <p>Si recibes este correo, la configuración de notificaciones por email está funcionando correctamente.</p>
                    <p><strong>Sistema MES</strong></p>
                </div>
            `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Correo de prueba enviado: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Error al enviar correo de prueba:', error);
        throw error;
    }
}

module.exports = {
    sendEmailNotification,
    sendTestEmail,
    sendEmailNotificationRepaired,
    transporter
};