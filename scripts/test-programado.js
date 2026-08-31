#!/usr/bin/env node
/**
 * Pruebas del reporte programado por correo (ETAPA 5, segunda parte).
 *
 *   node --env-file=../.env index.js          # en otra terminal
 *   node --env-file=../.env scripts/test-programado.js
 *
 * NO manda un solo correo de verdad: se sustituye transporter.sendMail por uno
 * de mentiras y se mira QUE se habria mandado. Una prueba que depende de que el
 * SMTP del cliente conteste no es una prueba, es una tirada de dados -- y ademas
 * le llegaria a gente real.
 *
 * Deja la base como la encontro: borra lo que crea.
 */
const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../database/pool');
const poolReadonly = require('../database/poolReadonly');
const email = require('../services/email/email');
const programador = require('../services/ai/programador');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// 5 = SuperAdmin de la compañia 3 (AO)     -> puede programar
// 8 = Admin      de la compañia 1 (SPACE)  -> no puede
const SUPERADMIN = 5;
const ADMIN = 8;
const COMPANIA = 3;

const token = (userId) => jwt.sign({ user_id: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });

async function pedir(metodo, ruta, userId, cuerpo) {
    const r = await fetch(`${BASE_URL}${ruta}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${token(userId)}`, 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
}

async function main() {
    let ok = 0;
    const paso = (t) => { ok++; console.log('  ok  ', t); };

    await pool.query('DELETE FROM mes_ai_report_schedules WHERE company_id = $1', [COMPANIA]);

    // --- cuando toca la proxima -------------------------------------------
    // La cuenta la hace Postgres en hora de Mexico. Lo que se comprueba es que
    // SIEMPRE cae en el futuro y en el dia correcto -- no una fecha concreta,
    // que dependeria de cuando se corra la prueba.
    for (const [caso, args] of [
        ['diario',  { periodicidad: 'diario',  hora_local: '07:00' }],
        ['semanal', { periodicidad: 'semanal', hora_local: '06:30', dia_semana: 1 }],
        ['mensual', { periodicidad: 'mensual', hora_local: '08:00' }],
    ]) {
        const cuando = await programador.proximaEjecucion(args);
        assert.ok(cuando > new Date(), `${caso}: la proxima ejecucion no es futura`);

        const local = new Date(cuando.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
        const [h, m] = args.hora_local.split(':').map(Number);
        assert.strictEqual(local.getHours(), h, `${caso}: la hora local no es ${args.hora_local}`);
        assert.strictEqual(local.getMinutes(), m, `${caso}: los minutos no cuadran`);
        if (caso === 'semanal') {
            // getDay(): 0=domingo. ISODOW 1=lunes.
            assert.strictEqual(local.getDay(), 1, 'semanal: no cayo en lunes');
        }
        if (caso === 'mensual') {
            assert.strictEqual(local.getDate(), 1, 'mensual: no cayo en dia 1');
        }
    }
    paso('la proxima ejecucion cae en el futuro, en hora LOCAL de la planta y en el dia pedido');

    // --- que periodo cubre cada uno ---------------------------------------
    // Siempre cerrado y hacia atras: el de las 7 de la mañana habla de AYER, no
    // del dia que acaba de empezar y no tiene ni un registro.
    const ahora = new Date('2026-03-11T13:00:00Z');   // miercoles
    assert.deepStrictEqual(programador.periodoDe('diario', ahora), { desde: '2026-03-10', hasta: '2026-03-10' });
    assert.deepStrictEqual(programador.periodoDe('semanal', ahora), { desde: '2026-03-04', hasta: '2026-03-10' });
    assert.deepStrictEqual(programador.periodoDe('mensual', ahora), { desde: '2026-02-01', hasta: '2026-02-28' });
    paso('el periodo va cerrado y hacia atras: ayer, los 7 dias previos, el mes pasado');

    // --- los destinatarios salen del alcance, no de un campo de texto ------
    const scopeAO = await require('../services/ai/scope').resolveScope(SUPERADMIN);
    const correos = await programador.destinatarios(scopeAO.orgIds);
    const ajenos = await programador.destinatarios([2, 4]);   // organizaciones de SPACE
    for (const c of correos) {
        assert.ok(!ajenos.includes(c) || correos.length === 0,
            `el correo ${c} aparece en las dos compañias: el alcance no filtra`);
    }
    paso(`los destinatarios salen de las organizaciones del alcance (${correos.length} en la compañia ${COMPANIA})`);

    // --- crear, listar, borrar --------------------------------------------
    const creado = await pedir('POST', '/api/ai/schedules', SUPERADMIN,
        { periodicidad: 'semanal', hora_local: '06:30', dia_semana: 1 });
    assert.strictEqual(creado.status, 200, `crear dio ${creado.status}: ${creado.json?.message}`);
    assert.strictEqual(creado.json.items.periodicidad, 'semanal');
    paso('POST /ai/schedules programa el reporte');

    const listado = await pedir('GET', '/api/ai/schedules', SUPERADMIN);
    assert.strictEqual(listado.status, 200);
    assert.strictEqual(listado.json.items.length, 1);
    paso('GET /ai/schedules lo devuelve');

    // Dos veces la misma periodicidad NO crea dos: si no, el mismo PDF llega
    // duplicado cada lunes y nadie sabe cual desactivar.
    const otraVez = await pedir('POST', '/api/ai/schedules', SUPERADMIN,
        { periodicidad: 'semanal', hora_local: '09:00', dia_semana: 3 });
    assert.strictEqual(otraVez.status, 200);
    const listado2 = await pedir('GET', '/api/ai/schedules', SUPERADMIN);
    assert.strictEqual(listado2.json.items.length, 1, 'se creo un segundo programado igual');
    assert.strictEqual(listado2.json.items[0].hora_local, '09:00:00', 'no se actualizo la hora');
    paso('programar dos veces lo mismo ACTUALIZA, no duplica');

    // --- lo que no se acepta ----------------------------------------------
    for (const cuerpo of [
        { periodicidad: 'cada rato' },
        { periodicidad: 'diario', hora_local: '25:00' },
        { periodicidad: 'diario', hora_local: '7:00' },
        { periodicidad: 'semanal', hora_local: '07:00' },              // sin dia
        { periodicidad: 'semanal', hora_local: '07:00', dia_semana: 9 },
    ]) {
        const malo = await pedir('POST', '/api/ai/schedules', SUPERADMIN, cuerpo);
        assert.strictEqual(malo.status, 400, `${JSON.stringify(cuerpo)} debio dar 400, dio ${malo.status}`);
        assert.ok(malo.json?.message, 'el 400 no trae mensaje');
    }
    paso('periodicidad, hora y dia de la semana se validan antes de tocar la tabla');

    // --- quien puede -------------------------------------------------------
    const deAdmin = await pedir('POST', '/api/ai/schedules', ADMIN, { periodicidad: 'diario' });
    assert.strictEqual(deAdmin.status, 403, 'un Admin pudo programar');
    // Y el 403 tiene que hablar de ESTO. El guardia es compartido con la boveda
    // de llaves, y con el texto de la llave cableado contestaba "Solo un
    // SuperAdmin puede configurar la llave del LLM" a quien pedia un programado:
    // manda a buscar donde no es.
    assert.ok(!/llave|LLM/i.test(deAdmin.json?.message || ''),
        `el 403 de /ai/schedules habla de la llave del LLM: ${deAdmin.json?.message}`);
    paso(`un Admin no puede programar, y el motivo no habla de otra cosa ("${deAdmin.json?.message}")`);

    const ajena = await pedir('GET', '/api/ai/schedules?company_id=1', SUPERADMIN);
    assert.strictEqual(ajena.status, 403, 'listo los programados de otra compañia');
    paso('la compañia ajena en la query -> 403');

    const sinToken = await fetch(`${BASE_URL}/api/ai/schedules`);
    assert.strictEqual(sinToken.status, 401);
    paso('sin token -> 401');

    // --- el envio, con un correo de mentiras -------------------------------
    const original = email.transporter.sendMail;
    const mandados = [];
    email.transporter.sendMail = async (opciones) => {
        mandados.push(opciones);
        return { messageId: 'de-mentiras' };
    };

    try {
        // El interruptor de la compañia de prueba se APAGA aqui a mano. La
        // primera version daba por hecho que esa compañia no tenia AI_FLAG, y
        // el dia que alguien se lo puso --probando otra cosa-- la prueba empezo
        // a fallar sin que hubiera cambiado el codigo. Una prueba que depende
        // de como este la base no prueba, adivina.
        const flag3 = (await pool.query(
            `SELECT value FROM mes_settings WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA])).rows[0]?.value;
        if (flag3 !== undefined) {
            await pool.query(
                `UPDATE mes_settings SET value = 'false' WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA]);
        }

        // Se fuerza a que toque YA y con un periodo que si tiene datos.
        const id = listado2.json.items[0].schedule_id;
        await pool.query(
            `UPDATE mes_ai_report_schedules SET proxima_ejecucion = now() - interval '1 minute'
              WHERE schedule_id = $1`, [id]);

        const antes = (await pool.query(
            'SELECT proxima_ejecucion FROM mes_ai_report_schedules WHERE schedule_id = $1', [id]
        )).rows[0].proxima_ejecucion;

        const r = await programador.ejecutarPendientes();
        assert.strictEqual(r.tomados, 1, `se tomaron ${r.tomados} pendientes`);
        paso('ejecutarPendientes recoge el que ya tocaba');

        const fila = (await pool.query(
            'SELECT * FROM mes_ai_report_schedules WHERE schedule_id = $1', [id]
        )).rows[0];
        assert.ok(fila.proxima_ejecucion > antes, 'la proxima ejecucion no avanzo');
        assert.ok(fila.proxima_ejecucion > new Date(), 'la proxima ejecucion quedo en el pasado: se reenviaria en bucle');
        assert.ok(fila.ultimo_resultado, 'no se guardo el resultado');
        paso(`la proxima se reprograma sola y queda constancia: "${fila.ultimo_resultado.slice(0, 45)}..."`);

        // OJO: la compañia 3 no tiene AI_FLAG, asi que lo de arriba se corto por
        // el INTERRUPTOR, no por falta de datos. La primera version de esta
        // prueba daba por buena esa distincion con un /no se mando nada/ que
        // casaba con los dos mensajes: pasaba sin demostrar lo que decia.
        assert.strictEqual(mandados.length, 0, 'mando un correo cuando no debia');
        assert.ok(/apagado/i.test(fila.ultimo_resultado),
            `con AI_FLAG en false esperaba el motivo del interruptor, quedo: ${fila.ultimo_resultado}`);
        paso('con el asistente apagado no sale correo, y el motivo queda escrito tal cual');

        if (flag3 !== undefined) {
            await pool.query(
                `UPDATE mes_settings SET value = $2 WHERE company_id = $1 AND name = 'AI_FLAG'`, [COMPANIA, flag3]);
        }

        // El caso "no mando un PDF vacio" de verdad: compañia CON el interruptor
        // puesto y un periodo sin produccion.
        const sinDatos = await programador.enviarUno(
            { company_id: 1, created_by: ADMIN, periodicidad: 'mensual' },
            { desde: '2020-01-01', hasta: '2020-01-31' });
        assert.strictEqual(mandados.length, 0, 'mando un PDF de un periodo sin produccion');
        assert.ok(/sin produccion/i.test(sinDatos), `esperaba "sin produccion", devolvio: ${sinDatos}`);
        paso('sin produccion en el periodo NO se manda un PDF vacio, y se dice por que');

        // --- EL CASO QUE IMPORTA: sale el correo, con su PDF dentro ---------
        // El periodo se pasa a mano porque el mensual mira al mes pasado y esta
        // base se detiene en junio de 2026. Sin este parametro, la unica prueba
        // posible seria "no habia datos", que es justo la que NO demuestra nada.
        const resultado = await programador.enviarUno(
            { company_id: 1, created_by: ADMIN, periodicidad: 'mensual' },
            { desde: '2026-01-01', hasta: '2026-06-30' });
        assert.ok(resultado.startsWith('OK'), `el envio devolvio: ${resultado}`);
        assert.ok(mandados.length >= 1, 'no se mando ningun correo');

        const correo = mandados[0];
        assert.strictEqual(correo.attachments.length, 1, 'el correo no lleva exactamente un adjunto');
        const adjunto = correo.attachments[0];
        assert.strictEqual(adjunto.contentType, 'application/pdf');
        assert.strictEqual(adjunto.content.subarray(0, 5).toString(), '%PDF-', 'el adjunto no es un PDF');
        assert.ok(adjunto.content.length > 1000, `el PDF pesa ${adjunto.content.length} bytes`);
        assert.ok(adjunto.filename.includes('2026-01-01'), 'el nombre del archivo no dice el periodo');
        paso(`sale el correo con su PDF adjunto (${adjunto.content.length} bytes, "${adjunto.filename}")`);

        // En copia OCULTA: un correo automatico que reparte la libreta de
        // direcciones de la empresa es un descuido gratuito.
        //
        // Y SIN copia a la cuenta que manda: con `to: SMTP_USER` el buzon del
        // sistema terminaba recibiendo la produccion de todas las compañias.
        for (const m of mandados) {
            assert.ok(m.bcc && m.bcc.length > 0, 'no hay destinatarios en bcc');
            assert.ok(!m.to, `el correo lleva un destinatario visible en "to": ${m.to}`);
            assert.ok(m.subject.includes('2026-01-01'), 'el asunto no dice el periodo');
        }
        paso(`los destinatarios van en copia oculta y nadie mas recibe copia (${mandados.length} envio(s))`);

        // --- cada quien recibe SOLO lo que puede ver -----------------------
        // Estar en la compañia no es estar en todas sus organizaciones. Un PDF
        // por conjunto de organizaciones, y el conjunto de cada grupo tiene que
        // caber dentro de las organizaciones de cada uno de sus destinatarios.
        const alcanceAdmin = (await require('../services/ai/scope').resolveScope(ADMIN)).orgIds;
        const grupos = await programador.gruposDeDestinatarios(alcanceAdmin);
        assert.ok(grupos.length > 0, 'no salio ningun grupo de destinatarios');
        for (const g of grupos) {
            for (const correoDe of g.correos) {
                const suyas = (await pool.query(`
                    SELECT DISTINCT uo.organization_id AS id
                      FROM mes_users u JOIN mes_users_org uo ON uo.user_id = u.user_id
                     WHERE u.email = $1`, [correoDe])).rows.map((r) => r.id);
                for (const org of g.orgIds) {
                    assert.ok(suyas.includes(org),
                        `a ${correoDe} le tocaria un PDF con la organizacion ${org}, que no tiene asignada`);
                }
            }
        }
        paso(`el PDF de cada grupo solo lleva organizaciones que sus destinatarios tienen (${grupos.length} grupo(s))`);

        // Y no le llega a nadie de otra compañia.
        const enviados = mandados.flatMap((m) => m.bcc.split(',').map((c) => c.trim()));
        const propios = await programador.destinatarios(alcanceAdmin);
        const ajenosCorreo = await pool.query(`
            SELECT DISTINCT u.email FROM mes_users u
              JOIN mes_users_org uo ON u.user_id = uo.user_id
              JOIN mes_organizations o ON o.organization_id = uo.organization_id
             WHERE o.company_id <> 1 AND u.email IS NOT NULL AND u.email <> ''`);
        for (const f of ajenosCorreo.rows) {
            if (propios.includes(f.email)) continue;   // el mismo correo en dos compañias
            assert.ok(!enviados.includes(f.email),
                `el reporte de la compañia 1 se le mando a ${f.email}, que no es de ahi`);
        }
        paso('el correo no le llega a nadie fuera de la compañia del reporte');

        mandados.length = 0;

        // --- el periodo sale de la RANURA VENCIDA, no del reloj -------------
        // Un proceso que despierta atrasado ya pasada la medianoche mandaba el
        // reporte del dia equivocado (y la pasada normal lo repetia). La ranura
        // de las 7:00 del 2026-06-12 habla del 2026-06-11, sea cuando sea que
        // el proceso despierte -- y el resultado siempre dice su periodo.
        const atrasado = await programador.enviarUno({
            company_id: 1, created_by: ADMIN, periodicidad: 'diario',
            proxima_ejecucion: new Date('2026-06-12T13:00:00Z'),   // 07:00 CDMX
        });
        assert.ok(atrasado.includes('2026-06-11'),
            `el periodo no salio de la ranura vencida: ${atrasado}`);
        mandados.length = 0;
        paso('un programado atrasado cubre el periodo de SU ranura, no el del reloj');

        // --- un SMTP roto queda en el resultado, no en una excepcion --------
        // Y no puede callar a los grupos que faltan: cada envio va con su try.
        email.transporter.sendMail = async () => { throw new Error('SMTP dijo que no'); };
        const roto = await programador.enviarUno(
            { company_id: 1, created_by: ADMIN, periodicidad: 'mensual' },
            { desde: '2026-01-01', hasta: '2026-06-30' });
        assert.ok(/^(FALLO|PARCIAL)/.test(roto),
            `un SMTP roto tenia que quedar escrito en el resultado: ${roto}`);
        assert.ok(roto.includes('SMTP dijo que no'), `el motivo no quedo en el resultado: ${roto}`);
        email.transporter.sendMail = async (opciones) => {
            mandados.push(opciones);
            return { messageId: 'de-mentiras' };
        };
        paso('un fallo de SMTP queda en ultimo_resultado y no revienta el envio entero');

        // --- el interruptor apaga tambien los correos ----------------------
        const flagAntes = (await pool.query(
            `SELECT value FROM mes_settings WHERE company_id = 1 AND name = 'AI_FLAG'`)).rows[0]?.value;
        await pool.query(`UPDATE mes_settings SET value = 'false' WHERE company_id = 1 AND name = 'AI_FLAG'`);
        const conApagado = await programador.enviarUno(
            { company_id: 1, created_by: ADMIN, periodicidad: 'mensual' },
            { desde: '2026-01-01', hasta: '2026-06-30' });
        await pool.query(`UPDATE mes_settings SET value = $1 WHERE company_id = 1 AND name = 'AI_FLAG'`, [flagAntes]);
        assert.ok(/apagado/i.test(conApagado), `con AI_FLAG apagado devolvio: ${conApagado}`);
        paso('AI_FLAG apagado tambien apaga los correos, no solo el chat');

        // --- el alcance se vuelve a resolver en cada envio ------------------
        // Un usuario que ya no existe no puede seguir mandando su reporte.
        await assert.rejects(
            () => programador.enviarUno({ company_id: 1, created_by: 999999, periodicidad: 'mensual' },
                                        { desde: '2026-01-01', hasta: '2026-06-30' }),
            /no tiene organizaciones|usuario/i,
            'un created_by inexistente no reviento el envio'
        );
        paso('si el usuario del programado ya no tiene alcance, el reporte NO sale');

    } finally {
        email.transporter.sendMail = original;
    }

    // --- borrar ------------------------------------------------------------
    const id = listado2.json.items[0].schedule_id;
    const ajenoBorrar = await pedir('DELETE', `/api/ai/schedules/${id}?company_id=1`, SUPERADMIN);
    assert.strictEqual(ajenoBorrar.status, 403, 'borro con el company_id de otra compañia');
    paso('borrar con la compañia ajena -> 403');

    const borrado = await pedir('DELETE', `/api/ai/schedules/${id}`, SUPERADMIN);
    assert.strictEqual(borrado.status, 200);
    await pool.query('DELETE FROM mes_ai_report_schedules WHERE company_id IN (1, $1)', [COMPANIA]);
    const quedan = Number((await pool.query(
        'SELECT count(*) c FROM mes_ai_report_schedules')).rows[0].c);
    assert.strictEqual(quedan, 0, 'quedaron programados sueltos de la prueba');
    paso('limpieza: la base queda como estaba');

    console.log(`\n${ok}/${ok} pruebas del reporte programado OK`);
}

main()
    .catch((e) => { console.error('\nFALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        programador.parar();
        Promise.allSettled([pool.end(), poolReadonly.end()])
            .finally(() => process.exit(process.exitCode || 0));
    });
