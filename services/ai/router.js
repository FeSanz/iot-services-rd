/**
 * Router del bot IA: todo lo que vive bajo /api/ai/* -- el chat, el reporte en
 * PDF, los reportes programados y la boveda de llaves del LLM.
 *
 * Se monta con middleware/authenticateToken.js -- NO con
 * services/iot/authMiddleware.js, que es codigo muerto y trae un secreto de
 * respaldo hardcodeado ('mi_secreto_seguro'): sin JWT_SECRET aceptaria tokens
 * firmados con un secreto publico.
 */
const express = require('express');
const router = express.Router();
const authenticateToken = require('../../middleware/authenticateToken');
const pool = require('../../database/pool');
const { resolveScope, scopeDeCompania } = require('./scope');
const {
    PROVEEDORES,
    guardarCredencial,
    describirCredenciales,
    borrarCredencial,
    obtenerCredencialActiva,
    redactar,
} = require('./credentials');
const { conversar } = require('./agent');
const { datosDelReporte, dibujarReporte } = require('./reporte');
const { paletaDeCompania } = require('./portada');
const { redactarComentario } = require('./comentario');
const programador = require('./programador');
const { asistenteEncendido } = require('./interruptor');
const { fecha } = require('./tools');
const { registrarTurno } = require('./audit');
const { tomarLugar, soltarLugar } = require('./cupo');

// Configurar la llave del LLM es cosa de SuperAdmin. Admin administra su
// organizacion; la llave es de la compañia entera y se paga aparte.
const ROLES_QUE_CONFIGURAN = ['SuperAdmin'];

const envolver = (mensaje, items = null) => ({
    errorsExistFlag: false,
    message: mensaje,
    totalResults: Array.isArray(items) ? items.length : (items ? 1 : 0),
    items,
});

/**
 * Resuelve la compañia sobre la que se va a operar SIN confiar en la peticion.
 *
 * Sale del alcance del token. Si el usuario pertenece a una sola compañia, esa
 * es. Si pertenece a varias -- el esquema lo permite aunque hoy nadie lo haga --
 * hay que decir cual, y se COMPRUEBA que este en el alcance; no se acepta.
 */
function companiaDeLaPeticion(scope, companyIdPedida) {
    if (companyIdPedida === undefined || companyIdPedida === null || companyIdPedida === '') {
        if (scope.companyIds.length === 1) return scope.companyIds[0];
        throw Object.assign(
            new Error('El usuario pertenece a varias compañias: indica company_id'),
            { status: 409 }
        );
    }
    const pedida = Number(companyIdPedida);
    if (!scope.companyIds.includes(pedida)) {
        // Mismo mensaje que si no existiera: no se confirma la existencia de
        // compañias ajenas.
        throw Object.assign(new Error('Compañia fuera de alcance'), { status: 403 });
    }
    return pedida;
}

async function contexto(req, { exigirSuperAdmin = true } = {}) {
    // resolveScope lanza si el usuario no existe, esta deshabilitado o no tiene
    // organizaciones. Los tres son 403, no 500: el token es valido, lo que no
    // hay es a que darle acceso.
    //
    // Aqui cae, por ejemplo, el token de POST /api/getToken, que reparte un JWT
    // de SuperAdmin con user_id 0 sin pedir credenciales (hallazgo previo, ver
    // NOTA-AISLAMIENTO-MULTIEMPRESA.md). Ese usuario no existe en mes_users,
    // asi que el bot no le da una sola fila.
    let scope;
    try {
        scope = await resolveScope(req.user.user_id);
    } catch (e) {
        throw Object.assign(e, { status: e.status || 403 });
    }
    // Generico a proposito: `contexto()` la usan la llave del LLM Y los reportes
    // programados. Con el texto de la llave cableado, pedir un programado siendo
    // Viewer contestaba "Solo un SuperAdmin puede configurar la llave del LLM",
    // que habla de otra cosa y manda a buscar donde no es.
    if (exigirSuperAdmin && !ROLES_QUE_CONFIGURAN.includes(scope.role)) {
        throw Object.assign(
            new Error('Solo un SuperAdmin puede hacer esta configuracion'),
            { status: 403 }
        );
    }
    return scope;
}

