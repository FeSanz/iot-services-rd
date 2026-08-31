/**
 * La narrativa del reporte: tres parrafos redactados por el LLM (ETAPA 5,
 * acabado).
 *
 * TRES REGLAS QUE NO SE NEGOCIAN, y que son lo unico interesante de este
 * archivo:
 *
 * 1. **El PDF nunca falla por culpa del LLM.** Hay una redaccion estatica lista
 *    ANTES de llamar a nadie, armada con las mismas cifras. Si el proveedor
 *    tarda, se cae o contesta cualquier cosa, sale esa. El reporte del lunes a
 *    las 7 no puede depender de que un tercero conteste.
 *
 * 2. **Una sola llamada y 20 segundos.** Sin reintentos. Un reintento convierte
 *    "el reporte tardo" en "el reporte tardo el doble", y ya hay un texto
 *    aceptable esperando.
 *
 * 3. **El modelo no ve un solo numero que no este en el paquete, y no se le
 *    pide que calcule nada.** Redacta sobre cifras ya calculadas. Es la misma
 *    razon por la que el chart_spec de las graficas lo arma la herramienta y no
 *    el modelo: volver a escribir un numero es como se inventan.
 *
 * Lo que se le manda es un resumen plano y pequeño -- no las filas -- para que
 * no haya nada que "interpretar" ni que recortar.
 */
const llm = require('./llm.client');

const SEGUNDOS = Number(process.env.AI_COMENTARIO_TIMEOUT_MS || 20000);
const MARCAS = ['RESUMEN', 'EVENTOS', 'RECOMENDACIONES'];

const numero = (n) => (n === null || n === undefined ? '0' : Number(n).toLocaleString('es-MX'));

/**
 * El paquete de cifras que ve el modelo. Plano, corto y ya calculado.
 *
 * Se recorta a los primeros de cada lista: con quince maquinas y diez articulos
 * el prompt crece y la redaccion no mejora -- lo que importa son los de arriba.
 */
function cifras({ empresa, desde, hasta, datos }) {
    const r = datos.resumen || {};
    const producido = Number(r.cajas) || 0;
    const merma = Number(r.scrap || 0) + Number(r.rechazo || 0);
    const mermaPct = producido + merma > 0 ? (merma / (producido + merma) * 100) : 0;
    const minutos = datos.paros.reduce((a, p) => a + (Number(p.total_min) || 0), 0);

    return {
        empresa,
        periodo: `${desde} a ${hasta}`,
        producido,
        merma,
        merma_pct: Number(mermaPct.toFixed(1)),
        registros: Number(r.registros) || 0,
        dias_con_produccion: datos.porDia.length,
        paros: datos.paros.reduce((a, p) => a + p.cuantos, 0),
        minutos_parados: Math.round(minutos),
        por_turno: datos.porTurno.slice(0, 5)
            .map((t) => ({ turno: t.grupo, cajas: Number(t.cajas) || 0 })),
        top_maquinas: datos.porMaquina.slice(0, 5)
            .map((m) => ({ maquina: m.grupo, cajas: Number(m.cajas) || 0, scrap: Number(m.scrap) || 0 })),
        top_articulos: datos.items.slice(0, 5)
            .map((i) => ({ articulo: i.item, planeado: Number(i.planeado) || 0, completado: Number(i.completado) || 0 })),
        paros_por_tipo: datos.paros.slice(0, 5)
            .map((p) => ({ tipo: p.tipo, cuantos: p.cuantos, total_min: Number(p.total_min) || 0 })),
        maquinas_mas_paradas: (datos.parosPorMaquina || []).slice(0, 5)
            .map((p) => ({ maquina: p.grupo, total_min: Number(p.total_min) || 0 })),
    };
}

/**
 * La redaccion de respaldo. Sale de las mismas cifras, sin adjetivos y sin
 * conclusiones: dice lo que hay.
 *
 * No es un texto de relleno ni un "no disponible": es lo que lleva el PDF
 * cuando el LLM no contesta, y tiene que poder leerse sin que se note.
 */
