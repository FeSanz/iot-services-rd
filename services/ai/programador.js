/**
 * Reportes programados por correo (ETAPA 5, segunda parte).
 *
 * POR QUE NO HAY node-cron, que era lo que pedia el plan:
 *
 * Un cron en memoria no sabe que se cayo. Render reinicia el servicio a menudo
 * --y en el plan free lo duerme por inactividad-- y lo que le tocaba disparar
 * mientras estaba caido se pierde en silencio: nadie recibe el reporte del lunes
 * y nadie se entera hasta que alguien lo echa de menos.
 *
 * Aqui la proxima ejecucion vive EN LA TABLA. El proceso solo pregunta cada
 * pocos minutos "¿que toca ya?", asi que un reinicio no pierde nada: al volver,
 * lo atrasado sigue atrasado y sale. Y cambiar un horario es un UPDATE, no un
 * despliegue.
 *
 * Es menos codigo que registrar y re-registrar tareas de node-cron, y una
 * dependencia menos.
 *
 * MULTIINSTANCIA: la seleccion va con FOR UPDATE SKIP LOCKED. Con dos instancias
 * despiertas a la vez, cada programado se lo lleva UNA. Sin eso, dos copias del
 * mismo correo -- que es como se descubre que hay dos instancias.
 */
const { PassThrough } = require('stream');
const pool = require('../../database/pool');
const { transporter } = require('../email/email');
const { resolveScope, scopeDeCompania } = require('./scope');
const { datosDelReporte, dibujarReporte } = require('./reporte');
const { paletaDeCompania } = require('./portada');
const { redactarComentario } = require('./comentario');
const { obtenerCredencialActiva } = require('./credentials');
const { asistenteEncendido } = require('./interruptor');
const { ocuparLugar } = require('./cupo');

const { ZONA } = require('./domain');   // la zona de las plantas, en un solo sitio
const CADA_MS = Number(process.env.AI_SCHEDULER_INTERVAL_MS || 5 * 60 * 1000);

let temporizador = null;

/**
 * Cuando toca la siguiente, en hora local de la planta.
 *
 * La cuenta la hace POSTGRES, no Node. Las plantas estan en Mexico y el servidor
 * corre en UTC: "todos los dias a las 7" es una hora de pared, no un desfase
 * fijo -- el horario de verano la moveria. Postgres ya sabe de zonas, y este
 * proyecto ya se quemo una vez con eso (los turnos de la ETAPA 2).
 */
async function proximaEjecucion({ periodicidad, hora_local, dia_semana }) {
    const sql = `
        SELECT (SELECT MIN(cuando) FROM (
                    SELECT generate_series(
                               date_trunc('day', now() AT TIME ZONE $4),
                               date_trunc('day', now() AT TIME ZONE $4) + interval '40 days',
                               interval '1 day'
                           ) + $2::time AS cuando
                ) dias
                WHERE (cuando AT TIME ZONE $4) > now()
                  AND CASE $1::text
                        WHEN 'diario'  THEN true
                        WHEN 'semanal' THEN EXTRACT(ISODOW FROM cuando) = $3::int
                        WHEN 'mensual' THEN EXTRACT(DAY FROM cuando) = 1
                      END
               ) AT TIME ZONE $4 AS proxima`;
    const { rows } = await pool.query(sql, [periodicidad, hora_local, dia_semana || 1, ZONA]);
    return rows[0].proxima;
}

/**
 * Que periodo cubre cada reporte. Siempre CERRADO y hacia atras: el diario de
 * las 7 de la mañana habla de AYER, no del dia que acaba de empezar y todavia
 * no tiene ni un registro.
 *
 * `ahora` es LA RANURA QUE TOCABA (proxima_ejecucion), no el reloj. Con el
 * reloj, un proceso que despierta atrasado ya pasada la medianoche calculaba
 * "ayer" desde el dia nuevo: mandaba el reporte de hoy-1, la pasada normal lo
 * repetia dos horas despues, y el del dia que tocaba no salia nunca. Anclado a
 * la ranura, lo atrasado cubre SU periodo aunque salga tarde.
 */
