/**
 * Las tools del bot (ETAPA 3).
 *
 * DOS REGLAS QUE NO SE ROMPEN:
 *
 * 1. Ningun esquema de tool tiene organization_id, company_id ni nada parecido.
 *    Si el modelo no lo puede nombrar, no lo puede pedir. El alcance entra por
 *    consultarConAlcance(), que lo saca del token.
 *
 * 2. Todo argumento que llega del modelo se sanea. No es paranoia: en la
 *    primera prueba contra gpt-oss:120b, con un enum ["RELEASED","IN_PROCESS"]
 *    declarado en el esquema, el modelo mando "open". Los enums son una
 *    sugerencia para el modelo, no una garantia.
 */
const { consultarConAlcance } = require('./scope');

const LIMITE_MAXIMO = 50;   // tope duro de filas: esto va a un prompt

// Nota sobre los COALESCE(NULLIF(trim(x), ''), 'sin ...') que hay repartidos:
// COALESCE solo atrapa NULL, y en esta base hay campos con la CADENA VACIA. Con
// un COALESCE pelado salia un renglon sin etiqueta al lado de otro que decia
// "sin tipo" -- dos grupos distintos para la misma cosa, y uno de ellos sin
// nombre. Se vio en el PDF del reporte, no leyendo el SQL.

// --- saneo ------------------------------------------------------------------

function enumerado(valor, permitidos, porDefecto = null) {
    if (typeof valor !== 'string') return porDefecto;
    const limpio = valor.trim();
    // Sin distinguir mayusculas: el modelo escribe "released" tan seguido como
    // "RELEASED".
    const encontrado = permitidos.find((p) => p.toLowerCase() === limpio.toLowerCase());
    return encontrado || porDefecto;
}

function entero(valor, { min = 1, max = LIMITE_MAXIMO, porDefecto = 20 } = {}) {
    const n = Number.parseInt(valor, 10);
    if (!Number.isFinite(n)) return porDefecto;
    return Math.min(max, Math.max(min, n));
}

/**
 * Solo acepta AAAA-MM-DD. Cualquier otra cosa es null, no una fecha inventada.
 *
 * El patron no basta: "2026-02-31" lo cumple. Y `new Date()` no ayuda sola,
 * porque NO se queja -- desborda al dia siguiente, en silencio:
 *
 *   new Date('2026-02-31T00:00:00Z')  ->  2026-03-03    no es NaN
 *   new Date('2025-02-29T00:00:00Z')  ->  2025-03-01    tampoco
 *
 * La version anterior devolvia la cadena ORIGINAL, asi que "2026-02-31" llegaba
 * tal cual a Postgres y reventaba la consulta entera con un error que el bot no
 * sabe explicar. Y si algun dia se usara el objeto Date, seria peor: filtraria
 * por marzo sin que nadie lo note.
 *
 * Se comprueba de ida y vuelta: si la fecha reconstruida no es identica a la que
 * escribieron, esa fecha no existe. Los años bisiestos salen gratis --
 * 2024-02-29 pasa, 2025-02-29 no.
 *
 * El patron va anclado por los DOS lados. Sin el `$` final, "2026-06-01 lo que
 * sea" pasaba y se quedaba con el prefijo. No era inyectable -- las consultas
 * van parametrizadas -- pero contradecia el contrato que dice el esquema de las
 * tools ("AAAA-MM-DD"), y una funcion de saneo que acepta a medias es una que
 * hay que volver a leer entera cada vez que se toca lo que hay detras.
 */