function redaccionEstatica(c) {
    const resumen = c.registros === 0
        ? `No hay producción registrada para ${c.empresa} en el periodo ${c.periodo} dentro del alcance de este reporte.`
        : `En el periodo ${c.periodo} se registraron ${numero(c.producido)} cajas en ${numero(c.registros)} `
          + `registros de producción, repartidos en ${numero(c.dias_con_produccion)} día(s) con actividad. `
          + `La merma fue de ${numero(c.merma)} unidades, un ${c.merma_pct} % del total movido. `
          + (c.por_turno.length
              ? `El turno con más producción fue ${c.por_turno[0].turno}, con ${numero(c.por_turno[0].cajas)} cajas. `
              : '')
          + (c.top_maquinas.length
              ? `La máquina con más producción fue ${c.top_maquinas[0].maquina}.`
              : '');

    const eventos = c.paros === 0
        ? 'No se registraron paros de máquina en el periodo.'
        : `Se registraron ${numero(c.paros)} paros que suman ${numero(c.minutos_parados)} minutos detenidos. `
          + (c.paros_por_tipo.length
              ? `El tipo más frecuente fue "${c.paros_por_tipo[0].tipo}", con ${numero(c.paros_por_tipo[0].cuantos)} casos. `
              : '')
          + (c.maquinas_mas_paradas.length
              ? `La máquina con más tiempo detenido fue ${c.maquinas_mas_paradas[0].maquina}, `
                + `con ${numero(c.maquinas_mas_paradas[0].total_min)} minutos.`
              : '');

    const recomendaciones = [
        c.merma_pct > 0
            ? `Revisar el origen de la merma: representa el ${c.merma_pct} % de lo movido en el periodo.`
            : 'No se registró merma en el periodo: conviene confirmar que se está capturando.',
        c.maquinas_mas_paradas.length
            ? `Atender ${c.maquinas_mas_paradas[0].maquina}, que concentra el mayor tiempo detenido.`
            : 'Sin paros registrados: conviene confirmar que las alertas se están cerrando.',
        c.dias_con_produccion < 5
            ? 'Verificar la captura de producción: hay pocos días con registros en el periodo.'
            : 'Comparar este periodo con el anterior para ver si la tendencia se sostiene.',
    ].join('\n');

    return { resumen, eventos, recomendaciones, deLaIA: false };
}

const SISTEMA = `Eres un analista de manufactura. Escribes en español de México, en tono
profesional y directo, para un gerente de planta.

Recibes un resumen de cifras YA CALCULADAS de un reporte de producción. Tu trabajo es
redactarlo, no calcularlo.

REGLAS:
- NO ESCRIBAS CIFRAS. Ni un número, ni con dígitos ni con letra. Las cifras ya están en
  las tablas y las gráficas del reporte; tu trabajo es decir qué muestran.
  Escribe "la producción se concentró en pocos días", no "se produjeron 7 cajas en 3 días".
- Sí puedes nombrar máquinas, turnos y artículos tal como vienen en el JSON
  ("TWMFC780-12", "TURNO 3"), aunque lleven números en el nombre.
- Si un dato no está, no lo menciones; no supongas.
- Nada de saludos, títulos, listas numeradas ni markdown.

Responde EXACTAMENTE con este formato, sin nada antes ni después:

[RESUMEN]
Cuatro o cinco líneas sobre qué pasó en el periodo.

[EVENTOS]
Tres o cuatro líneas sobre los paros y las máquinas o artículos que destacan.

[RECOMENDACIONES]
- Tres acciones concretas, una por línea, cada una empezando con un guion.`;

/**
 * ¿Que numeros dice este texto que NO estan en las cifras?
 *
 * EL PROMPT NO ES UN GUARDRAIL. "No inventes ningun numero" es una sugerencia
 * educada, igual que "no muestres datos de otras compañias" lo era para el
 * aislamiento -- y en este proyecto eso ya se decidio que no cuenta como capa.
 * Este texto acaba en un PDF que se manda por correo a un gerente de planta y se
 * lee como si fuera dato. Una cifra inventada ahi es exactamente el fallo que el
 * resto del sistema lleva evitando: por eso `total_encontrado` viene del dato y
 * por eso el chart_spec lo arma la herramienta y no el modelo.
 *
 * Asi que se comprueba. Se sacan todos los numeros del paquete --incluidos los
 * que van dentro de cadenas, como las fechas del periodo o el "780-12" de un
 * codigo de maquina-- y se compara contra los del texto. Se aceptan tambien las
 * formas redondeadas: que el modelo escriba "410,598" por 410597.6 es redactar,
 * no inventar.
 *
 * NO hay excepciones. Hubo una: los enteros del 0 al 12 pasaban sin comprobar,
 * porque en prosa española aparecen solos ("tres acciones", "los 2 turnos") y
 * bloquearlos parecia que iba a mandar el texto al respaldo a cada rato. Era una
 * concesion mal hecha: "5 maquinas paradas" cuando hay 8 es una cifra falsa en
 * un reporte, y que sea chica no la hace menos falsa. Medido con el modelo de
 * verdad, la excepcion tampoco hacia falta -- los numeros chicos que escribe
 * salen de los datos.
 *
 * Lo que si se hace es pedirle en el prompt que escriba con LETRA lo que no
 * venga del JSON. Eso no es un guardrail --sigue siendo una sugerencia-- pero
 * baja los falsos positivos sin abrir ningun hueco: la garantia es el filtro.
 */

