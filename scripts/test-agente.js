#!/usr/bin/env node
/**
 * Pruebas del agente (ETAPA 3).
 *
 *   node --env-file=../.env scripts/test-agente.js
 *
 * NO necesita el backend arriba ni gasta una sola llamada al LLM: el bucle se
 * prueba con un modelo de mentiras. Es a proposito -- una prueba que depende de
 * la red y de lo que se le ocurra contestar a un modelo no es una prueba.
 *
 * La prueba de aislamiento del plan (1.5) se hace AQUI, en la capa de tools, no
 * preguntandole al bot. Que el modelo se niegue a contestar no demuestra nada:
 * lo que hay que demostrar es que aunque llame a la herramienta con la
 * organizacion ajena escrita a mano, salen CERO FILAS.
 */
const assert = require('assert');
const pool = require('../database/pool');
const poolReadonly = require('../database/poolReadonly');
const { resolveScope, scopeDeCompania } = require('../services/ai/scope');
const { TOOLS, esquemasParaElModelo, ejecutarTool, enumerado, entero, fecha } = require('../services/ai/tools');
const { datosDelReporte, dibujarReporte } = require('../services/ai/reporte');
const { paletaDe, PALETA_BASE } = require('../services/ai/portada');
const { redactarComentario, redaccionEstatica, cifras, partir,
        cifrasEnElTexto } = require('../services/ai/comentario');
const cupo = require('../services/ai/cupo');
const jwt = require('jsonwebtoken');
const llm = require('../services/ai/llm.client');
const { conversar, systemPrompt } = require('../services/ai/agent');

