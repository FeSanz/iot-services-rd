#!/usr/bin/env node
/**
 * Pruebas de las dos observaciones de la revision:
 *   1. SSRF por base_url
 *   2. Ausencia de timeout de SQL
 *
 *   node --env-file=../.env scripts/test-endurecimiento.js
 *
 * No necesita el backend arriba. Las de SSRF que resuelven DNS necesitan salida
 * a internet.
 */
const assert = require('assert');
const pool = require('../database/pool');
const poolReadonly = require('../database/poolReadonly');
const { validarUrlDeProveedor, clasificar } = require('../services/ai/url-proveedor');
const { guardarCredencial, borrarCredencial } = require('../services/ai/credentials');
const llm = require('../services/ai/llm.client');
const { MENSAJES, porEstado } = llm;
const { responderError } = require('../services/ai/router');

// Cada forma de escribir la misma direccion. El bypass que se nos habia colado
// era este: Node normaliza "[::ffff:169.254.169.254]" a "::ffff:a9fe:a9fe", y
// una comprobacion contra el cuarteto decimal lo deja pasar.
const IPS = {
    siempre: [
        '169.254.169.254',          // metadatos AWS/GCP/Azure
        '::ffff:169.254.169.254',   // la misma, mapeada
        '::ffff:a9fe:a9fe',         // la misma, como la normaliza Node
        '::169.254.169.254',        // la misma, IPv4-compatible
        // Los metadatos no viven solo en 169.254.169.254. Estas tres caen dentro
        // de rangos que AI_ALLOW_PRIVATE_LLM_HOST abre, asi que sin nombrarlas
        // el interruptor de "mi Ollama esta en la LAN" entregaba credenciales.
        'fd00:ec2::254',            // metadatos de EC2 por IPv6
        'fd00:ec2:0:0:0:0:0:254',   // la misma, sin comprimir
        'fd00:eC2::254',            // la misma, en mayusculas
        '100.100.100.200',          // metadatos de Alibaba (dentro de CGNAT)
        '192.0.0.192',              // metadatos de Oracle (dentro de 192.0.0/24)
        // IPv4 embebida que la RED traduce al conectar: NAT64 (64:ff9b::/96) y
        // 6to4 (2002::/16). El envoltorio parece publico; lo que cuenta es la
        // IPv4 de dentro -- estas dos SON 169.254.169.254 con sombrero.
        '64:ff9b::a9fe:a9fe',       // metadatos via NAT64
        '2002:a9fe:a9fe::',         // metadatos via 6to4
        '0.0.0.0', '224.0.0.1', '::', 'fe80::1', 'ff02::1',
    ],
    privada: [
        '127.0.0.1', '::1', '::ffff:127.0.0.1',
        '10.0.0.5', '192.168.1.1', '172.16.0.1', '100.64.0.1', 'fd00::1',
        '64:ff9b::c0a8:101',        // 192.168.1.1 via NAT64
    ],
    publica: ['8.8.8.8', '1.1.1.1', '2606:4700::1', '::ffff:8.8.8.8',
              '64:ff9b::808:808'],  // 8.8.8.8 via NAT64: publica de verdad
};

