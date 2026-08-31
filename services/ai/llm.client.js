/**
 * Cliente del LLM (ETAPA 3).
 *
 * Agnostico de proveedor: habla el formato OpenAI, que es lo que exponen Groq,
 * Ollama (local y Cloud) y OpenAI. Cambiar de proveedor es cambiar base_url,
 * model y llave -- que es justo lo que guarda la boveda por compañia.
 *
 * NO usa el SDK de OpenAI: es una dependencia nueva para un POST. fetch basta.
 */
const { redactar } = require('./credentials');
const { validarUrlDeProveedor } = require('./url-proveedor');

const TIEMPO_LIMITE_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);
// Tope de lectura del cuerpo. `respuesta.text()` bufferiza TODO lo que mande el
// proveedor -- y la URL del proveedor la configura el cliente: uno hostil o
// roto puede contestar 200 con gigas, que se cargarian enteros en memoria antes
// del slice() y tumbarian el proceso. 20 MB sobran para /chat/completions.
const CUERPO_MAX_BYTES = Number(process.env.LLM_MAX_BODY_BYTES || 20 * 1024 * 1024);

/** El cuerpo como texto, cortando la conexion si pasa del tope. */
async function leerCuerpoConTope(respuesta) {
    // Sin stream (el mock de las pruebas, o un cuerpo ya consumido): text().
    if (!respuesta.body || typeof respuesta.body.getReader !== 'function') {
        return respuesta.text();
    }
    const lector = respuesta.body.getReader();
    const trozos = [];
    let total = 0;
    for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        total += value.byteLength;
        if (total > CUERPO_MAX_BYTES) {
            lector.cancel().catch(() => {});
            throw falloDelProveedor('LLM_RARO',
                `El proveedor mando un cuerpo de mas de ${Math.round(CUERPO_MAX_BYTES / 1048576)} MB; se corto la lectura`);
        }
        trozos.push(value);
    }
    return Buffer.concat(trozos).toString('utf8');
}

/**
 * Lo que ve quien pregunta cuando el proveedor falla.
 *
 * Antes le llegaba el error crudo, tal cual:
 *
 *   El proveedor respondio 401: {"error":{"message":"Unauthorized",...}}
 *
 * No filtra la llave --redactar() se encarga-- pero un operador de planta no
 * tiene por que leer eso, y encima no le dice que hacer. El detalle va al log
 * del servidor, donde sirve; aqui va lo que se puede hacer al respecto.
 *
 * El `codigo` viaja en el JSON para que soporte sepa cual de los cinco fue sin
 * que el texto se lo tenga que decir al usuario.
 */
const MENSAJES = {
    LLM_AUTH:    'El asistente no esta configurado correctamente. Avisa a soporte.',
    LLM_CUPO:    'El asistente esta saturado. Intenta en unos segundos.',
    LLM_CAIDO:   'El asistente no esta disponible en este momento.',
    LLM_MUDO:    'El asistente no responde. Intenta de nuevo.',
    LLM_RARO:    'No pude responder. Intenta de nuevo.',
};

/**
 * Un fallo del proveedor: `message` es el detalle (va al log, ya redactado),
 * `publico` es lo que se le enseña a quien pregunta y `codigo` lo que se le
 * dice a soporte.
 *
 * 502 y no 500: el que fallo es el de arriba, no nosotros. El cliente ya trata
 * cualquier codigo que no sea 401/440 pintando `message`, asi que no hace falta
 * tocar la burbuja.
 */
function falloDelProveedor(codigo, detalle) {
    const e = new Error(redactar(detalle));
    e.codigo = codigo;
    e.publico = MENSAJES[codigo];
    e.status = 502;
    return e;
}

/**
 * Estados que significan "se acabo el tiempo", no "esta mal algo".
 *
 *   408  Request Timeout, del propio proveedor
 *   504  Gateway Timeout, de lo que tenga delante
 *   524  el timeout de Cloudflare, que es lo que hay delante de Groq y OpenAI
 *
 * Van aparte porque el 408 caia en el cajon de los 4xx y se le decia al usuario
 * que el asistente "no esta configurado correctamente": lo mandaba a llamar a
 * soporte cuando lo que tenia que hacer era volver a intentar.
 */
const ESTADOS_SIN_TIEMPO = new Set([408, 504, 524]);

