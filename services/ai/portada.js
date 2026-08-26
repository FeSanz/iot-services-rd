/**
 * La portada del reporte (ETAPA 5, acabado).
 *
 * Se DIBUJA, no es una imagen. Es lo que pidio el cliente: una portada de
 * fabrica, diseñada aqui, a la que pdfkit solo le cambia color, nombres y
 * cifras segun la compañia. Una PNG no se puede recolorear -- y recolorear era
 * el requisito.
 *
 * Todo el color sale de UNA variable: `REPORT_COLOR` en mes_settings. Sin esa
 * fila, la paleta base (azul noche y dorado). El dia que llegue arte de un
 * diseñador, meterlo es cambiar el degradado por un doc.image() de fondo y
 * dejar los textos encima -- por eso los textos van en su propia funcion.
 *
 * Sin Chromium, sin plantillas HTML y sin dependencias nuevas: pdfkit ya estaba.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../../database/pool');

const LOGO = path.join(__dirname, '..', '..', 'assets', 'img', 'mes_logo_white.png');

/** Azul noche y dorado. Lo que sale cuando la compañia no eligio color. */
const PALETA_BASE = {
    fondo1: '#0F1B2D',
    fondo2: '#1E3A5F',
    acento: '#E8B830',
    tinta:  '#F2EFEA',
    suave:  '#8AA0B0',
};

// --- color, lo minimo para poder mezclar ------------------------------------
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function aRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function aHex(rgb) {
    return '#' + rgb
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('');
}

function mezclar(colorA, colorB, t) {
    const a = aRgb(colorA);
    const b = aRgb(colorB);
    return aHex(a.map((v, i) => v + (b[i] - v) * t));
}