/** Las cadenas del paquete: nombres, codigos, tipos y el periodo. */
function cadenasDelPaquete(paquete) {
    const cadenas = [];
    const recorrer = (x) => {
        if (Array.isArray(x)) x.forEach(recorrer);
        else if (x && typeof x === 'object') Object.values(x).forEach(recorrer);
        else if (typeof x === 'string' && x.trim()) cadenas.push(x.trim());
    };
    recorrer(paquete);

    // Las fechas sueltas, ademas del periodo entero: el modelo escribe "del
    // 2026-01-01 al 2026-06-30" y ahi la cadena completa no aparece tal cual.
    //
    // La fecha ENTERA y nada mas: ni el año, ni el mes, ni el dia por separado.
    // Se probo dejar pasar el año --"en 2026" es una forma legitima de nombrar
    // el periodo-- y con eso "se produjeron 2026 cajas" tambien pasaba. Entre un
    // falso positivo, que cae al texto estatico y no le hace daño a nadie, y una
    // cifra falsa dentro de un PDF que se manda por correo, se elige el primero.
    for (const c of [...cadenas]) {
        for (const f of c.matchAll(/\d{4}-\d{2}-\d{2}/g)) cadenas.push(f[0]);
    }
    return [...new Set(cadenas)].sort((a, b) => b.length - a.length);
}

const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "1 de enero", "30 de junio de 2026", "junio de 2026". Los meses van escritos y
// no interpolados desde MESES_ES para que la expresion se lea de un vistazo;
// MESES_ES es la que traduce el nombre a numero, y las dos listas son la misma.
const FECHA_EN_PROSA =
    /\b(?:(\d{1,2})\s+de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/gi;

/**
 * Quita del texto las fechas escritas con palabras, PERO solo las que cuadran
 * con una fecha del paquete.
 *
 * El modelo no escribe "2026-01-01": escribe "del 1 de enero al 30 de junio de
 * 2026". Con la fecha en prosa, el 1, el 30 y el 2026 quedaban sueltos y se
 * leian como metricas inventadas -- un falso positivo que tiraba el resumen en
 * tres de cada ocho reportes.
 *
 * La comprobacion de que cuadre es lo que evita cambiar un agujero por otro: si
 * escribe "el 31 de diciembre de 2030", esa fecha NO esta en los datos, no se
 * quita, y sus numeros se revisan como cualquier otra cifra.
 */
function sinFechasEnProsa(texto, fechas) {
    return texto.replace(FECHA_EN_PROSA, (todo, dia, mes, anio) => {
        const m = MESES_ES.indexOf(mes.toLowerCase()) + 1;
        const cuadra = fechas.some((f) => f.m === m
            && (dia === undefined || Number(dia) === f.d)
            && (anio === undefined || Number(anio) === f.y));
        return cuadra ? ' ' : todo;
    });
}

const APLANAR = (t) => String(t)
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/[\u00a0\u2007\u2009\u202f]/g, ' ');

const ESCAPAR = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Quita del texto los nombres, codigos y fechas que vienen de los datos, para
 * que sus digitos no se confundan con metricas.
 *
 * De mayor a menor: "2026-01-01" antes que "2026", o quedaria "-01-01" suelto.
 */
function sinContexto(texto, cadenas) {
    let limpio = APLANAR(texto);
    for (const c of cadenas) {
        if (!/\d/.test(c)) continue;   // sin digitos no estorba
        limpio = limpio.replace(new RegExp(ESCAPAR(APLANAR(c)), 'gi'), ' ');
    }

    // Y las fechas escritas con palabras, que es como las escribe el modelo.
    const fechas = [];
    for (const c of cadenas) {
        for (const f of String(c).matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
            fechas.push({ y: Number(f[1]), m: Number(f[2]), d: Number(f[3]) });
        }
    }
    if (fechas.length) {
        limpio = sinFechasEnProsa(limpio, fechas);
        // El año detras de una preposicion: "el primer semestre DE 2026",
        // "DESDE 2026". Solo ahi. Suelto no, porque entonces "se produjeron
        // 2026 cajas" tambien pasaria, y eso si es una cifra inventada.
        const anios = new Set(fechas.map((f) => f.y));
        limpio = limpio.replace(/\b(?:de|del|en|desde|hasta|a)\s+(\d{4})\b/gi,
                                (todo, anio) => (anios.has(Number(anio)) ? ' ' : todo));
    }
    return limpio;
}

