/**
 * El bucle del agente (ETAPA 3).
 *
 * Tool-calling a mano, sin LangChain: los dos agentes que ya existen en la casa
 * lo hacen asi y funciona. Una dependencia menos que auditar.
 *
 * Donde vive cada guardrail (plan 3.4). De adentro hacia afuera:
 *   1. El rol de Postgres solo tiene SELECT sobre 8 vistas   -> database/poolReadonly.js
 *   2. El alcance se inyecta desde el token                  -> scope.js
 *   3. Ningun esquema de tool nombra organization_id         -> tools.js
 *   4. Todo argumento del modelo se sanea                    -> tools.js
 *   5. El system prompt                                      -> aqui
 *
 * La capa 5 NO carga nada de seguridad. Escribir "no muestres datos de otras
 * compañias" en el prompt no es un guardrail, es una sugerencia educada que
 * cualquier inyeccion tumba. Aqui solo va tono y honestidad.
 */
const llm = require('./llm.client');
const domain = require('./domain');
const { esquemasParaElModelo, ejecutarTool } = require('./tools');
const { cifrasSinRespaldo } = require('./respaldo');

const MAX_VUELTAS = Number(process.env.AGENT_MAX_LOOPS || 10);
const MAX_SEGUNDOS = Number(process.env.AGENT_MAX_SECONDS || 90);
// Cuantas tool_calls por VUELTA. El numero lo decide el proveedor, no este
// codigo, y la URL del proveedor la configura el cliente: uno hostil o roto
// puede mandar miles en un solo turno, y MAX_VUELTAS no acota eso. Un modelo
// de verdad rara vez pasa de cinco.
const MAX_TOOLS_POR_VUELTA = Number(process.env.AGENT_MAX_TOOLS_PER_TURN || 20);
// El guardia de cifras: 'corrige' para que pida una correccion y avise al
// usuario; cualquier otra cosa deja el aviso solo en el log. Ver mas abajo.
const CORRIGE = process.env.AI_GUARDIA_CIFRAS === 'corrige';

function systemPrompt(ahora = new Date()) {
    // La fecha va en el prompt porque el modelo NO la sabe: preguntando por una
    // tendencia se invento el rango "2024-07-01 a 2024-08-21", dos años atras.
    //
    // Y va en hora de la PLANTA, no en UTC. Se calculaba con toISOString(), que
    // es UTC: de las 18:00 en adelante --hora de Mexico-- el prompt le decia al
    // modelo que hoy era mañana, y con eso "hoy", "ayer" y "este mes" se
    // resolvian sobre el dia equivocado. El ultimo dia del mes, "este mes" se
    // iba al siguiente. La linea de abajo dice "la zona es America/Mexico_City"
    // mientras la de arriba la ignoraba.
    //
    // `ahora` es parametro para poder probarlo con un instante fijo; es el mismo
    // recurso que usa periodoDe() en programador.js, y por el mismo motivo.
    const hoy = domain.hoyEnLaPlanta(ahora);
    return `Hoy es ${hoy}. La zona horaria de las plantas es ${domain.ZONA}.

Eres el asistente de Condor MES, un sistema de manufactura. Contestas
preguntas sobre produccion, ordenes de trabajo, paros de maquina y sensores.

COMO TRABAJAS:
- Contestas SOLO con lo que devuelven las herramientas. Si no llamaste a
  ninguna, no tienes datos: llama a una.
- Si una herramienta devuelve cero filas, dilo. No rellenes con suposiciones ni
  con ejemplos.
- Si te preguntan algo que ninguna herramienta cubre, dilo en una linea y di que
  si puedes contestar.
- NUNCA digas que una herramienta no existe, o que no acepta un parametro, sin
  haberla llamado. La lista que tienes es la real y esta completa. Ante la duda,
  llamala: si el parametro no vale, la herramienta te lo dira. Que en este mismo
  turno hayas contestado "no tengo eso" a otra pregunta no significa nada para
  la siguiente.
- Nunca inventes numeros. Ni uno.
- Si el resultado de una herramienta trae un campo "nota", hazle caso: es una
  instruccion para TI, no un adorno. Si la nota dice que vuelvas a llamar a la
  herramienta con otras fechas, llamala tu ANTES de contestar. No le pidas al
  usuario que te lo vuelva a preguntar.
- Si trae "periodo_real_cubierto", di de que fechas son las cifras.
- Para decir CUANTOS hay, usa "total_encontrado". NUNCA cuentes las filas: la
  lista viene recortada. Si "hay_mas" es true, las filas son una muestra --
  dilo, y da el total.
- Los datos de esta base pueden no llegar hasta hoy. Cuando des cifras de un
  periodo, di de que fechas son en realidad.

COMO CONTESTAS:
- En español, corto y directo. Sin preambulos.
- Cifras en tablas cuando sean mas de tres.
- Nada de disculpas ni de "como asistente de IA".

${domain.comoTexto()}`;
}

