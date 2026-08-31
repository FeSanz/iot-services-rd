const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
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

        if (type === 'pdf') {
            // Puntos numéricos válidos, ordenados cronológicamente para el análisis y la gráfica
            const points = data
                .map(row => ({ value: parseFloat(row.value), date: new Date(row.date_time) }))
                .filter(p => !isNaN(p.value))
                .sort((a, b) => a.date - b.date);

            if (points.length === 0) {
                return res.status(404).json({ error: 'No hay valores numéricos para generar el reporte' });
            }

            const stats = computeStats(points);

            // Momento con mayor cantidad de muestras (independiente del modo de agregación elegido)
            const busiestQuery = `
                SELECT date_trunc('hour', date_time) AS hour, COUNT(*) AS cnt
                FROM mes_sensor_data
                WHERE sensor_id = $1 AND date_time BETWEEN $2 AND $3
                GROUP BY hour
                ORDER BY cnt DESC
                LIMIT 1;`;
            const busiestResult = await db.query(busiestQuery, [sensor, start, end]);
            const busiest = busiestResult.rows[0] || null;

            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="Reporte_Sensor.pdf"');
            doc.pipe(res);

            const marginLeft = doc.page.margins.left;
            const contentWidth = doc.page.width - marginLeft - doc.page.margins.right;

            // Encabezado
            doc.fontSize(18).fillColor('#2C3E50').text('Reporte de Sensor');
            doc.moveDown(0.3);
            doc.fontSize(10).fillColor('#555555');
            doc.text(`Dispositivo: ${data[0].machine_name}  (ID: ${data[0].machine_id})`);
            doc.text(`Sensor: ${data[0].sensor_name}`);
            doc.text(`Rango: ${new Date(start).toLocaleString()}  a  ${new Date(end).toLocaleString()}`);
            doc.text(`Modo de Consulta: ${usarAgregacion ? `Agrupado (${aggregation.toUpperCase()} cada ${period.replace('_', ' ')})` : 'Histórico Completo'}`);
            doc.text(`Total de Muestras: ${points.length}`);
            doc.moveDown(1);
            doc.x = marginLeft;

            // Widgets de datos clave
            drawKpiRow(doc, marginLeft, doc.y, contentWidth, [
                { label: 'MÍNIMO', value: stats.min.toFixed(2), sub: fmtDate(stats.minDate) },
                { label: 'MÁXIMO', value: stats.max.toFixed(2), sub: fmtDate(stats.maxDate) },
                { label: 'PROMEDIO', value: stats.avg.toFixed(2) },
                { label: 'DESV. ESTÁNDAR', value: stats.stddev.toFixed(2) },
            ]);
            doc.x = marginLeft;
            doc.moveDown(0.8);

            // Gráfica de tendencia
            doc.fontSize(12).fillColor('#2C3E50').text('Tendencia de Valores', marginLeft, doc.y);
            doc.moveDown(0.3);
            drawLineChart(doc, points, stats, marginLeft, doc.y, contentWidth, 200);
            doc.x = marginLeft;
            doc.moveDown(1);

            // Momento con mayor cantidad de muestras
            if (busiest) {
                doc.fontSize(11).fillColor('#2C3E50').text('Periodo con Mayor Cantidad de Muestras', marginLeft, doc.y);
                doc.fontSize(10).fillColor('#333333').text(`${new Date(busiest.hour).toLocaleString()} — ${busiest.cnt} muestras registradas`, marginLeft);
                doc.moveDown(0.8);
            }

            // Desviaciones anormales (|z| > 2)
            doc.x = marginLeft;
            doc.fontSize(11).fillColor('#2C3E50').text('Desviaciones Anormales Detectadas (> 2 desv. estándar)', marginLeft, doc.y);
            doc.moveDown(0.2);
            if (stats.anomalies.length === 0) {
                doc.fontSize(10).fillColor('#333333').text('No se detectaron valores fuera de ±2 desviaciones estándar respecto al promedio.', marginLeft);
            } else {
                doc.fontSize(9);
                stats.anomalies.slice(0, 25).forEach(a => {
                    doc.fillColor('#B03A2E').text(`•  ${fmtDate(a.date)}   —   Valor: ${a.value.toFixed(2)}   (z = ${a.z.toFixed(2)})`, marginLeft);
                });
                if (stats.anomalies.length > 25) {
                    doc.fillColor('#777777').text(`… y ${stats.anomalies.length - 25} desviación(es) adicional(es).`, marginLeft);
                }
            }

            doc.end();
            return;
        }

        res.status(400).json({ error: 'Tipo de exportación no soportado' });

    } catch (error) {
        console.error('Error en exportación:', error);
        res.status(500).json({ error: 'Error interno al generar el reporte' });
    }
});

// ---- Helpers de análisis y dibujo para el reporte PDF ----

