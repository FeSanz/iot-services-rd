/**
 * El reporte en PDF (ETAPA 5).
 *
 * DOS DECISIONES QUE EXPLICAN TODO LO DEMAS:
 *
 * 1. pdfkit, no Puppeteer. Ya venia en package.json y services/iot/
 *    exportEndpoints.js lleva tiempo generando PDF con el en produccion. La
 *    alternativa del plan --plantillas HTML + Chromium-- pedia subir el plan de
 *    Render, disco persistente y aguantar los OOM. Se quita de un plumazo el
 *    riesgo de infraestructura mas caro del proyecto.
 *
 * 2. NO se guarda ningun archivo. El PDF se dibuja y se manda por el mismo
 *    request, sin tocar el disco. El sistema de archivos de Render es efimero,
 *    asi que cualquier cosa "guardada" se evapora en el siguiente despliegue y
 *    obliga a inventarse un almacen. Regenerarlo cuesta cinco consultas.
 *
 * El aislamiento no es cosa de este archivo: TODAS las consultas van por
 * consultarConAlcance, igual que las tools. Un reporte que se saltara el alcance
 * seria la fuga mas comoda de todas -- un PDF con los datos de otra compañia,
 * listo para reenviar por correo.
 */
const PDFDocument = require('pdfkit');
const { consultarConAlcance } = require('./scope');
const { drawKpiRow } = require('../iot/exportEndpoints');
const { dibujarPortada, PALETA_BASE } = require('./portada');

const TINTA = { titulo: '#2C3E50', suave: '#7F8C8D', linea: '#DDDDDD', barra: '#3498DB', mala: '#B03A2E' };

const numero = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('es-MX'));

/**
 * Los datos del reporte, todos con el alcance del que pregunta.
 *
 * En paralelo porque son independientes y hay alguien esperando con la ventana
 * abierta: en serie son cinco viajes a la base, uno detras de otro.
 */
