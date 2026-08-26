#!/usr/bin/env node
/**
 * Pruebas del contrato de datos (ETAPA 2).
 *
 *   node --env-file=../.env scripts/test-vistas.js
 *
 * Comprueba las tres cosas que el plan (2.1.1) declara obligatorias y que son
 * facil de romper sin darse cuenta:
 *   1. Las 6 vistas exponen organization_id -- sin esa columna la capa de
 *      alcance no tiene sobre que filtrar y la vista nace rota.
 *   2. Los joins no duplican ni pierden filas por accidente.
 *   3. El rol condor_ai_ro no puede leer tablas base ni escribir nada.
 */
const assert = require('assert');
const pool = require('../database/pool');            // rol de la aplicacion
const poolReadonly = require('../database/poolReadonly'); // rol condor_ai_ro

const VISTAS = [
    'v_wo_status',
    'v_production_shift',
    'v_production_machine',
    'v_machine_stops',
    'v_sensor_latest',
    'v_sensor_readings',
    'v_shifts',
    'v_oee',
];

const uno = async (p, sql, params = []) => (await p.query(sql, params)).rows[0];

async function main() {
    let ok = 0;
    const paso = (t) => { ok++; console.log('  ok  ', t); };

    // --- 1. regla 1 del plan: toda vista lleva organization_id --------------
    for (const v of VISTAS) {
        const { count } = await uno(
            pool,
            `SELECT count(*) FROM information_schema.columns
              WHERE table_name = $1 AND column_name = 'organization_id'`,
            [v]
        );
        assert.strictEqual(Number(count), 1, `${v} no expone organization_id`);
    }
    paso(`las ${VISTAS.length} vistas exponen organization_id`);

    // Y se puede consultar de verdad, no solo existe en el catalogo.
    for (const v of VISTAS) {
        await poolReadonly.query(`SELECT organization_id FROM ${v} LIMIT 1`);
    }
    paso('SELECT organization_id corre en las 6 vistas');

    // --- 2. los joins no inventan ni pierden filas --------------------------
    const filas = async (sql) => Number((await uno(pool, sql)).c);

    // Produccion: el join a mes_shifts es LEFT y los turnos no se solapan, asi
    // que cada ejecucion aparece UNA vez. Si alguien configura dos turnos que
    // se pisan, esto lo caza.
    const ejecuciones = await filas('SELECT count(*) c FROM mes_work_execution');
    assert.strictEqual(await filas('SELECT count(*) c FROM v_production_shift'), ejecuciones);
    assert.strictEqual(await filas('SELECT count(*) c FROM v_production_machine'), ejecuciones);
    paso(`v_production_* = ${ejecuciones} ejecuciones, sin duplicar por turno`);

    // Ninguna ejecucion se queda sin turno en las organizaciones que SI tienen
    // turnos configurados. En las que no tienen, shift_id nulo es lo correcto.
    const sinTurno = await filas(`
        SELECT count(*) c FROM v_production_shift p
         WHERE p.shift_id IS NULL
           AND EXISTS (SELECT 1 FROM mes_shifts s
                        WHERE s.organization_id = p.organization_id
                          AND s.enabled_flag = 'Y')`);
    assert.strictEqual(sinTurno, 0, 'hay produccion sin turno en una org que si tiene turnos');
    paso('toda ejecucion cae en un turno donde hay turnos configurados');

    // Paros: el INNER JOIN a mes_machines deja fuera las alertas huerfanas.
    // Eso es correcto -- de una maquina borrada no se sabe de quien es -- pero
    // hay que saber cuantas son, no descubrirlo en una junta.
    const alertas = await filas('SELECT count(*) c FROM mes_alerts');
    const paros = await filas('SELECT count(*) c FROM v_machine_stops');
    const huerfanas = await filas(`
        SELECT count(*) c FROM mes_alerts a
          LEFT JOIN mes_machines m ON m.machine_id = a.machine_id
         WHERE m.machine_id IS NULL`);
    assert.strictEqual(paros, alertas - huerfanas);
    paso(`v_machine_stops = ${paros} de ${alertas} alertas (${huerfanas} sin maquina, fuera a proposito)`);

    // Sensores: uno por sensor, ni mas ni menos.
    const sensores = await filas('SELECT count(*) c FROM mes_sensors');
    assert.strictEqual(await filas('SELECT count(*) c FROM v_sensor_latest'), sensores);
    paso(`v_sensor_latest = ${sensores} filas, una por sensor`);

    // --- 3. el turno se calcula en hora local, no en UTC --------------------
    // La base corre en UTC y mes_shifts guarda hora de pared local (Mexico,
    // UTC-6). Sin convertir, casi todo caeria en TURNO 3. Se comprueba contra
    // la fila real mas reciente.
    const t = await uno(pool, `
        SELECT execution_date, shift_name,
               to_char(execution_date AT TIME ZONE 'America/Mexico_City', 'HH24:MI') hora_local,
               to_char(execution_date, 'HH24:MI') hora_utc,
               shift_start, shift_end
          FROM v_production_shift
         WHERE shift_name IS NOT NULL
         ORDER BY execution_date DESC LIMIT 1`);
    const hhmm = (x) => String(x).slice(0, 5);
    const dentro = t.shift_start < t.shift_end
        ? t.hora_local >= hhmm(t.shift_start) && t.hora_local < hhmm(t.shift_end)
        : t.hora_local >= hhmm(t.shift_start) || t.hora_local < hhmm(t.shift_end);
    assert.ok(dentro, `${t.hora_local} no cae en ${t.shift_name} ${t.shift_start}-${t.shift_end}`);
    assert.notStrictEqual(t.hora_local, t.hora_utc, 'la conversion de zona horaria no se aplico');
    paso(`turno por hora local: ${t.hora_utc} UTC = ${t.hora_local} local -> ${t.shift_name}`);

    // --- 4. el rol de solo lectura esta amarrado ---------------------------
    const { current_user } = await uno(poolReadonly, 'SELECT current_user');
    assert.strictEqual(current_user, 'condor_ai_ro', 'AI_DATABASE_URL no apunta al rol de solo lectura');
    paso('el pool del bot conecta como condor_ai_ro');

    for (const tabla of ['mes_users', 'mes_work_orders', 'mes_sensor_data']) {
        await assert.rejects(
            () => poolReadonly.query(`SELECT * FROM ${tabla} LIMIT 1`),
            /permission denied|permiso denegado/i,
            `${tabla} NO deberia ser legible por el bot`
        );
    }
    paso('SELECT sobre tablas base -> permiso denegado (incluida mes_users)');

    await assert.rejects(
        () => poolReadonly.query(`INSERT INTO mes_work_orders (work_order_id) VALUES (-1)`),
        /permission denied|permiso denegado|read-only|solo lectura/i
    );
    paso('INSERT -> rechazado');

    // Postgres corta esta antes de mirar permisos: una vista con joins no es
    // actualizable. Da igual el motivo, el punto es que no se puede escribir.
    await assert.rejects(
        () => poolReadonly.query(`DELETE FROM v_wo_status`),
        /permission denied|permiso denegado|read-only|solo lectura|cannot delete from view/i
    );
    paso('DELETE sobre la vista -> rechazado');

    console.log(`\n${ok}/${ok} pruebas de vistas OK`);
}

main()
    .catch((e) => { console.error('\nFALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        Promise.allSettled([pool.end(), poolReadonly.end()])
            .finally(() => process.exit(process.exitCode || 0));
    });
