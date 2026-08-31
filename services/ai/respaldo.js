/**
 * Guardia de cifras del chat.
 *
 * EL FALLO QUE LO TRAE AQUI (sesion 20, bitacora `mes_ai_audit` 2): a la
 * pregunta "cuantas ordenes hay y cuanto se produjo", el modelo llamo SOLO a
 * `resumen_produccion` agrupado por dia, conto las seis filas que le
 * devolvieron y contesto "Total de ordenes de trabajo: 6". Son 119. Cifra
 * falsa, redactada con seguridad y sin ninguna señal para quien pregunta.
 *
 * La regla que se hace cumplir aqui es la misma que ya rige la narrativa del
 * PDF en comentario.js, pero al reves: alli el modelo NO puede escribir ni una
 * cifra; aqui puede, siempre que la cifra SALGA de lo que devolvieron las
 * herramientas. Se admite ademas lo que cualquiera haria de cabeza con esos
 * numeros -- sumar una columna, promediarla, sacar un porcentaje entre dos --
 * porque eso no es inventar, es aritmetica sobre el dato.
 *
 * Lo que NO se admite, y es justo lo que fallo: contar las filas de una tool y
 * presentar ese conteo como otra metrica. Si el numero de dias con produccion
 * importa, la herramienta tiene que devolverlo como valor.
 *
 * ponytail: se ignoran el 0 y el 1 (articulos, "uno de cada...", numeraciones)
 * y no se admiten restas entre cifras. Si aparecen falsos positivos por
 * diferencias ("bajo 74 cajas"), ampliar DERIVADAS antes que subir el umbral.
 */
const { sinContexto } = require('./comentario');

/** Ni el 0 ni el 1 se revisan: aparecen cien veces como palabra por cada vez
 *  que son una metrica, y un "1" equivocado no es el que rompe una demo. */
const MINIMO = 2;

/** Tope para el cruce de porcentajes: 80 cifras son 6400 divisiones, que es
 *  nada; sin tope, una tool con mil filas seria un cuelgue por linea. */
const MAX_CRUCES = 80;

const redondear = (n) => Math.round(n * 10) / 10;

/**
 * Un numero escrito por el modelo, que mezcla las dos convenciones: "1,234"
 * (miles) y "12,5" (decimal) aparecen en la misma respuesta.
 *
 * La regla es la de siempre: una coma seguida de UNO O DOS digitos al final es
 * separador decimal; con tres, es de miles. Sin esto, "12,5 %" se leia como 125
 * y salia marcado como cifra inventada -- lo caza la prueba de abajo.
 */
function aNumero(crudo) {
    const t = /,\d{1,2}$/.test(crudo)
        ? crudo.replace(/\./g, '').replace(',', '.')
        : crudo.replace(/,/g, '');
    return Number(t);
}

/** Recorre la salida de una tool juntando numeros (los valores) y cadenas (los
 *  nombres, codigos y fechas, que sirven para limpiar el texto despues). */
function recolectar(valor, numeros, cadenas, profundidad = 0) {
    if (valor === null || valor === undefined || profundidad > 8) return;

    if (typeof valor === 'number') {
        if (Number.isFinite(valor)) numeros.add(redondear(valor));
        return;
    }
    if (typeof valor === 'string') {
        // Una cadena que ES un numero cuenta como valor; el resto es contexto.
        const n = aNumero(valor.trim());
        if (valor.trim() !== '' && Number.isFinite(n)) numeros.add(redondear(n));
        else cadenas.push(valor);
        return;
    }
    if (Array.isArray(valor)) {
        for (const v of valor) recolectar(v, numeros, cadenas, profundidad + 1);
        // Y los agregados por columna: sumar una columna de la tabla que acaba
        // de leer es lo primero que hace cualquiera con esos datos.
        const porClave = {};
        for (const fila of valor) {
            if (!fila || typeof fila !== 'object' || Array.isArray(fila)) continue;
            for (const [k, v] of Object.entries(fila)) {
                const n = typeof v === 'number' ? v : Number(v);
                if (!Number.isFinite(n)) continue;
                (porClave[k] = porClave[k] || []).push(n);
            }
        }
        for (const lista of Object.values(porClave)) {
            const suma = lista.reduce((a, b) => a + b, 0);
            numeros.add(redondear(suma));
            numeros.add(redondear(suma / lista.length));
        }
        return;
    }
    if (typeof valor === 'object') {
        for (const v of Object.values(valor)) recolectar(v, numeros, cadenas, profundidad + 1);
    }
}

