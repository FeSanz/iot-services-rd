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

module.exports = { asistenteEncendido };