function periodoDe(periodicidad, ahora = new Date()) {
    // Con los getters locales, NO con toISOString(): `hoy` es hora de pared de
    // la planta metida en un Date local, y toISOString() la convierte a UTC --
    // en un host al oeste de UTC (una maquina de desarrollo en Mexico, por la
    // tarde) eso corre la fecha un dia. En Render (UTC) daba igual; aqui no.
    const dia = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hoy = new Date(ahora.toLocaleString('en-US', { timeZone: ZONA }));

    if (periodicidad === 'diario') {
        const ayer = new Date(hoy);
        ayer.setDate(ayer.getDate() - 1);
        return { desde: dia(ayer), hasta: dia(ayer) };
    }
    if (periodicidad === 'semanal') {
        const fin = new Date(hoy);
        fin.setDate(fin.getDate() - 1);
        const ini = new Date(fin);
        ini.setDate(ini.getDate() - 6);
        return { desde: dia(ini), hasta: dia(fin) };
    }
    // mensual: el mes anterior completo
    const finMes = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
    const iniMes = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    return { desde: dia(iniMes), hasta: dia(finMes) };
}

/** El PDF en memoria, para adjuntarlo. Mismo dibujo que el de la descarga. */
function pdfEnMemoria(datosDelDibujo) {
    return new Promise((resolve, reject) => {
        const flujo = new PassThrough();
        const trozos = [];
        flujo.on('data', (t) => trozos.push(t));
        flujo.on('end', () => resolve(Buffer.concat(trozos)));
        flujo.on('error', reject);
        // La oreja va en el DOCUMENTO, no solo en el flujo: pipe no propaga los
        // errores del origen al destino. Sin esto, un error interno de pdfkit
        // dejaba la promesa pendiente para siempre -- y el finally que suelta el
        // lugar del cupo, sin correr hasta el reinicio.
        dibujarReporte(flujo, datosDelDibujo).on('error', reject);
    });
}

/**
 * A quien se le manda: los usuarios de las organizaciones DEL ALCANCE.
 *
 * No hay lista de correos configurable, y es a proposito. Un campo de texto con
 * direcciones convierte "programar un reporte" en "sacar la produccion de la
 * empresa a donde yo diga", y encima con la firma del sistema.
 */
async function destinatarios(orgIds) {
    const { rows } = await pool.query(`
        SELECT DISTINCT u.email
          FROM mes_users u
          INNER JOIN mes_users_org uo ON u.user_id = uo.user_id
         WHERE uo.organization_id = ANY($1)
           AND u.enabled_flag = 'Y'
           AND u.email IS NOT NULL
           AND u.email <> ''`, [orgIds]);
    return rows.map((r) => r.email);
}

/**
 * Los mismos destinatarios, pero agrupados por LO QUE CADA UNO PUEDE VER.
 *
 * Estar en la compañia no es estar en todas sus organizaciones: aqui la
 * asignacion va de 1 a 10 organizaciones por persona. Mandarle a todos el mismo
 * PDF --el de las organizaciones de quien programo-- le entrega a alguien de
 * INVENTARIOS PLANTA 1 la produccion de SIKA y de VIBRACOUSTIC, que en la
 * pantalla del MES no puede abrir. No es fuga entre compañias, pero si es dar
 * por correo lo que la aplicacion niega.
 *
 * Asi que un PDF por conjunto distinto de organizaciones, y cada quien recibe el
 * suyo. `organization_id = ANY($1)` recorta al alcance del programado ANTES de
 * agrupar, de modo que el conjunto de cada persona es su interseccion con el.
 *
 * Suele haber pocos grupos y los PDF cuestan ~100 ms, asi que no es caro; y a
 * quien solo lleva una planta le llega el reporte de SU planta, que ademas es
 * mas util que el de todas.
 */
async function gruposDeDestinatarios(orgIds) {
    const { rows } = await pool.query(`
        SELECT u.email,
               array_agg(DISTINCT uo.organization_id ORDER BY uo.organization_id) AS orgs
          FROM mes_users u
          INNER JOIN mes_users_org uo ON u.user_id = uo.user_id
         WHERE uo.organization_id = ANY($1)
           AND u.enabled_flag = 'Y'
           AND u.email IS NOT NULL
           AND u.email <> ''
         GROUP BY u.email`, [orgIds]);

    const grupos = new Map();
    for (const r of rows) {
        const clave = r.orgs.join(',');
        if (!grupos.has(clave)) grupos.set(clave, { orgIds: r.orgs, correos: [] });
        grupos.get(clave).correos.push(r.email);
    }
    return [...grupos.values()];
}

