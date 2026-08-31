/**
 * Valida la URL del proveedor de LLM antes de que el servidor le hable.
 *
 * EL PROBLEMA (SSRF): base_url la escribe un SuperAdmin del cliente y el
 * servidor le manda un POST con la llave en el header. Sin validar, esa caja de
 * texto es un "hazme una peticion a donde yo diga desde tu red":
 *
 *   http://169.254.169.254/...  -> metadatos de la instancia en AWS/GCP/Azure.
 *                                  Entrega credenciales de la maquina a quien
 *                                  pregunte, sin autenticacion. Es el destino
 *                                  clasico y el que de verdad importa.
 *   http://10.0.0.5:6379/       -> Redis, Postgres o cualquier servicio interno
 *                                  que no esta expuesto a internet.
 *   http://localhost:3000/api/  -> el propio backend, saltandose el JWT.
 *
 * QUE SE HACE: se resuelve el nombre y se exige que TODAS las IPs sean
 * publicas. No basta con mirar el texto del host: "malo.com" puede tener un
 * registro A apuntando a 169.254.169.254.
 *
 * LA EXCEPCION LEGITIMA: Ollama suele correr en la LAN del cliente o en el
 * mismo servidor. Para eso esta AI_ALLOW_PRIVATE_LLM_HOST=true, que hay que
 * encender a proposito y por instalacion. Apagado por omision.
 *
 * ponytail: queda una carrera de DNS rebinding entre esta comprobacion y el
 * connect (el nombre podria resolver distinto medio segundo despues). Cerrarla
 * pide un dispatcher de undici con lookup fijado a la IP ya validada; se hace
 * si algun dia el proveedor deja de ser un dominio conocido del cliente.
 */
const dns = require('dns').promises;
const net = require('net');

// Se lee en cada llamada, no al cargar el modulo: asi se puede probar los dos
// caminos sin reiniciar el proceso.
const permitePrivadas = () => process.env.AI_ALLOW_PRIVATE_LLM_HOST === 'true';

function falla(mensaje) {
    const e = new Error(mensaje);
    e.status = 400;
    return e;
}

// Dos niveles, porque "red interna" no es todo lo mismo:
//
//   PROHIBIDO SIEMPRE  -> 169.254/16 y compañia. Ningun LLM legitimo vive ahi,
//                         ni el de la LAN del cliente. Es donde estan los
//                         metadatos de la instancia, o sea las credenciales de
//                         la maquina. Encender AI_ALLOW_PRIVATE_LLM_HOST no lo
//                         desbloquea: seria darle al interruptor de "mi Ollama
//                         esta en la LAN" el poder de abrir esa puerta.
//
//   PROHIBIDO SALVO FLAG -> 10/8, 192.168/16, 127/8... Ahi SI puede vivir un
//                         Ollama de verdad, en el mismo servidor o en la LAN.

// Los metadatos de la instancia NO viven solo en 169.254.169.254. Cada nube
// tiene la suya, y estas dos caen dentro de rangos que el flag de LAN abre
// (100.64/10 es CGNAT, 192.0.0/24 es "IETF protocol assignments"), asi que sin
// nombrarlas a mano quedan destapadas justo cuando el cliente enciende el flag
// porque su Ollama esta en la red local.
const IPV4_METADATOS = [
    '100.100.100.200',   // Alibaba Cloud
    '192.0.0.192',       // Oracle Cloud
];

function ipv4SiempreProhibida(a, b) {
    return (
        (a === 169 && b === 254) ||   // link-local: METADATOS DE LA INSTANCIA
        a === 0 ||                    // 0.0.0.0/8
        a >= 224                      // multicast y reservadas
    );
}

function ipv4Privada(a, b) {
    return (
        a === 10 ||
        a === 127 ||                              // loopback: Ollama local
        (a === 100 && b >= 64 && b <= 127) ||     // CGNAT
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19))
    );
}

function clasificarIPv4(ip) {
    const [a, b] = ip.split('.').map(Number);
    if (IPV4_METADATOS.includes(ip)) return 'siempre';
    if (ipv4SiempreProhibida(a, b)) return 'siempre';
    return ipv4Privada(a, b) ? 'privada' : null;
}

/**
 * Expande una IPv6 a sus 8 grupos de 16 bits.
 *
 * Existe porque mirar el texto NO alcanza. Node normaliza
 * "[::ffff:169.254.169.254]" a "::ffff:a9fe:a9fe", y una comprobacion contra el
 * cuarteto decimal deja pasar los metadatos por la puerta de atras. Esto lo
 * cazamos probando, no leyendo el codigo.
 */
function gruposIPv6(ip) {
    let texto = ip.toLowerCase();

    // Un cuarteto decimal al final ocupa dos grupos: ::ffff:1.2.3.4
    const punteado = texto.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (punteado) {
        const a = Number(punteado[1]), b = Number(punteado[2]);
        const c = Number(punteado[3]), d = Number(punteado[4]);
        if ([a, b, c, d].some((n) => n > 255)) return null;
        texto = texto.slice(0, punteado.index) +
                ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
    }

    const partes = texto.split('::');
    if (partes.length > 2) return null;

    const izq = partes[0] ? partes[0].split(':') : [];
    const der = partes.length === 2 ? (partes[1] ? partes[1].split(':') : []) : null;

    let grupos;
    if (der === null) {
        grupos = izq;
    } else {
        const faltan = 8 - izq.length - der.length;
        if (faltan < 0) return null;
        grupos = [...izq, ...Array(faltan).fill('0'), ...der];
    }
    if (grupos.length !== 8) return null;

    const numeros = grupos.map((g) => parseInt(g || '0', 16));
    return numeros.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : numeros;
}

