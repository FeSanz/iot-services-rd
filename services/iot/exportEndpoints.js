const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const ExcelJS = require('exceljs');
// Cambiamos 'pool' por 'db' si es el nombre que prefieres usar, 
// o simplemente usa 'pool' en la consulta.
const db = require('../../database/pool');
router.get('/sensorsData/export', authenticateToken, async (req, res) => {
    try {
        // 1. Extraemos los nuevos parámetros opcionales de agrupación
        const { type, sensor, start, end, period, aggregation } = req.query;

        if (!sensor || !start || !end) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos' });
        }

        const usarAgregacion = period && period !== '';
        let query = '';
        let queryParams = [sensor, start, end];

        // 2. CONSTRUCCIÓN DE QUERY ADAPTATIVA (Clon de tu lógica principal)
        if (usarAgregacion) {
            const aggLower = aggregation.toLowerCase();
            let sqlAggregation = '';
            let sqlIdColumn = '';

            // Condición de ID según la operación estadística
            if (aggLower === 'max' || aggLower === 'min') {
                sqlIdColumn = `(SELECT sd_sub.sensor_data_id FROM mes_sensor_data sd_sub WHERE sd_sub.sensor_id = sd.sensor_id AND sd_sub.value = ${aggLower === 'max' ? 'MAX(sd.value)' : 'MIN(sd.value)'} LIMIT 1) AS sensor_data_id`;
            } else {
                sqlIdColumn = 'NULL AS sensor_data_id';
            }

            // Operación matemática
            if (aggLower === 'avg') sqlAggregation = 'AVG(sd.value)::numeric(10,2) AS value';
            else if (aggLower === 'max') sqlAggregation = 'MAX(sd.value) AS value';
            else if (aggLower === 'min') sqlAggregation = 'MIN(sd.value) AS value';
            else if (aggLower === 'sum') sqlAggregation = 'SUM(sd.value) AS value';
            else if (aggLower === 'count') sqlAggregation = 'COUNT(sd.value) AS value';
            else if (aggLower === 'median') {
                sqlAggregation = 'percentile_cont(0.5) WITHIN GROUP (ORDER BY sd.value) AS value';
            }

            // Tratamiento de intervalos variables para PostgreSQL
            let timeExpressionStart = '';
            let intervalStr = '';

            switch (period) {
                case 'minute': timeExpressionStart = "date_trunc('minute', sd.date_time)"; intervalStr = "1 minute"; break;
                case '5_minutes': timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 300) * 300)"; intervalStr = "5 minutes"; break;
                case '15_minutes': timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 900) * 900)"; intervalStr = "15 minutes"; break;
                case '30_minutes': timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 1800) * 1800)"; intervalStr = "30 minutes"; break;
                case 'hour': timeExpressionStart = "date_trunc('hour', sd.date_time)"; intervalStr = "1 hour"; break;
                case '5_hours': timeExpressionStart = "to_timestamp(floor(extract(epoch from sd.date_time) / 18000) * 18000)"; intervalStr = "5 hours"; break;
                case 'day': timeExpressionStart = "date_trunc('day', sd.date_time)"; intervalStr = "1 day"; break;
                default: timeExpressionStart = "date_trunc('minute', sd.date_time)"; intervalStr = "1 minute";
            }

            let timeExpressionEnd = `(${timeExpressionStart} + interval '${intervalStr}')`;

            query = `
                SELECT 
                    ${sqlIdColumn}, 
                    ${sqlAggregation}, 
                    ${timeExpressionStart} AS date_time,
                    ${timeExpressionEnd} AS date_time_end,
                    s.name AS sensor_name, 
                    m.name AS machine_name, 
                    m.machine_id,
                    'Agrupación matemática' AS comment
                FROM mes_sensor_data sd
                JOIN mes_sensors s ON sd.sensor_id = s.sensor_id
                JOIN mes_machines m ON s.machine_id = m.machine_id
                WHERE s.sensor_id = $1 AND sd.date_time BETWEEN $2 AND $3
                GROUP BY s.name, sd.sensor_id, m.name, m.machine_id, ${timeExpressionStart}
                ORDER BY date_time DESC;`;
        } else {
            // Consulta original sin cambios si el usuario quiere "Todo" (Sin lapso)
            query = `
                SELECT 
                    sd.sensor_data_id, 
                    sd.value, 
                    sd.date_time, 
                    NULL AS date_time_end,
                    sd.comment,
                    s.name AS sensor_name, 
                    m.name AS machine_name, 
                    m.machine_id
                FROM mes_sensor_data sd
                JOIN mes_sensors s ON sd.sensor_id = s.sensor_id
                JOIN mes_machines m ON s.machine_id = m.machine_id
                WHERE s.sensor_id = $1 AND sd.date_time BETWEEN $2 AND $3
                ORDER BY sd.date_time DESC;`;
        }

        const result = await db.query(query, queryParams);
        const data = result.rows;

        // Si la consulta no trajo registros, respondemos con código limpio
        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'No se encontraron datos para el rango especificado' });
        }

        if (type === 'excel') {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Reporte de Sensores');

            // Metadata superior
            worksheet.mergeCells('A1:B1');
            worksheet.getCell('A1').value = 'Reporte Detallado de Sensores';
            worksheet.getCell('A1').font = { size: 16, bold: true, color: { argb: 'FF2C3E50' } };

            const metaData = [
                ['Dispositivo:', data[0].machine_name],
                ['ID Dispositivo:', data[0].machine_id],
                ['Sensor:', data[0].sensor_name],
                ['Modo de Consulta:', usarAgregacion ? `Agrupado (${aggregation.toUpperCase()} cada ${period.replace('_', ' ')})` : 'Histórico Completo'],
                ['Total de Filas:', data.length]
            ];

            metaData.forEach(item => {
                const row = worksheet.addRow(item);
                row.getCell(1).font = { bold: true };
                row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
                row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
            });

            worksheet.addRow([]); // Espaciado

            const headers = ['ID Dato', 'Fecha / Periodo', 'Valor', 'Comentario / Tipo'];
            const headerRow = worksheet.addRow(headers);

            headerRow.eachCell((cell, colNumber) => {
                if (colNumber <= headers.length) {
                    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
            });

            // 3. ENMASCARADO DE FILAS DINÁMICAS EN EXCEL
            data.forEach(row => {
                let celdaId = row.sensor_data_id ? row.sensor_data_id : '-';
                let celdaFecha = '';
                let celdaComentario = row.comment || '-';

                if (usarAgregacion && row.date_time_end) {
                    // Formateamos un string de rango limpio dentro de la celda de Excel
                    const inicio = new Date(row.date_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const fin = new Date(row.date_time_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const fechaDia = new Date(row.date_time_end).toLocaleDateString();
                    celdaFecha = `${inicio} a ${fin} (${fechaDia})`;
                    celdaComentario = `Cálculo: ${aggregation.toUpperCase()}`;
                } else {
                    celdaFecha = new Date(row.date_time).toLocaleString();
                }

                const r = worksheet.addRow([
                    celdaId,
                    celdaFecha,
                    row.value,
                    celdaComentario
                ]);

                r.eachCell((cell) => {
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });
            });

            // Auto-dimensionado de columnas
            worksheet.columns.forEach(column => {
                let maxLength = 0;
                column.eachCell({ includeEmpty: true }, (cell) => {
                    const columnLength = cell.value ? cell.value.toString().length : 10;
                    if (columnLength > maxLength) maxLength = columnLength;
                });
                column.width = maxLength < 15 ? 15 : maxLength + 3;
            });

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