/**
 * De lo que contesto el proveedor a uno de los cinco casos.
 *
 * El resto de 4xx que no sea 429 entra en LLM_AUTH y no en "error raro" a
 * proposito: un 400 por un modelo que no existe o un 404 por una base_url mal
 * escrita son lo mismo que un 401 desde donde lo mira el usuario -- esta mal
 * configurado y no es cosa suya.
 */
function porEstado(estado) {
    if (ESTADOS_SIN_TIEMPO.has(estado)) return 'LLM_MUDO';
    if (estado === 429) return 'LLM_CUPO';
    if (estado >= 500) return 'LLM_CAIDO';
    if (estado >= 400) return 'LLM_AUTH';
    return 'LLM_RARO';
}

/**
 * Una vuelta de conversacion. Devuelve el message tal cual lo manda el
 * proveedor, para que el bucle del agente decida si hay tool_calls o texto.
 */
async function chat({ baseUrl, apiKey, model, messages, tools, maxTokens, signal }) {
    const cuerpo = {
        model,
        messages,
        max_tokens: maxTokens || Number(process.env.LLM_MAX_OUTPUT_TOKENS || 1200),
        temperature: 0,          // esto contesta sobre datos, no escribe cuentos
    };
    if (tools && tools.length) {
        cuerpo.tools = tools;
        cuerpo.tool_choice = 'auto';
    }

    // Se revalida AQUI, no solo al guardar la credencial: una URL que apuntaba
    // a un host publico el mes pasado puede resolver hoy a la red interna sin
    // que nadie toque la configuracion.
    const { url } = await validarUrlDeProveedor(baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;

    // El tope de ESTA llamada y el del agente entero son dos cosas distintas y
    // tienen que valer las dos.
    //
    // Antes era `signal || AbortSignal.timeout(...)`, y como el agente pasa
    // SIEMPRE su corte de AGENT_MAX_SECONDS (agent.js:71) en cada vuelta, el
    // `||` nunca llegaba al segundo: LLM_TIMEOUT_MS era configuracion muerta en
    // el unico camino que la usa. Una sola llamada colgada se comia los 90 s del
    // agente en vez de cortarse a los 60 y dejar que el bucle reaccionara.
    //
    // AbortSignal.any aborta con el primero de los dos que salte.
    const propio = AbortSignal.timeout(TIEMPO_LIMITE_MS);
    const corte = signal ? AbortSignal.any([signal, propio]) : propio;

    let respuesta;
    try {
        respuesta = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(cuerpo),
            signal: corte,
            // Sin esto, validar la URL no sirve de nada: el proveedor contesta
            // un 302 hacia 169.254.169.254 y fetch lo sigue solito.
            redirect: 'error',
        });
    } catch (e) {
        // El error de fetch puede traer la peticion entera. redactar() antes de
        // que nadie lo vea -- y va al log, no a la pantalla.
        //
        // Agotar el tiempo no es lo mismo que no poder conectar: en el primer
        // caso el proveedor esta ahi y tarda, en el segundo no se llego. Se le
        // dicen cosas distintas porque tienen remedios distintos.
        const seAgotoElTiempo = e.name === 'TimeoutError' || e.name === 'AbortError';
        throw falloDelProveedor(
            seAgotoElTiempo ? 'LLM_MUDO' : 'LLM_CAIDO',
            `No se pudo hablar con el proveedor: ${e.message}`
        );
    }

    const texto = await leerCuerpoConTope(respuesta);
    if (!respuesta.ok) {
        throw falloDelProveedor(
            porEstado(respuesta.status),
            `El proveedor respondio ${respuesta.status}: ${texto.slice(0, 300)}`
        );
    }

    let json;
    try {
        json = JSON.parse(texto);
    } catch {
        throw falloDelProveedor('LLM_RARO', `El proveedor devolvio algo que no es JSON: ${texto.slice(0, 200)}`);
    }

    const eleccion = json.choices && json.choices[0];
    if (!eleccion) {
        throw falloDelProveedor('LLM_RARO', `El proveedor no devolvio ninguna respuesta: ${texto.slice(0, 200)}`);
    }

    return {
        message: eleccion.message || {},
        finishReason: eleccion.finish_reason,
        usage: json.usage || null,
    };
}

module.exports = { chat, MENSAJES, porEstado, TIEMPO_LIMITE_MS };
