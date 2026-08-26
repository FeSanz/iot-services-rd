#!/usr/bin/env node
/**
 * Pruebas de la boveda de llaves del LLM (ETAPA 3.5, plan 7.4).
 *
 *   node --env-file=../.env index.js          # en otra terminal
 *   node --env-file=../.env scripts/test-credenciales.js
 *
 * Necesita el backend arriba porque la mitad de lo que hay que probar son las
 * negativas del endpoint, no del modulo: que un Admin no pueda configurar la
 * llave y que nadie toque la compañia de al lado.
 *
 * Deja la base como la encontro: borra lo que crea.
 */
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../database/pool');
const poolReadonly = require('../database/poolReadonly');
const cred = require('../services/ai/credentials');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Usuarios reales de la base local:
//   5  SuperAdmin de la compañia 3 (AO)      -> si puede configurar
//   8  Admin      de la compañia 1 (SPACE)   -> no puede
//   4  SuperAdmin de la compañia 4           -> puede, pero solo la suya
const COMPANIA_PRUEBA = 3;
const LLAVE_PRUEBA = 'gsk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

const token = (userId) =>
    jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });

async function pedir(metodo, ruta, userId, cuerpo) {
    const r = await fetch(`${BASE_URL}${ruta}`, {
        method: metodo,
        headers: {
            Authorization: `Bearer ${token(userId)}`,
            'Content-Type': 'application/json',
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
    let ok = 0;
    const paso = (t) => { ok++; console.log('  ok  ', t); };

    // --- el cifrado ---------------------------------------------------------
    const caja = cred.cifrar(LLAVE_PRUEBA);
    assert.strictEqual(cred.descifrar(caja), LLAVE_PRUEBA);
    assert.ok(!caja.ciphertext.toString('utf8').includes('gsk_'), 'la llave asoma en el ciphertext');
    paso('cifrar/descifrar va y vuelve, y el ciphertext no deja ver la llave');

    const otra = cred.cifrar(LLAVE_PRUEBA);
    assert.notDeepStrictEqual(caja.iv, otra.iv, 'IV repetido: eso rompe GCM por completo');
    assert.notDeepStrictEqual(caja.ciphertext, otra.ciphertext);
    paso('cada escritura usa un IV distinto');

    // GCM es autenticado: alterar la base tiene que FALLAR, no devolver basura.
    const manipulado = { ...caja, ciphertext: Buffer.from(caja.ciphertext) };
    manipulado.ciphertext[0] ^= 0xff;
    assert.throws(() => cred.descifrar(manipulado));
    paso('ciphertext manipulado -> el descifrado falla, no devuelve basura');

    const maestraOriginal = process.env.AI_CRED_MASTER_KEY;
    process.env.AI_CRED_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    assert.throws(() => cred.descifrar(caja));
    process.env.AI_CRED_MASTER_KEY = 'muy-corta';
    assert.throws(() => cred.cifrar('x'), /32 bytes/);
    delete process.env.AI_CRED_MASTER_KEY;
    assert.throws(() => cred.cifrar('x'), /sin definir/);
    process.env.AI_CRED_MASTER_KEY = maestraOriginal;
    paso('sin la llave maestra correcta no se descifra nada');

    // --- redaccion ----------------------------------------------------------
    const suciedad = `fallo la peticion con api_key=${LLAVE_PRUEBA} y Authorization: Bearer ${LLAVE_PRUEBA}`;
    const limpio = cred.redactar(suciedad);
    assert.ok(!limpio.includes(LLAVE_PRUEBA.slice(4)), 'la llave sobrevivio a redactar()');
    assert.ok(limpio.includes('[REDACTADO]'));
    paso('redactar() tapa la llave en mensajes de error');

    // --- la tabla no la ve el bot -------------------------------------------
    await assert.rejects(
        () => poolReadonly.query('SELECT * FROM mes_ai_credentials LIMIT 1'),
        /permission denied|permiso denegado/i
    );
    paso('el rol del bot no puede leer mes_ai_credentials');

    // --- guardar, describir, obtener ----------------------------------------
    await cred.borrarCredencial(COMPANIA_PRUEBA, 'groq');  // por si quedo de antes

    const guardada = await cred.guardarCredencial({
        companyId: COMPANIA_PRUEBA,
        provider: 'groq',
        apiKey: LLAVE_PRUEBA,
        model: 'openai/gpt-oss-120b',
        userId: 5,
    });
    assert.strictEqual(guardada.last4, LLAVE_PRUEBA.slice(-4));
    assert.ok(!JSON.stringify(guardada).includes(LLAVE_PRUEBA), 'guardarCredencial devolvio la llave');
    paso('guardar devuelve last4 y nunca la llave');

    const enLaBase = (await pool.query(
        'SELECT * FROM mes_ai_credentials WHERE company_id = $1 AND provider = $2',
        [COMPANIA_PRUEBA, 'groq']
    )).rows[0];
    const todaLaFila = Object.values(enLaBase).map((v) =>
        Buffer.isBuffer(v) ? v.toString('binary') : String(v)).join(' ');
    assert.ok(!todaLaFila.includes(LLAVE_PRUEBA), 'la llave quedo en texto plano en alguna columna');
    paso('ninguna columna de la fila guarda la llave en claro');

    const recuperada = await cred.obtenerCredencial(COMPANIA_PRUEBA, 'groq');
    assert.strictEqual(recuperada.apiKey, LLAVE_PRUEBA);
    assert.strictEqual(recuperada.model, 'openai/gpt-oss-120b');
    paso('obtenerCredencial devuelve la llave original');

    // Rotar: mismo par (compañia, proveedor) no duplica fila.
    const LLAVE_NUEVA = 'gsk_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4';
    await cred.guardarCredencial({
        companyId: COMPANIA_PRUEBA, provider: 'groq', apiKey: LLAVE_NUEVA, userId: 5,
    });
    const cuantas = Number((await pool.query(
        'SELECT count(*) c FROM mes_ai_credentials WHERE company_id = $1 AND provider = $2',
        [COMPANIA_PRUEBA, 'groq'])).rows[0].c);
    assert.strictEqual(cuantas, 1);
    assert.strictEqual((await cred.obtenerCredencial(COMPANIA_PRUEBA, 'groq')).apiKey, LLAVE_NUEVA);
    paso('rotar la llave reemplaza la fila, no la duplica');

    // --- validaciones -------------------------------------------------------
    const rechaza = async (args, patron) =>
        assert.rejects(() => cred.guardarCredencial({ companyId: COMPANIA_PRUEBA, userId: 5, ...args }), patron);

    await rechaza({ provider: 'inventado', apiKey: 'x' }, /no soportado/);
    await rechaza({ provider: 'groq', apiKey: '' }, /vacia/);
    await rechaza({ provider: 'groq', apiKey: 'sk-loquesea1234567890' }, /deberia empezar/);
    await rechaza({ provider: 'groq', apiKey: 'gsk_corta' }, /demasiado corta/);
    paso('rechaza proveedor desconocido, llave vacia, prefijo malo y llave corta');

    // ollama no pide llave real, pero su base_url si pasa por el filtro de SSRF:
    // un Ollama en localhost es legitimo y hay que encenderlo a proposito.
    const LOCAL = { companyId: COMPANIA_PRUEBA, provider: 'ollama', apiKey: 'ollama',
                    model: 'gpt-oss:20b', baseUrl: 'http://localhost:11434/v1', userId: 5 };
    const flagOriginal = process.env.AI_ALLOW_PRIVATE_LLM_HOST;

    process.env.AI_ALLOW_PRIVATE_LLM_HOST = 'false';
    await assert.rejects(() => cred.guardarCredencial(LOCAL), /Solo se permite https/);

    process.env.AI_ALLOW_PRIVATE_LLM_HOST = 'true';
    await cred.guardarCredencial(LOCAL);
    process.env.AI_ALLOW_PRIVATE_LLM_HOST = flagOriginal;
    paso('ollama se guarda sin prefijo de llave, pero su base_url local exige el flag');

    // --- el endpoint --------------------------------------------------------
    const admin = await pedir('GET', '/api/ai/credentials', 8);
    assert.strictEqual(admin.status, 403);
    paso('un Admin (no SuperAdmin) recibe 403');

    const superAdmin = await pedir('GET', '/api/ai/credentials', 5);
    assert.strictEqual(superAdmin.status, 200);
    assert.strictEqual(superAdmin.json.items.length, 2);
    const cuerpo = JSON.stringify(superAdmin.json);
    for (const prohibido of ['ciphertext', 'iv', 'auth_tag', LLAVE_NUEVA]) {
        assert.ok(!cuerpo.includes(prohibido), `la respuesta expone ${prohibido}`);
    }
    paso('el SuperAdmin ve provider/model/last4 y nada mas');

    // La compañia sale del token. El usuario 5 es de la 3; pedir la 1 no cuela
    // aunque la 1 exista y tenga llaves.
    const ajena = await pedir('GET', '/api/ai/credentials?company_id=1', 5);
    assert.strictEqual(ajena.status, 403);
    paso('pedir la compañia de al lado -> 403, aunque exista');

    const guardadaHttp = await pedir('POST', '/api/ai/credentials', 5, {
        provider: 'openai', api_key: 'sk-' + 'q'.repeat(30), model: 'gpt-4o-mini',
    });
    assert.strictEqual(guardadaHttp.status, 200);
    assert.ok(!JSON.stringify(guardadaHttp.json).includes('q'.repeat(30)));
    paso('POST guarda por HTTP y no devuelve la llave');

    const sinToken = await fetch(`${BASE_URL}/api/ai/credentials`);
    assert.strictEqual(sinToken.status, 401);
    paso('sin token -> 401');

    // --- limpieza -----------------------------------------------------------
    for (const p of ['groq', 'ollama', 'openai']) {
        await cred.borrarCredencial(COMPANIA_PRUEBA, p);
    }
    const quedan = Number((await pool.query(
        'SELECT count(*) c FROM mes_ai_credentials WHERE company_id = $1',
        [COMPANIA_PRUEBA])).rows[0].c);
    assert.strictEqual(quedan, 0);
    paso('limpieza: la base queda como estaba');

    console.log(`\n${ok}/${ok} pruebas de credenciales OK`);
}

main()
    .catch((e) => { console.error('\nFALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        Promise.allSettled([pool.end(), poolReadonly.end()])
            .finally(() => process.exit(process.exitCode || 0));
    });
