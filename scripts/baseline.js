#!/usr/bin/env node
/**
 * baseline.js — foto de no-regresion de la API (paso 0.6 del plan del bot).
 *
 * Recorre TODAS las rutas GET del backend contra un servidor que ya este corriendo
 * y guarda, por cada una, solo la FORMA de la respuesta:
 *
 *     { ruta, status, claves, filas }
 *
 * No guarda valores. Asi el diff entre dos corridas no falla porque cambiaron los
 * datos, solo si cambio el contrato.
 *
 * Las rutas NO se copian de ningun documento: se leen del stack de Express de los
 * routers que index.js monta de verdad. Es la unica fuente que no se desactualiza,
 * y descarta los archivos router que existen pero nadie monta.
 *
 * Uso:
 *   1. levantar el backend:  node --env-file=../.env index.js
 *   2. node --env-file=../.env scripts/baseline.js [etiqueta]
 *
 * Salida: scripts/baseline-<etiqueta>.json  (por defecto la etiqueta es la fecha)
 *
 * Comparar dos corridas:
 *   node --env-file=../.env scripts/baseline.js --diff antes despues
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const RAIZ = path.resolve(__dirname, '..');
const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const SALIDA = __dirname;

// ---------------------------------------------------------------- utilidades

const leerJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Claves de primer nivel, ordenadas. Para arrays, las claves del primer elemento. */
function forma(valor) {
    if (Array.isArray(valor)) {
        return valor.length ? forma(valor[0]).map((k) => `[].${k}`) : [];
    }
    if (valor && typeof valor === 'object') return Object.keys(valor).sort();
    return [];
}

/** Cuenta filas si la respuesta trae una coleccion; si no, null. */
function filas(cuerpo) {
    if (Array.isArray(cuerpo)) return cuerpo.length;
    if (cuerpo && typeof cuerpo === 'object') {
        for (const k of ['items', 'rows', 'data', 'result']) {
            if (Array.isArray(cuerpo[k])) return cuerpo[k].length;
        }
    }
    return null;
}

// ------------------------------------------------- 1. rutas reales de Express

/**
 * Saca las rutas del stack de Express, pero SOLO de los routers que index.js
 * monta de verdad.
 *
 * Recorrer services/ a ciegas no sirve: hay archivos router que existen pero
 * nadie monta (services/iot/sensor_data_original.js es uno) y sus rutas no son
 * alcanzables. Contarlas produce una foto con rutas fantasma.
 *
 * Cargar estos modulos tiene efectos secundarios (abre el broker MQTT, el
 * WebSocket, el transporte SMTP), por eso este proceso SIEMPRE termina con
 * process.exit(): si no, el event loop nunca se vacia y el script se cuelga.
 */
function rutasDeExpress() {
    const index = fs.readFileSync(path.join(RAIZ, 'index.js'), 'utf8');

    // app.use('/api', require('./services/iot/machines'));
    const montados = [...index.matchAll(/app\.use\(\s*'([^']*)'\s*,\s*require\('(\.\/services\/[^']+)'\)/g)]
        .map((m) => ({ prefijo: m[1], modulo: m[2] }));

    if (!montados.length) throw new Error('no se detecto ningun router montado en index.js');

    const encontradas = [];
    for (const { prefijo, modulo } of montados) {
        const archivo = path.resolve(RAIZ, modulo);
        let mod;
        try { mod = require(archivo); } catch { continue; }
        if (!mod || !Array.isArray(mod.stack)) continue;

        for (const capa of mod.stack) {
            if (!capa.route) continue;
            for (const metodo of Object.keys(capa.route.methods)) {
                encontradas.push({
                    metodo: metodo.toUpperCase(),
                    ruta: capa.route.path,
                    prefijo,
                    archivo: modulo.replace('./', ''),
                });
            }
        }
    }
    return encontradas;
}

// ------------------------------------------- 2. valores reales para los :params

/**
 * Los :params se rellenan con IDs que existen de verdad en la base, no con "1".
 * Un ID inventado devuelve 200 con lista vacia y la foto sale mentirosa.
 */