/** Luminancia relativa, para saber si algo se va a leer sobre el fondo oscuro. */
function luz(hex) {
    const [r, g, b] = aRgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * De UN color de compañia a la paleta entera.
 *
 * El acento se aclara hasta que se lee sobre el fondo oscuro. Sin esto, una
 * compañia con el azul marino de su logo se llevaba una portada con el periodo
 * escrito en un color que no se distingue del fondo -- tecnicamente correcto e
 * ilegible.
 */
function paletaDe(color) {
    if (!color || !HEX.test(String(color).trim())) return PALETA_BASE;
    const base = '#' + String(color).trim().replace('#', '');

    let acento = base;
    // Acotado: mezclar con blanco converge, pero un bucle sin tope en algo que
    // dibuja un PDF a peticion es una forma tonta de colgar el servidor.
    for (let i = 0; i < 8 && luz(acento) < 0.45; i++) acento = mezclar(acento, '#ffffff', 0.3);

    return {
        fondo1: mezclar(base, '#000000', 0.80),
        fondo2: mezclar(base, '#000000', 0.45),
        acento,
        tinta:  '#F2EFEA',
        suave:  mezclar(base, '#ffffff', 0.62),
    };
}

/**
 * El color de la compañia, si lo eligio.
 *
 * Fila opcional en mes_settings, con la misma forma que AI_FLAG. Sin fila, la
 * paleta base -- no hay migracion que aplicar para que esto funcione.
 */
async function paletaDeCompania(companyId) {
    try {
        const { rows } = await pool.query(
            `SELECT value FROM mes_settings
              WHERE company_id = $1 AND name = 'REPORT_COLOR' AND enabled_flag = 'Y'`,
            [companyId]
        );
        return paletaDe(rows[0]?.value);
    } catch (e) {
        // Un color mal puesto no puede impedir que salga el reporte.
        console.error('[AI] no pude leer REPORT_COLOR:', e.message);
        return PALETA_BASE;
    }
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-01-01" -> "1 ene 2026". En la portada la fecha se lee, no se parsea. */
function fechaLarga(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    return `${Number(m[3])} ${MESES[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * La portada, a pagina completa. Deja el documento listo para que quien llame
 * haga addPage() y empiece el cuerpo.
 *
 * `kpis` son hasta cuatro { etiqueta, valor }. Van en la portada porque es lo
 * que alguien mira cuando abre el PDF y lo cierra a los diez segundos.
 */
function dibujarPortada(doc, { empresa, desde, hasta, kpis = [], paleta = PALETA_BASE, generadoPor }) {
    const W = doc.page.width;
    const H = doc.page.height;
    const m = 56;

    // Fondo a sangre: el rect ignora los margenes a proposito.
    const fondo = doc.linearGradient(0, 0, W, H);
    fondo.stop(0, paleta.fondo1).stop(0.55, paleta.fondo2).stop(1, paleta.fondo1);
    doc.rect(0, 0, W, H).fill(fondo);

    // Circulos concentricos casi invisibles. Es lo unico que separa "un
    // rectangulo de color" de algo que parece diseñado.
    doc.save().opacity(0.06).strokeColor(paleta.tinta).lineWidth(1);
    for (let r = 90; r < 640; r += 52) doc.circle(W - 40, 150, r).stroke();
    doc.restore();

    let y = 64;
    if (fs.existsSync(LOGO)) {
        doc.image(LOGO, m, y, { height: 30 });
        y += 46;
    }

    // Nombre de la compañia en versalitas espaciadas: es la firma, no el titulo.
    doc.font('Helvetica-Bold').fontSize(11).fillColor(paleta.acento)
        .text(String(empresa || '').toUpperCase(), m, y, { characterSpacing: 4, width: W - m * 2 });
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(8).fillColor(paleta.suave)
        .text('SISTEMA DE EJECUCIÓN DE MANUFACTURA', m, y, { characterSpacing: 2.5, width: W - m * 2 });

    // El titulo, en serif y grande. Times-Bold viene con pdfkit: no hay que
    // embeber ninguna fuente ni añadir un archivo al despliegue.
    doc.font('Times-Bold').fontSize(52).fillColor(paleta.tinta)
        .text('Reporte de', m, H * 0.34, { width: W - m * 2, lineGap: -6 });
    doc.font('Times-Bold').fontSize(52).fillColor(paleta.tinta)
        .text('producción', m, doc.y, { width: W - m * 2 });

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(paleta.acento)
        .text(`${fechaLarga(desde)}  —  ${fechaLarga(hasta)}`, m, doc.y, { characterSpacing: 1 });

    if (generadoPor) {
        doc.font('Helvetica').fontSize(9).fillColor(paleta.suave)
            .text(generadoPor, m, doc.y + 4, { width: W - m * 2 });
    }

    // --- las cifras que se miran de un vistazo ------------------------------
    if (kpis.length) {
        const hueco = 12;
        const anchoCaja = (W - m * 2 - hueco * (kpis.length - 1)) / kpis.length;
        const cajaY = H - 190;

        kpis.forEach((k, i) => {
            const cx = m + i * (anchoCaja + hueco);
            doc.save().opacity(0.10)
                .roundedRect(cx, cajaY, anchoCaja, 74, 8).fill(paleta.tinta)
                .restore();
            doc.save().opacity(0.25).lineWidth(0.8)
                .roundedRect(cx, cajaY, anchoCaja, 74, 8).stroke(paleta.acento)
                .restore();

            doc.font('Helvetica').fontSize(7.5).fillColor(paleta.suave)
                .text(String(k.etiqueta).toUpperCase(), cx + 12, cajaY + 14,
                      { width: anchoCaja - 24, characterSpacing: 1.5, ellipsis: true });
            doc.font('Helvetica-Bold').fontSize(20).fillColor(paleta.tinta)
                .text(String(k.valor), cx + 12, cajaY + 32, { width: anchoCaja - 24, ellipsis: true });
        });
    }

    // Pie de portada.
    doc.save().opacity(0.35).lineWidth(0.8).strokeColor(paleta.tinta)
        .moveTo(m, H - 78).lineTo(W - m, H - 78).stroke()
        .restore();
    doc.font('Helvetica').fontSize(8).fillColor(paleta.suave)
        .text(`Generado el ${new Date().toISOString().slice(0, 10)}`, m, H - 66,
              { width: (W - m * 2) / 2 });
    doc.font('Helvetica').fontSize(8).fillColor(paleta.suave)
        .text('Confidencial', W / 2, H - 66, { width: (W - m * 2) / 2, align: 'right' });
}

module.exports = { dibujarPortada, paletaDe, paletaDeCompania, PALETA_BASE, fechaLarga };