function fecha(valor) {
    if (typeof valor !== 'string') return null;
    const m = valor.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Filtro de fechas para una columna. Devuelve el fragmento SQL y los valores.
 *
 * Sin fechas NO filtra nada. Es deliberado: los datos de esta base se detienen
 * en junio de 2026, y un "ultimos 7 dias" por omision devolveria cero filas y
 * el bot diria que no hubo produccion, que es falso.
 */
function rangoFechas(columna, desde, hasta, siguiente) {
    const partes = [];
    const valores = [];
    if (desde) { valores.push(desde); partes.push(`AND ${columna} >= $${siguiente + valores.length - 1}`); }
    if (hasta) { valores.push(hasta); partes.push(`AND ${columna} < ($${siguiente + valores.length - 1}::date + 1)`); }
    return { sql: partes.join('\n'), valores };
}

/**
 * Una consulta con LIMIT, devolviendo TAMBIEN cuantas filas habia de verdad.
 *
 * El problema que resuelve, visto en el navegador: a "¿cuantas ordenes tengo en
 * proceso?" el bot contestaba 50, 33 o 10 segun el dia. El 50 era el LIMIT.
 * El modelo recibia una lista truncada, la contaba, y cantaba ese numero como
 * si fuera el total. **Un numero que a veces miente es peor que no tener
 * numero**, porque nadie sabe cual de las dos veces fue.
 *
 * Se arregla con el dato, no con el prompt: la consulta trae el total al lado de
 * las filas y el modelo ya no tiene que deducirlo contando.
 *
 * `count(*) OVER ()` cuenta sobre el conjunto YA FILTRADO y ANTES del LIMIT, en
 * la misma pasada: no hay segunda consulta ni riesgo de que las dos vean cosas
 * distintas. En una consulta agrupada cuenta grupos, que es justo lo que se
 * quiere.
 *
 * La consulta TIENE que traer `count(*) OVER () AS _total`.
 */
async function consultarLista(scope, sql, valores, nombreFilas) {
    const { rows } = await consultarConAlcance(scope, sql, valores);
    const total = rows.length ? Number(rows[0]._total) : 0;
    // Fuera del resultado: es plomeria, y cada fila que va al prompt se paga.
    for (const fila of rows) delete fila._total;
    return {
        total_encontrado: total,
        mostradas: rows.length,
        hay_mas: total > rows.length,
        [nombreFilas]: rows,
    };
}

/**
 * La especificacion de una grafica para que la pinte el frontend (ETAPA 4).
 *
 * La arma la TOOL con los datos que acaba de leer, no el modelo. Si el modelo
 * tuviera que dictar los numeros de la grafica, tendria que volver a
 * escribirlos, y volver a escribir numeros es exactamente como se inventan.
 * Aqui el modelo decide QUE pregunta; los numeros no pasan por el.
 *
 * El agente saca este campo del resultado ANTES de devolverselo al modelo: al
 * modelo no le sirve de nada y pagaria el doble de tokens por los mismos datos.
 *
 * Formato propio y corto, no la configuracion de ApexCharts: si mañana el
 * cliente cambia de libreria, el backend no se entera.
 */
function grafica({ tipo, titulo, eje_x, series, unidad = null }) {
    return { tipo, titulo, eje_x, series, unidad };
}

/**
 * Que decirle al modelo cuando el periodo que eligio sale vacio.
 *
 * Un "no hay datos" a secas lo deja contestando "no hay produccion", que es
 * FALSO: la hay, pero de otras fechas. Los datos de esta base se detienen en
 * junio de 2026 y el modelo pide "el ultimo mes" contando desde hoy.
 *
 * Mismo patron que historico_sensor: se le dice que SI hay y entre que fechas,
 * y se le manda volver a llamar. El prompt ya le dice que obedezca las notas.
 */
async function notaSinDatos(ctx, vista, desde, hasta) {
    if (!desde && !hasta) {
        return 'No hay ni un registro de produccion en tu alcance.';
    }
    const { rows } = await consultarConAlcance(ctx.scope, `
        SELECT min(execution_date)::date AS primera, max(execution_date)::date AS ultima
          FROM ${vista}
         WHERE organization_id = ANY($ORGS)`);
    const hay = rows[0];
    if (!hay || !hay.primera) {
        return 'No hay ni un registro de produccion en tu alcance.';
    }
    return `Sin produccion en el periodo que pediste, PERO si hay registros entre `
         + `${hay.primera.toISOString().slice(0, 10)} y ${hay.ultima.toISOString().slice(0, 10)}. `
         + `Vuelve a llamar a esta herramienta con esas fechas, o sin fechas, ANTES de contestar. `
         + `No digas que no hay produccion.`;
}

/** De que fechas son en realidad las filas que se devuelven. */
function periodoDe(filas, campoIni = 'primera', campoFin = 'ultima') {
    const fechas = filas
        .flatMap((f) => [f[campoIni], f[campoFin]])
        .filter(Boolean)
        .map((d) => new Date(d))
        .filter((d) => !Number.isNaN(d.getTime()));
    if (fechas.length === 0) return null;
    return {
        desde: new Date(Math.min(...fechas)).toISOString(),
        hasta: new Date(Math.max(...fechas)).toISOString(),
    };
}

// --- las tools --------------------------------------------------------------

const TOOLS = {

    panorama_planta: {
        descripcion:
            'Foto rapida de la planta: ordenes por estado, maquinas por estado, ' +
            'paros abiertos y sensores. Empieza por aqui cuando la pregunta sea general.',
        esquema: { type: 'object', properties: {}, additionalProperties: false },
        async ejecutar(_args, ctx) {
            const [ordenes, maquinas, paros, sensores] = await Promise.all([
                consultarConAlcance(ctx.scope, `
                    SELECT status, count(*)::int AS cuantas
                      FROM v_wo_status
                     WHERE organization_id = ANY($ORGS)
                     GROUP BY status ORDER BY 2 DESC`),
                consultarConAlcance(ctx.scope, `
                    SELECT COALESCE(NULLIF(machine_status, ''), 'sin estado') AS estado,
                           count(DISTINCT machine_id)::int AS cuantas
                      FROM v_production_machine
                     WHERE organization_id = ANY($ORGS)
                     GROUP BY 1 ORDER BY 2 DESC`),
                consultarConAlcance(ctx.scope, `
                    SELECT status, count(*)::int AS cuantos
                      FROM v_machine_stops
                     WHERE organization_id = ANY($ORGS)
                       AND status <> 'completed'
                     GROUP BY status ORDER BY 2 DESC`),
                consultarConAlcance(ctx.scope, `
                    SELECT count(*)::int AS total,
                           count(*) FILTER (WHERE last_reading_at IS NULL)::int AS nunca_reportaron,
                           max(last_reading_at) AS lectura_mas_reciente
                      FROM v_sensor_latest
                     WHERE organization_id = ANY($ORGS)`),
            ]);
            return {
                ordenes_por_estado: ordenes.rows,
                maquinas_con_produccion_por_estado: maquinas.rows,
                paros_sin_cerrar: paros.rows,
                sensores: sensores.rows[0],
            };
        },
    },

    listar_ordenes: {
        descripcion: 'Ordenes de trabajo con su avance contra lo planeado.',
        esquema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['RELEASED', 'IN_PROCESS'], description: 'Filtra por estado' },
                limite: { type: 'integer', description: `Cuantas devolver, maximo ${LIMITE_MAXIMO}` },
            },
            additionalProperties: false,
        },
        async ejecutar(args, ctx) {
            const status = enumerado(args.status, ['RELEASED', 'IN_PROCESS']);
            const limite = entero(args.limite);
            const valores = [];
            let filtro = '';
            if (status) { valores.push(status); filtro = `AND status = $1`; }

            return {
                filtro_aplicado: { status, limite },
                ...(await consultarLista(ctx.scope, `
                SELECT count(*) OVER () AS _total,
                       work_order_number, status, item_number, item_description, uom,
                       machine_code, machine_name, work_center_name,
                       planned_start_quantity, completed_quantity,
                       CASE WHEN planned_start_quantity > 0
                            THEN round(completed_quantity / planned_start_quantity * 100, 1)
                       END AS avance_pct,
                       start_date, end_date
                  FROM v_wo_status
                 WHERE organization_id = ANY($ORGS)
                 ${filtro}
                 ORDER BY start_date DESC NULLS LAST
                 LIMIT ${limite}`, valores, 'ordenes')),
            };
        },
    },

    resumen_produccion: {
        descripcion:
            'Produccion registrada, agrupada por turno, maquina o dia. ' +
            'Incluye cajas buenas, scrap, rechazo y el porcentaje de merma. ' +
            'Con agrupar_por="maquina" sirve para comparar maquinas entre si.',
        esquema: {
            type: 'object',
            properties: {
                agrupar_por: { type: 'string', enum: ['turno', 'maquina', 'dia'] },
                desde: { type: 'string', description: 'Fecha inicial AAAA-MM-DD. Si se omite, toda la historia.' },
                hasta: { type: 'string', description: 'Fecha final AAAA-MM-DD, inclusive.' },
            },
            additionalProperties: false,
        },
        async ejecutar(args, ctx) {
            const agrupar = enumerado(args.agrupar_por, ['turno', 'maquina', 'dia'], 'dia');
            const desde = fecha(args.desde);
            const hasta = fecha(args.hasta);

            const VISTAS = {
                turno:   { vista: 'v_production_shift',   clave: "COALESCE(NULLIF(trim(shift_name), ''), 'sin turno')" },
                maquina: { vista: 'v_production_machine', clave: "COALESCE(NULLIF(trim(machine_name), ''), NULLIF(trim(machine_code), ''), 'sin maquina')" },
                dia:     { vista: 'v_production_shift',   clave: 'local_date::text' },
            };
            const { vista, clave } = VISTAS[agrupar];
            const r = rangoFechas('execution_date', desde, hasta, 1);

            const lista = await consultarLista(ctx.scope, `
                SELECT ${clave} AS grupo,
                       count(*)::int          AS registros,
                       sum(cajas)             AS cajas,
                       sum(scrap)             AS scrap,
                       sum(rechazo)           AS rechazo,
                       CASE WHEN sum(cajas + scrap + rechazo) > 0
                            THEN round(sum(scrap + rechazo) / sum(cajas + scrap + rechazo) * 100, 2)
                       END                    AS merma_pct,
                       min(execution_date)    AS primera,
                       max(execution_date)    AS ultima,
                       -- Al final, no al principio: con GROUP BY 1 / ORDER BY 1
                       -- las posiciones cuentan, y de primera columna esta
                       -- rompia la consulta entera.
                       count(*) OVER ()       AS _total
                  FROM ${vista}
                 WHERE organization_id = ANY($ORGS)
                 ${r.sql}
                 GROUP BY 1
                 ORDER BY 1
                 LIMIT ${LIMITE_MAXIMO}`, r.valores, 'grupos');
            const rows = lista.grupos;

            return {
                agrupado_por: agrupar,
                periodo_pedido: { desde, hasta },
                // Sin esto el modelo presenta la historia entera como si fuera
                // el periodo que le pidieron. Le decimos que fechas son de
                // verdad y que lo diga.
                periodo_real_cubierto: periodoDe(rows),
                nota: rows.length === 0
                    ? await notaSinDatos(ctx, vista, desde, hasta)
                    : (!desde && !hasta
                        ? 'No se pidieron fechas: esto es TODA la historia. Di de que fechas son las cifras.'
                        : undefined),
                ...lista,
                ...(rows.length > 1 ? {
                    grafica: grafica({
                        tipo: 'barras',
                        titulo: `Produccion por ${agrupar}`,
                        eje_x: rows.map((f) => String(f.grupo)),
                        series: [
                            { nombre: 'cajas',   datos: rows.map((f) => Number(f.cajas)) },
                            { nombre: 'scrap',   datos: rows.map((f) => Number(f.scrap)) },
                            { nombre: 'rechazo', datos: rows.map((f) => Number(f.rechazo)) },
                        ],
                    }),
                } : {}),   // con un solo grupo no hay nada que comparar: no es una grafica, es un numero
            };
        },
    },

    paros_de_maquina: {
        descripcion: 'Paros y alertas de maquina, con su duracion, tipo y area responsable.',
        esquema: {
            type: 'object',
            properties: {
                solo_sin_cerrar: { type: 'boolean', description: 'Solo los que siguen abiertos' },
                desde: { type: 'string', description: 'AAAA-MM-DD' },
                hasta: { type: 'string', description: 'AAAA-MM-DD' },
                limite: { type: 'integer' },
            },
            additionalProperties: false,
        },
        async ejecutar(args, ctx) {
            const limite = entero(args.limite);
            const desde = fecha(args.desde);
            const hasta = fecha(args.hasta);
            const r = rangoFechas('start_date', desde, hasta, 1);
            const abiertos = args.solo_sin_cerrar === true ? `AND status <> 'completed'` : '';

            const lista = await consultarLista(ctx.scope, `
                SELECT count(*) OVER () AS _total,
                       machine_code, machine_name, work_center_name,
                       status, failure_name, failure_type, failure_area,
                       start_date, end_date, duracion_min
                  FROM v_machine_stops
                 WHERE organization_id = ANY($ORGS)
                 ${abiertos}
                 ${r.sql}
                 ORDER BY start_date DESC NULLS LAST
                 LIMIT ${limite}`, r.valores, 'paros');
            const rows = lista.paros;

            const { rows: porTipo } = await consultarConAlcance(ctx.scope, `
                SELECT COALESCE(NULLIF(trim(failure_type), ''), 'sin tipo') AS tipo,
                       count(*)::int AS cuantos,
                       round(avg(duracion_min), 1) AS duracion_promedio_min
                  FROM v_machine_stops
                 WHERE organization_id = ANY($ORGS)
                 ${abiertos}
                 ${r.sql}
                 GROUP BY 1 ORDER BY 2 DESC`, r.valores);

            return {
                periodo_pedido: { desde, hasta },
                periodo_real_cubierto: periodoDe(rows, 'start_date', 'start_date'),
                nota: (!desde && !hasta && rows.length)
                    ? 'No se pidieron fechas: esto es TODA la historia. Di de que fechas son las cifras.'
                    : undefined,
                resumen_por_tipo: porTipo,
                ...lista,
            };
        },
    },

    estado_sensores: {
        descripcion:
            'Ultima lectura de cada sensor, con su maquina. Sirve para ver que sensor ' +
            'dejo de reportar y desde cuando.',
        esquema: {
            type: 'object',
            properties: {
                solo_mudos: { type: 'boolean', description: 'Solo los que llevan mas de un dia sin reportar' },
                limite: { type: 'integer' },
            },
            additionalProperties: false,
        },
        async ejecutar(args, ctx) {
            const limite = entero(args.limite);
            const mudos = args.solo_mudos === true
                ? `AND (last_reading_at IS NULL OR last_reading_at < now() - interval '1 day')`
                : '';
            return consultarLista(ctx.scope, `
                SELECT count(*) OVER () AS _total,
                       sensor_name, var, machine_code, machine_name,
                       value AS ultimo_valor, last_reading_at,
                       CASE WHEN last_reading_at IS NULL THEN NULL
                            ELSE round(EXTRACT(EPOCH FROM (now() - last_reading_at)) / 86400.0, 1)
                       END AS dias_sin_reportar
                  FROM v_sensor_latest
                 WHERE organization_id = ANY($ORGS)
                 ${mudos}
                 ORDER BY last_reading_at DESC NULLS LAST
                 LIMIT ${limite}`, [], 'sensores');
        },
    },
};


