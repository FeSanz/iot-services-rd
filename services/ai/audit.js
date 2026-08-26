/**
 * Bitacora de conversaciones (ETAPA 3).
 *
 * Defensiva a proposito: si la tabla no existe -- porque nadie corrio
 * assets/db/ai_audit.sql en ese ambiente -- no se cae la respuesta del bot. El
 * usuario ya tiene su contestacion; perder el registro es molesto, tumbar la
 * peticion por eso seria peor.
 */
const pool = require('../../database/pool');
const { redactar } = require('./credentials');

let avisado = false;

async function registrarTurno({ userId, companyId, pregunta, respuesta, herramientas, tokens, ms }) {
    try {
        await pool.query(
            `INSERT INTO mes_ai_audit
                    (user_id, company_id, question, answer, tools,
                     prompt_tokens, completion_tokens, elapsed_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                userId,
                companyId,
                redactar(pregunta),
                redactar(respuesta),
                JSON.stringify(herramientas || []),
                tokens?.prompt || 0,
                tokens?.completion || 0,
                ms,
            ]
        );
    } catch (e) {
        // Una sola vez por arranque: si la tabla falta, no hay que llenar el log
        // con el mismo aviso en cada pregunta.
        if (!avisado) {
            avisado = true;
            console.warn('[AI] no se pudo escribir la bitacora:', redactar(e.message));
        }
    }
}

module.exports = { registrarTurno };