async function valoresDeParametros(pool) {
    const uno = async (sql, porDefecto) => {
        try {
            const { rows } = await pool.query(sql);
            return rows.length ? String(Object.values(rows[0])[0]) : porDefecto;
        } catch { return porDefecto; }
    };

    return {
        userId:        await uno('SELECT user_id FROM mes_users ORDER BY 1 LIMIT 1', '1'),
        userID:        await uno('SELECT user_id FROM mes_users ORDER BY 1 LIMIT 1', '1'),
        user_id:       await uno('SELECT user_id FROM mes_users ORDER BY 1 LIMIT 1', '1'),
        company:       await uno('SELECT company_id FROM mes_companies ORDER BY 1 LIMIT 1', '1'),
        companyId:     await uno('SELECT company_id FROM mes_companies ORDER BY 1 LIMIT 1', '1'),
        organization:  await uno('SELECT organization_id FROM mes_organizations ORDER BY 1 LIMIT 1', '1'),
        organizationId:await uno('SELECT organization_id FROM mes_organizations ORDER BY 1 LIMIT 1', '1'),
        machineId:     await uno('SELECT machine_id FROM mes_machines ORDER BY 1 LIMIT 1', '1'),
        machineID:     await uno('SELECT machine_id FROM mes_machines ORDER BY 1 LIMIT 1', '1'),
        // El sensor NO se elige por ID mas bajo: se elige el que mas lecturas tiene
        // dentro de la ventana que usa la foto. Con uno sin datos, endpoints como
        // /sensorsData/export responden 404 "No se encontraron datos" y parecen rotos.
        sensorId:      await uno("SELECT sensor_id FROM mes_sensor_data "
            + "WHERE date_time >= '2026-06-01' AND date_time < '2026-06-20' "
            + "GROUP BY 1 ORDER BY count(*) DESC LIMIT 1", '1'),
        sensorID:      await uno("SELECT sensor_id FROM mes_sensor_data "
            + "WHERE date_time >= '2026-06-01' AND date_time < '2026-06-20' "
            + "GROUP BY 1 ORDER BY count(*) DESC LIMIT 1", '1'),
        groupId:       await uno('SELECT dashboard_group_id FROM mes_dashboards_group ORDER BY 1 LIMIT 1', '1'),
        dashboardId:   await uno('SELECT dashboard_id FROM mes_dashboards ORDER BY 1 LIMIT 1', '1'),
        workOrderId:   await uno('SELECT work_order_id FROM mes_work_orders ORDER BY 1 LIMIT 1', '1'),
        itemId:        await uno('SELECT item_id FROM mes_items ORDER BY 1 LIMIT 1', '1'),
        alertId:       await uno('SELECT alert_id FROM mes_alerts ORDER BY 1 LIMIT 1', '1'),
        id:            await uno('SELECT alert_id FROM mes_alerts ORDER BY 1 LIMIT 1', '1'),
        machId:        await uno('SELECT machine_id FROM mes_machines ORDER BY 1 LIMIT 1', '1'),
        organization_id: await uno('SELECT organization_id FROM mes_organizations ORDER BY 1 LIMIT 1', '1'),
        machineToken:  await uno("SELECT token FROM mes_machines WHERE token IS NOT NULL LIMIT 1", 'sin-token'),
        campaign_id:   await uno('SELECT campaign_id FROM mes_campaigns ORDER BY 1 LIMIT 1', '1'),
        work_center_id:await uno('SELECT work_center_id FROM mes_work_centers ORDER BY 1 LIMIT 1', '1'),
        wc:            await uno('SELECT work_center_id FROM mes_work_centers ORDER BY 1 LIMIT 1', '1'),
        workDispatchId:await uno('SELECT work_dispatch_id FROM mes_work_dispatch ORDER BY 1 LIMIT 1', '1'),
        workOrderNumber: await uno("SELECT work_order_number FROM mes_work_orders WHERE work_order_number IS NOT NULL LIMIT 1", 'SIN-NUMERO'),
        code:          await uno("SELECT code FROM mes_verification_codes LIMIT 1", '000000'),
        type:          await uno("SELECT DISTINCT type FROM mes_work_orders WHERE type IS NOT NULL LIMIT 1", '1'),
        // La ingesta murio el 2026-06-18; anclar a esa ventana, no a now().
        interval:      '30days',   // valores validos: today|24hours|7days|week|30days|month
        startDate:     '2026-06-01',
        endDate:       '2026-06-19',
    };
}

/**
 * Muchos endpoints piden el alcance por QUERY STRING (req.query.organizations,
 * req.query.user_id...) y sin el devuelven 400. Sin esto la foto seria inutil:
 * un 400 no dice nada del contrato. Los nombres salen de grepear req.query en
 * services/, no de adivinar.
 */