// ─── las que faltaban del plan 3.3 ──────────────────────────────────────────

/**
 * Resuelve un sensor por nombre o por variable, dentro del alcance.
 *
 * El modelo no puede pasar sensor_id: no lo conoce y no debe. Pasa "temperatura"
 * o "temp", y si hay varios con ese nombre en distintas maquinas devolvemos los
 * candidatos para que pregunte, en vez de escoger uno al azar.
 */
async function resolverSensor(ctx, nombre, maquina) {
    if (typeof nombre !== 'string' || !nombre.trim()) {
        return { error: 'Falta el nombre del sensor' };
    }
    const valores = [nombre.trim()];
    let porMaquina = '';
    if (typeof maquina === 'string' && maquina.trim()) {
        valores.push(maquina.trim());
        porMaquina = `AND (lower(machine_code) = lower($2) OR lower(machine_name) = lower($2))`;
    }
    const { rows } = await consultarConAlcance(ctx.scope, `
        SELECT sensor_id, sensor_name, var, machine_code, machine_name
          FROM v_sensor_latest
         WHERE organization_id = ANY($ORGS)
           AND (lower(sensor_name) = lower($1) OR lower(var) = lower($1))
         ${porMaquina}
         ORDER BY sensor_id`, valores);

    if (rows.length === 0) {
        const { rows: hay } = await consultarConAlcance(ctx.scope, `
            SELECT DISTINCT sensor_name, var, machine_code
              FROM v_sensor_latest
             WHERE organization_id = ANY($ORGS)
             ORDER BY sensor_name LIMIT 40`);
        return { error: `No hay ningun sensor llamado "${nombre}"`, sensores_disponibles: hay };
    }
    if (rows.length > 1) {
        return { error: `Hay ${rows.length} sensores con ese nombre. Di en que maquina.`, candidatos: rows };
    }
    return { sensor: rows[0] };
}

