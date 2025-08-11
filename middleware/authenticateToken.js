const jwt = require('jsonwebtoken');
require('dotenv').config();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        // No autenticado
        return res.status(401).json({
            errorsExistFlag: true,
            message: 'Token no proporcionado'
        });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                // Sesión expirada
                return res.status(440).json({ // o 498 si prefieres
                    errorsExistFlag: true,
                    message: 'El token ha expirado'
                });
            }
            // Token inválido (firma incorrecta, manipulación, etc.)
            return res.status(401).json({
                errorsExistFlag: true,
                message: 'Token inválido'
            });
        }

        // Guardar info del usuario en la request para usar en la ruta
        req.user = decoded;
        next();
    });
}

module.exports = authenticateToken;