/**
 * Un error a la respuesta HTTP.
 *
 * Dos publicos distintos y dos textos distintos. Los errores que traen
 * `publico` --hoy los del proveedor del LLM, ver llm.client.js-- llevan el
 * detalle en `message` para el log y el mensaje legible en `publico`. Antes se
 * mandaba `message` siempre, y al usuario le llegaba tal cual:
 *
 *   El proveedor respondio 401: {"error":{"message":"Unauthorized",...}}
 *
 * El resto de errores de este router ya nacen redactados para leerse ("Compañia
 * fuera de alcance", "El asistente no esta habilitado..."), asi que esos siguen
 * yendo tal cual.
 */
function responderError(res, e, donde) {
    const status = e.status || 500;
    const detalle = redactar(e.message);

    // redactar() antes de cualquier log: si el error trae el cuerpo de la
    // peticion, ahi viene la llave.
    //
    // Los que traen `publico` se registran SIEMPRE, aunque no sean 5xx: un 502
    // del proveedor es justo lo que soporte necesita ver, y si solo se guardara
    // el mensaje al usuario --"avisa a soporte"-- soporte no tendria nada que
    // mirar.
    if (status >= 500 || e.publico) console.error(`[AI] ${donde} (${e.codigo || status}):`, detalle);

    res.status(status).json({
        errorsExistFlag: true,
        message: e.publico || detalle,
        ...(e.codigo ? { codigo: e.codigo } : {}),
    });
}

// --- guardar o rotar la llave ----------------------------------------------
// SIEMPRE POST y la llave en el BODY: en un query string quedaria en los logs
// de acceso, en el historial del navegador y en los proxies.
router.post('/ai/credentials', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req);
        const companyId = companiaDeLaPeticion(scope, req.body.company_id);
        const guardada = await guardarCredencial({
            companyId,
            provider: req.body.provider,
            apiKey: req.body.api_key,
            model: req.body.model,
            baseUrl: req.body.base_url,
            userId: scope.userId,
        });
        res.status(200).json(envolver('Llave guardada', guardada));
    } catch (e) {
        responderError(res, e, 'POST /ai/credentials');
    }
});

// --- que hay configurado ----------------------------------------------------
// Devuelve last4 y nada mas. Ni al SuperAdmin se le regresa la llave: si la
// perdio, la rota.
router.get('/ai/credentials', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req);
        const companyId = companiaDeLaPeticion(scope, req.query.company_id);
        const items = await describirCredenciales(companyId);
        res.status(200).json(envolver(items.length ? 'OK' : 'Sin llave configurada', items));
    } catch (e) {
        responderError(res, e, 'GET /ai/credentials');
    }
});

// --- proveedores soportados -------------------------------------------------
router.get('/ai/providers', authenticateToken, (req, res) => {
    const items = Object.entries(PROVEEDORES).map(([provider, p]) => ({
        provider,
        requiere_llave: p.requiereLlave,
        prefijo: p.prefijo || null,
    }));
    res.status(200).json(envolver('OK', items));
});

// --- ¿hay que dibujar el boton? ---------------------------------------------
//
// El cliente ya sabe leer AI_FLAG, pero de userData.Company.Settings, que solo
// se llena AL INICIAR SESION: encender el bot en una compañia obligaba a todos
// sus usuarios a volver a entrar para que les apareciera la burbuja. El
// servidor lo aplica al instante; el cliente tardaba un login.
//
// Esto NO da permiso, dice si pintar un boton. El interruptor que manda se
// consulta en cada turno dentro de /ai/chat: esconder el boton no apaga nada,
// quien tenga el token puede llamar al endpoint con curl.
//
// No pasa por companiaDeLaPeticion a proposito: con dos compañias esa lanza 409
// pidiendo company_id, y para pintar un boton un 409 no es una respuesta. Si
// alguna de las suyas lo tiene encendido, se dibuja -- el chat ya recorta por
// compañia y ya sabe decir que no.
//
// Y mira tambien AGENT_ENABLED: con el agente apagado en la instancia, el boton
// estaba ahi y cada pregunta se iba en 503. Un boton que no puede funcionar no
// tiene por que estar.
router.get('/ai/enabled', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req, { exigirSuperAdmin: false });
        const encendidas = await Promise.all(
            scope.companyIds.map((id) => asistenteEncendido(id))
        );
        res.status(200).json(envolver('OK', {
            enabled: process.env.AGENT_ENABLED === 'true' && encendidas.some(Boolean),
        }));
    } catch (e) {
        responderError(res, e, 'GET /ai/enabled');
    }
});