/**
 * Lo que el modelo puede decir sin inventar: los valores de las herramientas,
 * sus sumas y promedios por columna, y los porcentajes entre dos de ellos.
 */
function respaldoDe(salidas) {
    const numeros = new Set();
    const cadenas = [];
    for (const s of salidas) recolectar(s, numeros, cadenas);

    // Porcentajes: a sobre b. Se guardan aparte para no ensuciar el conjunto
    // base con miles de valores derivados si alguien lo inspecciona.
    const base = [...numeros].slice(0, MAX_CRUCES);
    for (const a of base) {
        for (const b of base) {
            if (!b) continue;
            const p = redondear((a / b) * 100);
            if (p >= 0 && p <= 100) numeros.add(p);
        }
    }
    return { numeros, cadenas: [...new Set(cadenas)].sort((a, b) => b.length - a.length) };
}

// Las fechas en prosa, que son la mitad del ruido: el modelo escribe
// "13 nov 2025 - 19 jun 2026" y "13 noviembre 2025" tanto como "13 de noviembre
// de 2025", y sinContexto() solo entiende la ultima. Sin esto, el dia y los dos
// años de cada periodo se leian como metricas inventadas -- cuatro de las seis
// preguntas de prueba salieron marcadas por esto y por nada mas.
//
// Los "de" son opcionales a los dos lados y el mes vale abreviado o entero. Se
// exige mes + (dia o año) para no tragarse un "mayo" suelto.
const FECHA_SUELTA =
    /\b(?:(\d{1,2})\s+(?:de\s+)?)?(ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)[a-zé]*\.?(?:\s+(?:de\s+)?(\d{4}))?\b/gi;

// Y las fechas en cifras, con cualquier separador: 2026-06-19, 2026/06/19,
// 19-06-2026. sinContexto() solo quita las que coinciden EXACTAMENTE con una
// cadena del dato, asi que basta con que el modelo cambie el guion por una
// barra para que el dia y el año se lean como metricas. Una fecha nunca es la
// cifra que este guardia busca, asi que se van todas.
const FECHA_EN_CIFRAS = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g;

/** Las cifras del texto que no salen de ninguna herramienta. */
function cifrasSinRespaldo(texto, salidas) {
    if (!texto || !salidas || !salidas.length) return [];
    const { numeros, cadenas } = respaldoDe(salidas);

    // Fuera los nombres, codigos y fechas que vienen de los datos: sus digitos
    // no son metricas. Es la misma limpieza que usa la narrativa del PDF, mas
    // las fechas abreviadas, que alli no hacen falta y aqui son la mitad del
    // ruido.
    const sinFechas = String(texto)
        // Los guiones "bonitos" primero: el modelo escribe 13‑nov‑2025 y
        // 2025‑11‑13, y con ellos ninguna de las dos expresiones de abajo
        // engancha. sinContexto() ya los aplana, pero eso pasa despues.
        .replace(/[‐-―−]/g, '-')
        .replace(FECHA_EN_CIFRAS, ' ')
        .replace(FECHA_SUELTA, (todo, dia, mes, anio) => (dia || anio ? ' ' : todo));
    const limpio = sinContexto(sinFechas, cadenas);

    const sueltas = [];
    for (const m of limpio.matchAll(/\d[\d.,]*/g)) {
        const crudo = m[0].replace(/[.,]$/, '');
        const n = aNumero(crudo);
        if (!Number.isFinite(n) || Math.abs(n) < MINIMO) continue;

        const r = redondear(n);
        if (numeros.has(r) || numeros.has(Math.round(n))) continue;
        sueltas.push(crudo);
    }
    return [...new Set(sueltas)];
}

module.exports = { cifrasSinRespaldo, respaldoDe };
