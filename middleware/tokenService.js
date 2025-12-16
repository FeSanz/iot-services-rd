class TokenService {
    constructor() {
        this.blacklist = new Map(); // jti -> expireTime
        this.userRevocations = new Map(); // userId -> revokedAt timestamp

        // Limpiar tokens expirados cada hora
        setInterval(() => this.cleanup(), 3600000);
    }

    /**
     * Revocar un token específico
     * @param {string} tokenJti - ID único del token
     * @param {number} expiresInSeconds - Segundos hasta que expire
     */
    revokeToken(tokenJti, expiresInSeconds) {
        const expireTime = Date.now() + (expiresInSeconds * 1000);
        this.blacklist.set(tokenJti, expireTime);
    }

    /**
     * Revocar todos los tokens de un usuario
     * @param {number} userId - ID del usuario
     */
    revokeAllUserTokens(userId) {
        const timestamp = Date.now();
        this.userRevocations.set(userId, timestamp);
        console.log(userId);
    }

    /**
     * Verificar si un token fue revocado
     * @param {string} tokenJti - ID único del token
     * @param {number} userId - ID del usuario
     * @param {number} tokenIssuedAt - Timestamp de cuando se emitió el token (iat)
     */
    isTokenRevoked(tokenJti, userId, tokenIssuedAt) {
        // 1. Verificar si el token específico está en blacklist
        const expireTime = this.blacklist.get(tokenJti);
        if (expireTime && Date.now() < expireTime) {
            return true;
        }

        // 2. Verificar si todos los tokens del usuario fueron revocados
        const revokedAt = this.userRevocations.get(userId);
        if (revokedAt && revokedAt > tokenIssuedAt * 1000) {
            return true;
        }

        return false;
    }

    /**
     * Eliminar la revocación global de un usuario
     */
    clearUserRevocation(userId) {
        this.userRevocations.delete(userId);
    }

    /**
     * Limpiar tokens expirados de la memoria
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        // Limpiar tokens expirados de la blacklist
        for (const [jti, expireTime] of this.blacklist.entries()) {
            if (now >= expireTime) {
                this.blacklist.delete(jti);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 Limpieza: ${cleaned} tokens expirados eliminados de memoria`);
        }
    }

    /**
     * Obtener estadísticas (útil para debugging)
     */
    getStats() {
        return {
            blacklistedTokens: this.blacklist.size,
            revokedUsers: this.userRevocations.size
        };
    }
}

module.exports = new TokenService();