// --- borrar -----------------------------------------------------------------
router.delete('/ai/credentials/:provider', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req);
        const companyId = companiaDeLaPeticion(scope, req.query.company_id);
        const borrada = await borrarCredencial(companyId, req.params.provider);
        res.status(borrada ? 200 : 404).json(
            borrada
                ? envolver('Llave borrada')
                : { errorsExistFlag: true, message: 'No habia llave para ese proveedor' }
        );
    } catch (e) {
        responderError(res, e, 'DELETE /ai/credentials');
    }
});

// --- cuantas conversaciones a la vez ----------------------------------------
//
// NO es un rate limit por consumo: la llave es de cada cliente y el gasto de
// tokens es suyo. Esto protege OTRA cosa -- la instancia. Cada turno son hasta
// 10 idas y vueltas al LLM con varias consultas SQL cada una, y el plan de
// Render no da para veinte de esas al mismo tiempo.
//
// El cupo de la instancia vive en cupo.js: lo comparten este router y el
// programador de reportes, que tambien consume la maquina. Ver el comentario
// de ese archivo.

// El historial lo manda el cliente y va derechito al proveedor del LLM. Se
// limitaba el numero de turnos (10) pero no su tamaño: diez mensajes de un mega
// cada uno pasaban enteros. Se corta cada uno al mismo tope que la pregunta.
//
// Tambien se queda solo con {role, content}: el resto de lo que traiga el
// cuerpo no tiene por que llegar al proveedor.
const TOPE_MENSAJE = 2000;

function sanearHistorial(history) {
    if (!Array.isArray(history)) return [];
    return history
        .slice(-10)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, TOPE_MENSAJE) }));
}

// --- el chat ----------------------------------------------------------------
// Cualquier usuario con organizaciones puede preguntar; ve lo suyo y nada mas.
router.post('/ai/chat', authenticateToken, async (req, res) => {
    const empezo = Date.now();
    try {
        if (process.env.AGENT_ENABLED !== 'true') {
            throw Object.assign(new Error('El asistente esta apagado (AGENT_ENABLED)'), { status: 503 });
        }
        const pregunta = typeof req.body.message === 'string' ? req.body.message.trim() : '';
        if (!pregunta) {
            throw Object.assign(new Error('Falta "message" en el cuerpo'), { status: 400 });
        }
        if (pregunta.length > 2000) {
            throw Object.assign(new Error('La pregunta es demasiado larga'), { status: 400 });
        }

        const scope = await contexto(req, { exigirSuperAdmin: false });
        const companyId = companiaDeLaPeticion(scope, req.body.company_id);

        // Antes de buscar la credencial: si el asistente esta apagado para esta
        // compañia, el motivo es ese y no "falta configurar la llave".
        if (!(await asistenteEncendido(companyId))) {
            throw Object.assign(
                new Error('El asistente no esta habilitado para tu compañia.'),
                { status: 403 }
            );
        }

        const credencial = await obtenerCredencialActiva(companyId);

        tomarLugar(companyId);
        let r;
        try {
            r = await conversar({
                // Recortado a la compañia elegida, no el alcance completo: un
                // usuario de dos compañias veria las cifras de las dos sumadas
                // mientras la llave del LLM es de una sola.
                scope: scopeDeCompania(scope, companyId),
                credencial,
                historial: sanearHistorial(req.body.history),
                pregunta,
            });
        } finally {
            // En finally: si el LLM revienta a media conversacion, el lugar se
            // devuelve igual. Un contador que solo baja cuando todo sale bien
            // acaba en cero lugares libres y nadie sabe por que.
            soltarLugar(companyId);
        }

        await registrarTurno({
            userId: scope.userId,
            companyId,
            pregunta,
            respuesta: r.texto,
            herramientas: r.herramientasUsadas,
            tokens: r.tokens,
            ms: Date.now() - empezo,
        });

        res.status(200).json(envolver('OK', {
            reply: r.texto,
            // Las pinta el cliente con ApexCharts, que el MES ya trae.
            charts: r.graficas || [],
            // El periodo, no el archivo: el cliente pide GET /ai/reporte con el.
            report: r.reporte || null,
            tools_used: r.herramientasUsadas.map((h) => h.nombre),
            elapsed_ms: Date.now() - empezo,
        }));
    } catch (e) {
        responderError(res, e, 'POST /ai/chat');
    }
});