async function main() {
    let ok = 0;
    const paso = (t) => { ok++; console.log('  ok  ', t); };

    const deSpace = await resolveScope(8);   // Admin, orgs {2,4}, compañia 1
    const deAO    = await resolveScope(5);   // SuperAdmin, org {6}, compañia 3

    // --- 1. ningun esquema deja nombrar la organizacion ---------------------
    const esquemas = JSON.stringify(esquemasParaElModelo());
    for (const prohibido of ['organization_id', 'company_id', 'organizations', 'user_id']) {
        assert.ok(!esquemas.includes(prohibido), `el esquema de tools menciona ${prohibido}`);
    }
    paso(`los ${Object.keys(TOOLS).length} esquemas no nombran organization_id ni company_id`);

    // --- 2. LA PRUEBA DEL PLAN, en la capa de tools -------------------------
    // Se le pasan a mano los argumentos que un modelo secuestrado intentaria.
    const inyeccion = { organization_id: 2, company_id: 1, organizations: [2, 4], scope: null };

    const ordenesSpace = await ejecutarTool('listar_ordenes', { ...inyeccion }, { scope: deSpace });
    assert.ok(ordenesSpace.ordenes.length > 0);
    paso(`"dame las ordenes" desde la compañia 1 -> ${ordenesSpace.ordenes.length} filas`);

    const ordenesAO = await ejecutarTool('listar_ordenes', { ...inyeccion }, { scope: deAO });
    assert.strictEqual(ordenesAO.ordenes.length, 0, 'FUGA: la compañia 3 vio ordenes ajenas');
    paso('la misma llamada desde la compañia 3, con organization_id=2 a mano -> 0 filas');

    // TODAS las tools, con argumentos reales de la compañia 1 puestos a mano.
    // La compañia 3 no tiene ni una orden, ni un paro, ni un sensor: si algo de
    // la compañia 1 se cuela, aparece aqui.
    const unaOrden = ordenesSpace.ordenes[0].work_order_number;
    const ARGS_AJENOS = {
        historico_sensor:  { sensor: 'temperatura', maquina: 'DEV 4' },
        tendencia_sensor:  { sensor: 'temperatura', maquina: 'DEV 4' },
        detalle_orden:     { orden: unaOrden },
        comparar_periodos: { a_desde: '2026-01-01', a_hasta: '2026-03-31',
                             b_desde: '2026-04-01', b_hasta: '2026-06-30' },
    };
    const HUELLAS_AJENAS = ['RELEASED', 'IN_PROCESS', 'OI_PL1', 'Runtime', 'Downtime',
                            'DEV 4', 'temperatura', unaOrden];

    for (const nombre of Object.keys(TOOLS)) {
        const r = await ejecutarTool(nombre, { ...inyeccion, ...ARGS_AJENOS[nombre] }, { scope: deAO });
        const texto = JSON.stringify(r);
        for (const huella of HUELLAS_AJENAS) {
            // El mensaje de error puede repetir lo que pidio el usuario ("no
            // existe la orden X"): eso no es fuga, es eco. Lo que se revisa es
            // el resto de la respuesta.
            const sinMensaje = JSON.stringify({ ...r, error: undefined });
            assert.ok(
                !sinMensaje.includes(huella),
                `${nombre} dejo salir "${huella}" a la compañia 3: ${sinMensaje.slice(0, 200)}`
            );
        }
        void texto;
    }
    paso(`las ${Object.keys(TOOLS).length} tools no filtran nada a la compañia 3`);

    // Cuando una tool no encuentra algo, la lista de alternativas que ofrece
    // TAMBIEN va filtrada por alcance. Es el descuido tipico: negar el dato y
    // regalar el catalogo.
    const sensorAjeno = await ejecutarTool('historico_sensor', { sensor: 'temperatura' }, { scope: deAO });
    assert.ok(sensorAjeno.error);
    assert.deepStrictEqual(sensorAjeno.sensores_disponibles, []);
    paso('la lista de "sensores disponibles" de un error tambien respeta el alcance');

    const ordenAjena = await ejecutarTool('detalle_orden', { orden: unaOrden }, { scope: deAO });
    assert.ok(/dentro de tu alcance/.test(ordenAjena.error));
    assert.strictEqual(ordenAjena.orden, undefined);
    paso('una orden de otra compañia no existe, no "esta prohibida"');

    // --- 3. saneo de lo que manda el modelo ---------------------------------
    // gpt-oss:120b mando "open" con un enum ["RELEASED","IN_PROCESS"] declarado.
    assert.strictEqual(enumerado('open', ['RELEASED', 'IN_PROCESS']), null);
    assert.strictEqual(enumerado('released', ['RELEASED', 'IN_PROCESS']), 'RELEASED');
    assert.strictEqual(enumerado(123, ['RELEASED']), null);
    paso('enumerado() rechaza lo que no esta en la lista y acepta otra caja');

    assert.strictEqual(entero(9999), 50);
    assert.strictEqual(entero(-5), 1);
    assert.strictEqual(entero('siete'), 20);
    assert.strictEqual(entero('12'), 12);
    paso('entero() recorta al tope, al piso y aguanta basura');

    assert.strictEqual(fecha('2026-06-01'), '2026-06-01');
    assert.strictEqual(fecha('mañana'), null);
    assert.strictEqual(fecha('2026-13-45'), null);
    // Antes esto devolvia '2026-06-01': el patron no estaba anclado al final y
    // se quedaba con el prefijo. No era inyectable -- las consultas van
    // parametrizadas -- pero el esquema de las tools promete "AAAA-MM-DD", y
    // aceptar a medias es lo que obliga a releer la funcion entera cada vez que
    // se toca lo que hay detras.
    assert.strictEqual(fecha("2026-06-01'; DROP TABLE mes_users; --"), null);
    for (const conCola of ['2026-06-01 texto', '2026-06-01T10:30:00Z', '2026-06-011',
                           '2026-06-01x', 'ayer 2026-06-01']) {
        assert.strictEqual(fecha(conCola), null, `${JSON.stringify(conCola)} tiene cola y paso`);
    }
    // Los espacios de los lados si se perdonan: eso es un descuido al escribir,
    // no otra cosa pegada a la fecha.
    assert.strictEqual(fecha('  2026-06-01  '), '2026-06-01');
    paso('fecha() solo acepta AAAA-MM-DD entero, sin colas ni prefijos');

    // Cumplir el patron no es existir. "2026-02-31" pasaba el regex, y `new Date`
    // no se queja: desborda a marzo en silencio. La cadena original llegaba tal
    // cual a Postgres y reventaba la consulta con un error que el bot no sabe
    // explicar.
    for (const imposible of ['2026-02-31', '2026-04-31', '2026-02-30', '2025-02-29',
                             '2026-06-31', '2026-09-31', '2026-11-31']) {
        assert.strictEqual(fecha(imposible), null, `${imposible} no existe y paso`);
    }
    paso('fecha() rechaza dias que no existen (31 de febrero, 31 de abril...)');

    // Y los bisiestos no se van de paso: 2024 si, 2025 no, 2100 no (no es bisiesto).
    assert.strictEqual(fecha('2024-02-29'), '2024-02-29');
    assert.strictEqual(fecha('2025-02-29'), null);
    assert.strictEqual(fecha('2000-02-29'), '2000-02-29');
    assert.strictEqual(fecha('2100-02-29'), null);
    paso('fecha() acierta los bisiestos: 2024 y 2000 si, 2025 y 2100 no');

    // Que ninguna tool reviente con una fecha imposible: sin filtro, no con un
    // error de SQL.
    const conFechaMala = await ejecutarTool('resumen_produccion',
        { agrupar_por: 'dia', desde: '2026-02-31' }, { scope: deSpace });
    assert.ok(!conFechaMala.error, `fecha imposible reventó la tool: ${conFechaMala.error}`);
    assert.strictEqual(conFechaMala.periodo_pedido.desde, null,
        'la fecha imposible tiene que llegar al modelo como null, para que sepa que se ignoro');
    paso('una fecha imposible no revienta la consulta: se ignora y se dice');

    // Con un status invalido la tool NO debe fallar ni filtrar de mas: lo ignora.
    const conBasura = await ejecutarTool('listar_ordenes', { status: 'open', limite: 9999 }, { scope: deSpace });
    assert.strictEqual(conBasura.filtro_aplicado.status, null);
    assert.strictEqual(conBasura.filtro_aplicado.limite, 50);
    paso('status invalido se ignora y el limite se recorta, sin reventar');

    // --- 3.35 ninguna tool revienta con sus argumentos normales --------------
    // El bucle de arriba prueba el AISLAMIENTO y le basta con que no salgan
    // datos ajenos: una tool rota devuelve {error} y pasa igual. Asi se colo un
    // "window functions are not allowed in GROUP BY" que solo aparecio abriendo
    // el navegador. Aqui se corren las 13 con el alcance BUENO y datos de verdad.
    const ARGS_NORMALES = {
        historico_sensor:  { sensor: 'temperatura', maquina: 'DEV 4' },
        tendencia_sensor:  { sensor: 'temperatura', maquina: 'DEV 4' },
        detalle_orden:     { orden: unaOrden },
        comparar_periodos: { a_desde: '2025-07-01', a_hasta: '2025-12-31',
                             b_desde: '2026-01-01', b_hasta: '2026-06-30' },
        generar_reporte:   { desde: '2026-01-01', hasta: '2026-06-30' },
    };
    // programar_reporte queda fuera: con un Admin devuelve {error} A PROPOSITO, y
    // ademas ESCRIBE. Tiene su propio bloque mas abajo.
    const SOLO_LECTURA = Object.keys(TOOLS).filter((n) => n !== 'programar_reporte');
    for (const nombre of SOLO_LECTURA) {
        const r = await ejecutarTool(nombre, ARGS_NORMALES[nombre] || {}, { scope: deSpace });
        assert.ok(!r.error, `${nombre} devolvio error con argumentos normales: ${r.error}`);
    }
    paso(`las ${SOLO_LECTURA.length} tools de lectura corren sin error con el alcance bueno`);

    // --- 3.36 la unica tool que escribe -------------------------------------
    // El bot es de solo lectura y esa es la capa 1 del aislamiento. Esta se sale
    // de ahi, asi que lo que se prueba no es que funcione: es que no se pueda
    // usar para lo que no es.
    const admin = await ejecutarTool('programar_reporte', { periodicidad: 'diario' }, { scope: deSpace });
    assert.ok(/SuperAdmin/i.test(admin.error || ''), `un Admin pudo programar: ${JSON.stringify(admin)}`);
    paso('programar_reporte: un Admin recibe un no, aunque lo pida bien');

    // El rol sale de la BASE (resolveScope), no del token ni del modelo. Un
    // scope con el rol cambiado a mano no cuela porque el bot nunca construye
    // uno: siempre viene de resolveScope. Aqui se comprueba que la tool mira
    // ctx.scope.role y no un argumento.
    const conRolInventado = await ejecutarTool('programar_reporte',
        { periodicidad: 'diario', role: 'SuperAdmin', scope: { role: 'SuperAdmin' } },
        { scope: deSpace });
    assert.ok(/SuperAdmin/i.test(conRolInventado.error || ''), 'el rol se pudo inyectar por argumentos');
    paso('programar_reporte: el rol no se puede meter por los argumentos del modelo');

    // Con un SuperAdmin de verdad si crea, y NO acepta que le digan la compañia.
    // Se limpia antes: si quedo una fila de una corrida anterior, el INSERT se
    // convierte en UPDATE (hay unico por compañia+periodicidad) y la cuenta de
    // filas deja de decir lo que se cree que dice.
    await pool.query(`DELETE FROM mes_ai_report_schedules WHERE company_id = 3`);
    const antesDeProgramar = Number((await pool.query(
        'SELECT count(*) c FROM mes_ai_report_schedules')).rows[0].c);
    const superAdmin = { ...deAO, companyIds: [3] };
    const creado = await ejecutarTool('programar_reporte',
        { periodicidad: 'semanal', hora: '06:30', dia_semana: 1, company_id: 1, organization_id: 2 },
        { scope: superAdmin });
    assert.ok(!creado.error, `el SuperAdmin no pudo programar: ${creado.error}`);
    assert.strictEqual(creado.programado.periodicidad, 'semanal');

    const fila = (await pool.query(
        'SELECT company_id, created_by FROM mes_ai_report_schedules WHERE schedule_id = $1',
        [creado.programado.schedule_id])).rows[0];
    assert.strictEqual(fila.company_id, 3, 'la compañia salio del argumento del modelo, no del alcance');
    assert.strictEqual(fila.created_by, deAO.userId, 'el created_by no es quien pregunto');
    paso('programar_reporte: el SuperAdmin programa, y la compañia sale del ALCANCE, no del argumento');

    // Lo que llega mal no toca la tabla.
    for (const malos of [{ periodicidad: 'cuando sea' }, { periodicidad: 'diario', hora: '25:00' },
                         { periodicidad: 'semanal', hora: '07:00' }]) {
        const r = await ejecutarTool('programar_reporte', malos, { scope: superAdmin });
        assert.ok(r.error, `${JSON.stringify(malos)} no fue rechazado`);
    }
    const despues = Number((await pool.query(
        'SELECT count(*) c FROM mes_ai_report_schedules')).rows[0].c);
    assert.strictEqual(despues, antesDeProgramar + 1, 'un argumento malo llego a crear una fila');
    paso('programar_reporte: periodicidad, hora y dia se sanean antes de tocar la tabla');

    // No hay forma de decir a quien se le manda. Se miran los NOMBRES de los
    // argumentos, no el texto entero: la primera version buscaba "para" dentro
    // del JSON y saltaba con "Solo para semanal", que es prosa de una
    // descripcion. Una prueba que falla por una palabra en una frase no vigila
    // nada, solo estorba.
    const argumentos = Object.keys(TOOLS.programar_reporte.esquema.properties);
    assert.deepStrictEqual(argumentos, ['periodicidad', 'hora', 'dia_semana'],
        `programar_reporte acepta argumentos de mas: ${argumentos.join(', ')}`);
    assert.strictEqual(TOOLS.programar_reporte.esquema.additionalProperties, false,
        'el esquema deja colar argumentos que no estan declarados');
    paso('programar_reporte: no hay argumento para elegir destinatario -- son los de la compañia');

    await pool.query('DELETE FROM mes_ai_report_schedules WHERE schedule_id = $1',
                     [creado.programado.schedule_id]);

    // Y las tres formas de agrupar, que van por caminos SQL distintos.
    for (const agrupar of ['turno', 'maquina', 'dia']) {
        const r = await ejecutarTool('resumen_produccion', { agrupar_por: agrupar }, { scope: deSpace });
        assert.ok(!r.error, `resumen_produccion agrupado por ${agrupar}: ${r.error}`);
        assert.ok(r.grupos.length > 0, `resumen_produccion por ${agrupar} no devolvio grupos`);
    }
    paso('resumen_produccion agrupa por turno, maquina y dia sin romperse');

    // --- 3.45 la grafica la arma la tool, no el modelo ----------------------
    const conGrafica = await ejecutarTool('historico_sensor',
        { sensor: 'temperatura', maquina: 'DEV 4' }, { scope: deSpace });
    const g = conGrafica.grafica;
    assert.ok(g, 'historico_sensor no adjunto grafica');
    assert.strictEqual(g.tipo, 'linea');
    assert.strictEqual(g.eje_x.length, conGrafica.puntos.length, 'el eje X no cuadra con los puntos');
    for (const serie of g.series) {
        assert.strictEqual(serie.datos.length, g.eje_x.length, `la serie ${serie.nombre} no cuadra con el eje X`);
        assert.ok(serie.datos.every((n) => typeof n === 'number' && Number.isFinite(n)),
            `la serie ${serie.nombre} trae algo que no es un numero`);
    }
    // Los numeros de la grafica son los MISMOS que los del dato: si divergen,
    // el usuario ve una cosa y lee otra.
    assert.deepStrictEqual(
        g.series[0].datos,
        conGrafica.puntos.map((p) => Number(p.promedio)),
        'la serie no coincide con los puntos que se le devuelven al modelo'
    );
    paso(`historico_sensor adjunta una grafica de linea de ${g.eje_x.length} puntos, cuadrada con el dato`);

    // Con un solo grupo no hay nada que comparar: no debe haber grafica.
    const unSolo = await ejecutarTool('resumen_produccion',
        { agrupar_por: 'dia', desde: '2026-06-19', hasta: '2026-06-19' }, { scope: deSpace });
    assert.ok(unSolo.grupos.length <= 1, 'la prueba necesita un solo dia');
    assert.strictEqual(unSolo.grafica, undefined, 'con un solo grupo no hay grafica que pintar');
    paso('con un solo grupo no se adjunta grafica');

    // --- 3.455 recortar el alcance a UNA compañia ----------------------------
    // El esquema permite un usuario con organizaciones de varias compañias. Hoy
    // nadie lo hace, asi que se prueba con un alcance armado a mano: la cabecera
    // del PDF dice UNA compañia y las cifras tienen que ser de esa, no la suma.
    const dosCompanias = {
        userId: 999, role: 'Admin',
        orgIds: [2, 4, 6], companyIds: [1, 3],
        orgsPorCompania: { 1: [2, 4], 3: [6] },
    };
    assert.deepStrictEqual(scopeDeCompania(dosCompanias, 1).orgIds, [2, 4]);
    assert.deepStrictEqual(scopeDeCompania(dosCompanias, 1).companyIds, [1]);
    assert.deepStrictEqual(scopeDeCompania(dosCompanias, 3).orgIds, [6]);
    paso('scopeDeCompania recorta las organizaciones a la compañia pedida');

    // Recorta, nunca ensancha: una compañia que no es suya no le da nada.
    assert.throws(() => scopeDeCompania(dosCompanias, 2), /fuera de alcance/);
    assert.throws(() => scopeDeCompania(dosCompanias, 999), /fuera de alcance/);
    paso('scopeDeCompania no ensancha: una compañia ajena es 403, no un alcance vacio');

    // Y con un solo dueño, el alcance recortado es el de siempre.
    assert.deepStrictEqual(
        scopeDeCompania(deSpace, deSpace.companyIds[0]).orgIds.sort(),
        [...deSpace.orgIds].sort(),
        'con una sola compañia el recorte no debe quitar nada'
    );
    paso('con una sola compañia (el caso de hoy) el recorte no cambia nada');

    // --- 3.46 el reporte no se salta el alcance -----------------------------
    // El PDF es la fuga mas comoda de todas: un archivo con los datos de otra
    // compañia, listo para reenviar. Se comprueba sobre los DATOS, antes de que
    // se conviertan en dibujo -- de un PDF ya generado no se lee nada.
    const delReporte = await datosDelReporte(deSpace, '2026-01-01', '2026-06-30');
    assert.ok(delReporte.resumen.registros > 0, 'la prueba necesita datos en ese periodo');

    const ajeno = await datosDelReporte(deAO, '2026-01-01', '2026-06-30');
    assert.strictEqual(Number(ajeno.resumen.registros), 0, 'el reporte de otra compañia trajo filas');
    for (const seccion of ['porTurno', 'porMaquina', 'items', 'paros']) {
        assert.strictEqual(ajeno[seccion].length, 0,
            `la seccion ${seccion} del reporte se salio del alcance`);
    }
    paso('el reporte respeta el alcance: la compañia 3 no ve ni una fila de la 1');

    // --- 3.47 el PDF sale entero, con portada y con el color de la compañia --
    // Se dibuja de verdad y se mira el binario. Las cifras ya se comprueban
    // arriba sobre los datos; aqui lo que se prueba es que el documento se
    // termina, que tiene las paginas que debe y que el color NO esta cableado.
    const aBuffer = (opciones) => new Promise((resolve, reject) => {
        const trozos = [];
        const flujo = new (require('stream').PassThrough)();
        flujo.on('data', (t) => trozos.push(t));
        flujo.on('end', () => resolve(Buffer.concat(trozos)));
        flujo.on('error', reject);
        dibujarReporte(flujo, opciones);
    });

    const comun = { empresa: 'SPACE', desde: '2026-01-01', hasta: '2026-06-30', datos: delReporte };
    const pdfBase = await aBuffer({ ...comun, paleta: PALETA_BASE, generadoPor: 'prueba' });

    assert.strictEqual(pdfBase.subarray(0, 5).toString(), '%PDF-', 'lo dibujado no es un PDF');
    assert.ok(pdfBase.length > 20000, `el PDF pesa ${pdfBase.length} bytes: se quedo a medias`);
    const paginas = (pdfBase.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.ok(paginas >= 5, `el reporte trae ${paginas} paginas y deberia traer portada + 4 secciones`);
    paso(`el PDF sale entero: ${paginas} paginas, ${pdfBase.length} bytes`);

    // Un PDF sin produccion tambien tiene que terminarse -- con portada y todo.
    const pdfVacio = await aBuffer({
        empresa: 'AO', desde: '2026-01-01', hasta: '2026-06-30', datos: ajeno, paleta: PALETA_BASE,
    });
    assert.strictEqual(pdfVacio.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdfVacio.length > 10000, 'el PDF sin produccion se quedo a medias');
    paso('un periodo sin produccion tambien produce un PDF completo, no un archivo roto');

    // Dos colores distintos -> dos documentos distintos. Si la paleta no se
    // usara, saldrian identicos y esto lo destapa.
    const pdfVino = await aBuffer({ ...comun, paleta: paletaDe('#7A1F3D'), generadoPor: 'prueba' });
    assert.notStrictEqual(pdfBase.length + ':' + pdfBase.toString('latin1').slice(0, 4000),
                          pdfVino.length + ':' + pdfVino.toString('latin1').slice(0, 4000),
                          'la portada sale igual con otro color: la paleta no se esta usando');
    paso('REPORT_COLOR cambia la portada de verdad (dos colores, dos documentos)');

    // Y un color imposible no puede tumbar el reporte.
    for (const malo of [null, '', 'azul', '#gggggg', '#12', 12345, {}]) {
        assert.deepStrictEqual(paletaDe(malo), PALETA_BASE, `paletaDe(${JSON.stringify(malo)}) no cayo a la base`);
    }
    // Un color muy oscuro tiene que aclararse o el acento no se lee sobre el fondo.
    const oscura = paletaDe('#000814');
    assert.notStrictEqual(oscura.acento.toLowerCase(), '#000814', 'el acento oscuro no se aclaro');
    paso('un REPORT_COLOR invalido cae a la paleta base y uno muy oscuro se aclara');

    // --- 3.48 la narrativa: el PDF NUNCA depende de que el LLM conteste ------
    const conCifras = { empresa: 'SPACE', desde: '2026-01-01', hasta: '2026-06-30', datos: delReporte };

    // Sin credencial no se llama a nadie y sale la estatica.
    const sinLlave = await redactarComentario({ ...conCifras, credencial: null });
    assert.strictEqual(sinLlave.deLaIA, false, 'sin credencial no puede venir de la IA');
    for (const parte of ['resumen', 'eventos', 'recomendaciones']) {
        assert.ok(sinLlave[parte] && sinLlave[parte].length > 40,
            `la redaccion estatica dejo vacia la seccion ${parte}`);
    }
    paso('sin credencial la narrativa sale estatica y con las tres secciones');

    // Con el LLM caido, tambien. Este es EL caso: el reporte del lunes a las 7.
    const chatDeVerdad = llm.chat;
    llm.chat = async () => { throw Object.assign(new Error('el proveedor se cayo'), { codigo: 'LLM_CAIDO' }); };
    const conLlmCaido = await redactarComentario({ ...conCifras, credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' } });
    assert.strictEqual(conLlmCaido.deLaIA, false);
    assert.deepStrictEqual(
        { r: conLlmCaido.resumen, e: conLlmCaido.eventos },
        { r: sinLlave.resumen, e: sinLlave.eventos },
        'con el LLM caido no salio la misma redaccion estatica'
    );
    paso('con el LLM caido la narrativa NO lanza: sale la estatica y el PDF se termina');

    // Y con una respuesta que no respeta el formato, igual.
    llm.chat = async () => ({ message: { content: 'aqui va un texto libre sin marcas' }, finishReason: 'stop' });
    const sinFormato = await redactarComentario({ ...conCifras, credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' } });
    assert.strictEqual(sinFormato.deLaIA, false, 'una respuesta sin marcas no puede pasar por narrativa de la IA');
    paso('una respuesta que no respeta el formato tampoco entra al PDF');

    // El caso real con este modelo: se corta a media tercera seccion. Las dos
    // buenas se aprovechan; la que quedo a medias, no.
    llm.chat = async () => ({
        message: { content: '[RESUMEN]\nTodo bien.\n\n[EVENTOS]\nHubo paros.\n\n[RECOMENDACIONES]\n- Revisar la maq' },
        finishReason: 'length',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    const cortada = await redactarComentario({ ...conCifras, credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' } });
    llm.chat = chatDeVerdad;

    assert.strictEqual(cortada.deLaIA, true, 'con dos secciones buenas la narrativa si es de la IA');
    assert.strictEqual(cortada.resumen, 'Todo bien.');
    assert.strictEqual(cortada.eventos, 'Hubo paros.');
    assert.ok(!cortada.recomendaciones.includes('Revisar la maq'),
        'la seccion cortada a la mitad llego al PDF');
    assert.strictEqual(cortada.recomendaciones, sinLlave.recomendaciones,
        'la seccion cortada no se relleno con la estatica');
    paso('respuesta cortada: se usan las secciones completas y la de a medias la cubre la estatica');

    // El parser, en seco.
    assert.deepStrictEqual(partir(''), {});
    assert.deepStrictEqual(partir(null), {});
    assert.deepStrictEqual(partir('[RESUMEN]\nA\n[EVENTOS]\nB\n[RECOMENDACIONES]\nC'),
                           { resumen: 'A', eventos: 'B', recomendaciones: 'C' });
    assert.deepStrictEqual(partir('[RESUMEN]\nA\n[EVENTOS]\nB', true), { resumen: 'A' },
                           'truncado tiene que tirar la ultima seccion');
    paso('partir() saca las secciones que hay y tira la ultima si la respuesta venia cortada');

    // Lo que se le manda al modelo son cifras YA calculadas, no filas: si algun
    // dia alguien mete las filas crudas aqui, el modelo tendra que reescribir
    // numeros y ahi es donde se los inventa.
    const paquete = cifras(conCifras);
    assert.ok(JSON.stringify(paquete).length < 4000,
        `el paquete de cifras pesa ${JSON.stringify(paquete).length} caracteres: se estan mandando filas`);
    assert.strictEqual(paquete.producido, Number(delReporte.resumen.cajas) || 0);
    assert.ok(!('rows' in paquete), 'se colaron filas crudas en el paquete del modelo');
    paso(`al modelo se le mandan cifras calculadas (${JSON.stringify(paquete).length} caracteres), no las filas`);

    // --- 3.49 la narrativa NO escribe cifras --------------------------------
    // Las cifras del reporte estan en la portada, los KPI, las graficas y las
    // tablas, y todas salen de una consulta. El texto describe lo que enseñan.
    //
    // La version anterior comparaba cada numero contra los valores del paquete y
    // se le fueron cerrando agujeros de uno en uno; el ultimo no tenia arreglo
    // por ese camino: un valor REAL puesto en el campo que no es. Si los datos
    // dicen paros=180 y producido=7, "se produjeron 180 cajas" usa un numero que
    // si esta en los datos, y es falso.
    const dePrueba = {
        periodo: '2026-01-01 a 2026-06-30',
        producido: 7,
        paros: 180,
        por_turno: [{ turno: 'TURNO 3', cajas: 3 }, { turno: 'TURNO 2', cajas: 2 }, { turno: 'TURNO 1', cajas: 2 }],
        top_maquinas: [{ maquina: 'TWMFC780-12', cajas: 5 }],
    };

    for (const [texto, debeRechazar, porque] of [
        // --- prosa sin cifras, y los nombres que si vienen de los datos ---
        ['La producción se concentró en pocos días.',            false, 'prosa sin numeros'],
        ['La máquina TWMFC780-12 fue la de mayor producción.',   false, 'codigo de maquina'],
        ['El TURNO 3 fue el de mayor producción.',               false, 'nombre de turno, tal como esta en los datos'],
        ['Del 2026-01-01 al 2026-06-30 la actividad fue baja.',  false, 'periodo en ISO'],
        ['Del 1 de enero al 30 de junio de 2026, baja.',         false, 'el mismo periodo, en prosa'],
        ['Durante el primer semestre de 2026 hubo poca carga.',  false, 'el año detras de una preposicion'],

        // --- cualquier cifra, venga de donde venga ---
        ['Se produjeron 7 cajas.',                               true,  'la cifra es correcta, pero es una cifra'],
        ['Se produjeron 180 cajas.',                             true,  'valor real del paquete en el campo equivocado'],
        ['Hubo 8 paros.',                                        true,  'inventada'],
        ['La merma fue del 34 %.',                               true,  'porcentaje'],
        ['Hubo 30 paros.',                                       true,  'el 30 sale del dia de una fecha'],
        ['La máquina 780 tuvo 12 fallas.',                       true,  'digitos de un codigo, sin su palabra cerca'],
        ['El 31 de diciembre de 2030 hubo 99 paros.',            true,  'fecha que no esta en los datos'],
        // No hay excepcion para los identificadores sueltos. La hubo, y abria el
        // mismo agujero por la puerta de al lado: con "turno" cerca, el segundo
        // 3 de "el turno 3 produjo 3 cajas" pasaba como si fuera un nombre.
        ['El turno 3 produjo 3 cajas.',                          true,  'un numero pegado a su noun sigue siendo un numero'],
        ['Los turnos 3, 2 y 1 aportaron de mayor a menor.',      true,  'enumeracion suelta: cae en la estatica, que es correcta'],
    ]) {
        const sobran = cifrasEnElTexto(texto, dePrueba);
        assert.strictEqual(sobran.length > 0, debeRechazar,
            `"${texto}" (${porque}): ${debeRechazar ? 'paso el filtro y no debia' : 'se rechazo y era valido'}`
            + (sobran.length ? ` -- señalo ${JSON.stringify(sobran)}` : ''));
    }
    paso('la narrativa no escribe cifras, sin excepciones: pasan los nombres y el periodo');

    // De punta a punta: la seccion con la cifra se cae, las limpias sobreviven.
    const chatDeVerdad2 = llm.chat;
    llm.chat = async () => ({
        message: { content:
            '[RESUMEN]\nLa producción fue baja y se concentró en pocos días.\n\n'
            + '[EVENTOS]\nHubo 98431 paros catastroficos.\n\n'
            + '[RECOMENDACIONES]\n- Revisar la linea.' },
        finishReason: 'stop',
        usage: { prompt_tokens: 5, completion_tokens: 5 },
    });
    const filtrada = await redactarComentario({ ...conCifras, credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' } });
    llm.chat = chatDeVerdad2;

    assert.strictEqual(filtrada.deLaIA, true);
    assert.ok(filtrada.resumen.includes('pocos días'), 'se tiro el resumen, que estaba bien');
    assert.ok(!filtrada.eventos.includes('98431'), 'la cifra llego al PDF');
    assert.strictEqual(filtrada.eventos, sinLlave.eventos, 'la seccion sucia no se relleno con la estatica');
    assert.strictEqual(filtrada.recomendaciones, '- Revisar la linea.', 'se tiro una seccion limpia');
    paso('una seccion con cifra se cae y la cubre la estatica; las limpias se quedan');

    // La estatica SI lleva numeros, y esta bien: la escribe el codigo con las
    // cifras de la consulta, no un modelo.
    assert.ok(/\d/.test(sinLlave.resumen), 'la redaccion estatica se quedo sin cifras');
    paso('la redaccion estatica si lleva cifras: las pone el codigo, no el modelo');

    // --- 3.494 las tools que comparan devuelven grafica ---------------------
    // El pendiente que arrastraba el plan: top_items y paros_de_maquina piden
    // barras y no las llevaban. La grafica la arma la TOOL con los datos que
    // acaba de leer -- si la dictara el modelo tendria que volver a escribir los
    // numeros, y volver a escribir un numero es como se inventan.
    for (const [herramienta, args, serieEsperada] of [
        ['top_items',        { desde: '2026-01-01', hasta: '2026-06-30' }, 'completado'],
        ['paros_de_maquina', { desde: '2026-01-01', hasta: '2026-06-30' }, 'paros'],
        ['resumen_produccion', { agrupar_por: 'turno' }, 'cajas'],
    ]) {
        const r = await ejecutarTool(herramienta, args, { scope: deSpace });
        assert.ok(r.grafica, `${herramienta} no devolvio grafica`);
        assert.strictEqual(r.grafica.tipo, 'barras');
        assert.ok(r.grafica.eje_x.length > 1, `${herramienta}: una barra no es una comparacion`);
        assert.ok(r.grafica.series.some((se) => se.nombre === serieEsperada),
            `${herramienta}: falta la serie "${serieEsperada}"`);
        for (const se of r.grafica.series) {
            assert.strictEqual(se.datos.length, r.grafica.eje_x.length,
                `${herramienta}: la serie "${se.nombre}" no cuadra con el eje`);
            assert.ok(se.datos.every((d) => typeof d === 'number' && Number.isFinite(d)),
                `${herramienta}: la serie "${se.nombre}" trae algo que no es un numero`);
        }
    }
    paso('top_items, paros_de_maquina y resumen_produccion devuelven su grafica, armada por la tool');

    // Y con un solo grupo NO hay grafica: eso no es una comparacion, es un
    // numero, y una barra sola en el chat solo ocupa sitio.
    const unSoloItem = await ejecutarTool('top_items', { limite: 1 }, { scope: deSpace });
    assert.ok(!unSoloItem.grafica, 'con un solo articulo dibujo una grafica de una barra');
    paso('top_items con limite 1 no dibuja grafica: una barra sola no es una comparacion');

    // --- 3.4945 el resumen por tipo tiene tope, y dice cuantos hay ----------
    // Iba sin LIMIT: `failure_type` sale del catalogo de fallas, que es texto
    // libre --hoy tres tipos, pero failure_name en la misma tabla ya va por
    // 105-- y ese resumen entero se le manda al modelo Y alimenta el eje X de
    // la grafica. Un catalogo suelto se llevaba el prompt por delante.
    const conParos = await ejecutarTool('paros_de_maquina',
        { desde: '2026-01-01', hasta: '2026-06-30', limite: 3 }, { scope: deSpace });

    const tiposDeVerdad = Number((await pool.query(`
        SELECT count(DISTINCT COALESCE(NULLIF(trim(failure_type), ''), 'sin tipo'))
          FROM v_machine_stops
         WHERE organization_id = ANY($1)
           AND start_date >= '2026-01-01' AND start_date < '2026-07-01'`,
        [deSpace.orgIds])).rows[0].count);

    // LA aserción: el total sale del DATO, no de contar las filas que caben.
    // Es el mismo error que hay_mas vino a cerrar en las listas.
    assert.strictEqual(conParos.tipos_encontrados, tiposDeVerdad,
        'tipos_encontrados no es el total de verdad');
    assert.ok(conParos.resumen_por_tipo.length <= tiposDeVerdad);
    assert.strictEqual(conParos.hay_mas_tipos,
        tiposDeVerdad > conParos.resumen_por_tipo.length);
    // Y la plomeria del conteo no puede viajar al prompt.
    assert.ok(!conParos.resumen_por_tipo.some((t) => '_total' in t),
        'el _total del conteo se colo en las filas que ve el modelo');
    // El recorte de las FILAS es independiente del recorte del resumen.
    assert.strictEqual(conParos.paros.length, 3, 'el limite de las filas no se respeto');
    paso(`resumen_por_tipo dice cuantos tipos hay (${tiposDeVerdad}), no cuantos caben`);

    // --- 3.495 las herramientas se ofrecen SIEMPRE, tambien con historial ---
    // De la revision en vivo: con una negativa en el historial, el modelo
    // contesto "no hay herramienta que agrupe por turno" -- y la hay
    // (tools.js declara enum ['turno','maquina','dia']). No se pudo reproducir
    // en 14 intentos, asi que lo que se prueba aqui es lo MECANICO, que si es
    // determinista: que en cada vuelta se le manden los esquemas, y que el
    // prompt le prohiba negar una herramienta sin llamarla. Lo que decide el
    // modelo con eso delante no es una prueba, es una medicion.
    const pasadas = [];
    llm.chat = async ({ messages, tools }) => {
        pasadas.push({ tools: (tools || []).length, mensajes: messages.length });
        // Primera vuelta: pide una tool. Segunda: contesta.
        return pasadas.length === 1
            ? { message: { role: 'assistant', tool_calls: [{ id: 't1', type: 'function',
                  function: { name: 'panorama_planta', arguments: '{}' } }] } }
            : { message: { role: 'assistant', content: 'Listo.' } };
    };
    const conHistorial = await conversar({
        scope: deSpace,
        credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' },
        historial: [
            { role: 'user', content: '¿cuál es el OEE?' },
            { role: 'assistant', content: 'No hay datos de OEE disponibles.' },
        ],
        pregunta: 'producción por turno de junio 2026',
    });
    llm.chat = chatDeVerdad2;

    assert.strictEqual(pasadas.length, 2, 'el bucle no dio las dos vueltas');
    for (const [i, v] of pasadas.entries()) {
        assert.ok(v.tools > 0, `en la vuelta ${i + 1} no se le mandaron los esquemas de tools`);
    }
    assert.ok(pasadas[0].mensajes >= 4, 'el historial no llego al modelo (system + 2 + pregunta)');
    assert.strictEqual(conHistorial.herramientasUsadas.length, 1);
    paso('con historial de por medio, las herramientas se ofrecen en TODAS las vueltas');

    // Y el prompt se lo prohibe explicitamente. Es la capa 5 --una sugerencia,
    // no un guardrail-- pero es la unica palanca que hay sobre una conducta que
    // no se pudo reproducir: 14 de 14 intentos llamaron a la herramienta.
    const prompt = require('../services/ai/agent').systemPrompt
        ? require('../services/ai/agent').systemPrompt()
        : require('fs').readFileSync('services/ai/agent.js', 'utf8');
    assert.ok(/NUNCA digas que una herramienta no existe/.test(prompt),
        'el prompt ya no le prohibe negar una herramienta sin llamarla');
    paso('el prompt le prohibe negar una herramienta sin haberla llamado');

    // --- 3.496 la fecha del prompt va en hora de la PLANTA, no en UTC -------
    // Se calculaba con toISOString(), que es UTC. De las 18:00 en adelante
    // --hora de Mexico-- el prompt le decia al modelo que hoy era mañana, y con
    // eso "hoy", "ayer" y "este mes" se resolvian sobre el dia equivocado. El
    // ultimo dia del mes, "este mes" se iba al siguiente.
    //
    // Es la TERCERA vez que este proyecto se tropieza con lo mismo: los turnos
    // (ETAPA 2) y periodoDe() en el programador tuvieron el mismo fallo.
    for (const [instante, esperado, porque] of [
        ['2026-08-26T03:00:00Z', '2026-08-25', '21:00 del 25 en Mexico: el prompt decia 26'],
        ['2026-08-26T18:00:00Z', '2026-08-26', 'mediodia: UTC y Mexico coinciden'],
        ['2026-09-01T04:30:00Z', '2026-08-31', 'ultimo dia del mes por la noche: se iba a septiembre'],
        ['2026-01-01T05:00:00Z', '2025-12-31', 'nochevieja: se iba al año siguiente'],
    ]) {
        const primera = systemPrompt(new Date(instante)).split('\n')[0];
        assert.ok(primera.includes(`Hoy es ${esperado}.`),
            `${porque} -- con ${instante} el prompt dice "${primera}"`);
    }
    // Y la zona que se le dice al modelo es la misma que se usa para calcularla:
    // decir una y calcular con otra es el fallo que se acaba de arreglar.
    assert.ok(systemPrompt().includes(`La zona horaria de las plantas es ${require('../services/ai/domain').ZONA}`),
        'el prompt nombra una zona distinta de la que usa para calcular el dia');
    paso('la fecha del prompt sale en hora de la planta, no en UTC (4 instantes)');

    // --- 3.50 la narrativa corre DENTRO del cupo de la instancia -------------
    // Estaba fuera: el cupo se soltaba en cuanto acababan las consultas, y la
    // llamada al LLM --que hoy es la parte cara-- quedaba sin contar. Se levanta
    // el router en este proceso para poder mirar el contador desde dentro.
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../services/ai/router'));
    const servidor = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const puerto = servidor.address().port;

    let cupoDurante = -1;
    llm.chat = async () => {
        cupoDurante = cupo.enCurso();
        return { message: { content: '[RESUMEN]\nSin novedad.' }, finishReason: 'stop', usage: {} };
    };
    const rep = await fetch(`http://localhost:${puerto}/api/ai/reporte?desde=2026-01-01&hasta=2026-06-30`,
                            { headers: { Authorization: `Bearer ${jwt.sign({ user_id: 8 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` } });
    const cuerpoPdf = Buffer.from(await rep.arrayBuffer());
    llm.chat = chatDeVerdad2;

    assert.strictEqual(rep.status, 200, `el reporte dio ${rep.status}`);
    assert.strictEqual(rep.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(cuerpoPdf.subarray(0, 5).toString(), '%PDF-',
        'se anuncio application/pdf y el cuerpo no es un PDF');
    assert.ok(cupoDurante >= 1,
        `la llamada al LLM corrio con el cupo en ${cupoDurante}: esta fuera del contador`);
    paso(`la narrativa corre dentro del cupo (contador en ${cupoDurante}) y la descarga sale como PDF`);

    // Y el camino de error NO puede salir etiquetado como PDF: si las cabeceras
    // se escribieran antes de tiempo, el navegador se tragaria un JSON con
    // nombre de reporte.
    const malaFecha = await fetch(`http://localhost:${puerto}/api/ai/reporte?desde=ayer&hasta=hoy`,
                                  { headers: { Authorization: `Bearer ${jwt.sign({ user_id: 8 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` } });
    assert.notStrictEqual(malaFecha.status, 200);
    assert.ok(!/pdf/i.test(malaFecha.headers.get('content-type') || ''),
        `un error salio etiquetado como PDF: ${malaFecha.headers.get('content-type')}`);
    servidor.close();
    paso('un reporte que falla contesta JSON, no un PDF roto con nombre de reporte');

    // --- 3.4 el total no puede salir de contar las filas ---------------------
    // El bug que se vio en el navegador: "¿cuantas ordenes tengo en proceso?"
    // contestaba 50, 33 o 10 segun el dia. El 50 era el LIMIT, que el modelo
    // contaba y cantaba como total. Ahora el total viene en el dato.
    const verdad = Number((await pool.query(
        `SELECT count(*) FROM v_wo_status
          WHERE organization_id = ANY($1) AND status = 'IN_PROCESS'`,
        [deSpace.orgIds]
    )).rows[0].count);
    assert.ok(verdad > 5, `hacen falta mas de 5 ordenes IN_PROCESS para probar el truncado, hay ${verdad}`);

    const recortado = await ejecutarTool('listar_ordenes', { status: 'IN_PROCESS', limite: 5 }, { scope: deSpace });
    assert.strictEqual(recortado.ordenes.length, 5, 'el limite no se respeto');
    assert.strictEqual(recortado.total_encontrado, verdad, 'total_encontrado no es el total de verdad');
    assert.strictEqual(recortado.mostradas, 5);
    assert.strictEqual(recortado.hay_mas, true, 'con 5 de ' + verdad + ' hay_mas debe ser true');
    paso(`listar_ordenes recorta a 5 pero dice que hay ${verdad}`);

    // Y el total respeta el alcance: no es un count global disfrazado.
    const otraCompania = await ejecutarTool('listar_ordenes', { status: 'IN_PROCESS' }, { scope: deAO });
    assert.strictEqual(otraCompania.total_encontrado, 0, 'el total se salio del alcance');
    paso('total_encontrado respeta el alcance (otra compañia ve 0, no el total global)');

    // Sin truncar, hay_mas es false: si siempre dijera true, el bot avisaria de
    // filas que no existen.
    const completo = await ejecutarTool('listar_ordenes', { status: 'IN_PROCESS', limite: 50 }, { scope: deSpace });
    assert.strictEqual(completo.hay_mas, verdad > 50);
    paso(`hay_mas es ${completo.hay_mas} cuando caben las ${verdad} filas en el limite`);

    // Ninguna fila puede salir con la plomeria pegada.
    for (const tool of ['listar_ordenes', 'estado_sensores', 'paros_de_maquina']) {
        const r = await ejecutarTool(tool, { limite: 3 }, { scope: deSpace });
        const filas = r.ordenes || r.sensores || r.paros;
        assert.ok(Array.isArray(filas), `${tool} no devolvio filas`);
        assert.ok(filas.every((f) => !('_total' in f)), `${tool} deja _total en las filas`);
        assert.strictEqual(typeof r.total_encontrado, 'number', `${tool} no trae total_encontrado`);
    }
    paso('las 3 tools de lista traen total y no filtran el _total a las filas');

    // --- 3.5 las tools nuevas contestan lo que deben ------------------------
    const hist = await ejecutarTool('historico_sensor',
        { sensor: 'temperatura', maquina: 'DEV 4', puntos: 999 }, { scope: deSpace });
    assert.ok(hist.puntos.length > 0 && hist.puntos.length <= 30, 'el submuestreo no respeto el tope de 30');
    paso(`historico_sensor submuestrea a ${hist.puntos.length} puntos (pidieron 999)`);

    const tend = await ejecutarTool('tendencia_sensor',
        { sensor: 'temperatura', maquina: 'DEV 4' }, { scope: deSpace });
    assert.ok(Number.isFinite(Number(tend.r2)), 'no calculo R2');
    assert.ok(typeof tend.interpretacion === 'string');
    paso(`tendencia_sensor: R2=${tend.r2}, "${tend.interpretacion.slice(0, 40)}..."`);

    const turno = await ejecutarTool('turno_vigente', {}, { scope: deSpace });
    assert.ok(Array.isArray(turno.turnos_en_curso));
    paso(`turno_vigente resuelve contra v_shifts (${turno.turnos_en_curso.length} en curso)`);

    // La tool de OEE existe precisamente para dar esta respuesta. Sin ella el
    // modelo intentaria estimarlo con produccion y paros.
    const oee = await ejecutarTool('oee', {}, { scope: deSpace });
    assert.strictEqual(oee.disponible, false);
    assert.ok(/mes_kpis/.test(oee.motivo));
    paso('oee contesta "no disponible" con el motivo, no un numero inventado');

    const fechasMalas = await ejecutarTool('comparar_periodos',
        { a_desde: 'ayer', a_hasta: 'hoy', b_desde: 'x', b_hasta: 'y' }, { scope: deSpace });
    assert.ok(/fechas AAAA-MM-DD validas/.test(fechasMalas.error));
    paso('comparar_periodos rechaza fechas que no son fechas');

    // --- 4. ejecutarTool nunca lanza ---------------------------------------
    const inexistente = await ejecutarTool('borra_todo', {}, { scope: deSpace });
    assert.ok(inexistente.error && /No existe/.test(inexistente.error));
    const sinScope = await ejecutarTool('listar_ordenes', {}, {});
    assert.ok(sinScope.error, 'sin scope deberia devolver error, no datos');
    paso('herramienta inexistente y contexto sin alcance -> { error }, nunca una excepcion');

    // --- 5. el bucle, con un modelo de mentiras -----------------------------
    const chatReal = llm.chat;
    let vueltas = 0;
    llm.chat = async ({ messages }) => {
        vueltas++;
        if (vueltas === 1) {
            return {
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_1', type: 'function',
                        function: { name: 'panorama_planta', arguments: '{}' },
                    }],
                },
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
        }
        // La segunda vuelta ya trae el resultado de la herramienta.
        const ultimo = messages[messages.length - 1];
        assert.strictEqual(ultimo.role, 'tool');
        assert.ok(ultimo.content.includes('ordenes_por_estado'));
        return { message: { role: 'assistant', content: 'listo' }, usage: { prompt_tokens: 20, completion_tokens: 3 } };
    };

    const r = await conversar({
        scope: deSpace,
        credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' },
        pregunta: 'como esta la planta',
    });
    assert.strictEqual(r.texto, 'listo');
    assert.strictEqual(r.vueltas, 2);
    assert.deepStrictEqual(r.herramientasUsadas.map((h) => h.nombre), ['panorama_planta']);
    assert.strictEqual(r.tokens.prompt, 30);
    paso('el bucle ejecuta la herramienta, le devuelve el resultado al modelo y cierra');

    // Un modelo que se atora pidiendo herramientas para siempre no cuelga el
    // servidor: se corta en MAX_TOOL_LOOPS.
    llm.chat = async () => ({
        message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'x', type: 'function', function: { name: 'panorama_planta', arguments: '{}' } }],
        },
        usage: null,
    });
    const atorado = await conversar({
        scope: deSpace,
        credencial: { baseUrl: 'x', apiKey: 'x', model: 'x' },
        pregunta: 'dale',
    });
    assert.strictEqual(atorado.agotado, true);
    assert.strictEqual(atorado.herramientasUsadas.length, 10);
    paso('modelo en bucle infinito -> se corta en 10 vueltas y contesta algo');

    llm.chat = chatReal;

    console.log(`\n${ok}/${ok} pruebas del agente OK`);
}

main()
    .catch((e) => { console.error('\nFALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        Promise.allSettled([pool.end(), poolReadonly.end()])
            .finally(() => process.exit(process.exitCode || 0));
    });