/**
 * Genera y manda UN programado. Devuelve el texto que se guarda como resultado.
 *
 * @param periodo  opcional, para forzar el rango. Existe por las pruebas: el
 *                 periodo normal se calcula desde la fecha de hoy, y esta base
 *                 se detiene en junio de 2026, asi que sin esto la unica prueba
 *                 posible seria "no habia datos" -- que es justo la que NO
 *                 demuestra que el correo sale con su PDF.
 */
async function enviarUno(prog, periodo = null) {
    // El alcance se vuelve a resolver EN CADA ENVIO. Si al usuario lo
    // deshabilitaron o le quitaron la organizacion, esto lanza y el reporte no
    // sale -- que es lo que tiene que pasar.
    // El mismo interruptor que apaga el chat apaga los correos. Si no, apagarle
    // el asistente a una compañia la dejaria recibiendo su produccion por correo
    // todos los lunes.
    if (!(await asistenteEncendido(prog.company_id))) {
        return 'El asistente esta apagado para esta compañia: no se mando nada';
    }

    const scope = scopeDeCompania(await resolveScope(prog.created_by), prog.company_id);
    // Anclado a la ranura vencida, no al reloj: ver periodoDe().
    const { desde, hasta } = periodo
        || periodoDe(prog.periodicidad, prog.proxima_ejecucion ? new Date(prog.proxima_ejecucion) : undefined);

    const grupos = await gruposDeDestinatarios(scope.orgIds);
    if (grupos.length === 0) {
        return 'Sin destinatarios con correo en el alcance: no se mando nada';
    }

    const empresa = (await pool.query(
        'SELECT name FROM mes_companies WHERE company_id = $1', [prog.company_id]
    )).rows[0]?.name || `Compañia ${prog.company_id}`;

    // Se leen una vez, no una por grupo: el color y la llave son de la compañia
    // y todos los PDF de este envio son suyos.
    const paleta = await paletaDeCompania(prog.company_id);
    const credencial = await obtenerCredencialActiva(prog.company_id).catch(() => null);

    // El programado consume la misma maquina que el chat: ocupa lugar en el cupo
    // de la instancia. No se rechaza a si mismo -- ver ocuparLugar().
    const soltar = ocuparLugar(prog.company_id);
    let envios = 0;
    let personas = 0;
    const fallos = [];
    try {
        for (const grupo of grupos) {
            // Cada grupo con su propio try: un SMTP que rechaza el correo del
            // grupo 2 no puede dejar sin reporte al 3 -- la proxima_ejecucion ya
            // avanzo y no hay reintento, asi que lo que no salga aqui no sale.
            try {
                // Un alcance por grupo: cada PDF se construye SOLO con lo que ese
                // grupo puede ver.
                const alcance = {
                    ...scope,
                    orgIds: grupo.orgIds,
                    orgsPorCompania: { [prog.company_id]: grupo.orgIds },
                };
    
                const datos = await datosDelReporte(alcance, desde, hasta);
                // Un PDF vacio cada lunes entrena a la gente a no abrirlo.
                if (!datos.resumen || !datos.resumen.registros) continue;
    
                // Una narrativa POR GRUPO, no una compartida: cada PDF lleva las
                // cifras de su alcance, y un texto que hable de numeros que no estan
                // en el documento es exactamente lo que este proyecto lleva evitando
                // desde el principio. Son N llamadas al LLM por envio, cada una con
                // su tope de 20 s y su respaldo estatico.
                const comentario = await redactarComentario({ empresa, desde, hasta, datos, credencial });
    
                const pdf = await pdfEnMemoria({
                    empresa, desde, hasta, datos, paleta, comentario,
                    generadoPor: `programado ${prog.periodicidad}`,
                });
    
                const producido = Number(datos.resumen.cajas) || 0;
                await transporter.sendMail({
                    from: `"Sistema MES" <${process.env.SMTP_USER}>`,
                    // Solo copia oculta, y SIN copia a la cuenta que manda: con
                    // `to: SMTP_USER` el buzon del sistema acababa recibiendo la
                    // produccion de todas las compañias, todas las semanas.
                    // Un correo automatico que reparte la libreta de direcciones
                    // entera tampoco: por eso bcc y no to.
                    bcc: grupo.correos.join(', '),
                    subject: `Reporte de produccion ${desde} a ${hasta} — ${empresa}`,
                    text: `Reporte de produccion de ${empresa}.\n\n`
                        + `Periodo: ${desde} a ${hasta}\n`
                        + `Producido: ${producido.toLocaleString('es-MX')} cajas\n\n`
                        + `El detalle va en el PDF adjunto.\n\n`
                        + `Este correo es automatico. Para dejar de recibirlo, pide que se `
                        + `desactive el reporte programado de tu compañia.`,
                    attachments: [{
                        filename: `reporte-produccion-${desde}-a-${hasta}.pdf`,
                        content: pdf,
                        contentType: 'application/pdf',
                    }],
                });
                envios++;
                personas += grupo.correos.length;
            } catch (e) {
                fallos.push(e.message);
                console.error(`[AI-PROG] programado ${prog.schedule_id}, envio a ${grupo.correos.length} correo(s):`, e.message);
            }
        }
    } finally {
        soltar();
    }

    if (fallos.length) {
        const cabeza = envios === 0
            ? 'FALLO: ningun envio salio'
            : `PARCIAL: ${envios} de ${grupos.length} envio(s) salieron (${personas} destinatario(s))`;
        return `${cabeza}, ${desde} a ${hasta}. ${fallos.join('; ')}`;
    }
    if (envios === 0) {
        return `Sin produccion entre ${desde} y ${hasta}: no se mando nada`;
    }
    return `OK: ${personas} destinatario(s) en ${envios} envio(s), ${desde} a ${hasta}`;
}

