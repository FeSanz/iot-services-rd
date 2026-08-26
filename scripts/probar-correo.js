#!/usr/bin/env node
/**
 * Manda el reporte de produccion a UNA direccion, para verlo con los ojos.
 *
 *   node --env-file=../.env scripts/probar-correo.js alguien@ejemplo.com
 *   node --env-file=../.env scripts/probar-correo.js alguien@ejemplo.com 1 2026-01-01 2026-06-30
 *
 * Argumentos: <correo> [company_id] [desde] [hasta]
 *
 * ESTO ES UNA HERRAMIENTA DE TRABAJO, NO UNA FUNCION DEL PRODUCTO.
 *
 * En el producto NO se puede elegir destinatario: los reportes programados van a
 * los usuarios de la compañia y punto, porque un campo de direcciones convierte
 * "programar un reporte" en "sacar la produccion de la empresa a donde yo diga".
 * Aqui se puede porque esto se corre a mano, con acceso al servidor y al .env
 * -- quien puede correr esto ya tiene la base entera.
 *
 * Si no hay SMTP configurado, en vez de fallar escribe el correo en disco (.eml,
 * se abre con cualquier cliente) y el PDF suelto. Asi se puede revisar el
 * resultado sin credenciales de correo.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const pool = require('../database/pool');
const poolReadonly = require('../database/poolReadonly');
const { resolveScope, scopeDeCompania } = require('../services/ai/scope');
const { datosDelReporte } = require('../services/ai/reporte');
const email = require('../services/email/email');

const destino = process.argv[2];
const companyId = Number(process.argv[3] || 1);
const desde = process.argv[4] || '2026-01-01';
const hasta = process.argv[5] || '2026-06-30';

const haySmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER);

async function main() {
    if (!destino || !destino.includes('@')) {
        throw new Error('Uso: probar-correo.js <correo> [company_id] [desde] [hasta]');
    }

    // Un SuperAdmin de esa compañia, para que el alcance sea el de alguien real.
    const { rows } = await pool.query(`
        SELECT DISTINCT u.user_id
          FROM mes_users u
          JOIN mes_users_org uo ON u.user_id = uo.user_id
          JOIN mes_organizations o ON o.organization_id = uo.organization_id
         WHERE o.company_id = $1 AND u.enabled_flag = 'Y'
         ORDER BY u.user_id LIMIT 1`, [companyId]);
    if (rows.length === 0) throw new Error(`La compañia ${companyId} no tiene usuarios`);

    const scope = scopeDeCompania(await resolveScope(rows[0].user_id), companyId);
    const empresa = (await pool.query(
        'SELECT name FROM mes_companies WHERE company_id = $1', [companyId])).rows[0]?.name || `Compañia ${companyId}`;

    console.log(`Generando el reporte de ${empresa} (${desde} a ${hasta})...`);
    const datos = await datosDelReporte(scope, desde, hasta);
    if (!datos.resumen || !datos.resumen.registros) {
        throw new Error(`No hay produccion entre ${desde} y ${hasta}: el reporte saldria vacio`);
    }

    // El mismo dibujo que el del correo programado.
    const { PassThrough } = require('stream');
    const { dibujarReporte } = require('../services/ai/reporte');
    const pdf = await new Promise((resolve, reject) => {
        const flujo = new PassThrough();
        const trozos = [];
        flujo.on('data', (t) => trozos.push(t));
        flujo.on('end', () => resolve(Buffer.concat(trozos)));
        flujo.on('error', reject);
        dibujarReporte(flujo, { empresa, desde, hasta, datos, generadoPor: 'prueba manual' });
    });

    const mensaje = {
        from: `"Sistema MES" <${process.env.SMTP_USER || 'mes@example.com'}>`,
        to: destino,
        subject: `[PRUEBA] Reporte de produccion ${desde} a ${hasta} — ${empresa}`,
        text: `Reporte de produccion de ${empresa}.\n\n`
            + `Periodo: ${desde} a ${hasta}\n`
            + `Producido: ${Number(datos.resumen.cajas || 0).toLocaleString('es-MX')} cajas\n\n`
            + `El detalle va en el PDF adjunto.\n\n`
            + `Este es un envio de PRUEBA, hecho a mano desde el servidor.`,
        attachments: [{
            filename: `reporte-produccion-${desde}-a-${hasta}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
        }],
    };

    if (haySmtp) {
        const info = await email.transporter.sendMail(mensaje);
        console.log(`Enviado a ${destino}: ${info.messageId}`);
        console.log(`PDF de ${pdf.length} bytes adjunto.`);
        return;
    }

    // Sin SMTP: se deja en disco lo que se habria mandado.
    const salida = path.resolve(__dirname, '..', '..', 'respaldo');
    fs.mkdirSync(salida, { recursive: true });
    const eml = path.join(salida, 'reporte-prueba.eml');
    const soloPdf = path.join(salida, `reporte-prueba-${desde}-a-${hasta}.pdf`);

    // El correo entero, tal cual saldria, sin mandarlo.
    const crudo = await new Promise((resolve, reject) => {
        nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
            .sendMail(mensaje, (e, info) => (e ? reject(e) : resolve(info.message)));
    });
    fs.writeFileSync(eml, crudo);
    fs.writeFileSync(soloPdf, pdf);

    console.log('SMTP no esta configurado (falta SMTP_HOST / SMTP_USER en el .env).');
    console.log('No se mando nada. Lo que se habria mandado queda en disco:\n');
    console.log(`  ${eml}       <- el correo entero, se abre con Outlook/Thunderbird`);
    console.log(`  ${soloPdf}   <- solo el PDF`);
    console.log(`\nDestinatario que llevaba: ${destino}`);
    console.log('Para mandarlo de verdad, pon SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASS en el .env.');
}

main()
    .catch((e) => { console.error('FALLA:', e.message); process.exitCode = 1; })
    .finally(() => {
        Promise.allSettled([pool.end(), poolReadonly.end()])
            .finally(() => process.exit(process.exitCode || 0));
    });