function computeStats(points) {
    const n = points.length;
    const sum = points.reduce((acc, p) => acc + p.value, 0);
    const avg = sum / n;
    const variance = points.reduce((acc, p) => acc + Math.pow(p.value - avg, 2), 0) / n;
    const stddev = Math.sqrt(variance);

    let minPoint = points[0];
    let maxPoint = points[0];
    points.forEach(p => {
        if (p.value < minPoint.value) minPoint = p;
        if (p.value > maxPoint.value) maxPoint = p;
    });

    const anomalies = points
        .map(p => ({ ...p, z: stddev > 0 ? (p.value - avg) / stddev : 0 }))
        .filter(p => Math.abs(p.z) > 2)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

    return {
        min: minPoint.value, minDate: minPoint.date,
        max: maxPoint.value, maxDate: maxPoint.date,
        avg, stddev, anomalies,
    };
}

function fmtDate(date) {
    return date instanceof Date ? date.toLocaleString() : new Date(date).toLocaleString();
}

function drawKpiRow(doc, x, y, width, items) {
    const gap = 10;
    const boxWidth = (width - gap * (items.length - 1)) / items.length;
    const boxHeight = 55;

    items.forEach((item, i) => {
        const bx = x + i * (boxWidth + gap);
        doc.roundedRect(bx, y, boxWidth, boxHeight, 4).fillAndStroke('#F4F6F7', '#DDDDDD');
        doc.fontSize(8).fillColor('#7F8C8D').text(item.label, bx + 8, y + 8, { width: boxWidth - 16 });
        doc.fontSize(16).fillColor('#2C3E50').text(item.value, bx + 8, y + 21, { width: boxWidth - 16 });
        if (item.sub) {
            doc.fontSize(7).fillColor('#95A5A6').text(item.sub, bx + 8, y + 41, { width: boxWidth - 16 });
        }
    });

    doc.y = y + boxHeight;
}

function drawLineChart(doc, points, stats, x, y, width, height) {
    const padding = { top: 10, right: 10, bottom: 22, left: 42 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    const plotX = x + padding.left;
    const plotY = y + padding.top;

    doc.rect(x, y, width, height).fill('#FAFAFA');

    let valMin = stats.min;
    let valMax = stats.max;
    if (valMin === valMax) { valMin -= 1; valMax += 1; }
    const valRange = valMax - valMin;

    const tMin = points[0].date.getTime();
    const tMax = points[points.length - 1].date.getTime();
    const tRange = Math.max(tMax - tMin, 1);

    const xScale = (t) => plotX + ((t - tMin) / tRange) * plotW;
    const yScale = (v) => plotY + plotH - ((v - valMin) / valRange) * plotH;

    // Líneas de referencia horizontales
    doc.strokeColor('#E0E0E0').lineWidth(0.5);
    for (let i = 0; i <= 4; i++) {
        const gy = plotY + (plotH / 4) * i;
        doc.moveTo(plotX, gy).lineTo(plotX + plotW, gy).stroke();
        const val = valMax - (valRange / 4) * i;
        doc.fontSize(7).fillColor('#888888').text(val.toFixed(1), x, gy - 3, { width: padding.left - 5, align: 'right' });
    }

    // Reducimos la cantidad de puntos graficados si hay demasiados, para no saturar la gráfica
    const maxPlotPoints = 300;
    let plotPoints = points;
    if (points.length > maxPlotPoints) {
        const stride = Math.ceil(points.length / maxPlotPoints);
        plotPoints = points.filter((_, i) => i % stride === 0);
    }

    doc.strokeColor('#2C7BE5').lineWidth(1.2);
    plotPoints.forEach((p, i) => {
        const px = xScale(p.date.getTime());
        const py = yScale(p.value);
        if (i === 0) doc.moveTo(px, py);
        else doc.lineTo(px, py);
    });
    doc.stroke();

    // Anomalías resaltadas en rojo
    stats.anomalies.forEach(a => {
        doc.circle(xScale(a.date.getTime()), yScale(a.value), 2.3).fill('#E74C3C');
    });

    // Marcadores de mínimo y máximo
    doc.circle(xScale(stats.minDate.getTime()), yScale(stats.min), 2.5).fill('#27AE60');
    doc.circle(xScale(stats.maxDate.getTime()), yScale(stats.max), 2.5).fill('#8E44AD');

    doc.fontSize(7).fillColor('#888888');
    doc.text(points[0].date.toLocaleString(), plotX, plotY + plotH + 6, { width: plotW / 2, align: 'left' });
    doc.text(points[points.length - 1].date.toLocaleString(), plotX + plotW / 2, plotY + plotH + 6, { width: plotW / 2, align: 'right' });

    doc.rect(x, y, width, height).strokeColor('#DDDDDD').lineWidth(1).stroke();

    // Leyenda
    const legendY = y + height + 8;
    drawLegendDot(doc, x, legendY, '#2C7BE5', 'Valor');
    drawLegendDot(doc, x + 90, legendY, '#27AE60', 'Mínimo');
    drawLegendDot(doc, x + 180, legendY, '#8E44AD', 'Máximo');
    drawLegendDot(doc, x + 270, legendY, '#E74C3C', 'Anomalía (>2σ)');

    doc.y = legendY + 14;
}

function drawLegendDot(doc, x, y, color, label) {
    doc.circle(x + 4, y + 4, 3).fill(color);
    doc.fontSize(8).fillColor('#333333').text(label, x + 12, y, { width: 80 });
}

module.exports = router;