// --- el reporte en PDF (ETAPA 5) --------------------------------------------
//
// GET y no POST porque el navegador tiene que poder pedirlo como un archivo, y
// porque no crea nada: dos peticiones iguales dan el mismo PDF.
//
// El alcance sale del token, igual que en el chat. Las fechas se sanean con la
// MISMA funcion que las tools -- si aqui se colara un "2026-02-31", la consulta
// reventaria con un error que el usuario recibe como un PDF corrupto.
router.get('/ai/reporte', authenticateToken, async (req, res) => {
    try {
        if (process.env.AGENT_ENABLED !== 'true') {
            throw Object.assign(new Error('El asistente esta apagado (AGENT_ENABLED)'), { status: 503 });
        }

        const scope = await contexto(req, { exigirSuperAdmin: false });
        const companyId = companiaDeLaPeticion(scope, req.query.company_id);
        if (!(await asistenteEncendido(companyId))) {
            throw Object.assign(new Error('El asistente no esta habilitado para tu compañia.'), { status: 403 });
        }

        const desde = fecha(req.query.desde);
        const hasta = fecha(req.query.hasta);
        if (!desde || !hasta) {
            throw Object.assign(new Error('Faltan "desde" y "hasta" en formato AAAA-MM-DD'), { status: 400 });
        }
        if (desde > hasta) {
            throw Object.assign(new Error('"desde" es posterior a "hasta"'), { status: 400 });
        }

        const empresa = (await pool.query(
            'SELECT name FROM mes_companies WHERE company_id = $1', [companyId]
        )).rows[0]?.name || `Compañia ${companyId}`;

        // Recortado a la compañia cuyo nombre va en la cabecera del PDF.
        const alcance = scopeDeCompania(scope, companyId);

        // El mismo cupo que el chat, y por el mismo motivo: cada reporte son
        // cinco consultas agregadas sobre vistas grandes. El chat estaba
        // protegido y esta puerta no, asi que bastaba con pulsar "descargar"
        // veinte veces para hacerle al servidor lo que el cupo del chat impide.
        //
        // Comparten contador a proposito: lo que hay que proteger es la
        // instancia, y a la instancia le da igual por que puerta entro la carga.
        tomarLugar(companyId);
        let datos;
        let comentario;
        try {
            datos = await datosDelReporte(alcance, desde, hasta);

            // La narrativa va DENTRO del cupo. Estaba fuera y era un agujero
            // recien abierto: hoy la parte cara de un reporte no son las cinco
            // consultas, es la llamada al LLM, y dejarla fuera del contador es
            // volver a tener una puerta sin proteger -- justo lo que cupo.js
            // vino a arreglar para el programador.
            //
            // Sin credencial --una compañia a la que no le han configurado la
            // llave-- no se intenta nada: redactarComentario devuelve la estatica.
            const credencial = await obtenerCredencialActiva(companyId).catch(() => null);
            comentario = await redactarComentario({ empresa, desde, hasta, datos, credencial });
        } finally {
            // Se suelta en cuanto termina el trabajo que pesa. Dibujar el PDF no
            // toca la base ni al proveedor, y dejar el lugar tomado mientras se
            // escriben unos kilobytes en el socket es cobrarle al siguiente el
            // tiempo de red de este.
            soltarLugar(companyId);
        }

        // TODO lo que puede fallar va ANTES de las cabeceras -- la bitacora
        // incluida. Una vez escrito `Content-Type: application/pdf` ya no hay
        // marcha atras: el catch de abajo contestaria un JSON dentro de una
        // respuesta anunciada como PDF y el navegador se traga un archivo roto
        // con nombre de reporte. Es la razon por la que las consultas van antes,
        // y por la que la narrativa y el registro tienen que ir antes tambien.
        const paleta = await paletaDeCompania(companyId);
        if (comentario.deLaIA) {
            await registrarTurno({
                userId: scope.userId,
                companyId,
                pregunta: `(narrativa del reporte ${desde} a ${hasta})`,
                respuesta: comentario.resumen,
                herramientas: [],
                tokens: comentario.tokens,
                ms: comentario.ms,
            });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition',
            `attachment; filename="reporte-produccion-${desde}-a-${hasta}.pdf"`);
        dibujarReporte(res, {
            empresa,
            desde,
            hasta,
            datos,
            comentario,
            paleta,
            generadoPor: `usuario ${scope.userId}`,
        }).on('error', (e) => {
            // La oreja en el DOCUMENTO, como en pdfEnMemoria: pipe no propaga
            // los errores del origen, y un 'error' sin oyente tumba el proceso.
            // Aqui ya salieron bytes; solo queda registrar y cortar el socket
            // para que el cliente no espere un PDF que no va a terminar.
            console.error('[AI] GET /ai/reporte: error asincrono del PDF:', redactar(e.message));
            res.destroy();
        });
    } catch (e) {
        // Si el PDF ya empezo a salir no hay JSON que valga: dibujarReporte
        // cerro el flujo (truncado) y aqui solo queda el log. Y si NO salio ni
        // un byte, fuera las cabeceras de PDF antes de contestar el error --
        // sin esto, el JSON se descargaba como un archivo .pdf roto.
        if (res.headersSent) {
            console.error('[AI] GET /ai/reporte: fallo con el PDF ya empezado:', redactar(e.message));
            return;
        }
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Disposition');
        responderError(res, e, 'GET /ai/reporte');
    }
});