function clasificarIPv6(ip) {
    const g = gruposIPv6(ip);
    if (!g) return 'siempre';   // si no se puede leer, no se va

    const primerosCinco = g.slice(0, 5).every((x) => x === 0);

    // ::ffff:a.b.c.d (mapeada) y ::a.b.c.d (compatible, obsoleta pero viva en
    // algunos stacks). Las dos terminan hablandole a una IPv4.
    if (primerosCinco && (g[5] === 0xffff || g[5] === 0) && (g[6] !== 0 || g[7] !== 0)) {
        const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
        if (g[5] === 0xffff || g[6] !== 0) return clasificarIPv4(v4);
    }

    if (g.every((x) => x === 0)) return 'siempre';            // ::
    if ((g[0] & 0xffc0) === 0xfe80) return 'siempre';         // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return 'siempre';         // ff00::/8 multicast
    if (primerosCinco && g[5] === 0 && g[6] === 0 && g[7] === 1) return 'privada';  // ::1

    // fd00:ec2::254 son los metadatos de EC2 por IPv6 -- la MISMA puerta que
    // 169.254.169.254, entregando las mismas credenciales. Cae dentro de
    // fc00::/7, que es lo que abre AI_ALLOW_PRIVATE_LLM_HOST: sin esta linea,
    // el interruptor de "mi Ollama esta en la LAN" abria los metadatos, que es
    // exactamente lo que ese diseño de dos niveles decia impedir.
    //
    // Se prohibe el /32 entero y no solo la ::254: fd00:ec2:: es una reserva
    // fija y conocida, y las ULA legitimas se sortean al azar dentro de fd00::/8.
    // Nadie llega ahi por casualidad.
    if (g[0] === 0xfd00 && g[1] === 0x0ec2) return 'siempre';

    if ((g[0] & 0xfe00) === 0xfc00) return 'privada';         // fc00::/7 unica local

    // Prefijos que llevan una IPv4 EMBEBIDA que la red traduce al conectar:
    // NAT64 (64:ff9b::/96, RFC 6052) y 6to4 (2002::/16). Se clasifica la IPv4
    // de dentro, no el envoltorio: 64:ff9b::a9fe:a9fe ES 169.254.169.254 con
    // sombrero, y clasificarla como "publica" abria los metadatos en una red
    // con NAT64.
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
        const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
        return clasificarIPv4(v4);
    }
    if (g[0] === 0x2002) {
        const v4 = [g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff].join('.');
        return clasificarIPv4(v4);
    }

    return null;
}

/**
 * @returns 'siempre' | 'privada' | null
 */
function clasificar(ip) {
    const version = net.isIP(ip);
    if (version === 4) return clasificarIPv4(ip);
    if (version === 6) return clasificarIPv6(ip);
    return 'siempre';   // si no se sabe que es, no se va
}

/** Compatibilidad: ¿esta IP esta vetada con la configuracion actual? */
function ipReservada(ip) {
    const c = clasificar(ip);
    return c === 'siempre' || (c === 'privada' && !permitePrivadas());
}

/**
 * @returns {Promise<{url: URL, ips: string[]}>}
 * @throws  si la URL no sirve o apunta a la red interna
 */
async function validarUrlDeProveedor(texto) {
    if (typeof texto !== 'string' || !texto.trim()) {
        throw falla('Falta la URL del proveedor');
    }

    let url;
    try {
        url = new URL(texto.trim());
    } catch {
        throw falla(`"${texto}" no es una URL valida`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        // file:, gopher:, ftp: y demas no tienen nada que hacer aqui.
        throw falla(`Protocolo no permitido: ${url.protocol}`);
    }
    if (url.username || url.password) {
        // Credenciales en la URL terminan en logs de acceso.
        throw falla('La URL del proveedor no puede llevar usuario ni contraseña');
    }
    if (url.protocol === 'http:' && !permitePrivadas()) {
        throw falla('Solo se permite https para el proveedor del LLM');
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');   // IPv6 viene en corchetes

    let ips;
    if (net.isIP(host)) {
        ips = [host];
    } else {
        try {
            ips = (await dns.lookup(host, { all: true })).map((r) => r.address);
        } catch {
            throw falla(`No se pudo resolver "${host}"`);
        }
        if (ips.length === 0) throw falla(`"${host}" no resuelve a ninguna direccion`);
    }

    // TODAS, no la primera: un dominio con dos registros A puede tener uno
    // publico de señuelo y otro interno.
    for (const ip of ips) {
        const nivel = clasificar(ip);
        if (nivel === 'siempre') {
            throw falla(
                `La URL del proveedor apunta a ${ip}, una direccion que nunca se permite ` +
                '(metadatos de la instancia o rango reservado).'
            );
        }
        if (nivel === 'privada' && !permitePrivadas()) {
            throw falla(
                `La URL del proveedor apunta a una direccion interna (${ip}). ` +
                'Si tu Ollama corre en la red local, enciende AI_ALLOW_PRIVATE_LLM_HOST en el servidor.'
            );
        }
    }

    return { url, ips };
}

module.exports = { validarUrlDeProveedor, ipReservada, clasificar, permitePrivadas };