/**
 * Que datos SI tiene el sensor, para cuando la ventana pedida sale vacia.
 *
 * El modelo se inventa ventanas: preguntando "viene subiendo la temperatura?"
 * mando desde=hace-30-dias, y como ahi no hay lecturas contesto "no hay datos
 * suficientes" -- que suena a que el sensor no sirve, cuando en realidad tiene
 * 20 000 lecturas cinco meses antes. Devolverle el rango real le deja corregir.
 */
async function loQueSiHay(ctx, sensorId) {
    const { rows } = await consultarConAlcance(ctx.scope, `
        SELECT count(*)::int AS lecturas, min(date_time) AS desde, max(date_time) AS hasta
          FROM v_sensor_readings
         WHERE organization_id = ANY($ORGS) AND sensor_id = $1`, [sensorId]);
    return rows[0];
}

TOOLS.historico_sensor = {
    descripcion:
        'Serie historica de un sensor, ya submuestreada para poder graficarla. ' +
        'Devuelve como mucho 30 puntos con promedio, minimo y maximo de cada tramo.',
    esquema: {
        type: 'object',
        properties: {
            sensor: { type: 'string', description: 'Nombre del sensor o su variable, ej "temperatura" o "temp"' },
            maquina: { type: 'string', description: 'Codigo o nombre de la maquina, si el sensor se repite' },
            desde: { type: 'string', description: 'AAAA-MM-DD' },
            hasta: { type: 'string', description: 'AAAA-MM-DD' },
            puntos: { type: 'integer', description: 'Cuantos puntos devolver, maximo 30' },
        },
        required: ['sensor'],
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const encontrado = await resolverSensor(ctx, args.sensor, args.maquina);
        if (encontrado.error) return encontrado;

        const puntos = entero(args.puntos, { min: 2, max: 30, porDefecto: 30 });
        const desde = fecha(args.desde);
        const hasta = fecha(args.hasta);
        const valores = [encontrado.sensor.sensor_id];
        const r = rangoFechas('date_time', desde, hasta, 2);
        valores.push(...r.valores);

        // Cubos de IGUAL DURACION, no de igual numero de lecturas. Con ntile un
        // sensor que estuvo mudo tres meses y luego reporto seguido saldria con
        // el eje del tiempo deformado, y la grafica mentiria.
        const { rows } = await consultarConAlcance(ctx.scope, `
            WITH filtradas AS (
                SELECT date_time, value
                  FROM v_sensor_readings
                 WHERE organization_id = ANY($ORGS)
                   AND sensor_id = $1
                 ${r.sql}
            ), rango AS (
                SELECT EXTRACT(EPOCH FROM min(date_time)) AS ini,
                       EXTRACT(EPOCH FROM max(date_time)) + 1 AS fin
                  FROM filtradas
            )
            SELECT width_bucket(EXTRACT(EPOCH FROM f.date_time), rango.ini, rango.fin, ${puntos}) AS tramo,
                   min(f.date_time)          AS desde,
                   max(f.date_time)          AS hasta,
                   round(avg(f.value), 3)    AS promedio,
                   min(f.value)              AS minimo,
                   max(f.value)              AS maximo,
                   count(*)::int             AS lecturas
              FROM filtradas f, rango
             GROUP BY 1
             ORDER BY 1`, valores);

        if (rows.length === 0) {
            const hay = await loQueSiHay(ctx, encontrado.sensor.sensor_id);
            return {
                sensor: encontrado.sensor,
                periodo_pedido: { desde, hasta },
                puntos: [],
                datos_disponibles: hay,
                nota: hay.lecturas > 0
                    ? `Sin lecturas en el periodo que pediste. El sensor SI tiene ${hay.lecturas} lecturas entre ${hay.desde} y ${hay.hasta}: vuelve a llamar a esta herramienta con esas fechas, o sin fechas, ANTES de contestar.`
                    : 'Este sensor nunca ha reportado.',
            };
        }
        return {
            sensor: encontrado.sensor,
            periodo_pedido: { desde, hasta },
            submuestreo: `${puntos} tramos de igual duracion`,
            puntos: rows,
            grafica: grafica({
                tipo: 'linea',
                titulo: `${encontrado.sensor.sensor_name} - ${encontrado.sensor.machine_name || encontrado.sensor.machine_code || ''}`.trim().replace(/ -$/, ''),
                // La etiqueta es el INICIO del tramo, que es lo que representa.
                eje_x: rows.map((f) => f.desde),
                series: [
                    { nombre: 'promedio', datos: rows.map((f) => Number(f.promedio)) },
                    { nombre: 'minimo',   datos: rows.map((f) => Number(f.minimo)) },
                    { nombre: 'maximo',   datos: rows.map((f) => Number(f.maximo)) },
                ],
                unidad: encontrado.sensor.var || null,
            }),
        };
    },
};

