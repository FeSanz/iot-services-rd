const express = require('express');
const router = express.Router();
const pool = require('../../database/pool');

//Obtener todas las organizaciones
app.get('/api/organizations', async (req, res) => {
    try {
        const resultado = await pool.query(`
      SELECT 
        organization_id,
        code,
        name,
        location,
        work_method,
        bu_id
      FROM MES_ORGANIZATIONS 
      ORDER BY organization_id DESC
    `);

        res.json({
            exito: true,
            total: resultado.rows.length,
            organizaciones: resultado.rows
        });

    } catch (error) {
        console.error('❌ Error al obtener organizaciones:', error);
        res.status(500).json({
            exito: false,
            mensaje: 'Error al obtener organizaciones',
            error: error.message
        });
    }
});