/**
 * ¿Escribe este texto alguna cifra?
 *
 * ESTA ES LA REGLA, y es mas corta que todo lo que sustituye: **la narrativa no
 * lleva numeros**. Los numeros del reporte estan en la portada, en las cajas de
 * KPI, en las graficas y en las tablas, y todos salen de una consulta. El texto
 * describe lo que enseñan; no los repite.
 *
 * POR QUE SE LLEGO AQUI. La version anterior comparaba cada numero del texto
 * contra los valores del paquete, y se le fueron cerrando agujeros de uno en
 * uno: los decimales autorizaban otro numero con sus mismos digitos; una fecha
 * autorizaba cualquier metrica; los enteros chicos pasaban gratis. Cada parche
 * era correcto y aparecia el siguiente. El ultimo no tiene arreglo por ese
 * camino: **un valor de verdad, puesto en el campo que no es**. Si el paquete
 * dice `paros: 180` y `producido: 7`, "se produjeron 180 cajas" usa un numero
 * que SI esta en los datos -- y es falso. Validar la atribucion pide entender la
 * frase, y ahi no se acaba nunca.
 *
 * Asi que el modelo deja de escribir cifras. Es la misma decision que ya se
 * tomo con las graficas --el chart_spec lo arma la herramienta que leyo los
 * datos, no el modelo, porque volver a escribir un numero es como se inventan--
 * llevada hasta el final.
 *
 * Lo que SI puede escribir son los nombres que vienen de los datos: "TWMFC780-12",
 * "TURNO 3", el periodo. Esos se quitan del texto --tal como estan en los
 * datos-- y lo que quede no puede tener un digito.
 *
 * Y NO hay excepciones. Hubo una: un numero suelto valia como identificador si
 * la palabra que lo nombra aparecia poco antes, para dejar pasar "los turnos 3,
 * 2 y 1". Abria el mismo agujero de siempre por la puerta de al lado: con
 * "turno" cerca, "el turno 3 produjo 3 cajas" colaba el segundo 3 como si fuera
 * un nombre. Medido con el modelo real, la excepcion compraba una narrativa de
 * cada diez y costaba un agujero; el caso que pierde cae en la redaccion
 * estatica, que es correcta. Cada excepcion que se ha conservado en este filtro
 * ha acabado siendo el siguiente hallazgo.
 *
 * Coste: el resumen ya no dice "se produjeron 7 cajas", dice que la produccion
 * fue baja y se concentro en pocos dias. La cifra esta dos centimetros mas
 * arriba, en la caja de KPI, y esa si viene de la base.
 */
// Cifras escritas CON LETRA. El prompt las prohibe igual que los digitos, pero
// un prompt es una sugerencia: "tres mil cajas" cuando fueron 7 pasaba el
// filtro y llegaba al PDF. "un/una/uno" quedan fuera a proposito -- son
// articulos ("una maquina") cien veces por cada vez que son numero, y tirarian
// TODA narrativa a la estatica. Los ordinales ("el segundo turno") tampoco:
// nombran, no cuentan.
const CIFRA_CON_LETRA = /\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|cientos?|doscient[oa]s|trescient[oa]s|quinient[oa]s|mil(es)?|mill[oó]n|millones|decenas?|docenas?|centenar(es)?|veintenas?|millar(es)?)\b/gi;

function cifrasEnElTexto(texto, paquete) {
    const limpio = sinContexto(texto, cadenasDelPaquete(paquete));
    return [...limpio.matchAll(/\d+/g), ...limpio.matchAll(CIFRA_CON_LETRA)].map((m) => m[0]);
}