TOOLS.tendencia_sensor = {
    descripcion:
        'Si un sensor viene subiendo o bajando: pendiente por dia y R2 (que tan ' +
        'confiable es esa tendencia). R2 cerca de 0 significa que no hay tendencia, ' +
        'solo ruido.',
    esquema: {
        type: 'object',
        properties: {
            sensor: { type: 'string' },
            maquina: { type: 'string' },
            desde: { type: 'string', description: 'AAAA-MM-DD' },
            hasta: { type: 'string', description: 'AAAA-MM-DD' },
        },
        required: ['sensor'],
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const encontrado = await resolverSensor(ctx, args.sensor, args.maquina);
        if (encontrado.error) return encontrado;

        const desde = fecha(args.desde);
        const hasta = fecha(args.hasta);
        const valores = [encontrado.sensor.sensor_id];
        const r = rangoFechas('date_time', desde, hasta, 2);
        valores.push(...r.valores);

        // regr_slope y regr_r2 son de Postgres: no hay que traerse 20 000
        // lecturas a Node para sacar una recta.
        const { rows } = await consultarConAlcance(ctx.scope, `
            SELECT count(*)::int AS lecturas,
                   round(avg(value), 3) AS promedio,
                   min(value) AS minimo,
                   max(value) AS maximo,
                   min(date_time) AS desde,
                   max(date_time) AS hasta,
                   round((regr_slope(value, EXTRACT(EPOCH FROM date_time)) * 86400)::numeric, 6) AS pendiente_por_dia,
                   round(regr_r2(value, EXTRACT(EPOCH FROM date_time))::numeric, 4) AS r2
              FROM v_sensor_readings
             WHERE organization_id = ANY($ORGS)
               AND sensor_id = $1
             ${r.sql}`, valores);

        const t = rows[0];
        if (!t || t.lecturas < 3) {
            const hay = await loQueSiHay(ctx, encontrado.sensor.sensor_id);
            return {
                sensor: encontrado.sensor,
                periodo_pedido: { desde, hasta },
                lecturas_en_el_periodo: t?.lecturas || 0,
                datos_disponibles: hay,
                error: 'Hacen falta al menos 3 lecturas para hablar de tendencia',
                nota: hay.lecturas >= 3
                    ? `En el periodo que pediste casi no hay lecturas, pero el sensor SI tiene ${hay.lecturas} entre ${hay.desde} y ${hay.hasta}: vuelve a llamar a esta herramienta con esas fechas, o sin fechas, ANTES de contestar.`
                    : 'Este sensor practicamente no ha reportado nunca.',
            };
        }
        const r2 = Number(t.r2);
        return {
            sensor: encontrado.sensor,
            ...t,
            interpretacion: r2 < 0.3
                ? 'R2 bajo: no hay tendencia, es ruido. NO digas que sube ni que baja.'
                : (Number(t.pendiente_por_dia) > 0 ? 'Tendencia al alza' : 'Tendencia a la baja'),
        };
    },
};

TOOLS.turno_vigente = {
    descripcion: 'Que turno esta corriendo ahora mismo en cada organizacion, y cuanto le falta.',
    esquema: { type: 'object', properties: {}, additionalProperties: false },
    async ejecutar(_args, ctx) {
        // Misma logica que v_production_shift: hora local contra mes_shifts,
        // con el caso del turno que cruza la medianoche.
        const { rows } = await consultarConAlcance(ctx.scope, `
            WITH ahora AS (
                SELECT (now() AT TIME ZONE 'America/Mexico_City') AS local_ts
            )
            SELECT s.organization_id, s.organization_name AS organizacion,
                   s.shift_name AS turno, s.start_time, s.end_time, s.horas,
                   to_char(a.local_ts, 'YYYY-MM-DD HH24:MI') AS hora_local
              FROM v_shifts s
              CROSS JOIN ahora a
             WHERE s.organization_id = ANY($ORGS)
               AND s.enabled_flag = 'Y'
               AND CASE WHEN s.start_time < s.end_time
                        THEN a.local_ts::time >= s.start_time AND a.local_ts::time < s.end_time
                        ELSE a.local_ts::time >= s.start_time OR  a.local_ts::time < s.end_time
                   END
             ORDER BY s.organization_id`);

        return {
            zona_horaria: 'America/Mexico_City',
            nota: rows.length === 0
                ? 'Ninguna de tus organizaciones tiene turnos configurados en mes_shifts.'
                : undefined,
            turnos_en_curso: rows,
        };
    },
};