const PERIODICIDADES = ['diario', 'semanal', 'mensual'];

/**
 * Crea (o actualiza) un programado, saneando lo que llega.
 *
 * Vive aqui y no en el router porque tiene DOS puertas: el endpoint de
 * SuperAdmin y la tool del bot. Validar en dos sitios es tener dos validaciones,
 * y la segunda siempre se queda atras.
 *
 * Lanza con .status para que el router lo convierta en HTTP y la tool en texto.
 */
async function crearProgramado({ companyId, userId, periodicidad, hora, dia }) {
    const p = String(periodicidad || '').trim().toLowerCase();
    if (!PERIODICIDADES.includes(p)) {
        throw Object.assign(new Error(`"periodicidad" debe ser: ${PERIODICIDADES.join(', ')}`), { status: 400 });
    }

    // HH:MM, nada mas. Un "07:00:00'; DROP..." no llega a la consulta --va
    // parametrizado-- pero tampoco tiene por que llegar a la tabla.
    const h = String(hora || '07:00').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) {
        throw Object.assign(new Error('"hora" debe ser HH:MM en 24 horas'), { status: 400 });
    }

    let d = null;
    if (p === 'semanal') {
        d = Number(dia);
        if (!Number.isInteger(d) || d < 1 || d > 7) {
            throw Object.assign(new Error('"dia_semana" debe ser 1 (lunes) a 7 (domingo)'), { status: 400 });
        }
    }

    const proxima = await proximaEjecucion({ periodicidad: p, hora_local: h, dia_semana: d });

    const { rows } = await pool.query(`
        INSERT INTO mes_ai_report_schedules
               (company_id, created_by, periodicidad, hora_local, dia_semana, proxima_ejecucion)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (company_id, periodicidad) DO UPDATE
           SET created_by = EXCLUDED.created_by,
               hora_local = EXCLUDED.hora_local,
               dia_semana = EXCLUDED.dia_semana,
               proxima_ejecucion = EXCLUDED.proxima_ejecucion,
               enabled_flag = 'Y',
               updated_date = now()
        RETURNING schedule_id, periodicidad, hora_local, dia_semana, proxima_ejecucion`,
        [companyId, userId, p, h, d, proxima]);

    return rows[0];
}