/**
 * Parte la respuesta en las secciones que haya. `{}` si no hay ninguna.
 *
 * Tolerante a proposito: la primera version era todo-o-nada y con este modelo
 * fallaba SIEMPRE. gpt-oss gasta presupuesto en `reasoning` antes de escribir,
 * asi que la respuesta se cortaba a media [RECOMENDACIONES] -- con dos secciones
 * perfectamente buenas que se tiraban a la basura. Lo que falte lo rellena la
 * redaccion estatica, seccion por seccion.
 *
 * `truncado` (finish_reason === 'length') tira la ULTIMA seccion encontrada: si
 * la respuesta se corto, esa esta a medias, y media frase en un PDF que se manda
 * por correo es peor que el texto de respaldo.
 */
function partir(texto, truncado = false) {
    if (!texto) return {};

    const encontradas = MARCAS
        .map((marca) => ({ marca, ini: texto.indexOf(`[${marca}]`) }))
        .filter((m) => m.ini !== -1)
        .sort((a, b) => a.ini - b.ini);

    const partes = {};
    encontradas.forEach((m, i) => {
        const desde = m.ini + m.marca.length + 2;
        const hasta = i + 1 < encontradas.length ? encontradas[i + 1].ini : undefined;
        const trozo = texto.slice(desde, hasta).trim();
        if (trozo) partes[m.marca.toLowerCase()] = trozo;
    });

    if (truncado && encontradas.length) {
        delete partes[encontradas[encontradas.length - 1].marca.toLowerCase()];
    }
    return partes;
}

/**
 * Los tres parrafos. NUNCA lanza y NUNCA tarda mas de `SEGUNDOS`.
 *
 * @param credencial  la de la compañia. Sin ella se devuelve la estatica sin
 *                    intentar nada -- que es lo que pasa en una compañia a la
 *                    que todavia no le han configurado la llave.
 * @returns { resumen, eventos, recomendaciones, deLaIA, tokens, ms }
 */
async function redactarComentario({ empresa, desde, hasta, datos, credencial }) {
    const c = cifras({ empresa, desde, hasta, datos });
    const estatica = redaccionEstatica(c);

    // Sin cifras no hay nada que redactar, y gastar una llamada al LLM para que
    // escriba "no hubo produccion" es tirar el dinero.
    if (!credencial || c.registros === 0) return estatica;

    const empezo = Date.now();
    try {
        const r = await llm.chat({
            baseUrl: credencial.baseUrl,
            apiKey: credencial.apiKey,
            model: credencial.model,
            // 700 no alcanzaba: este modelo gasta antes en `reasoning` y la
            // respuesta se cortaba a media tercera seccion.
            maxTokens: Number(process.env.AI_COMENTARIO_MAX_TOKENS || 1600),
            messages: [
                { role: 'system', content: SISTEMA },
                { role: 'user', content: JSON.stringify(c) },
            ],
            signal: AbortSignal.timeout(SEGUNDOS),
        });

        const partes = partir(r.message?.content, r.finishReason === 'length');

        // Seccion por seccion: la que diga un numero que no esta en las cifras
        // se tira y la cubre la estatica. Se tira solo esa, no las tres -- una
        // recomendacion con una cifra inventada no invalida un resumen correcto.
        for (const nombre of Object.keys(partes)) {
            const cifrasSueltas = cifrasEnElTexto(partes[nombre], c);
            if (cifrasSueltas.length) {
                console.warn(`[AI] narrativa: la seccion ${nombre} escribe cifras `
                             + `(${cifrasSueltas.slice(0, 5).join(', ')}); va la estatica`);
                delete partes[nombre];
            }
        }

        // Si no salio ni el resumen --porque el modelo no respeto el formato o
        // porque lo que escribio no cuadra con los datos-- sale la estatica
        // entera, que es correcta.
        if (!partes.resumen) return estatica;

        return {
            // Lo que falte -- porque se corto, porque el modelo se salto una
            // marca o porque se invento una cifra -- lo pone la estatica.
            resumen: partes.resumen,
            eventos: partes.eventos || estatica.eventos,
            recomendaciones: partes.recomendaciones || estatica.recomendaciones,
            deLaIA: true,
            tokens: { prompt: r.usage?.prompt_tokens || 0, completion: r.usage?.completion_tokens || 0 },
            ms: Date.now() - empezo,
        };
    } catch (e) {
        // Se registra y se sigue. El PDF sale igual.
        console.error('[AI] la narrativa del reporte no salio, va la estatica:', e.message);
        return estatica;
    }
}

module.exports = { redactarComentario, redaccionEstatica, cifras, partir,
                   cifrasEnElTexto, cadenasDelPaquete, sinContexto, sinFechasEnProsa };