TOOLS.detalle_orden = {
    descripcion: 'Todo sobre una orden de trabajo: sus datos y cada registro de produccion.',
    esquema: {
        type: 'object',
        properties: { orden: { type: 'string', description: 'Numero de orden, ej "WO-1024"' } },
        required: ['orden'],
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const numero = typeof args.orden === 'string' ? args.orden.trim() : '';
        if (!numero) return { error: 'Falta el numero de orden' };

        const { rows: cabecera } = await consultarConAlcance(ctx.scope, `
            SELECT * FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
               AND lower(work_order_number) = lower($1)`, [numero]);

        if (cabecera.length === 0) {
            // Sin pistas de si existe en otra compañia: solo "no la tienes".
            return { error: `No existe la orden "${numero}" dentro de tu alcance` };
        }

        const ejecuciones = await consultarLista(ctx.scope, `
            SELECT count(*) OVER () AS _total,
                   execution_date, local_date, shift_name, cajas, scrap, rechazo, tare, container, status
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
               AND work_order_number = $1
             ORDER BY execution_date DESC
             LIMIT ${LIMITE_MAXIMO}`, [cabecera[0].work_order_number], 'registros_de_produccion');

        return { orden: cabecera[0], ...ejecuciones };
    },
};

TOOLS.cumplimiento_vs_plan = {
    descripcion:
        'Que tanto se cumplio lo planeado: cantidad planeada contra completada, ' +
        'por orden y en total. Sirve para "vamos bien o vamos tarde".',
    esquema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['RELEASED', 'IN_PROCESS'] },
            limite: { type: 'integer' },
        },
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const status = enumerado(args.status, ['RELEASED', 'IN_PROCESS']);
        const limite = entero(args.limite);
        const valores = [];
        const filtro = status ? (valores.push(status), 'AND status = $1') : '';

        const { rows: total } = await consultarConAlcance(ctx.scope, `
            SELECT count(*)::int AS ordenes,
                   sum(planned_start_quantity) AS planeado,
                   sum(completed_quantity)     AS completado,
                   CASE WHEN sum(planned_start_quantity) > 0
                        THEN round(sum(completed_quantity) / sum(planned_start_quantity) * 100, 1)
                   END AS cumplimiento_pct,
                   count(*) FILTER (WHERE completed_quantity >= planned_start_quantity)::int AS ordenes_completas,
                   count(*) FILTER (WHERE COALESCE(completed_quantity, 0) = 0)::int AS ordenes_sin_avance
              FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
             ${filtro}`, valores);

        const { rows: rezagadas } = await consultarConAlcance(ctx.scope, `
            SELECT work_order_number, status, item_number, machine_name,
                   planned_start_quantity, completed_quantity,
                   CASE WHEN planned_start_quantity > 0
                        THEN round(completed_quantity / planned_start_quantity * 100, 1)
                   END AS avance_pct,
                   start_date, end_date
              FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
             ${filtro}
             ORDER BY (CASE WHEN planned_start_quantity > 0
                            THEN completed_quantity / planned_start_quantity ELSE 0 END) ASC,
                      start_date ASC NULLS LAST
             LIMIT ${limite}`, valores);

        return { filtro_aplicado: { status }, total: total[0], mas_rezagadas: rezagadas };
    },
};

TOOLS.comparar_periodos = {
    descripcion:
        'Compara la produccion de dos periodos y da la diferencia y el cambio ' +
        'porcentual. Para "como vamos contra el mes pasado".',
    esquema: {
        type: 'object',
        properties: {
            a_desde: { type: 'string', description: 'AAAA-MM-DD, inicio del primer periodo' },
            a_hasta: { type: 'string', description: 'AAAA-MM-DD, fin del primer periodo' },
            b_desde: { type: 'string', description: 'AAAA-MM-DD, inicio del segundo periodo' },
            b_hasta: { type: 'string', description: 'AAAA-MM-DD, fin del segundo periodo' },
        },
        required: ['a_desde', 'a_hasta', 'b_desde', 'b_hasta'],
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const p = {
            a: { desde: fecha(args.a_desde), hasta: fecha(args.a_hasta) },
            b: { desde: fecha(args.b_desde), hasta: fecha(args.b_hasta) },
        };
        for (const [etiqueta, rango] of Object.entries(p)) {
            if (!rango.desde || !rango.hasta) {
                return { error: `El periodo ${etiqueta} necesita dos fechas AAAA-MM-DD validas` };
            }
        }

        const totales = async ({ desde, hasta }) => {
            const { rows } = await consultarConAlcance(ctx.scope, `
                SELECT count(*)::int AS registros,
                       COALESCE(sum(cajas), 0)   AS cajas,
                       COALESCE(sum(scrap), 0)   AS scrap,
                       COALESCE(sum(rechazo), 0) AS rechazo,
                       CASE WHEN sum(cajas + scrap + rechazo) > 0
                            THEN round(sum(scrap + rechazo) / sum(cajas + scrap + rechazo) * 100, 2)
                       END AS merma_pct
                  FROM v_production_shift
                 WHERE organization_id = ANY($ORGS)
                   AND execution_date >= $1
                   AND execution_date < ($2::date + 1)`, [desde, hasta]);
            return { desde, hasta, ...rows[0] };
        };

        const [a, b] = await Promise.all([totales(p.a), totales(p.b)]);
        const cambio = (x, y) => {
            const nx = Number(x), ny = Number(y);
            if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx === 0) return null;
            return Number((((ny - nx) / nx) * 100).toFixed(1));
        };

        return {
            periodo_a: a,
            periodo_b: b,
            diferencia: {
                cajas: Number(b.cajas) - Number(a.cajas),
                cambio_cajas_pct: cambio(a.cajas, b.cajas),
                cambio_merma_pct: cambio(a.merma_pct, b.merma_pct),
            },
            nota: (a.registros === 0 || b.registros === 0)
                ? 'Uno de los dos periodos no tiene produccion registrada. Dilo antes de comparar.'
                : undefined,
        };
    },
};

