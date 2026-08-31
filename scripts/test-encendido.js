#!/usr/bin/env node
/**
 * Pruebas del interruptor por HTTP: POST /api/ai/enabled (encender, el
 * "guardar" del tipo Asistente IA en "Agregar widget") y de paso el
 * DELETE /api/ai/enabled (apagar), que nacio en la sesion 25 sin prueba.
 *
 *   node --env-file=../.env index.js          # en otra terminal
 *   node --env-file=../.env scripts/test-encendido.js
 *
 * La prueba que importa es la 5: encender una compañia SIN fila de AI_FLAG y
 * con la secuencia de mes_settings atrasada a proposito, que es el estado real
 * de produccion (ver assets/db/ai_flag.sql). Sin el setval del interruptor,
 * ese INSERT muere con "duplicate key".
 */
const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../database/pool');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Usuarios reales de la base local, los mismos de test-credenciales.js:
const SUPERADMIN = 5;   // SuperAdmin de la compañia 3
const ADMIN = 8;        // Admin de la compañia 1
const COMPANIA = 3;     // la del SuperAdmin
const AJENA = 1;        // fuera de su alcance

const token = (userId) => jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });

// Copia fiel de lo que hara AiService.encender()/quitar().
async function interruptor(metodo, userId, companyId, conToken = true) {
    const r = await fetch(
        `${BASE_URL}/api/ai/enabled` + (metodo === 'DELETE' && companyId ? `?company_id=${companyId}` : ''),
        {
            method: metodo,
            headers: {
                'Content-Type': 'application/json',
                ...(conToken ? { Authorization: `Bearer ${token(userId)}` } : {}),
            },
            ...(metodo === 'POST' ? { body: JSON.stringify({ company_id: companyId }) } : {}),
        }
    );
    return { status: r.status, json: await r.json().catch(() => null) };
}

const leerFlag = async (companyId) => (await pool.query(
    `SELECT value, enabled_flag FROM mes_settings WHERE company_id = $1 AND name = 'AI_FLAG'`,
    [companyId]
)).rows[0];