// --- reportes programados por correo ----------------------------------------
//
// Configurarlos es cosa de SuperAdmin, igual que la llave del LLM: decide que se
// manda, cada cuanto y --por consecuencia-- a quien, porque los destinatarios
// son los usuarios de la compañia.
//
// Tambien se puede desde el chat: programar_reporte (tools.js), la UNICA tool
// que escribe. Comparte crearProgramado con este endpoint -- mismo saneo, mismo
// camino -- y va con sus cuatro cierres: solo SuperAdmin con el rol leido de la
// base, la compañia sale del alcance, NO se puede elegir destinatario, y
// escribe por el pool de la aplicacion (el rol del bot sigue sin poder).
router.post('/ai/schedules', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req);
        const companyId = companiaDeLaPeticion(scope, req.body.company_id);
        // El saneo y el INSERT viven en programador.crearProgramado, que es el
        // mismo camino que usa la tool del bot. Dos validaciones para una tabla
        // es tener una validacion y una copia que se queda atras.
        const fila = await programador.crearProgramado({
            companyId,
            userId: scope.userId,
            periodicidad: req.body.periodicidad,
            hora: req.body.hora_local,
            dia: req.body.dia_semana,
        });
        res.status(200).json(envolver('Reporte programado', fila));
    } catch (e) {
        responderError(res, e, 'POST /ai/schedules');
    }
});

router.get('/ai/schedules', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req);
        const companyId = companiaDeLaPeticion(scope, req.query.company_id);
        const { rows } = await pool.query(`
            SELECT schedule_id, periodicidad, hora_local, dia_semana, enabled_flag,
                   proxima_ejecucion, ultima_ejecucion, ultimo_resultado
              FROM mes_ai_report_schedules
             WHERE company_id = $1
             ORDER BY periodicidad`, [companyId]);
        res.status(200).json(envolver('OK', rows));
    } catch (e) {
        responderError(res, e, 'GET /ai/schedules');
    }
});

router.delete('/ai/schedules/:id', authenticateToken, async (req, res) => {
    try {
        const scope = await contexto(req);
        const companyId = companiaDeLaPeticion(scope, req.query.company_id);
        // El company_id va en el WHERE, no solo en la comprobacion: asi el id de
        // otra compañia no borra nada aunque alguien lo adivine.
        const { rowCount } = await pool.query(
            'DELETE FROM mes_ai_report_schedules WHERE schedule_id = $1 AND company_id = $2',
            [Number(req.params.id), companyId]);
        if (rowCount === 0) {
            throw Object.assign(new Error('Ese reporte programado no existe'), { status: 404 });
        }
        res.status(200).json(envolver('Reporte programado eliminado', null));
    } catch (e) {
        responderError(res, e, 'DELETE /ai/schedules');
    }
});

// Se arranca al montar el router, que es cuando ya hay servidor. En index.js
// solo hay una linea nuestra y se queda asi.
programador.arrancar();

module.exports = router;
// Se exporta para poder probar el saneo sin levantar el servidor: desde fuera
// el recorte del historial no se puede observar, y una prueba que no observa lo
// que dice probar no prueba nada.
module.exports.sanearHistorial = sanearHistorial;
// Igual: desde fuera no se puede provocar un fallo del proveedor sin una
// credencial mala de verdad y una llamada a internet, y una prueba que necesita
// las dos cosas no se corre. Lo que hay que comprobar --que el detalle se queda
// en el log y al usuario le llega el mensaje-- se ve aqui.
module.exports.responderError = responderError;