TOOLS.top_items = {
    descripcion: 'Que articulos se produjeron mas, con sus ordenes y cantidades.',
    esquema: {
        type: 'object',
        properties: {
            limite: { type: 'integer' },
            desde: { type: 'string', description: 'AAAA-MM-DD' },
            hasta: { type: 'string', description: 'AAAA-MM-DD' },
        },
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const limite = entero(args.limite, { min: 1, max: LIMITE_MAXIMO, porDefecto: 10 });
        const desde = fecha(args.desde);
        const hasta = fecha(args.hasta);
        const r = rangoFechas('start_date', desde, hasta, 1);

        const { rows } = await consultarConAlcance(ctx.scope, `
            SELECT COALESCE(NULLIF(trim(item_number), ''), 'sin item') AS item,
                   max(item_description) AS descripcion,
                   max(uom)              AS uom,
                   count(*)::int         AS ordenes,
                   sum(planned_start_quantity) AS planeado,
                   sum(completed_quantity)     AS completado
              FROM v_wo_status
             WHERE organization_id = ANY($ORGS)
             ${r.sql}
             GROUP BY 1
             ORDER BY sum(completed_quantity) DESC NULLS LAST
             LIMIT ${limite}`, r.valores);

        return {
            periodo_pedido: { desde, hasta },
            nota: (!desde && !hasta && rows.length)
                ? 'No se pidieron fechas: esto es TODA la historia. Dilo.'
                : undefined,
            items: rows,
        };
    },
};

TOOLS.oee = {
    descripcion:
        'OEE, disponibilidad, rendimiento, calidad, MTBF, MTTR y MTTA por maquina. ' +
        'Llamala cuando pregunten por cualquiera de esos indicadores.',
    esquema: {
        type: 'object',
        properties: {
            desde: { type: 'string', description: 'AAAA-MM-DD' },
            hasta: { type: 'string', description: 'AAAA-MM-DD' },
            limite: { type: 'integer' },
        },
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const limite = entero(args.limite);
        const desde = fecha(args.desde);
        const hasta = fecha(args.hasta);
        const r = rangoFechas('kpi_date', desde, hasta, 1);

        const { rows } = await consultarConAlcance(ctx.scope, `
            SELECT machine_code, machine_name,
                   count(*)::int AS mediciones,
                   round(avg(availability), 3) AS disponibilidad,
                   round(avg(performance), 3)  AS rendimiento,
                   round(avg(quality), 3)      AS calidad,
                   round(avg(availability * performance * quality), 3) AS oee,
                   round(avg(mtbf), 2) AS mtbf,
                   round(avg(mttr), 2) AS mttr,
                   round(avg(mtta), 2) AS mtta
              FROM v_oee
             WHERE organization_id = ANY($ORGS)
             ${r.sql}
             GROUP BY 1, 2
             ORDER BY 7 DESC NULLS LAST
             LIMIT ${limite}`, r.valores);

        if (rows.length === 0) {
            // Esta tool existe justamente para dar esta respuesta. Sin ella el
            // modelo intentaria estimar el OEE con produccion y paros, y el
            // numero seria mentira: falta el tiempo planeado y el ciclo ideal.
            return {
                disponible: false,
                motivo: 'La tabla mes_kpis del MES no tiene datos para tu alcance. Nadie la esta poblando.',
                nota: 'Di que el OEE no esta disponible. NO lo estimes con produccion ni con paros.',
                maquinas: [],
            };
        }
        return { disponible: true, periodo_pedido: { desde, hasta }, maquinas: rows };
    },
};

/** El catalogo en formato OpenAI, que es lo que espera el proveedor. */
function esquemasParaElModelo() {
    return Object.entries(TOOLS).map(([name, t]) => ({
        type: 'function',
        function: { name, description: t.descripcion, parameters: t.esquema },
    }));
}

/**
 * Ejecuta una tool. NUNCA lanza: devuelve { error } para que el modelo pueda
 * reaccionar y corregir en la siguiente vuelta, en vez de tumbar la conversacion.
 */