async function main() {
    let ok = 0;
    const paso = (t) => { ok++; console.log('  ok  ', t); };
    const flagOriginal = process.env.AI_ALLOW_PRIVATE_LLM_HOST;

    // --- 1. clasificacion de direcciones ------------------------------------
    for (const ip of IPS.siempre) assert.strictEqual(clasificar(ip), 'siempre', ip);
    for (const ip of IPS.privada) assert.strictEqual(clasificar(ip), 'privada', ip);
    for (const ip of IPS.publica) assert.strictEqual(clasificar(ip), null, ip);
    paso(`${IPS.siempre.length + IPS.privada.length + IPS.publica.length} direcciones clasificadas bien, en todas sus escrituras`);

    // --- 2. el interruptor de LAN no abre los metadatos ---------------------
    // Es lo importante del diseño de dos niveles: encender "mi Ollama esta en
    // la LAN" NO puede ser tambien "puedes pedirle credenciales a la nube".
    process.env.AI_ALLOW_PRIVATE_LLM_HOST = 'true';
    for (const ip of IPS.siempre) {
        await assert.rejects(
            () => validarUrlDeProveedor(`http://${ip.includes(':') ? `[${ip}]` : ip}/v1`),
            /nunca se permite/,
            `${ip} paso con el flag encendido`
        );
    }
    await validarUrlDeProveedor('http://127.0.0.1:11434/v1');
    await validarUrlDeProveedor('http://192.168.1.50:11434/v1');
    paso('con AI_ALLOW_PRIVATE_LLM_HOST=true pasa la LAN pero NUNCA los metadatos');

    // --- 3. apagado, que es como sale de fabrica ----------------------------
    process.env.AI_ALLOW_PRIVATE_LLM_HOST = 'false';
    for (const ip of [...IPS.siempre, ...IPS.privada]) {
        await assert.rejects(() => validarUrlDeProveedor(`https://${ip.includes(':') ? `[${ip}]` : ip}/v1`));
    }
    paso('apagado (lo normal): ni metadatos ni red privada');

    // --- 4. lo demas que puede venir en una caja de texto -------------------
    await assert.rejects(() => validarUrlDeProveedor('file:///etc/passwd'), /Protocolo no permitido/);
    await assert.rejects(() => validarUrlDeProveedor('gopher://x/1'), /Protocolo no permitido/);
    await assert.rejects(() => validarUrlDeProveedor('https://u:p@api.groq.com/v1'), /usuario ni contraseña/);
    await assert.rejects(() => validarUrlDeProveedor('http://api.groq.com/v1'), /Solo se permite https/);
    await assert.rejects(() => validarUrlDeProveedor('no soy una url'), /no es una URL valida/);
    await assert.rejects(() => validarUrlDeProveedor(''), /Falta la URL/);
    await assert.rejects(() => validarUrlDeProveedor('https://esto.no.existe.invalido/v1'), /No se pudo resolver/);
    paso('protocolo raro, credenciales en la URL, http pelado y host que no resuelve');

    // --- 5. y no se puede GUARDAR una credencial asi ------------------------
    // La validacion tiene que estar en los dos lados. Si solo estuviera al
    // llamar, la URL mala quedaria guardada esperando a que alguien pregunte.
    await assert.rejects(
        () => guardarCredencial({
            companyId: 3, provider: 'ollama', apiKey: 'x',
            baseUrl: 'http://169.254.169.254/v1', userId: 5,
        }),
        /nunca se permite|Solo se permite https/
    );
    paso('guardar una credencial con base_url interna -> rechazada en la puerta');

    process.env.AI_ALLOW_PRIVATE_LLM_HOST = flagOriginal;

    // --- 6. el timeout de SQL ----------------------------------------------
    const esperado = Number(process.env.AI_STATEMENT_TIMEOUT_MS || 15000);
    const { rows } = await poolReadonly.query('SHOW statement_timeout');
    assert.strictEqual(rows[0].statement_timeout, `${esperado / 1000}s`);
    paso(`el pool del bot abre sus sesiones con statement_timeout=${rows[0].statement_timeout}`);

    // Y de verdad corta, no solo esta configurado.
    const t0 = Date.now();
    await assert.rejects(
        () => poolReadonly.query('SELECT pg_sleep(60)'),
        /statement timeout|canceling statement/i
    );
    const tardo = Date.now() - t0;
    assert.ok(tardo < esperado + 3000, `tardo ${tardo} ms en cortar`);
    paso(`una consulta de 60 s se corta a los ${(tardo / 1000).toFixed(1)} s`);

    // El pool de la aplicacion NO lleva timeout: el MES tiene endpoints que
    // tardan y no es nuestro lugar cambiarles el comportamiento.
    const app = await pool.query('SHOW statement_timeout');
    assert.strictEqual(app.rows[0].statement_timeout, '0');
    paso('el pool de la aplicacion sigue sin timeout: no se le toco nada al MES');

    // --- el error del proveedor no se le enseña crudo al usuario -----------
    // Lo que se veia en la burbuja con una llave mala:
    //   El proveedor respondio 401: {"error":{"message":"Unauthorized",...}}
    assert.strictEqual(porEstado(401), 'LLM_AUTH');
    assert.strictEqual(porEstado(403), 'LLM_AUTH');
    // Un 400 por un modelo que no existe o un 404 por una base_url mal escrita
    // son, para quien pregunta, lo mismo que un 401: esta mal configurado.
    assert.strictEqual(porEstado(400), 'LLM_AUTH');
    assert.strictEqual(porEstado(404), 'LLM_AUTH');
    assert.strictEqual(porEstado(429), 'LLM_CUPO');
    assert.strictEqual(porEstado(500), 'LLM_CAIDO');
    assert.strictEqual(porEstado(503), 'LLM_CAIDO');
    paso('cada estado del proveedor cae en su caso (auth, cupo, caido)');

    // 408 y sus primos son "se acabo el tiempo", no "esta mal configurado":
    // caian en el cajon de los 4xx y mandaban al usuario a llamar a soporte
    // cuando lo que tenia que hacer era volver a intentar.
    assert.strictEqual(porEstado(408), 'LLM_MUDO');
    assert.strictEqual(porEstado(504), 'LLM_MUDO');
    assert.strictEqual(porEstado(524), 'LLM_MUDO');
    paso('408, 504 y 524 se cuentan como "no responde", no como mala configuracion');

    // Ninguno de los cinco puede llevar dentro el error del proveedor.
    for (const [codigo, texto] of Object.entries(MENSAJES)) {
        assert.ok(texto && texto.length > 10, `${codigo} sin mensaje`);
        assert.ok(!/[{}"]|respondio|Unauthorized|http/i.test(texto),
            `${codigo} le ensena tripas al usuario: ${texto}`);
    }
    paso(`los ${Object.keys(MENSAJES).length} mensajes son legibles y ninguno trae tripas`);

    // Y el router: el detalle al log, el mensaje al usuario.
    const falso = {
        codigo: 'LLM_AUTH',
        publico: MENSAJES.LLM_AUTH,
        status: 502,
        message: 'El proveedor respondio 401: {"error":{"message":"Unauthorized"}}',
    };
    let enviado = null;
    const resFalso = { status(c) { this.codigoHttp = c; return this; }, json(j) { enviado = j; } };
    const errorReal = console.error;
    let registrado = '';
    console.error = (...a) => { registrado = a.join(' '); };
    try {
        responderError(resFalso, falso, 'POST /ai/chat');
    } finally {
        console.error = errorReal;
    }
    assert.strictEqual(resFalso.codigoHttp, 502, 'un fallo del proveedor no es 500 nuestro');
    assert.strictEqual(enviado.message, MENSAJES.LLM_AUTH);
    assert.strictEqual(enviado.codigo, 'LLM_AUTH', 'soporte no sabe cual de los cinco fue');
    assert.ok(!/Unauthorized|respondio 401/.test(JSON.stringify(enviado)),
        `el detalle del proveedor viajo al cliente: ${JSON.stringify(enviado)}`);
    assert.ok(/Unauthorized/.test(registrado), 'el detalle tampoco quedo en el log');
    paso('el detalle se queda en el log y al usuario le llega el mensaje y el codigo');

    // Los errores de siempre no se tocan: ya nacen redactados para leerse.
    let normal = null;
    responderError({ status(c) { this.codigoHttp = c; return this; }, json(j) { normal = j; } },
                   Object.assign(new Error('Compania fuera de alcance'), { status: 403 }), 'x');
    assert.strictEqual(normal.message, 'Compania fuera de alcance');
    assert.strictEqual(normal.codigo, undefined);
    paso('un error normal del router sigue pasando tal cual, sin codigo');

    // --- el tope por llamada vale aunque el agente pase el suyo -----------
    // El agente manda SIEMPRE su corte de AGENT_MAX_SECONDS en cada vuelta
    // (agent.js:71). Con `signal || AbortSignal.timeout(...)` el `||` nunca
    // llegaba al segundo y LLM_TIMEOUT_MS era configuracion muerta: una sola
    // llamada colgada se comia el presupuesto entero del agente.
    //
    // Se observa de verdad: un servidor que no contesta nunca, un tope de la
    // llamada corto y uno del agente largo. Tiene que cortar el corto.
    const http = require('http');
    const mudo = http.createServer(() => { /* nunca responde */ });
    await new Promise((r) => mudo.listen(0, '127.0.0.1', r));
    const puerto = mudo.address().port;

    const antesTope = process.env.LLM_TIMEOUT_MS;
    const antesPrivado = process.env.AI_ALLOW_PRIVATE_LLM_HOST;
    process.env.LLM_TIMEOUT_MS = '800';
    process.env.AI_ALLOW_PRIVATE_LLM_HOST = 'true';   // 127.0.0.1 es privada
    delete require.cache[require.resolve('../services/ai/llm.client')];
    const llmCorto = require('../services/ai/llm.client');

    const deAgente = AbortSignal.timeout(20000);      // el del agente, largo
    const t0Corte = Date.now();
    await assert.rejects(
        () => llmCorto.chat({
            baseUrl: `http://127.0.0.1:${puerto}/v1`,
            apiKey: 'x', model: 'x', messages: [], signal: deAgente,
        }),
        (e) => e.codigo === 'LLM_MUDO' && e.status === 502,
        'no corto, o no lo conto como "no responde"'
    );
    const tardoCorte = Date.now() - t0Corte;
    mudo.close();
    if (antesTope === undefined) delete process.env.LLM_TIMEOUT_MS; else process.env.LLM_TIMEOUT_MS = antesTope;
    if (antesPrivado === undefined) delete process.env.AI_ALLOW_PRIVATE_LLM_HOST; else process.env.AI_ALLOW_PRIVATE_LLM_HOST = antesPrivado;
    delete require.cache[require.resolve('../services/ai/llm.client')];

    assert.ok(tardoCorte < 5000,
        `el tope de la llamada no se aplico: tardo ${tardoCorte} ms con el del agente en 20 s`);
    assert.ok(!deAgente.aborted, 'corto el del agente, no el de la llamada');
    paso(`el tope por llamada corta a los ${tardoCorte} ms aunque el agente traiga uno de 20 s`);

    await borrarCredencial(3, 'ollama').catch(() => {});
    console.log(`\n${ok}/${ok} pruebas de endurecimiento OK`);
}

main()
    .catch((e) => { console.error('\nFALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        Promise.allSettled([pool.end(), poolReadonly.end()])
            .finally(() => process.exit(process.exitCode || 0));
    });
