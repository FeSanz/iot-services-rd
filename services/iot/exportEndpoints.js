const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const ExcelJS = require('exceljs');
// Cambiamos 'pool' por 'db' si es el nombre que prefieres usar, 
// o simplemente usa 'pool' en la consulta.
const db = require('../../database/pool');

router.get('/sensorsData/export', authenticateToken, async (req, res) => {
    try {
        const { type, sensor, start, end } = req.query;

        // Validar que los parámetros existan
        if (!sensor || !start || !end) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos' });
        }

        // 1. Consulta SQL usando 'db' (que es tu pool importado)
        const query = `
            SELECT 
                sd.sensor_data_id, 
                sd.value, 
                sd.date_time, 
                sd.comment,
                s.name AS sensor_name, 
                m.name AS machine_name, 
                m.machine_id
            FROM mes_sensor_data sd
            JOIN mes_sensors s ON sd.sensor_id = s.sensor_id
            JOIN mes_machines m ON s.machine_id = m.machine_id
            WHERE s.sensor_id = $1 
            AND sd.date_time BETWEEN $2 AND $3
            ORDER BY sd.date_time DESC;
                    `;

        // Ejecutar consulta (Asegúrate de que db.query soporte promesas o usa util.promisify)
        const result = await db.query(query, [sensor, start, end]);
        const data = result.rows;

        if (type === 'excel') {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Reporte de Sensores');

            // 1. FILAS DE METADATOS (Información independiente)
            // Agregamos filas manualmente para que se vean como un encabezado elegante
            worksheet.mergeCells('A1:B1');
            worksheet.getCell('A1').value = 'Reporte Detallado de Sensores';
            worksheet.getCell('A1').font = { size: 16, bold: true, color: { argb: 'FF2C3E50' } };
            // Información del dispositivo y sensor
            const metaData = [
                ['Dispositivo:', data[0].machine_name],
                ['ID Dispositivo:', data[0].machine_id],
                ['Sensor:', data[0].sensor_name],
                ['Total de Registros:', data.length]
            ];

            metaData.forEach(item => {
                const row = worksheet.addRow(item);
                row.getCell(1).font = { bold: true }; // Negrita para la etiqueta
            });

            worksheet.addRow([]); // Espaciado

            // 2. TABLA DE REGISTROS
            const headerRow = worksheet.addRow(['ID Dato', 'Fecha', 'Valor', 'Comentario']);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };

            // 3. INSERTAR DATOS Y ALINEACIÓN
            data.forEach(row => {
                const r = worksheet.addRow([
                    row.sensor_data_id,
                    new Date(row.date_time).toLocaleString(),
                    row.value,
                    row.comment
                ]);

                // Centrar contenido de todas las celdas de la fila
                r.eachCell((cell) => {
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });
            });

            // 4. AUTO-DIMENSIONADO Y ESTILO
            // Recorremos las columnas para ajustar el ancho según el contenido
            worksheet.columns.forEach(column => {
                let maxLength = 0;
                column.eachCell({ includeEmpty: true }, (cell) => {
                    const columnLength = cell.value ? cell.value.toString().length : 10;
                    if (columnLength > maxLength) maxLength = columnLength;
                });
                column.width = maxLength < 15 ? 15 : maxLength + 2; // Mínimo 15 de ancho
            });

            // 4. Enviar archivo
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="Reporte_Sensores.xlsx"');

            await workbook.xlsx.write(res);
            return res.end();
        }

        res.status(400).json({ error: 'Tipo de exportación no soportado' });

    } catch (error) {
        console.error('Error en exportación:', error);
        res.status(500).json({ error: 'Error interno al generar el reporte' });
    }
});

module.exports = router;