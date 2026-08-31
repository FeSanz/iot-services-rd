/**
 * El interruptor del asistente, por compañia.
 *
 * Vive en mes_settings (name = 'AI_FLAG'), igual que ALERTS_FLAG o PUSH_FLAG, y
 * el cliente tambien lo lee para decidir si dibuja la burbuja. **Eso no es un
 * interruptor.** Esconder el boton no apaga el endpoint: quien tenga el token
 * puede llamar /ai/chat con curl. Esta es la copia que manda.
 *
 * En su propio archivo porque lo consultan dos sitios que no se pueden requerir
 * entre si: el router (chat y reporte) y el programador (los correos).
 *
 * Se consulta en cada uso a proposito, sin cache: apagar el asistente de una
 * compañia tiene que surtir efecto ya, no cuando expire un cache. Es una fila
 * por indice (idx_settings_company).
 */
const pool = require('../../database/pool');

async function asistenteEncendido(companyId) {
    const { rows } = await pool.query(
        `SELECT value FROM mes_settings
          WHERE company_id = $1 AND name = 'AI_FLAG' AND enabled_flag = 'Y'`,
        [companyId]
    );
    // Sin fila -> apagado. Una compañia a la que nadie le encendio el bot no lo
    // tiene: el interruptor por omision es "no".
    return rows.length > 0 && String(rows[0].value).trim().toLowerCase() === 'true';
}

/**
 * Apaga el asistente de una compañia. Es lo que hay detras de "Eliminar" en el
 * menu del chat.
 *
 * Solo UPDATE, nunca INSERT. Dos razones: sin fila el asistente YA esta apagado
 * (asistenteEncendido() devuelve false sin fila), asi que no hay nada que
 * escribir; y la secuencia de mes_settings viene atrasada en produccion --ver
 * assets/db/ai_flag.sql-- con lo que un INSERT sin id revienta con
 * "duplicate key".
 *
 * Apaga, NO borra la llave del LLM: mes_ai_credentials se queda como estaba.
 * El camino de vuelta por interfaz es encenderAsistente(), detras del tipo
 * "Asistente IA" de "Agregar widget".
 */
async function apagarAsistente(companyId, userId) {
    const { rowCount } = await pool.query(
        `UPDATE mes_settings
            SET value = 'false', updated_by = $2, updated_date = now()
          WHERE company_id = $1 AND name = 'AI_FLAG'`,
        [companyId, String(userId)]
    );
    return rowCount > 0;
}

/**
 * Enciende el asistente de una compañia. Es lo que hay detras de "guardar" el
 * tipo Asistente IA en "Agregar widget". Devuelve true si estaba apagado.
 *
 * Al reves que el apagado, aqui SI puede hacer falta un INSERT (compañia sin
 * fila de AI_FLAG), asi que replica assets/db/ai_flag.sql: alinear primero la
 * secuencia atrasada de mes_settings --idempotente, y de paso deja arreglado
 * ese hueco para la pantalla de ajustes del propio MES-- y luego insertar solo
 * si no existe. Tres sentencias sin transaccion: cada una es idempotente y
 * esto es una accion de admin, no una ruta caliente.
 */
async function encenderAsistente(companyId, userId) {
    const estaba = await asistenteEncendido(companyId);
    await pool.query(
        `SELECT setval(pg_get_serial_sequence('mes_settings', 'setting_id'),
                GREATEST((SELECT COALESCE(max(setting_id), 1) FROM mes_settings), 1))`
    );
    await pool.query(
        `INSERT INTO mes_settings (company_id, name, value, description, type, status, enabled_flag, created_by, updated_by)
         SELECT $1, 'AI_FLAG', 'false', 'Asistente IA disponible para la compañia', 'AI', 'Verificado', 'Y', $2, $2
          WHERE NOT EXISTS (SELECT 1 FROM mes_settings WHERE company_id = $1 AND name = 'AI_FLAG')`,
        [companyId, String(userId)]
    );
    // enabled_flag tambien: una fila deshabilitada dejaria el POST contestando
    // "habilitado" con asistenteEncendido() devolviendo false.
    await pool.query(
        `UPDATE mes_settings
            SET value = 'true', enabled_flag = 'Y', updated_by = $2, updated_date = now()
          WHERE company_id = $1 AND name = 'AI_FLAG'`,
        [companyId, String(userId)]
    );
    return !estaba;
}

module.exports = { asistenteEncendido, apagarAsistente, encenderAsistente };