async function main() {
    let ok = 0;
    const paso = (t) => { ok++; console.log('  ok  ', t); };

    // Estado previo, para dejarlo todo como estaba.
    const antes = await leerFlag(COMPANIA);

    // --- quien NO puede encender ---------------------------------------------
    const sinToken = await interruptor('POST', SUPERADMIN, COMPANIA, false);
    assert.strictEqual(sinToken.status, 401, `sin token esperaba 401, dio ${sinToken.status}`);
    paso('POST sin token -> 401');

    const vencido = jwt.sign({ user_id: SUPERADMIN }, process.env.JWT_SECRET, { expiresIn: '-10m' });
    const r440 = await fetch(`${BASE_URL}/api/ai/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vencido}` },
        body: JSON.stringify({ company_id: COMPANIA }),
    });
    assert.strictEqual(r440.status, 440, `token vencido debio dar 440, dio ${r440.status}`);
    paso('token vencido -> 440');

    const admin = await interruptor('POST', ADMIN, AJENA);
    assert.strictEqual(admin.status, 403, `Admin debio dar 403, dio ${admin.status}`);
    assert.ok(/SuperAdmin/i.test(admin.json?.message || ''), 'el 403 del Admin no dice por que');
    paso('Admin -> 403 con mensaje legible');

    const ajena = await interruptor('POST', SUPERADMIN, AJENA);
    assert.strictEqual(ajena.status, 403, `compañia ajena debio dar 403, dio ${ajena.status}`);
    assert.ok(/alcance/i.test(ajena.json?.message || ''), 'el 403 de compañia ajena no dice "alcance"');
    paso('SuperAdmin con company_id ajeno -> 403, no ensancha el alcance');

    // --- la prueba de verdad: sin fila y con la secuencia atrasada -----------
    // El estado medido en produccion: filas metidas con id explicito sin
    // avanzar la secuencia. Se reproduce a proposito antes de encender.
    await pool.query(`DELETE FROM mes_settings WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA]);
    await pool.query(`SELECT setval(pg_get_serial_sequence('mes_settings', 'setting_id'), 1)`);

    const alta = await interruptor('POST', SUPERADMIN, COMPANIA);
    assert.strictEqual(alta.status, 200, `esperaba 200, llego ${alta.status}: ${alta.json?.message}`);
    assert.strictEqual(alta.json?.message, 'Asistente habilitado');
    let fila = await leerFlag(COMPANIA);
    assert.strictEqual(fila?.value, 'true', 'la fila no quedo encendida');
    assert.strictEqual(fila?.enabled_flag, 'Y', 'la fila no quedo con enabled_flag Y');
    paso('sin fila y con la secuencia atrasada -> la crea y enciende (el setval trabaja)');

    // --- idempotencia --------------------------------------------------------
    const repetido = await interruptor('POST', SUPERADMIN, COMPANIA);
    assert.strictEqual(repetido.status, 200);
    assert.strictEqual(repetido.json?.message, 'El asistente ya estaba encendido');
    assert.strictEqual((await leerFlag(COMPANIA)).value, 'true', 'el segundo POST toco el valor');
    paso('segundo POST -> "ya estaba encendido", sin romper nada');

    // --- fila apagada -> la enciende -----------------------------------------
    await pool.query(
        `UPDATE mes_settings SET value = 'false' WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA]);
    const reencendido = await interruptor('POST', SUPERADMIN, COMPANIA);
    assert.strictEqual(reencendido.json?.message, 'Asistente habilitado');
    assert.strictEqual((await leerFlag(COMPANIA)).value, 'true');
    paso('fila apagada -> vuelve a encender');

    // --- el DELETE, que estaba sin prueba ------------------------------------
    const apagado = await interruptor('DELETE', SUPERADMIN, COMPANIA);
    assert.strictEqual(apagado.status, 200, `DELETE esperaba 200, dio ${apagado.status}`);
    assert.strictEqual(apagado.json?.message, 'Asistente eliminado');
    assert.strictEqual((await leerFlag(COMPANIA)).value, 'false', 'el DELETE no apago la fila');
    paso('DELETE -> 200 y la fila queda en false');

    // El "ya estaba apagado" del DELETE es para compañia SIN fila (apagarAsistente
    // mira rowCount, y una fila ya en 'false' tambien se deja actualizar).
    await pool.query(`DELETE FROM mes_settings WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA]);
    const reapagado = await interruptor('DELETE', SUPERADMIN, COMPANIA);
    assert.strictEqual(reapagado.status, 200);
    assert.strictEqual(reapagado.json?.message, 'El asistente ya estaba apagado');
    paso('DELETE sin fila -> "ya estaba apagado"');

    const adminBorra = await interruptor('DELETE', ADMIN, AJENA);
    assert.strictEqual(adminBorra.status, 403, `Admin en DELETE debio dar 403, dio ${adminBorra.status}`);
    paso('DELETE de Admin -> 403');

    const borraSinToken = await interruptor('DELETE', SUPERADMIN, COMPANIA, false);
    assert.strictEqual(borraSinToken.status, 401);
    paso('DELETE sin token -> 401');

    // --- limpieza: todo como estaba ------------------------------------------
    // La fila pudo quedar borrada por la prueba del DELETE sin fila; si habia
    // algo antes, se recrea con la misma forma que usa el interruptor.
    await pool.query(`DELETE FROM mes_settings WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA]);
    if (antes) {
        await pool.query(
            `INSERT INTO mes_settings (company_id, name, value, description, type, status, enabled_flag, created_by, updated_by)
             VALUES ($1, 'AI_FLAG', $2, 'Asistente IA disponible para la compañia', 'AI', 'Verificado', $3, 'test-encendido', 'test-encendido')`,
            [COMPANIA, antes.value, antes.enabled_flag]);
    }
    const despues = await leerFlag(COMPANIA);
    assert.deepStrictEqual(despues, antes, 'el interruptor no quedo como estaba');
    paso('limpieza: AI_FLAG queda como estaba');

    console.log(`\n${ok}/${ok} pruebas del encendido OK`);
}

main()
    .catch((e) => { console.error('\nFALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        pool.end().finally(() => process.exit(process.exitCode || 0));
    });
