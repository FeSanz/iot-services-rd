/**
 * Pool de solo lectura del bot IA (ETAPA 2).
 *
 * Conecta con el rol condor_ai_ro (assets/db/rol_readonly.sql), que solo tiene
 * SELECT sobre las 8 vistas del bot. Aunque una tool lograra colar un DELETE,
 * la base lo rechaza: la defensa no depende del codigo de arriba.
 *
 * Si AI_DATABASE_URL no esta definida cae a DATABASE_URL y el backend sigue
 * funcionando, pero sin esa proteccion extra -- por eso lo avisa.
 */
const { Pool } = require('pg');

const connectionString = process.env.AI_DATABASE_URL || process.env.DATABASE_URL || '';

if (!process.env.AI_DATABASE_URL) {
    console.warn('[AI] AI_DATABASE_URL sin definir: el bot usara el rol de la aplicacion, sin proteccion de solo lectura');
}

// Mismo criterio que database/pool.js: Render exige SSL, un Postgres local lo
// rechaza. Si se cambia alla, cambiar aqui.
const esLocal = /@(localhost|127\.0\.0\.1|\[::1\]|db)(:|\/)/.test(connectionString);

const TIMEOUT_SQL_MS = Number(process.env.AI_STATEMENT_TIMEOUT_MS || 15000);

const poolReadonly = new Pool({
    connectionString,
    ssl: esLocal ? false : { rejectUnauthorized: false },

    // El bot no puede quedarse con todas las conexiones del plan de Render.
    max: 5,

    // Tope de tiempo por consulta. Van los dos a proposito:
    //
    //   statement_timeout -> lo aplica POSTGRES. Cancela la consulta del lado
    //                        del servidor y libera la conexion. Es el que de
    //                        verdad protege: sin el, una consulta pesada sigue
    //                        quemando CPU aunque el cliente ya se haya rendido.
    //   query_timeout     -> lo aplica NODE. Corta la espera si el servidor no
    //                        contesta (red caida, conexion colgada), caso en el
    //                        que statement_timeout nunca llegaria a avisar.
    //
    // El del cliente va un poco mas arriba para que gane el de Postgres y el
    // error que se vea sea el suyo, que dice que paso.
    statement_timeout: TIMEOUT_SQL_MS,
    query_timeout: TIMEOUT_SQL_MS + 2000,

    // Una transaccion abierta y olvidada mantiene la conexion ocupada para
    // siempre. El bot solo lee, asi que ninguna deberia durar nada.
    idle_in_transaction_session_timeout: TIMEOUT_SQL_MS,

    connectionTimeoutMillis: 10000,
});

module.exports = poolReadonly;
