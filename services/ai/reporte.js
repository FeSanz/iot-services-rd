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
const { consultarConAlcance, rangoFechas } = require('./scope');
const { dibujarPortada, PALETA_BASE } = require('./portada');

const TINTA = { titulo: '#2C3E50', suave: '#7F8C8D', linea: '#DDDDDD', barra: '#3498DB', mala: '#B03A2E' };

const numero = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('es-MX'));

/**
 * El periodo inmediatamente anterior, del mismo largo.
 *
 * Sin comparacion, "88 cajas" no dice nada: es una cifra sin vara. Con ella se
 * vuelve "88 cajas, 34 % menos que el periodo anterior", que ya es un juicio.
 * Se calcula en JS y no en SQL a proposito -- asi las dos consultas usan el
 * mismo rangoFechas de siempre y el corte de dia sigue siendo el de la planta.
 */
function periodoAnterior(desde, hasta) {
    if (!desde || !hasta) return null;
    const d = new Date(`${desde}T00:00:00Z`);
    const h = new Date(`${hasta}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || Number.isNaN(h.getTime()) || h < d) return null;

    const DIA = 86400000;
    const dias = Math.round((h - d) / DIA) + 1;
    const fin = new Date(d.getTime() - DIA);                 // el dia antes de que empiece este
    const ini = new Date(fin.getTime() - (dias - 1) * DIA);
    const iso = (t) => t.toISOString().slice(0, 10);
    return { desde: iso(ini), hasta: iso(fin), dias };
}

/** Variacion porcentual contra el periodo anterior. Null si no hay con que comparar. */
function variacion(ahora, antes) {
    const a = Number(ahora) || 0;
    const b = Number(antes) || 0;
    if (!b) return null;               // dividir entre cero no es "infinito por ciento"
    return ((a - b) / b) * 100;
}

/**
 * Los datos del reporte, todos con el alcance del que pregunta.
 *
 * En paralelo porque son independientes y hay alguien esperando con la ventana
 * abierta: en serie son cinco viajes a la base, uno detras de otro.
 */
async function datosDelReporte(scope, desde, hasta) {
    // El corte de dia es el de la PLANTA, via rangoFechas: con la base en UTC,
    // un `>= $1` pelado metia la noche anterior y perdia la ultima -- y la
    // grafica por dia (que agrupa por local_date) mostraba una barra fuera del
    // periodo declarado en la portada.
    const rx = rangoFechas('execution_date', desde, hasta, 1);
    const rs = rangoFechas('start_date', desde, hasta, 1);

    // Son DIEZ consultas en paralelo sobre un pool de cinco conexiones
    // (poolReadonly): las cinco de mas se encolan, no fallan, y el reporte
    // completo sigue tardando menos de un segundo en la parte de base -- lo que
    // se lleva los segundos es la narrativa del modelo. Si algun dia pesa, se
    // sube el `max` del pool, no se quitan consultas.
    //
    // El periodo anterior, del mismo largo, para poder comparar.
    const previo = periodoAnterior(desde, hasta);
    const rxPrevio = previo ? rangoFechas('execution_date', previo.desde, previo.hasta, 1) : null;
    const rsPrevio = previo ? rangoFechas('start_date', previo.desde, previo.hasta, 1) : null;

    const [resumen, porTurno, porMaquina, items, paros, porDia, parosPorMaquina,
           plan, resumenPrevio, parosPrevio] = await Promise.all([
        consultarConAlcance(scope, `
            SELECT count(*)::int       AS registros,
                   sum(cajas)          AS cajas,
                   sum(scrap)          AS scrap,
                   sum(rechazo)        AS rechazo,
                   min(execution_date) AS primera,
                   max(execution_date) AS ultima
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
             ${rx.sql}`, rx.valores),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(shift_name), ''), 'sin turno') AS grupo,
                   sum(cajas) AS cajas, sum(scrap) AS scrap, sum(rechazo) AS rechazo
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
             ${rx.sql}
             GROUP BY 1 ORDER BY 2 DESC NULLS LAST`, rx.valores),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(machine_name), ''), NULLIF(trim(machine_code), ''), 'sin maquina') AS grupo,
                   sum(cajas) AS cajas, sum(scrap) AS scrap, sum(rechazo) AS rechazo
              FROM v_production_machine
             WHERE organization_id = ANY($ORGS)
             ${rx.sql}
             GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 15`, rx.valores),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(item_number), ''), 'sin item') AS item,
                   max(item_description)       AS descripcion,
                   count(*)::int               AS ordenes,
                   sum(planned_start_quantity) AS planeado,
                   sum(completed_quantity)     AS completado
              FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
             ${rs.sql}
             GROUP BY 1 ORDER BY 5 DESC NULLS LAST LIMIT 10`, rs.valores),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(failure_type), ''), 'sin tipo') AS tipo,
                   count(*)::int              AS cuantos,
                   round(avg(duracion_min), 1) AS promedio_min,
                   round(sum(duracion_min), 1) AS total_min
              FROM v_machine_stops
             WHERE organization_id = ANY($ORGS)
             ${rs.sql}
             GROUP BY 1 ORDER BY 2 DESC`, rs.valores),

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
             ${rx.sql}
             GROUP BY 1 ORDER BY 1`, rx.valores),

        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(machine_name), ''), NULLIF(trim(machine_code), ''), 'sin maquina') AS grupo,
                   count(*)::int               AS cuantos,
                   round(sum(duracion_min), 1) AS total_min
              FROM v_machine_stops
             WHERE organization_id = ANY($ORGS)
             ${rs.sql}
             GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 8`, rs.valores),

        // Plan contra real. La META NO se inventa: sale de planned_start_quantity,
        // que es lo unico que el MES tiene registrado como objetivo. Donde no hay
        // plan capturado, el reporte lo dice en vez de suponerlo.
        consultarConAlcance(scope, `
            SELECT COALESCE(NULLIF(trim(status), ''), 'sin estado') AS estado,
                   count(*)::int                                    AS ordenes,
                   count(planned_start_quantity)::int               AS con_plan,
                   sum(planned_start_quantity)                      AS planeado,
                   sum(completed_quantity)                          AS completado
              FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
             ${rs.sql}
             GROUP BY 1 ORDER BY 2 DESC`, rs.valores),

        // Las dos del periodo anterior. Si no hay periodo con que comparar
        // (falta una fecha), se resuelven a null y la seccion lo omite.
        previo ? consultarConAlcance(scope, `
            SELECT count(*)::int AS registros,
                   sum(cajas)    AS cajas,
                   sum(scrap)    AS scrap,
                   sum(rechazo)  AS rechazo,
                   count(DISTINCT local_date)::int AS dias_con_datos
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
             ${rxPrevio.sql}`, rxPrevio.valores) : null,

        previo ? consultarConAlcance(scope, `
            SELECT count(*)::int              AS cuantos,
                   round(sum(duracion_min), 1) AS total_min
              FROM v_machine_stops
             WHERE organization_id = ANY($ORGS)
             ${rsPrevio.sql}`, rsPrevio.valores) : null,
    ]);

    return {
        resumen: resumen.rows[0],
        porTurno: porTurno.rows,
        porMaquina: porMaquina.rows,
        items: items.rows,
        paros: paros.rows,
        porDia: porDia.rows,
        parosPorMaquina: parosPorMaquina.rows,
        plan: plan.rows,
        anterior: previo && {
            ...previo,
            resumen: resumenPrevio.rows[0],
            paros: parosPrevio.rows[0],
        },
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
function dibujarBarrasAgrupadas(doc, filas, x, y, ancho, alto, paleta) {
    const series = [
        // Lo bueno va del color de la compañia; scrap y rechazo se quedan en
        // ambar y rojo -- son la misma advertencia en todos los reportes y no
        // deben cambiar de significado porque el cliente eligio otro color.
        { clave: 'cajas', color: paleta ? paleta.acento : TINTA.barra },
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
 * Subseccion: barra del color de la compañia, titulo y --si se le da-- una
 * linea en cursiva que explica COMO se lee lo que viene debajo.
 *
 * El titulo va redactado como pregunta ("¿Que turno produce mas?"). No es
 * coqueteria: quien abre un reporte de seis paginas necesita saber que le van a
 * contestar antes de mirar la grafica, o la hojea entera sin leerla.
 */
function subseccion(doc, titulo, nota, x, ancho, paleta) {
    const alto = nota ? 34 : 22;
    if (doc.y + alto + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;

    doc.save().rect(x, y, 3, 12).fill(paleta.acento).restore();
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(TINTA.titulo)
        .text(aWinAnsi(titulo), x + 10, y - 1, { width: ancho - 10 });

    if (nota) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(TINTA.suave)
            .text(aWinAnsi(nota), x + 10, doc.y + 1, { width: ancho - 10 });
    }
    doc.y += 6;
    doc.x = x;
}

/**
 * Recuadro de contexto. `tono` 'nota' para lo informativo y 'aviso' para lo que
 * el lector no debe pasar por alto (que la IA redacto algo, que el dato esta
 * incompleto).
 */
function recuadro(doc, texto, x, ancho, tono = 'nota', paleta) {
    if (!texto) return;
    const t = aWinAnsi(texto);
    const fondo = tono === 'aviso' ? '#FDF6E3' : '#F7F7F5';
    const barra = tono === 'aviso' ? '#B9770E' : (paleta ? paleta.acento : TINTA.barra);
    const color = tono === 'aviso' ? '#7E5109' : TINTA.titulo;

    doc.font(tono === 'aviso' ? 'Helvetica-Oblique' : 'Helvetica').fontSize(8.5);
    const alto = doc.heightOfString(t, { width: ancho - 26 }) + 14;
    if (doc.y + alto > doc.page.height - doc.page.margins.bottom) doc.addPage();

    const y = doc.y;
    doc.save().rect(x, y, ancho, alto).fill(fondo).restore();
    doc.save().rect(x, y, 3, alto).fill(barra).restore();
    doc.fillColor(color).text(t, x + 14, y + 7, { width: ancho - 26 });
    doc.y = y + alto + 8;
    doc.x = x;
}

/**
 * Las tarjetas de panorama: fondo oscuro de la compañia, cifra en el acento, y
 * debajo un pie chico con el CONTEXTO de la cifra (cuando fue, sobre que).
 * Una cifra sin contexto obliga a buscarlo en otra pagina.
 */
function tarjetasKpi(doc, x, y, ancho, tarjetas, paleta) {
    if (!tarjetas.length) return;
    const hueco = 8;
    const w = (ancho - hueco * (tarjetas.length - 1)) / tarjetas.length;
    const alto = 54;

    tarjetas.forEach((t, i) => {
        const cx = x + i * (w + hueco);
        doc.save().roundedRect(cx, y, w, alto, 4).fill(paleta.fondo1).restore();
        doc.font('Helvetica-Bold').fontSize(15).fillColor(paleta.acento)
            .text(aWinAnsi(t.valor), cx, y + 9, { width: w, align: 'center', lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(paleta.tinta)
            .text(aWinAnsi(t.etiqueta).toUpperCase(), cx + 4, y + 29,
                  { width: w - 8, align: 'center', characterSpacing: 0.4 });
        if (t.pie) {
            doc.font('Helvetica').fontSize(6).fillColor(paleta.suave)
                .text(aWinAnsi(t.pie), cx + 4, y + 40, { width: w - 8, align: 'center', lineBreak: false });
        }
    });
    doc.y = y + alto + 12;
    doc.x = x;
}

/**
 * Marco para una grafica: fondo claro, la grafica dentro y al pie el periodo de
 * los datos. `dibuja` recibe el hueco util y pinta ahi.
 */
function tarjetaGrafica(doc, { x, ancho, alto, pie, dibuja }) {
    if (doc.y + alto + 26 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    doc.save().roundedRect(x, y, ancho, alto + 24, 4).fill('#FBFBFA').restore();
    doc.save().roundedRect(x, y, ancho, alto + 24, 4).lineWidth(0.5).stroke(TINTA.linea).restore();

    doc.y = y + 10;
    doc.x = x + 12;
    dibuja(x + 12, doc.y, ancho - 24, alto - 12);

    if (pie) {
        doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(TINTA.suave)
            .text(aWinAnsi(pie), x + 12, y + alto + 10, { width: ancho - 24, align: 'right', lineBreak: false });
    }
    doc.y = y + alto + 30;
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
 * La etiqueta de merma. Dice la cifra y NO la juzga.
 *
 * Tenia tres colores con cortes en 3 % y 8 %, que nadie confirmo -- son lo que
 * suena razonable en manufactura, que no es lo mismo que ser cierto. Se
 * quedaron en un solo color el dia que la seccion de calidad empezo a decir por
 * escrito que el MES no tiene ningun umbral registrado y que este reporte no
 * declara si el nivel es aceptable: una pastilla verde debajo de ese parrafo lo
 * desmiente en el mismo vistazo.
 *
 * ponytail: cuando el umbral exista COMO DATO, aqui vuelve el color -- pero
 * leido de la base, no escrito a mano.
 */
function etiquetaDeMerma(pct) {
    return { texto: `merma ${pct.toFixed(1)} %`, color: TINTA.titulo };
}

/**
 * Una tabla. Salta de pagina sola si no cabe.
 *
 * Con `paleta` se dibuja formal: cabecera en el fondo de la compañia con las
 * etiquetas en su acento, y filas alternadas. Sin ella, la tabla escueta de
 * antes -- que es la que sigue sirviendo para los anexos.
 */
function dibujarTabla(doc, encabezados, filas, x, ancho, paleta) {
    const fijos = encabezados.reduce((a, h) => a + (h.ancho || 0), 0);
    const auto = encabezados.filter((h) => !h.ancho).length;
    const anchoDe = (i) => encabezados[i].ancho || (ancho - fijos) / auto;
    const ALTO = paleta ? 16 : 14;

    const cabecera = () => {
        if (doc.y + ALTO * 2 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const fy = doc.y;
        if (paleta) doc.save().rect(x, fy - 3, ancho, ALTO + 3).fill(paleta.fondo1).restore();
        let cx = x;
        encabezados.forEach((h, i) => {
            doc.font('Helvetica-Bold').fontSize(paleta ? 7.5 : 9)
                .fillColor(paleta ? paleta.acento : TINTA.suave)
                .text(paleta ? aWinAnsi(h.texto).toUpperCase() : h.texto, cx + (paleta ? 6 : 0), fy + (paleta ? 1 : 0), {
                    width: anchoDe(i) - (paleta ? 12 : 4),
                    ellipsis: true,
                    align: i === 0 ? 'left' : 'right',
                    characterSpacing: paleta ? 0.3 : 0,
                });
            cx += anchoDe(i);
        });
        doc.y = fy + ALTO;
        if (!paleta) {
            doc.moveTo(x, doc.y - 2).lineTo(x + ancho, doc.y - 2).strokeColor(TINTA.linea).stroke();
            doc.y += 2;
        }
    };

    const fila = (celdas, n) => {
        // Si no cabe ni una fila mas, pagina nueva -- y la cabecera se repite:
        // media tabla sin encabezado en la pagina siguiente no se puede leer.
        if (doc.y + ALTO + 4 > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            cabecera();
        }
        const fy = doc.y;
        if (paleta && n % 2 === 1) doc.save().rect(x, fy - 2, ancho, ALTO).fill('#F5F6F7').restore();
        let cx = x;
        celdas.forEach((c, i) => {
            doc.font('Helvetica').fontSize(paleta ? 8.5 : 9).fillColor(TINTA.titulo)
                .text(aWinAnsi(String(c)), cx + (paleta ? 6 : 0), fy, {
                    width: anchoDe(i) - (paleta ? 12 : 4),
                    ellipsis: true,
                    align: i === 0 ? 'left' : 'right',
                });
            cx += anchoDe(i);
        });
        doc.y = fy + ALTO;
    };

    cabecera();
    filas.forEach(fila);
    doc.x = x;
    doc.y += 4;
}

/** Dibuja el reporte entero sobre `res`. Devuelve el PDFDocument (por si el
 *  llamador quiere oir sus errores: pipe NO los propaga al destino). */
function dibujarReporte(res, { empresa, desde, hasta, datos, generadoPor, paleta = PALETA_BASE, comentario }) {
    // bufferPages para poder volver a cada pagina al final y escribirle
    // "pagina N de M": el total no se sabe hasta que se acaba de dibujar.
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    doc.pipe(res);
    try {
        pintar(doc, { empresa, desde, hasta, datos, generadoPor, paleta, comentario });
    } catch (e) {
        // Un throw a media pintura (un logo corrupto, un dato con forma rara)
        // dejaba al cliente esperando un PDF que nunca termina. Se cierra el
        // flujo con lo que haya --truncado, pero termina-- y el error sube para
        // que el llamador lo registre o conteste, segun pueda.
        try { doc.end(); } catch { /* ya estaba cerrado */ }
        throw e;
    }
    return doc;
}

/**
 * El reporte, seccion por seccion.
 *
 * El orden no es decorativo: primero QUE paso (resumen con comparacion), luego
 * CUANTO de lo prometido se cumplio (plan contra real), luego el detalle
 * (produccion, calidad, paros), y al final -- antes de las recomendaciones --
 * CUANTO se puede confiar en todo lo anterior (cobertura del dato). Un reporte
 * que no dice cuantos dias tuvieron registro deja al lector creyendo que una
 * linea plana es una planta parada, cuando puede ser una planta sin capturar.
 */
function pintar(doc, { empresa, desde, hasta, datos, generadoPor, paleta, comentario }) {
    const x = doc.page.margins.left;
    const ancho = doc.page.width - x - doc.page.margins.right;
    const r = datos.resumen || {};

    const producido = Number(r.cajas) || 0;
    const merma = Number(r.scrap || 0) + Number(r.rechazo || 0);
    const mermaPct = producido + merma > 0 ? (merma / (producido + merma) * 100) : 0;
    const paros = datos.paros.reduce((a, p) => a + p.cuantos, 0);
    const minutosParados = datos.paros.reduce((a, p) => a + (Number(p.total_min) || 0), 0);

    // Plan contra real. Si no hay ni una orden con plan capturado, no se finge
    // un porcentaje: se dice que no hay meta registrada.
    const plan = datos.plan || [];
    const planeado = plan.reduce((a, f) => a + (Number(f.planeado) || 0), 0);
    const completado = plan.reduce((a, f) => a + (Number(f.completado) || 0), 0);
    const ordenes = plan.reduce((a, f) => a + f.ordenes, 0);
    const sinPlan = plan.reduce((a, f) => a + (f.ordenes - f.con_plan), 0);
    const cumplimiento = planeado > 0 ? (completado / planeado) * 100 : null;

    // Cobertura: dias del periodo contra dias con al menos un registro.
    const DIA = 86400000;
    const diasPeriodo = (desde && hasta)
        ? Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / DIA) + 1
        : null;
    const diasConDatos = datos.porDia.length;
    const coberturaPct = diasPeriodo ? (diasConDatos / diasPeriodo) * 100 : null;

    const previo = datos.anterior;
    const pr = previo?.resumen || {};
    const producidoPrevio = Number(pr.cajas) || 0;
    const mermaPrevia = Number(pr.scrap || 0) + Number(pr.rechazo || 0);
    const parosPrevios = Number(previo?.paros?.cuantos) || 0;

    // Con el periodo anterior en cero no hay porcentaje que valga: "+infinito"
    // no es una variacion. Se dice que no hay base, y si ambos son cero, que no
    // se movio -- que es informacion, no un hueco.
    const pct = (ahora, antes) => {
        const v = variacion(ahora, antes);
        if (v !== null) return `${v > 0 ? '+' : ''}${v.toFixed(1)} %`;
        return (Number(ahora) || 0) === 0 ? 'igual (0)' : 'sin base';
    };
    const fecha = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

    const cerrar = () => {
        piesDePagina(doc, paleta, empresa);
        doc.end();
    };
    /**
     * Abre una seccion. NO siempre en pagina nueva: solo si lo que queda de
     * hoja no da para el titulo y algo debajo. Una seccion por pagina dejaba
     * media hoja en blanco cinco veces seguidas y estiraba el reporte a ocho
     * paginas de las que tres eran aire.
     *
     * El corte son 180 puntos: titulo con su regla (~30) + un recuadro o
     * subtitulo (~40) + cabecera de tabla y dos filas (~70), con holgura. Por
     * debajo de eso el encabezado se quedaria solo al pie, que es peor que el
     * blanco -- y por eso el corte no baja mas.
     */
    const hoja = (titulo, etiqueta, { nuevaPagina = false } = {}) => {
        const libre = doc.page.height - doc.page.margins.bottom - doc.y;
        if (nuevaPagina || libre < 180) {
            doc.addPage();
            doc.y = doc.page.margins.top;
        } else {
            doc.y += 22;
        }
        doc.x = x;
        seccion(doc, titulo, x, ancho, paleta, etiqueta);
    };

    // --- portada -----------------------------------------------------------
    dibujarPortada(doc, {
        empresa, desde, hasta, paleta,
        generadoPor: generadoPor ? `Origen: ${generadoPor}` : undefined,
        kpis: [
            { etiqueta: 'Producido', valor: numero(producido) },
            { etiqueta: 'Cumplimiento', valor: cumplimiento === null ? 's/ plan' : `${cumplimiento.toFixed(1)} %` },
            { etiqueta: 'Merma', valor: `${mermaPct.toFixed(1)} %` },
            { etiqueta: 'Paros', valor: numero(paros) },
        ],
    });

    // --- 1. resumen ejecutivo ----------------------------------------------
    hoja('Resumen ejecutivo', r.registros ? etiquetaDeMerma(mermaPct) : null, { nuevaPagina: true });
    doc.font('Helvetica').fontSize(9).fillColor(TINTA.suave)
        .text(`${empresa} · ${desde} a ${hasta}`, x);
    doc.moveDown(0.8);
    doc.x = x;

    if (comentario?.resumen) {
        dibujarParrafo(doc, comentario.resumen, x, ancho);
        doc.moveDown(0.8);
    }

    subseccion(doc, 'Cifras del periodo',
        previo
            ? `Comparadas con el periodo anterior de la misma duración (${previo.desde} a ${previo.hasta}).`
            : 'Sin periodo anterior con que comparar: falta una de las dos fechas.',
        x, ancho, paleta);

    dibujarTabla(doc, [
        { texto: 'Métrica' },
        { texto: 'Este periodo', ancho: 100 },
        { texto: 'Anterior', ancho: 100 },
        { texto: 'Variación', ancho: 90 },
    ], [
        ['Cajas producidas', numero(producido), previo ? numero(producidoPrevio) : '-', previo ? pct(producido, producidoPrevio) : '-'],
        ['Merma (scrap + rechazo)', numero(merma), previo ? numero(mermaPrevia) : '-', previo ? pct(merma, mermaPrevia) : '-'],
        ['Registros de producción', numero(r.registros), previo ? numero(pr.registros) : '-', previo ? pct(r.registros, pr.registros) : '-'],
        ['Paros', numero(paros), previo ? numero(parosPrevios) : '-', previo ? pct(paros, parosPrevios) : '-'],
        ['Días con registro', `${diasConDatos}${diasPeriodo ? ` de ${diasPeriodo}` : ''}`,
            previo ? numero(pr.dias_con_datos) : '-', '-'],
    ], x, ancho, paleta);
    doc.moveDown(0.8);

    subseccion(doc, 'Panorama del periodo', null, x, ancho, paleta);
    tarjetasKpi(doc, x, doc.y, ancho, [
        { etiqueta: 'Producido', valor: numero(producido), pie: 'cajas buenas' },
        { etiqueta: 'Cumplimiento', valor: cumplimiento === null ? '—' : `${cumplimiento.toFixed(1)} %`,
          pie: cumplimiento === null ? 'sin plan capturado' : `${numero(completado)} de ${numero(planeado)}` },
        { etiqueta: 'Merma', valor: `${mermaPct.toFixed(1)} %`, pie: `${numero(merma)} unidades` },
        { etiqueta: 'Paros', valor: numero(paros), pie: `${numero(Math.round(minutosParados))} min detenido` },
    ], paleta);

    // El aviso que evita que alguien lea un reporte vacio como "no se produjo".
    if (!r.registros) {
        recuadro(doc, 'No hay producción registrada en este periodo dentro de tu alcance. '
            + 'Puede que los datos no lleguen tan lejos: revisa el rango de fechas antes de leerlo como una planta detenida.',
            x, ancho, 'aviso');
        cerrar();
        return;
    }

    // --- 2. cumplimiento del plan ------------------------------------------
    hoja('Cumplimiento del plan');
    recuadro(doc, 'La meta no es una suposición: sale de la cantidad planeada que el MES tiene '
        + `capturada en cada orden. En este periodo hay ${numero(ordenes)} órdenes`
        + (sinPlan ? `, de las cuales ${numero(sinPlan)} no tienen cantidad planeada y quedan fuera del porcentaje.` : '.'),
        x, ancho, 'nota', paleta);

    subseccion(doc, '¿Cuánto de lo planeado se completó?',
        'Por estado de la orden. El porcentaje solo cuenta las órdenes con plan capturado.',
        x, ancho, paleta);

    dibujarTabla(doc, [
        { texto: 'Estado' },
        { texto: 'Órdenes', ancho: 70 },
        { texto: 'Planeado', ancho: 90 },
        { texto: 'Completado', ancho: 90 },
        { texto: 'Cumplido', ancho: 70 },
    ], plan.map((f) => {
        const p = Number(f.planeado) || 0;
        const c = Number(f.completado) || 0;
        return [f.estado, numero(f.ordenes), numero(p), numero(c), p > 0 ? `${(c / p * 100).toFixed(1)} %` : '—'];
    }), x, ancho, paleta);
    doc.moveDown(1);

    if (datos.items.length) {
        subseccion(doc, '¿Qué artículos concentran el plan?',
            'Los diez con más volumen planeado en el periodo.', x, ancho, paleta);
        dibujarTabla(doc, [
            { texto: 'Artículo' },
            { texto: 'Órdenes', ancho: 60 },
            { texto: 'Planeado', ancho: 80 },
            { texto: 'Completado', ancho: 80 },
        ], datos.items.map((f) => [
            `${f.item}${f.descripcion ? ' - ' + String(f.descripcion).slice(0, 30) : ''}`,
            numero(f.ordenes), numero(f.planeado), numero(f.completado),
        ]), x, ancho, paleta);
    }

    // --- 3. produccion -----------------------------------------------------
    hoja('Producción');

    if (datos.porDia.length) {
        subseccion(doc, '¿Cómo se movió la producción día a día?',
            'Cada punto es un día del periodo con registro. Los días sin captura no dibujan punto.',
            x, ancho, paleta);
        tarjetaGrafica(doc, {
            x, ancho, alto: 160,
            pie: `Periodo de los datos: ${fecha(r.primera)} — ${fecha(r.ultima)}`,
            dibuja: (gx, gy, gw, gh) => dibujarLinea(doc, datos.porDia, gx, gy, gw, gh, paleta),
        });
    }

    if (datos.porTurno.length) {
        subseccion(doc, '¿Qué turno produce más?',
            'Cajas buenas acumuladas por turno en todo el periodo.', x, ancho, paleta);
        tarjetaGrafica(doc, {
            x, ancho, alto: Math.min(30 + datos.porTurno.length * 22, 150),
            dibuja: (gx, gy, gw) => dibujarBarras(doc, datos.porTurno, gx, gy, gw, paleta.acento),
        });
    }

    if (datos.porMaquina.length) {
        subseccion(doc, '¿Qué máquinas concentran la producción?',
            'Cajas buenas contra lo que se fue en scrap y rechazo, por máquina.', x, ancho, paleta);
        tarjetaGrafica(doc, {
            x, ancho, alto: 180,
            dibuja: (gx, gy, gw, gh) => dibujarBarrasAgrupadas(doc, datos.porMaquina.slice(0, 10), gx, gy, gw, gh, paleta),
        });
    }

    // --- 4. calidad y merma ------------------------------------------------
    hoja('Calidad y merma', r.registros ? etiquetaDeMerma(mermaPct) : null);
    recuadro(doc, 'El MES no tiene registrado ningún umbral de merma, así que este reporte '
        + 'no declara si el nivel es aceptable: presenta la cifra y su reparto. '
        + 'En cuanto el umbral exista como dato, la tabla lo marca sola.',
        x, ancho, 'aviso');

    subseccion(doc, '¿Dónde se concentra la merma?',
        'Scrap y rechazo por máquina, con su peso sobre lo que esa máquina movió.',
        x, ancho, paleta);

    dibujarTabla(doc, [
        { texto: 'Máquina' },
        { texto: 'Cajas', ancho: 70 },
        { texto: 'Scrap', ancho: 70 },
        { texto: 'Rechazo', ancho: 70 },
        { texto: 'Merma', ancho: 70 },
    ], datos.porMaquina.map((f) => {
        const buenas = Number(f.cajas) || 0;
        const mala = (Number(f.scrap) || 0) + (Number(f.rechazo) || 0);
        const total = buenas + mala;
        return [f.grupo, numero(f.cajas), numero(f.scrap), numero(f.rechazo),
                total > 0 ? `${(mala / total * 100).toFixed(1)} %` : '—'];
    }), x, ancho, paleta);

    // --- 5. paros ----------------------------------------------------------
    hoja('Paros', paros ? { texto: `${numero(paros)} paros`, color: TINTA.mala } : null);

    // Sin paros la seccion se abrevia, pero NO se corta el reporte: un periodo
    // limpio es justo donde "confirma que las alertas se estan cerrando" mas
    // falta hace.
    if (datos.paros.length === 0) {
        recuadro(doc, 'Sin paros registrados en el periodo. Vale la pena confirmar que las alertas '
            + 'se están cerrando: un periodo sin paros y un periodo sin captura se ven igual desde aquí.',
            x, ancho, 'aviso');
    } else {
        if (comentario?.eventos) {
            dibujarParrafo(doc, comentario.eventos, x, ancho);
            doc.moveDown(0.8);
        }

        if (datos.parosPorMaquina.length) {
            subseccion(doc, '¿Qué máquinas estuvieron más tiempo detenidas?',
                'Minutos acumulados de paro en el periodo.', x, ancho, paleta);
            tarjetaGrafica(doc, {
                x, ancho, alto: Math.min(30 + datos.parosPorMaquina.length * 20, 170),
                // Reusa las barras horizontales: esperan la columna `cajas`, asi que se
                // le pasa el total de minutos con ese nombre. Es un helper de dibujo, no
                // sabe de produccion.
                dibuja: (gx, gy, gw) => dibujarBarras(doc,
                    datos.parosPorMaquina.map((f) => ({ grupo: f.grupo, cajas: f.total_min })),
                    gx, gy, gw, TINTA.mala),
            });
        }

        subseccion(doc, '¿Por qué se detuvieron?',
            'Por tipo de falla, ordenado por cuántas veces ocurrió.', x, ancho, paleta);
        dibujarTabla(doc, [
            { texto: 'Tipo' },
            { texto: 'Cuántos', ancho: 70 },
            { texto: 'Promedio (min)', ancho: 90 },
            { texto: 'Total (min)', ancho: 80 },
        ], datos.paros.map((f) => [f.tipo, numero(f.cuantos), numero(f.promedio_min), numero(f.total_min)]),
           x, ancho, paleta);
    }

    // --- 6. cobertura del dato ---------------------------------------------
    hoja('Cobertura del dato');
    recuadro(doc, 'Esta sección no habla de la planta, habla del reporte: cuánto del periodo '
        + 'tiene registro. Sin ella, un periodo sin capturar y un periodo sin producir '
        + 'se leen exactamente igual.', x, ancho, 'nota', paleta);

    dibujarTabla(doc, [
        { texto: 'Concepto' },
        { texto: 'Valor', ancho: 180 },
    ], [
        ['Días del periodo', diasPeriodo === null ? '-' : numero(diasPeriodo)],
        ['Días con al menos un registro', `${numero(diasConDatos)}${coberturaPct === null ? '' : ` (${coberturaPct.toFixed(1)} %)`}`],
        ['Primer registro del periodo', fecha(r.primera)],
        ['Último registro del periodo', fecha(r.ultima)],
        ['Máquinas con producción', numero(datos.porMaquina.length)],
        ['Órdenes sin cantidad planeada', numero(sinPlan)],
    ], x, ancho, paleta);

    if (coberturaPct !== null && coberturaPct < 50) {
        doc.moveDown(0.6);
        recuadro(doc, `Solo ${coberturaPct.toFixed(1)} % de los días del periodo tienen registro. `
            + 'Las cifras de arriba son ciertas, pero describen esos días, no el periodo completo: '
            + 'conviene leerlas como una muestra y no como el total.', x, ancho, 'aviso');
    }

    // --- 7. recomendaciones -------------------------------------------------
    if (comentario?.recomendaciones) {
        hoja('Recomendaciones');
        // Quien lee tiene derecho a saber si esto lo escribio un modelo o si son
        // frases armadas con las cifras. No es lo mismo y no se disimula.
        recuadro(doc, comentario.deLaIA
            ? 'Las siguientes sugerencias las redacta el asistente a partir de las cifras de este '
              + 'reporte. Son observaciones sobre el periodo, no un diagnóstico, y no sustituyen el '
              + 'criterio de quien opera la planta.'
            : 'Texto armado con las cifras de este reporte, sin intervención del modelo.',
            x, ancho, 'aviso');
        dibujarParrafo(doc, comentario.recomendaciones, x, ancho);
    }

    cerrar();
}

// periodoAnterior y variacion salen exportadas para poder probarlas sin
// levantar un PDF entero: son aritmetica de fechas y una division, que es
// justo donde se cuela un dia de mas o un "infinito por ciento".
module.exports = { datosDelReporte, dibujarReporte, periodoAnterior, variacion };
