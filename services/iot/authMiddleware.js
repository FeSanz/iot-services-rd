const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'mi_secreto_seguro';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET); // ⬅️ verifica expiración automáticamente
    req.user = decoded; // almacena los datos del token en la petición
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expirado' });
    }
    return res.status(403).json({ message: 'Token inválido' });
  }
}

module.exports = authMiddleware;