async function valoresDeQuery(pool, valores) {
    const lista = async (sql, porDefecto) => {
        try {
            const { rows } = await pool.query(sql);
            return rows.length ? rows.map((r) => Object.values(r)[0]).join(',') : porDefecto;
        } catch { return porDefecto; }
    };

    const orgs    = await lista('SELECT organization_id FROM mes_organizations ORDER BY 1 LIMIT 5', '1');
    const sensors = await lista("SELECT sensor_id FROM mes_sensor_data "
        + "WHERE date_time >= '2026-06-01' AND date_time < '2026-06-20' "
        + "GROUP BY 1 ORDER BY count(*) DESC LIMIT 5", '1');

    // La ingesta de sensores murio el 2026-06-18: una ventana contra now() sale
    // vacia y la foto no probaria nada. Se ancla a datos que existen de verdad.
    const inicio = '2026-06-01', fin = '2026-06-19';

    return {
        organizations: orgs,
        organization_id: valores.organization,
        company_id: valores.company,
        user_id: valores.userId,
        sensorIDs: sensors,
        sensors,
        sensor: valores.sensorId,   // el mismo con datos que arriba
        sensor_id: valores.sensorId,
        start: inicio, end: fin,
        startDate: inicio, endDate: fin,
        start_date: inicio, end_date: fin,
        period: 'day',
        aggregation: 'avg',
        limit: '10',
        tzOffset: '0',
        type: '1',
        Status: 'SUCCESS',   // enum: SUCCESS|PARTIAL_ERROR|ERROR
    };
}

/**
 * Un mismo nombre de query param significa cosas distintas segun el endpoint:
 * `type` es el formato de salida en /sensorsData/export ('excel'|'pdf') y un tipo
 * de orden en otros. Mandar un unico valor global deja al export en 400. Estos
 * overrides se aplican encima del query string comun.
 */
const OVERRIDES_QUERY = {
    '/sensorsData/export': { type: 'excel', period: 'hour' },
};

/** Sustituye :params. Devuelve null si algun parametro no tiene valor conocido. */
function concretar(ruta, valores) {
    let faltante = null;
    const url = ruta.replace(/:(\w+)/g, (_, nombre) => {
        const v = valores[nombre];
        if (v === undefined) { faltante = nombre; return ':' + nombre; }
        return encodeURIComponent(v);
    });
    return faltante ? { url: null, faltante } : { url, faltante: null };
}

// ----------------------------------------------------------------- 3. captura