async function datosDelReporte(scope, desde, hasta) {
    const rango = [desde, hasta];

    const [resumen, porTurno, porMaquina, items, paros, porDia, parosPorMaquina] = await Promise.all([
        consultarConAlcance(scope, `
            SELECT count(*)::int       AS registros,
                   sum(cajas)          AS cajas,
                   sum(scrap)          AS scrap,
                   sum(rechazo)        AS rechazo,
                   min(execution_date) AS primera,
                   max(execution_date) AS ultima
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
               AND execution_date >= $1 AND execution_date < ($2::date + 1)`, rango),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(shift_name), ''), 'sin turno') AS grupo,
                   sum(cajas) AS cajas, sum(scrap) AS scrap, sum(rechazo) AS rechazo
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
               AND execution_date >= $1 AND execution_date < ($2::date + 1)
             GROUP BY 1 ORDER BY 2 DESC NULLS LAST`, rango),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(machine_name), ''), NULLIF(trim(machine_code), ''), 'sin maquina') AS grupo,
                   sum(cajas) AS cajas, sum(scrap) AS scrap, sum(rechazo) AS rechazo
              FROM v_production_machine
             WHERE organization_id = ANY($ORGS)
               AND execution_date >= $1 AND execution_date < ($2::date + 1)
             GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 15`, rango),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(item_number), ''), 'sin item') AS item,
                   max(item_description)       AS descripcion,
                   count(*)::int               AS ordenes,
                   sum(planned_start_quantity) AS planeado,
                   sum(completed_quantity)     AS completado
              FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
               AND start_date >= $1 AND start_date < ($2::date + 1)
             GROUP BY 1 ORDER BY 5 DESC NULLS LAST LIMIT 10`, rango),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(failure_type), ''), 'sin tipo') AS tipo,
                   count(*)::int              AS cuantos,
                   round(avg(duracion_min), 1) AS promedio_min,
                   round(sum(duracion_min), 1) AS total_min
              FROM v_machine_stops
             WHERE organization_id = ANY($ORGS)
               AND start_date >= $1 AND start_date < ($2::date + 1)
             GROUP BY 1 ORDER BY 2 DESC`, rango),

        // Para la linea de produccion diaria. local_date y NO execution_date:
        // la base corre en UTC y la planta no; agrupar por el timestamp crudo
        // parte los dias por la mitad. Es el mismo motivo por el que el turno
        // se calcula y no se lee.
        consultarConAlcance(scope, `
            SELECT local_date::text                     AS dia,
                   sum(cajas)                           AS cajas,
                   sum(scrap) + sum(rechazo)            AS merma
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
               AND execution_date >= $1 AND execution_date < ($2::date + 1)
             GROUP BY 1 ORDER BY 1`, rango),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(machine_name), ''), NULLIF(trim(machine_code), ''), 'sin maquina') AS grupo,
                   count(*)::int               AS cuantos,
                   round(sum(duracion_min), 1) AS total_min
              FROM v_machine_stops
             WHERE organization_id = ANY($ORGS)
               AND start_date >= $1 AND start_date < ($2::date + 1)
             GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 8`, rango),
    ]);

    return {
        resumen: resumen.rows[0],
        porTurno: porTurno.rows,
        porMaquina: porMaquina.rows,
        items: items.rows,
        paros: paros.rows,
        porDia: porDia.rows,
        parosPorMaquina: parosPorMaquina.rows,
    };
}

/**
 * Recorta un texto para que quepa en `ancho`, midiendolo de verdad.
 *
 * pdfkit tiene `ellipsis`, pero solo actua dentro de su envoltura de lineas: con
 * `lineBreak: false` no recorta y con el salto activado parte la etiqueta en dos
 * -- que es como "Maquina de Membrana Manual" acababa montandose sobre la barra
 * de abajo. Medir y cortar es determinista y no depende de como se comporte la
 * libreria por dentro.
 *
 * Hay que fijar la fuente y el tamaño ANTES: widthOfString mide con los que
 * esten puestos.
 */
function recortar(doc, texto, ancho) {
    let t = String(texto);
    if (doc.widthOfString(t) <= ancho) return t;
    while (t.length > 1 && doc.widthOfString(t + '\u2026') > ancho) t = t.slice(0, -1);
    return t + '\u2026';
}

/** Barras horizontales. Con pdfkit son rectangulos: no hace falta una libreria. */
function dibujarBarras(doc, filas, x, y, ancho, color = TINTA.barra) {
    const alto = 16;
    const hueco = 6;
    const anchoEtiqueta = 110;
    const maximo = Math.max(...filas.map((f) => Number(f.cajas) || 0), 1);

    filas.forEach((f, i) => {
        const fy = y + i * (alto + hueco);
        doc.fontSize(9).fillColor(TINTA.titulo)
            .text(recortar(doc, f.grupo, anchoEtiqueta - 6), x, fy + 4, { lineBreak: false });

        const disponible = ancho - anchoEtiqueta - 55;
        const largo = Math.max(1, (Number(f.cajas) || 0) / maximo * disponible);
        doc.rect(x + anchoEtiqueta, fy, largo, alto).fill(color);
        doc.fontSize(9).fillColor(TINTA.suave)
            .text(numero(f.cajas), x + anchoEtiqueta + largo + 6, fy + 4, { width: 49 });
    });

    doc.y = y + filas.length * (alto + hueco);
}

/**
 * Linea de produccion por dia. Ejes, rejilla y trazo con primitivas: una
 * libreria de graficas para dibujar polilineas y rectangulos es una dependencia
 * a cambio de nada.
 */
function dibujarLinea(doc, filas, x, y, ancho, alto, paleta) {
    const izq = 46;
    const abajoEje = 18;
    const w = ancho - izq;
    const h = alto - abajoEje;
    // Un 10 % de aire arriba: una barra pegada al techo se lee como si se
    // hubiera salido de la escala.
    const maximo = Math.max(...filas.map((f) => Number(f.cajas) || 0), 1) * 1.1;

    // Rejilla y escala. Cuatro lineas: mas es ruido en una grafica de 150 px.
    doc.save().lineWidth(0.5).strokeColor(TINTA.linea);
    for (let i = 0; i <= 4; i++) {
        const gy = y + h - (h * i / 4);
        doc.moveTo(x + izq, gy).lineTo(x + ancho, gy).stroke();
        doc.fontSize(7).fillColor(TINTA.suave)
            .text(numero(Math.round(maximo * i / 4)), x, gy - 4, { width: izq - 6, align: 'right' });
    }
    doc.restore();

    const px = (i) => (filas.length === 1
        ? x + izq + w / 2
        : x + izq + (w * i / (filas.length - 1)));
    const py = (f) => y + h - (Number(f.cajas) || 0) / maximo * h;

    if (filas.length === 1) {
        // Un solo dia no es una linea, es un punto: se dibuja como tal en vez de
        // un trazo invisible de cero pixeles.
        doc.circle(px(0), py(filas[0]), 3).fill(paleta.acento);
    } else {
        doc.save().lineWidth(1.6).strokeColor(TINTA.barra);
        filas.forEach((f, i) => (i === 0 ? doc.moveTo(px(i), py(f)) : doc.lineTo(px(i), py(f))));
        doc.stroke().restore();
        filas.forEach((f, i) => doc.circle(px(i), py(f), 2).fill(TINTA.barra));
    }

    // Etiquetas del eje X: solo los extremos y el medio. Con 180 dias, una por
    // dia es una mancha negra.
    const cuando = (f) => String(f.dia).slice(5).replace('-', '/');
    const indices = filas.length > 2
        ? [0, Math.floor(filas.length / 2), filas.length - 1]
        : filas.map((_, i) => i);
    doc.fontSize(7).fillColor(TINTA.suave);
    indices.forEach((i) => {
        doc.text(cuando(filas[i]), px(i) - 20, y + h + 5, { width: 40, align: 'center' });
    });

    doc.y = y + alto;
}

/** Barras verticales agrupadas: cajas, scrap y rechazo lado a lado. */
function dibujarBarrasAgrupadas(doc, filas, x, y, ancho, alto) {
    const series = [
        { clave: 'cajas', color: TINTA.barra },
        { clave: 'scrap', color: '#E67E22' },
        { clave: 'rechazo', color: TINTA.mala },
    ];
    const izq = 46;
    const abajoEje = 26;
    const w = ancho - izq;
    const h = alto - abajoEje;
    const maximo = Math.max(...filas.flatMap((f) => series.map((s) => Number(f[s.clave]) || 0)), 1) * 1.1;

    doc.save().lineWidth(0.5).strokeColor(TINTA.linea);
    for (let i = 0; i <= 3; i++) {
        const gy = y + h - (h * i / 3);
        doc.moveTo(x + izq, gy).lineTo(x + ancho, gy).stroke();
        doc.fontSize(7).fillColor(TINTA.suave)
            .text(numero(Math.round(maximo * i / 3)), x, gy - 4, { width: izq - 6, align: 'right' });
    }
    doc.restore();

    const anchoGrupo = w / filas.length;
    const anchoBarra = Math.min(14, Math.max(3, (anchoGrupo - 8) / series.length));

    filas.forEach((f, i) => {
        const gx = x + izq + i * anchoGrupo + (anchoGrupo - anchoBarra * series.length) / 2;
        series.forEach((s, j) => {
            const valor = Number(f[s.clave]) || 0;
            const bh = valor > 0 ? Math.max(1, valor / maximo * h) : 0;
            if (bh > 0) doc.rect(gx + j * anchoBarra, y + h - bh, anchoBarra - 1, bh).fill(s.color);
        });
        doc.fontSize(6.5).fillColor(TINTA.suave)
            .text(recortar(doc, f.grupo, anchoGrupo - 2), x + izq + i * anchoGrupo, y + h + 5,
                  { width: anchoGrupo, align: 'center', lineBreak: false });
    });

    // Leyenda: sin ella son tres colores sin nombre.
    let lx = x + izq;
    const ly = y + h + 16;
    series.forEach((s) => {
        doc.rect(lx, ly, 7, 7).fill(s.color);
        doc.fontSize(7).fillColor(TINTA.suave).text(s.clave, lx + 10, ly, { width: 50 });
        lx += 58;
    });

    doc.y = y + alto;
}

/**
 * Deja el texto en caracteres que las fuentes de pdfkit saben dibujar.
 *
 * Las fuentes estandar (Helvetica, Times) usan WinAnsi, y lo que no esta en esa
 * tabla pdfkit no lo pinta: lo BORRA, sin avisar. El modelo escribe guiones no
 * separables y espacios finos a cada rato, asi que "TWMFC780\u2011 12" salia en el
 * PDF como "TWMFC780  12", con un hueco donde iba el guion. Un numero de parte
 * roto en un reporte que se manda por correo.
 *
 * Se hace aqui y no en el prompt porque pedirle al modelo que no use un
 * caracter es una sugerencia; esto es una garantia.
 */
function aWinAnsi(texto) {
    return String(texto)
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')   // guiones de todo tipo
        .replace(/[\u2018\u2019\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201F]/g, '"')
        .replace(/\u2026/g, '...')
        .replace(/[\u00A0\u2007\u2009\u202F\u200A\u2002\u2003]/g, ' ')  // espacios raros
        .replace(/[\u200B-\u200D\uFEFF]/g, '');                 // invisibles
}

/**
 * Un parrafo de la narrativa. Vacio -> no dibuja nada ni deja el hueco.
 *
 * Las vinetas se pintan a mano: el modelo las escribe con guion al principio de
 * linea y un "- " suelto en un PDF se lee como un guion perdido.
 */
function dibujarParrafo(doc, texto, x, ancho) {
    if (!texto || !String(texto).trim()) return;
    const lineas = aWinAnsi(texto).trim().split('\n').map((l) => l.trim()).filter(Boolean);

    lineas.forEach((linea) => {
        const vineta = /^[-*\u2022]\s+/.test(linea);
        if (doc.y + 24 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        if (vineta) {
            doc.font('Helvetica').fontSize(9.5).fillColor(TINTA.titulo)
                .text('\u2022', x, doc.y, { width: 10, continued: false });
            doc.y -= doc.currentLineHeight();
            doc.text(linea.replace(/^[-*\u2022]\s+/, ''), x + 12, doc.y,
                     { width: ancho - 12, align: 'left' });
        } else {
            doc.font('Helvetica').fontSize(9.5).fillColor(TINTA.titulo)
                .text(linea, x, doc.y, { width: ancho, align: 'justify' });
        }
        doc.y += 3;
    });
    doc.x = x;
}

/**
 * Cabecera de seccion: titulo, regla del color de la compañia y, opcionalmente,
 * una etiqueta a la derecha con una cifra.
 */
function seccion(doc, titulo, x, ancho, paleta, etiqueta) {
    if (doc.y + 70 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(TINTA.titulo).text(titulo, x, y);

    if (etiqueta) {
        const w = 120;
        doc.save().roundedRect(x + ancho - w, y - 2, w, 16, 8).fill(etiqueta.color).restore();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
            .text(etiqueta.texto.toUpperCase(), x + ancho - w, y + 3,
                  { width: w, align: 'center', characterSpacing: 0.5 });
    }

    doc.y = y + 18;
    doc.save().lineWidth(2).strokeColor(paleta.acento)
        .moveTo(x, doc.y).lineTo(x + 34, doc.y).stroke().restore();
    doc.y += 10;
    doc.x = x;
}

/**
 * El pie, en todas las paginas menos la portada.
 *
 * En una segunda pasada porque el total de paginas no se sabe hasta el final:
 * "pagina 2 de 5" no se puede escribir mientras todavia se estan generando. Por
 * eso el documento va con bufferPages.
 */
function piesDePagina(doc, paleta, empresa) {
    const rango = doc.bufferedPageRange();
    for (let i = rango.start + 1; i < rango.start + rango.count; i++) {
        doc.switchToPage(i);
        const W = doc.page.width;
        const H = doc.page.height;
        const x = doc.page.margins.left;
        const ancho = W - x - doc.page.margins.right;

        // pdfkit mete pagina nueva si se escribe por debajo del margen inferior,
        // y eso aqui seria un bucle: cada pie crearia otra pagina que pedir pie.
        const margenAbajo = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        doc.save().lineWidth(0.5).strokeColor(TINTA.linea)
            .moveTo(x, H - 34).lineTo(W - x, H - 34).stroke().restore();
        doc.font('Helvetica').fontSize(7.5).fillColor(TINTA.suave)
            .text(`${empresa} · Reporte de producción · Confidencial`, x, H - 27,
                  { width: ancho / 2, lineBreak: false });
        doc.font('Helvetica').fontSize(7.5).fillColor(TINTA.suave)
            .text(`Página ${i - rango.start + 1} de ${rango.count}`, x + ancho / 2, H - 27,
                  { width: ancho / 2, align: 'right', lineBreak: false });

        doc.page.margins.bottom = margenAbajo;
    }
}

/**
 * El color de la etiqueta de merma.
 *
 * ponytail: los cortes (3 % y 8 %) NO los ha confirmado el cliente -- son lo
 * que suena razonable en manufactura, que no es lo mismo que ser cierto. Por
 * eso la etiqueta dice la cifra y no un veredicto ("MERMA 2.4 %", no "BIEN"):
 * el color orienta, el numero es el que manda. Cuando el cliente confirme sus
 * umbrales se cambian aqui y ya.
 */
function etiquetaDeMerma(pct) {
    const color = pct < 3 ? '#1E8449' : pct < 8 ? '#B9770E' : TINTA.mala;
    return { texto: `merma ${pct.toFixed(1)} %`, color };
}

/** Una tabla simple. Salta de pagina sola si no cabe. */
function dibujarTabla(doc, encabezados, filas, x, ancho) {
    const fijos = encabezados.reduce((a, h) => a + (h.ancho || 0), 0);
    const auto = encabezados.filter((h) => !h.ancho).length;
    const anchoDe = (i) => encabezados[i].ancho || (ancho - fijos) / auto;

    const escribirFila = (celdas, encabezado) => {
        // Si no cabe ni una fila mas, pagina nueva. Sin esto pdfkit escribe
        // encima del pie o se sale de la hoja.
        if (doc.y + 18 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const fy = doc.y;
        let cx = x;
        celdas.forEach((c, i) => {
            doc.fontSize(9).fillColor(encabezado ? TINTA.suave : TINTA.titulo)
                .text(String(c), cx, fy, {
                    width: anchoDe(i) - 4,
                    ellipsis: true,
                    align: i === 0 ? 'left' : 'right',
                });
            cx += anchoDe(i);
        });
        doc.y = fy + 14;
    };

    escribirFila(encabezados.map((h) => h.texto), true);
    doc.moveTo(x, doc.y - 2).lineTo(x + ancho, doc.y - 2).strokeColor(TINTA.linea).stroke();
    doc.y += 2;
    filas.forEach((f) => escribirFila(f, false));
}

/** Dibuja el reporte entero sobre `res`. No devuelve nada: escribe el PDF. */
function dibujarReporte(res, { empresa, desde, hasta, datos, generadoPor, paleta = PALETA_BASE, comentario }) {
    // bufferPages para poder volver a cada pagina al final y escribirle
    // "pagina N de M": el total no se sabe hasta que se acaba de dibujar.
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    doc.pipe(res);

    const x = doc.page.margins.left;
    const ancho = doc.page.width - x - doc.page.margins.right;
    const r = datos.resumen || {};
    const producido = Number(r.cajas) || 0;
    const merma = Number(r.scrap || 0) + Number(r.rechazo || 0);
    const mermaPct = producido + merma > 0 ? (merma / (producido + merma) * 100) : 0;
    const paros = datos.paros.reduce((a, p) => a + p.cuantos, 0);
    const minutosParados = datos.paros.reduce((a, p) => a + (Number(p.total_min) || 0), 0);

    const cerrar = () => {
        piesDePagina(doc, paleta, empresa);
        doc.end();
    };

    dibujarPortada(doc, {
        empresa, desde, hasta, paleta,
        generadoPor: generadoPor ? `Origen: ${generadoPor}` : undefined,
        kpis: [
            { etiqueta: 'Producido', valor: numero(producido) },
            { etiqueta: 'Merma', valor: `${mermaPct.toFixed(1)} %` },
            { etiqueta: 'Registros', valor: numero(r.registros) },
            { etiqueta: 'Paros', valor: numero(paros) },
        ],
    });

    // --- 1. resumen --------------------------------------------------------
    doc.addPage();
    doc.x = x;
    doc.y = doc.page.margins.top;

    seccion(doc, 'Resumen del periodo', x, ancho, paleta,
            r.registros ? etiquetaDeMerma(mermaPct) : null);
    doc.font('Helvetica').fontSize(9).fillColor(TINTA.suave)
        .text(`${empresa} · ${desde} a ${hasta}`, x);
    doc.moveDown(0.8);
    doc.x = x;

    drawKpiRow(doc, x, doc.y, ancho, [
        { label: 'PRODUCIDO', value: numero(producido), sub: 'cajas' },
        { label: 'MERMA', value: numero(merma), sub: `${mermaPct.toFixed(1)} % del total` },
        { label: 'REGISTROS', value: numero(r.registros) },
        { label: 'PAROS', value: numero(paros), sub: `${numero(Math.round(minutosParados))} min` },
    ]);
    doc.x = x;
    doc.moveDown(1.4);

    if (comentario?.resumen) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA.titulo).text('Resumen ejecutivo', x, doc.y);
        doc.moveDown(0.4);
        dibujarParrafo(doc, comentario.resumen, x, ancho);
        doc.moveDown(1.2);
    }

    // El aviso que evita que alguien lea un reporte vacio como "no se produjo".
    if (!r.registros) {
        doc.font('Helvetica').fontSize(11).fillColor(TINTA.mala)
            .text('No hay producción registrada en este periodo dentro de tu alcance.', x);
        doc.font('Helvetica').fontSize(9).fillColor(TINTA.suave)
            .text('Puede que los datos no lleguen tan lejos: revisa el rango de fechas.', x);
        cerrar();
        return;
    }

    if (datos.porDia.length) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA.titulo).text('Producción por día', x, doc.y);
        doc.font('Helvetica').fontSize(8).fillColor(TINTA.suave)
            .text('Cajas registradas cada día del periodo.', x);
        doc.moveDown(0.5);
        dibujarLinea(doc, datos.porDia, x, doc.y, ancho, 150, paleta);
        doc.x = x;
        doc.moveDown(1.4);
    }

    doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA.titulo).text('Cajas por turno', x, doc.y);
    doc.moveDown(0.5);
    dibujarBarras(doc, datos.porTurno, x, doc.y, ancho);
    doc.x = x;

    // --- 2. produccion por maquina -----------------------------------------
    doc.addPage();
    doc.x = x;
    doc.y = doc.page.margins.top;
    seccion(doc, 'Producción por máquina', x, ancho, paleta);

    if (datos.porMaquina.length) {
        doc.font('Helvetica').fontSize(8).fillColor(TINTA.suave)
            .text('Cajas buenas contra lo que se fue en scrap y rechazo.', x);
        doc.moveDown(0.5);
        dibujarBarrasAgrupadas(doc, datos.porMaquina.slice(0, 10), x, doc.y, ancho, 170);
        doc.x = x;
        doc.moveDown(1.6);
    }

    dibujarTabla(doc, [
        { texto: 'Máquina' },
        { texto: 'Cajas', ancho: 80 },
        { texto: 'Scrap', ancho: 80 },
        { texto: 'Rechazo', ancho: 80 },
    ], datos.porMaquina.map((f) => [f.grupo, numero(f.cajas), numero(f.scrap), numero(f.rechazo)]), x, ancho);

    // --- 3. articulos ------------------------------------------------------
    doc.addPage();
    doc.x = x;
    doc.y = doc.page.margins.top;
    seccion(doc, 'Artículos más producidos', x, ancho, paleta);
    dibujarTabla(doc, [
        { texto: 'Artículo' },
        { texto: 'Órdenes', ancho: 60 },
        { texto: 'Planeado', ancho: 80 },
        { texto: 'Completado', ancho: 80 },
    ], datos.items.map((f) => [
        `${f.item}${f.descripcion ? ' - ' + String(f.descripcion).slice(0, 30) : ''}`,
        numero(f.ordenes), numero(f.planeado), numero(f.completado),
    ]), x, ancho);

    // --- 4. paros ----------------------------------------------------------
    doc.addPage();
    doc.x = x;
    doc.y = doc.page.margins.top;
    seccion(doc, 'Paros', x, ancho, paleta,
            paros ? { texto: `${numero(paros)} paros`, color: TINTA.mala } : null);

    if (datos.paros.length === 0) {
        doc.font('Helvetica').fontSize(9).fillColor(TINTA.suave)
            .text('Sin paros registrados en el periodo.', x);
        cerrar();
        return;
    }

    if (comentario?.eventos) {
        dibujarParrafo(doc, comentario.eventos, x, ancho);
        doc.moveDown(1.2);
    }

    if (datos.parosPorMaquina.length) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA.titulo)
            .text('Minutos parados por máquina', x, doc.y);
        doc.font('Helvetica').fontSize(8).fillColor(TINTA.suave)
            .text('Las que más tiempo estuvieron detenidas.', x);
        doc.moveDown(0.5);
        // Reusa las barras horizontales: esperan la columna `cajas`, asi que se
        // le pasa el total de minutos con ese nombre. Es un helper de dibujo, no
        // sabe de produccion.
        dibujarBarras(doc, datos.parosPorMaquina.map((f) => ({ grupo: f.grupo, cajas: f.total_min })),
                      x, doc.y, ancho, TINTA.mala);
        doc.x = x;
        doc.moveDown(1.6);
    }

    doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA.titulo).text('Por tipo de falla', x, doc.y);
    doc.moveDown(0.5);
    dibujarTabla(doc, [
        { texto: 'Tipo' },
        { texto: 'Cuántos', ancho: 70 },
        { texto: 'Promedio (min)', ancho: 90 },
        { texto: 'Total (min)', ancho: 80 },
    ], datos.paros.map((f) => [f.tipo, numero(f.cuantos), numero(f.promedio_min), numero(f.total_min)]), x, ancho);

    // --- 5. recomendaciones -------------------------------------------------
    if (comentario?.recomendaciones) {
        doc.addPage();
        doc.x = x;
        doc.y = doc.page.margins.top;
        seccion(doc, 'Recomendaciones', x, ancho, paleta);
        dibujarParrafo(doc, comentario.recomendaciones, x, ancho);

        // Quien lee tiene derecho a saber si esto lo escribio un modelo o si
        // son frases armadas con las cifras. No es lo mismo y no se disimula.
        doc.moveDown(1.5);
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(TINTA.suave)
            .text(comentario.deLaIA
                ? 'Redactado por el asistente a partir de las cifras de este reporte. '
                  + 'Son sugerencias sobre lo observado en el periodo, no un diagnóstico.'
                : 'Texto armado con las cifras de este reporte.', x, doc.y, { width: ancho });
    }

    cerrar();
}

module.exports = { datosDelReporte, dibujarReporte };