async function ejecutarTool(nombre, argumentos, ctx) {
    const tool = TOOLS[nombre];
    if (!tool) return { error: `No existe la herramienta "${nombre}"` };
    try {
        const args = typeof argumentos === 'string' ? JSON.parse(argumentos || '{}') : (argumentos || {});
        return await tool.ejecutar(args, ctx);
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * El reporte en PDF (ETAPA 5).
 *
 * Esta tool NO genera el archivo: prepara el boton. Devuelve el periodo ya
 * saneado y el agente lo aparta para que el cliente pida
 * GET /api/ai/reporte?desde=&hasta=, que dibuja el PDF y lo manda.
 *
 * Que no lo genere aqui es a proposito: un PDF de 200 kB dentro del resultado de
 * una tool se le mandaria AL MODELO como texto, y ademas el modelo no puede
 * entregarle un archivo a nadie -- lo unico que sabe hacer es escribir.
 *
 * Lo que si hace es MIRAR SI HAY ALGO. Ofrecer un boton que baja un PDF vacio es
 * peor que decir "no hay datos en ese periodo": el usuario se lleva un archivo
 * que parece decir que no se produjo nada.
 */
TOOLS.generar_reporte = {
    descripcion:
        'Prepara un reporte de produccion en PDF para un periodo. No devuelve el archivo: ' +
        'le deja al usuario un boton para descargarlo. Usala cuando pidan un reporte, un PDF ' +
        'o algo "para imprimir" o "para mandar por correo".',
    esquema: {
        type: 'object',
        properties: {
            desde: { type: 'string', description: 'AAAA-MM-DD' },
            hasta: { type: 'string', description: 'AAAA-MM-DD' },
        },
        required: ['desde', 'hasta'],
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const desde = fecha(args.desde);
        const hasta = fecha(args.hasta);
        if (!desde || !hasta) {
            return { error: 'Necesito el periodo completo en formato AAAA-MM-DD: desde y hasta.' };
        }
        if (desde > hasta) {
            return { error: 'La fecha "desde" es posterior a "hasta".' };
        }

        const { rows } = await consultarConAlcance(ctx.scope, `
            SELECT count(*)::int AS registros, sum(cajas) AS cajas
              FROM v_production_shift
             WHERE organization_id = ANY($ORGS)
               AND execution_date >= $1 AND execution_date < ($2::date + 1)`, [desde, hasta]);

        if (!rows[0] || !rows[0].registros) {
            const hay = await consultarConAlcance(ctx.scope, `
                SELECT min(execution_date)::date AS primera, max(execution_date)::date AS ultima
                  FROM v_production_shift
                 WHERE organization_id = ANY($ORGS)`);
            const rango = hay.rows[0];
            return {
                periodo: { desde, hasta },
                registros: 0,
                nota: rango && rango.primera
                    ? `Sin produccion en ese periodo, asi que el reporte saldria vacio. SI hay `
                      + `registros entre ${rango.primera.toISOString().slice(0, 10)} y `
                      + `${rango.ultima.toISOString().slice(0, 10)}: vuelve a llamar a esta `
                      + `herramienta con esas fechas ANTES de contestar.`
                    : 'No hay ni un registro de produccion en tu alcance: no hay reporte que hacer.',
            };
        }

        return {
            periodo: { desde, hasta },
            registros: rows[0].registros,
            cajas: rows[0].cajas,
            reporte: { desde, hasta, titulo: `Reporte de produccion ${desde} a ${hasta}` },
            nota: 'El boton de descarga ya esta puesto. Di en una linea que el reporte esta listo '
                + 'y de que periodo es. NO pongas enlaces ni digas que no puedes generar archivos.',
        };
    },
};

/**
 * Programar el reporte por correo, desde el chat.
 *
 * ES LA UNICA TOOL QUE ESCRIBE. El resto del bot es de solo lectura --el rol de
 * Postgres solo tiene SELECT sobre 8 vistas-- y esa es la capa 1 del
 * aislamiento. Esta se sale de ahi, asi que va con cuatro cierres, y el que
 * importa es el tercero:
 *
 *  1. Solo SuperAdmin. El rol sale de resolveScope --de la BASE, no del token ni
 *     del modelo--, asi que ni una inyeccion ni un token viejo lo cambian.
 *  2. La compañia es la del alcance ya recortado. No hay argumento para
 *     nombrarla, igual que en todas las demas.
 *  3. NO SE PUEDE ELEGIR DESTINATARIO. Son los usuarios de la compañia, y punto.
 *     Esto es lo que convierte el peor caso --que una inyeccion escondida en un
 *     nombre de maquina consiga programar algo-- en "a tus propios compañeros les
 *     llega un PDF de mas", en vez de "la produccion sale de la empresa".
 *  4. Todo argumento se sanea en crearProgramado, el mismo camino que el
 *     endpoint.
 *
 * Y no escribe por el pool del bot: va por el de la aplicacion, en una sola
 * sentencia parametrizada. El rol condor_ai_ro sigue sin poder escribir nada.
 */
TOOLS.programar_reporte = {
    descripcion:
        'Programa el envio automatico del reporte de produccion por correo a los usuarios ' +
        'de la compañia. Solo un SuperAdmin puede. Usala cuando pidan recibir el reporte ' +
        '"cada dia", "cada semana" o "cada mes". No sirve para mandarlo una sola vez.',
    esquema: {
        type: 'object',
        properties: {
            periodicidad: { type: 'string', enum: ['diario', 'semanal', 'mensual'] },
            hora: { type: 'string', description: 'HH:MM en 24 horas, hora local de la planta. Por omision 07:00' },
            dia_semana: { type: 'integer', description: 'Solo para "semanal": 1 lunes ... 7 domingo' },
        },
        required: ['periodicidad'],
        additionalProperties: false,
    },
    async ejecutar(args, ctx) {
        const { crearProgramado } = require('./programador');

        if (ctx.scope.role !== 'SuperAdmin') {
            return { error: 'Solo un SuperAdmin puede programar el envio de reportes.' };
        }
        // El alcance del chat llega ya recortado a una compañia (scopeDeCompania).
        // Si alguna vez llegara con varias, no se adivina cual.
        if (ctx.scope.companyIds.length !== 1) {
            return { error: 'No puedo saber para que compañia programarlo.' };
        }

        try {
            const fila = await crearProgramado({
                companyId: ctx.scope.companyIds[0],
                userId: ctx.scope.userId,
                periodicidad: args.periodicidad,
                hora: args.hora,
                dia: args.dia_semana,
            });
            return {
                programado: fila,
                nota: 'Ya esta programado. Dile al usuario cada cuanto y a que hora sale, y '
                    + 'que se manda a los usuarios de su compañia que tengan correo. '
                    + 'NO preguntes a quien mandarlo: no se elige.',
            };
        } catch (e) {
            // Los errores de saneo llevan .status y su mensaje es legible.
            return { error: e.status ? e.message : 'No pude programar el reporte.' };
        }
    },
};

module.exports = { TOOLS, esquemasParaElModelo, ejecutarTool, enumerado, entero, fecha };
