const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';

// Render exige SSL; un Postgres local no lo soporta y rechaza la conexion con
// "The server does not support SSL connections". Se decide por la cadena en vez
// de comentar y descomentar la linea a mano.
const esLocal = /@(localhost|127\.0\.0\.1|\[::1\]|db)(:|\/)/.test(connectionString);

const pool = new Pool({
    connectionString,
    ssl: esLocal ? false : { rejectUnauthorized: false },
});

module.exports = pool;