/**
 * Una conversacion completa: manda, deja que el modelo pida herramientas, y
 * devuelve la respuesta final.
 *
 * @param {object}   scope       el de resolveScope(): de donde sale el aislamiento
 * @param {object}   credencial  { baseUrl, apiKey, model } de la boveda
 * @param {Array}    historial   turnos previos [{role, content}]
 * @param {string}   pregunta    lo que acaba de escribir el usuario
 */
async function conversar({ scope, credencial, historial = [], pregunta }) {
    const limite = AbortSignal.timeout(MAX_SEGUNDOS * 1000);
    const ctx = { scope };
    const herramientasUsadas = [];
    // Las graficas que van pintadas junto a la respuesta. No pasan por el
    // modelo: las arma la tool con los datos que acaba de leer.
    //
    // Un Map por titulo, no una lista: el modelo llama dos veces a la misma
    // herramienta mas seguido de lo que parece -- primero sin fechas y luego con
    // ellas. Se queda la ULTIMA, que es la que describe su respuesta. Con dos
    // graficas iguales del mismo sensor, el usuario no sabe cual esta leyendo.
    const porTitulo = new Map();
    const graficas = () => [...porTitulo.values()];
    // El ultimo reporte pedido en el turno. Uno solo: dos botones de descarga en
    // la misma respuesta y nadie sabe cual baja que.
    let reporte = null;
    let tokens = { prompt: 0, completion: 0 };
    // Lo que devolvieron las herramientas en este turno: es el unico respaldo
    // valido para las cifras de la respuesta final.
    const salidas = [];
    let corregido = false;

    const mensajes = [
        { role: 'system', content: systemPrompt() },
        ...historial.filter((m) => m.role === 'user' || m.role === 'assistant'),
        { role: 'user', content: pregunta },
    ];

    for (let vuelta = 1; vuelta <= MAX_VUELTAS; vuelta++) {
        if (limite.aborted) {
            return { texto: `Me pase de los ${MAX_SEGUNDOS} segundos y corte la busqueda.`, herramientasUsadas, graficas: graficas(), reporte, tokens, agotado: true };
        }

        const { message, usage } = await llm.chat({
            baseUrl: credencial.baseUrl,
            apiKey: credencial.apiKey,
            model: credencial.model,
            messages: mensajes,
            tools: esquemasParaElModelo(),
            signal: limite,
        });

        if (usage) {
            tokens = {
                prompt: tokens.prompt + (usage.prompt_tokens || 0),
                completion: tokens.completion + (usage.completion_tokens || 0),
            };
        }

        let llamadas = message.tool_calls || [];
        if (llamadas.length === 0) {
            const texto = message.content || '';

            // El guardia de cifras. El modelo ya contesto; antes de darlo por
            // bueno se comprueba que cada numero de la respuesta salga de lo que
            // devolvieron las herramientas -- ver respaldo.js para el fallo que
            // lo trajo aqui (conto filas y las llamo "ordenes").
            const sueltas = cifrasSinRespaldo(texto, salidas);

            // POR QUE ESTO NO CORRIGE POR OMISION. Medido contra el modelo real
            // con seis preguntas normales: la comprobacion marco cinco. Dos
            // motivos, y solo uno era arreglable -- las fechas abreviadas, ya
            // corregidas en respaldo.js. El otro no lo es: el modelo suma dos
            // resultados ("86 + 33 = 119 ordenes") y eso es correcto, pero
            // admitir sumas entre cifras sueltas tambien admitiria el 6 del
            // fallo original (1 + 5 de la misma tabla). O marca de mas, o deja
            // pasar justo lo que vino a cazar.
            //
            // Asi que por omision AVISA EN EL LOG y no toca la respuesta del
            // usuario. Con AI_GUARDIA_CIFRAS=corrige pide una correccion y, si
            // el modelo insiste, entrega la respuesta con el aviso a la vista.
            // ponytail: la medicion esta en la bitacora; si el ruido baja lo
            // suficiente, el modo `corrige` pasa a ser el de fabrica.
            if (sueltas.length && !CORRIGE) {
                console.warn(`[AI] cifras sin respaldo en la respuesta: ${sueltas.join(', ')}`
                    + ` | tools: ${herramientasUsadas.map((h) => h.nombre).join(',') || '(ninguna)'}`);
                return {
                    texto, herramientasUsadas, graficas: graficas(), reporte, tokens,
                    vueltas: vuelta, cifrasSinRespaldo: sueltas,
                };
            }

            // Una sola correccion. Si a la segunda sigue sin respaldo, se
            // entrega igual: callar la respuesta seria peor que entregarla con
            // el aviso, y reintentar en bucle es pagar el turno tres veces.
            if (sueltas.length && !corregido) {
                corregido = true;
                mensajes.push(message);
                mensajes.push({
                    role: 'user',
                    content: `Estas cifras de tu respuesta no salen de ninguna herramienta: `
                        + `${sueltas.join(', ')}. No cuentes filas de un resultado para presentarlas `
                        + `como otra metrica. Llama a la herramienta que da esos datos y corrige la `
                        + `respuesta; si no hay herramienta para eso, dilo y no des la cifra.`,
                });
                continue;
            }

            return {
                texto: sueltas.length ? `${texto}\n\n_(No pude respaldar con los datos consultados: `
                                        + `${sueltas.join(', ')}. Tomalas con reserva.)_`
                                      : texto,
                herramientasUsadas,
                graficas: graficas(),
                reporte,
                tokens,
                vueltas: vuelta,
                cifrasSinRespaldo: sueltas,
            };
        }
        if (llamadas.length > MAX_TOOLS_POR_VUELTA) {
            console.warn(`[AI] el proveedor pidio ${llamadas.length} tools en una vuelta; recortado a ${MAX_TOOLS_POR_VUELTA}`);
            // Se recorta TAMBIEN en el mensaje que va al historial: el proveedor
            // exige un role:'tool' por cada tool_call que anuncio el asistente.
            llamadas = llamadas.slice(0, MAX_TOOLS_POR_VUELTA);
            message.tool_calls = llamadas;
        }

        // El historial necesita el turno del asistente con sus tool_calls, o el
        // proveedor rechaza los mensajes role:'tool' que vienen despues.
        mensajes.push(message);

        for (const llamada of llamadas) {
            // El reloj tambien DENTRO de la vuelta: las tools son consultas de
            // hasta 15 s cada una, y mirar la hora solo entre vueltas dejaba
            // ejecutar la lista entera con el tiempo ya vencido.
            if (limite.aborted) break;
            const nombre = llamada.function?.name;
            const argumentos = llamada.function?.arguments;
            const resultado = await ejecutarTool(nombre, argumentos, ctx);
            herramientasUsadas.push({ nombre, argumentos, error: resultado?.error });

            // La grafica se aparta ANTES de devolverle el resultado al modelo:
            // son los mismos numeros que ya lleva en el cuerpo del resultado, y
            // mandarselos dos veces es pagar el doble de tokens por nada.
            let paraElModelo = resultado;
            if (resultado && resultado.reporte) {
                const { reporte: r, ...resto } = resultado;
                reporte = r;
                paraElModelo = resto;
            }
            if (resultado && resultado.grafica) {
                const { grafica, ...resto } = paraElModelo;
                porTitulo.set(grafica.titulo, grafica);
                // En su lugar va un aviso, no un hueco. El modelo tiene que
                // SABER que la grafica esta puesta: la primera version se la
                // quitaba en silencio y contestaba volcando los 30 puntos en una
                // tabla debajo del dibujo que ya los mostraba.
                paraElModelo = {
                    ...resto,
                    grafica_adjunta:
                        'Al usuario ya se le esta mostrando una grafica con estos datos. ' +
                        'NO los repitas en una tabla ni los enumeres: describe en dos o tres ' +
                        'frases lo que se ve -- tendencia, maximo, minimo y periodo.',
                };
            }

            salidas.push(paraElModelo);
            mensajes.push({
                role: 'tool',
                tool_call_id: llamada.id,
                content: JSON.stringify(paraElModelo),
            });
        }
    }

    return {
        texto: `Le di ${MAX_VUELTAS} vueltas y no llegue a una respuesta. Prueba con una pregunta mas concreta.`,
        herramientasUsadas,
        graficas: graficas(),
        reporte,
        tokens,
        agotado: true,
    };
}

module.exports = { conversar, systemPrompt, MAX_VUELTAS, MAX_SEGUNDOS };
