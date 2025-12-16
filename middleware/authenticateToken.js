const jwt = require('jsonwebtoken');
const tokenService = require('./tokenService'); // ← ASEGÚRATE que la ruta sea correcta
require('dotenv').config();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            errorsExistFlag: true,
            message: 'Token no proporcionado'
        });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(440).json({
                    errorsExistFlag: true,
                    message: 'El token ha expirado'
                });
            }
            return res.status(401).json({
                errorsExistFlag: true,
                message: 'Token inválido'
            });
        }

        // ← AGREGAR ESTA VERIFICACIÓN
        try {
            // Verificar si el token fue revocado
            const isRevoked = tokenService.isTokenRevoked(
                decoded.jti,
                decoded.userId || decoded.user_id, // Soportar ambos
                decoded.iat
            );

            if (isRevoked) {
                return res.status(401).json({
                    errorsExistFlag: true,
                    message: 'Token revocado. Por favor, inicia sesión nuevamente.'
                });
            }

            req.user = decoded;
            next();
        } catch (error) {
            console.error('Error verificando revocación:', error);
            return res.status(500).json({
                errorsExistFlag: true,
                message: 'Error de autenticación'
            });
        }
    });
}

module.exports = authenticateToken;