async function token() {
    const r = await fetch(`${BASE_URL}/api/getToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    const j = await r.json();
    // OJO: este endpoint entrega un JWT de SuperAdmin sin pedir credenciales.
    // Es un hallazgo de seguridad documentado; aqui se aprovecha para la foto.
    if (!j.token) throw new Error('POST /api/getToken no devolvio token');
    return j.token;
}

async function capturar(etiqueta) {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: /@(localhost|127\.0\.0\.1|\[::1\]|db)(:|\/)/.test(process.env.DATABASE_URL || '')
            ? false : { rejectUnauthorized: false },
    });

    const todas = rutasDeExpress();
    const gets = todas.filter((r) => r.metodo === 'GET');
    const valores = await valoresDeParametros(pool);
    const query = await valoresDeQuery(pool, valores);
    const qs = new URLSearchParams(query).toString();
    await pool.end();

    console.log(`rutas en el router: ${todas.length} (${gets.length} GET)`);
    console.log(`servidor: ${BASE_URL}`);

    const jwt = await token();
    const resultados = [];
    let ok = 0, fallos = 0, omitidas = 0;

    for (const r of gets.sort((a, b) => a.ruta.localeCompare(b.ruta))) {
        const { url, faltante } = concretar(r.ruta, valores);
        if (!url) {
            omitidas++;
            resultados.push({ ruta: r.ruta, archivo: r.archivo, omitida: `sin valor para :${faltante}` });
            continue;
        }

        // Se mandan TODOS los query params conocidos siempre. Los que el endpoint
        // no usa los ignora; los que necesita ya van puestos.
        const propios = OVERRIDES_QUERY[r.ruta]
            ? new URLSearchParams({ ...query, ...OVERRIDES_QUERY[r.ruta] }).toString()
            : qs;
        const destino = `${BASE_URL}${r.prefijo}${url}?${propios}`;
        try {
            const resp = await fetch(destino, { headers: { Authorization: `Bearer ${jwt}` } });
            const texto = await resp.text();
            let cuerpo = null;
            try { cuerpo = JSON.parse(texto); } catch { /* no es JSON */ }

            resultados.push({
                ruta: r.ruta,
                archivo: r.archivo,
                probada: url,
                status: resp.status,
                json: cuerpo !== null,
                claves: cuerpo !== null ? forma(cuerpo) : [],
                filas: cuerpo !== null ? filas(cuerpo) : null,
            });
            resp.status < 400 ? ok++ : fallos++;
        } catch (e) {
            resultados.push({ ruta: r.ruta, archivo: r.archivo, probada: url, error: e.message });
            fallos++;
        }
    }

    const foto = {
        generado: new Date().toISOString(),
        base_url: BASE_URL,
        totales: { get: gets.length, ok, fallos, omitidas },
        endpoints: resultados,
    };

    const destino = path.join(SALIDA, `baseline-${etiqueta}.json`);
    fs.writeFileSync(destino, JSON.stringify(foto, null, 2));
    console.log(`\nOK: ${ok}  |  con error: ${fallos}  |  omitidas: ${omitidas}`);
    console.log(`escrito: ${path.relative(RAIZ, destino).split(path.sep).join('/')}`);

    const rotas = resultados.filter((r) => r.status >= 400 || r.error);
    if (rotas.length) {
        console.log(`\nFALLAS PREEXISTENTES (${rotas.length}) — se anotan, no se arreglan aqui:`);
        for (const r of rotas) console.log(`  ${r.status || 'ERR'}  ${r.ruta}  (${r.archivo})`);
    }
    return foto;
}

// -------------------------------------------------------------------- 4. diff

function diff(a, b) {
    const A = leerJson(path.join(SALIDA, `baseline-${a}.json`));
    const B = leerJson(path.join(SALIDA, `baseline-${b}.json`));
    const porRuta = (f) => new Map(f.endpoints.map((e) => [e.ruta, e]));
    const ma = porRuta(A), mb = porRuta(B);
    const cambios = [];

    for (const [ruta, ea] of ma) {
        const eb = mb.get(ruta);
        if (!eb) { cambios.push(`DESAPARECIO  ${ruta}`); continue; }
        if (ea.status !== eb.status) cambios.push(`STATUS       ${ruta}: ${ea.status} -> ${eb.status}`);
        const ca = (ea.claves || []).join(','), cb = (eb.claves || []).join(',');
        if (ca !== cb) cambios.push(`CLAVES       ${ruta}: [${ca}] -> [${cb}]`);
    }
    for (const ruta of mb.keys()) if (!ma.has(ruta)) cambios.push(`NUEVA        ${ruta}`);

    if (!cambios.length) { console.log(`Sin cambios entre "${a}" y "${b}". Diff vacio: no hay regresion.`); return true; }
    console.log(`${cambios.length} cambios entre "${a}" y "${b}":\n`);
    for (const c of cambios) console.log('  ' + c);
    return false;
}

// ------------------------------------------------------------- autocomprobacion

function autocomprobar() {
    const assert = require('assert');

    assert.deepStrictEqual(forma({ b: 1, a: 2 }), ['a', 'b'], 'claves ordenadas');
    assert.deepStrictEqual(forma([{ x: 1, y: 2 }]), ['[].x', '[].y'], 'array -> claves del primer elemento');
    assert.deepStrictEqual(forma([]), [], 'array vacio');
    assert.deepStrictEqual(forma('hola'), [], 'escalar');

    assert.strictEqual(filas({ items: [1, 2, 3] }), 3, 'cuenta items');
    assert.strictEqual(filas([1, 2]), 2, 'cuenta array suelto');
    assert.strictEqual(filas({ message: 'ok' }), null, 'sin coleccion');

    const v = { organization: '7', userId: '3' };
    assert.strictEqual(concretar('/workOrders/:organization', v).url, '/workOrders/7');
    assert.strictEqual(concretar('/machines/:userId', v).url, '/machines/3');
    assert.strictEqual(concretar('/x/:noExiste', v).url, null, 'param desconocido -> se omite');
    assert.strictEqual(concretar('/x/:noExiste', v).faltante, 'noExiste');
    assert.strictEqual(concretar('/organizations', v).url, '/organizations', 'ruta sin params');

    console.log('autocomprobacion: OK');
}

// -------------------------------------------------------------------- entrada

(async () => {
    const args = process.argv.slice(2);
    if (args[0] === '--test')  { autocomprobar(); return; }
    if (args[0] === '--diff')  { process.exitCode = diff(args[1], args[2]) ? 0 : 1; return; }
    autocomprobar();
    await capturar(args[0] || new Date().toISOString().slice(0, 10));
})()
    .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
    // Cargar los routers abre el broker MQTT y el WebSocket. Sin este exit
    // el proceso se queda vivo para siempre.
    .finally(() => process.exit(process.exitCode || 0));