/**
 * Una pasada: coge los que ya tocaban y los manda.
 *
 * Cada uno en su propia transaccion y con su propio try: si el de una compañia
 * revienta, los demas salen igual. Un programador que se para entero porque un
 * cliente tiene mal el correo no es un programador.
 */
async function ejecutarPendientes() {
    const cliente = await pool.connect();
    let pendientes = [];
    try {
        await cliente.query('BEGIN');
        // SKIP LOCKED: con dos instancias despiertas, cada programado se lo lleva
        // una sola. Sin esto, dos copias del mismo correo.
        const { rows } = await cliente.query(`
            SELECT * FROM mes_ai_report_schedules
             WHERE enabled_flag = 'Y' AND proxima_ejecucion <= now()
             ORDER BY proxima_ejecucion
             FOR UPDATE SKIP LOCKED
             LIMIT 20`);
        pendientes = rows;

        // La proxima se apunta ANTES de mandar y dentro de la misma transaccion.
        // Si el envio falla, no se reintenta en bucle cada cinco minutos: se
        // queda para la siguiente vuelta natural. Un fallo que se reintenta solo
        // deja de ser un fallo y pasa a ser una avalancha de correos.
        for (const p of pendientes) {
            await cliente.query(
                'UPDATE mes_ai_report_schedules SET proxima_ejecucion = $2, ultima_ejecucion = now() WHERE schedule_id = $1',
                [p.schedule_id, await proximaEjecucion(p)]
            );
        }
        await cliente.query('COMMIT');
    } catch (e) {
        await cliente.query('ROLLBACK').catch(() => {});
        console.error('[AI-PROG] no pude tomar los pendientes:', e.message);
        return { tomados: 0, enviados: 0 };
    } finally {
        cliente.release();
    }

    let enviados = 0;
    for (const p of pendientes) {
        let resultado;
        try {
            resultado = await enviarUno(p);
            if (resultado.startsWith('OK')) enviados++;
        } catch (e) {
            resultado = `FALLO: ${e.message}`;
            console.error(`[AI-PROG] programado ${p.schedule_id}:`, e.message);
        }
        await pool.query(
            'UPDATE mes_ai_report_schedules SET ultimo_resultado = $2, updated_date = now() WHERE schedule_id = $1',
            [p.schedule_id, resultado.slice(0, 500)]
        ).catch(() => {});
        console.log(`[AI-PROG] programado ${p.schedule_id} (compañia ${p.company_id}): ${resultado}`);
    }

    return { tomados: pendientes.length, enviados };
}

/**
 * Arranca el bucle. Idempotente: llamarlo dos veces no crea dos temporizadores.
 *
 * AVISO DE OPERACION: en el plan free de Render el servicio se duerme por
 * inactividad, y un proceso dormido no dispara nada. El reporte de las 7 de la
 * mañana sale a las 7 si hay alguien usando el sistema; si no, sale cuando
 * alguien lo despierte. Con el plan de pago esto deja de ser un problema. Vale
 * la pena decirlo antes de prometer un reporte semanal.
 */
function arrancar() {
    if (temporizador) return temporizador;
    if (process.env.AGENT_ENABLED !== 'true' || process.env.AI_SCHEDULER_ENABLED === 'false') {
        console.log('[AI-PROG] programador de reportes apagado');
        return null;
    }
    temporizador = setInterval(() => {
        ejecutarPendientes().catch((e) => console.error('[AI-PROG]', e.message));
    }, CADA_MS);
    // No retiene el proceso vivo: si el resto del servidor se apaga, esto no lo
    // impide.
    if (temporizador.unref) temporizador.unref();
    console.log(`[AI-PROG] programador de reportes cada ${Math.round(CADA_MS / 1000)} s`);
    return temporizador;
}

function parar() {
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
}

module.exports = { arrancar, parar, ejecutarPendientes, proximaEjecucion, periodoDe,
                   destinatarios, gruposDeDestinatarios, enviarUno, crearProgramado, PERIODICIDADES };
