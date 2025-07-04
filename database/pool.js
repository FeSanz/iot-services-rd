const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    //ssl: false // 👈 esto evita el error
    ssl: {
        rejectUnauthorized: false, // Evitar bloqueos en de conexión
    },
});

module.exports = pool;