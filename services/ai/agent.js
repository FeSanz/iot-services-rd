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

const MAX_VUELTAS = Number(process.env.AGENT_MAX_LOOPS || 10);
const MAX_SEGUNDOS = Number(process.env.AGENT_MAX_SECONDS || 90);

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

        const llamadas = message.tool_calls || [];
        if (llamadas.length === 0) {
            return { texto: message.content || '', herramientasUsadas, graficas: graficas(), reporte, tokens, vueltas: vuelta };
        }

        // El historial necesita el turno del asistente con sus tool_calls, o el
        // proveedor rechaza los mensajes role:'tool' que vienen despues.
        mensajes.push(message);

        for (const llamada of llamadas) {
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
