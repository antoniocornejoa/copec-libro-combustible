/**
 * Diagnostico: por que cuenta/consultarfacturas devuelve 0 facturas.
 *
 * IMPORTANTE: este repo es PUBLICO, y los logs de Actions tambien.
 * Este script imprime SOLO la ESTRUCTURA de la respuesta (nombres de campos,
 * tipos y largos). NUNCA valores, montos, folios ni datos del cliente.
 *
 * Uso: node debug-facturas.js 2026-03
 */

const crypto = require('crypto');

const API_URL = 'https://api.copecempresas.com/EM1/PR/empresas';

function computeFirma(bodyString, equipoSecret) {
  return crypto.createHmac('sha256', equipoSecret).update(bodyString).digest('hex');
}

async function apiCall(endpoint, body, tokens) {
  const bodyString = JSON.stringify(body);
  const firma = computeFirma(bodyString, tokens.equipoSecret);
  const res = await fetch(`${API_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'access_token': tokens.access_token,
      'firma': firma,
    },
    body: bodyString,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { __noJson: text.slice(0, 120) }; }
  return { status: res.status, data };
}

// Describe la forma de un valor SIN revelar contenido
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    return depth > 2
      ? `array[${v.length}]`
      : `array[${v.length}]` + (v.length ? ` of {${Object.keys(v[0] || {}).join(', ')}}` : '');
  }
  const t = typeof v;
  if (t !== 'object') return t;
  const out = {};
  for (const k of Object.keys(v)) out[k] = shape(v[k], depth + 1);
  return out;
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: f(new Date(y, m - 1, 1)), end: f(new Date(y, m, 1)) };
}

async function main() {
  const mes = process.argv[2] || '2026-03';
  const r = monthRange(mes);
  const tokens = {
    access_token: process.env.COPEC_ACCESS_TOKEN,
    equipoSecret: process.env.COPEC_EQUIPO_SECRET,
  };
  const cuentaId = parseInt(process.env.COPEC_CUENTA_ID);
  if (!tokens.access_token || !tokens.equipoSecret || !cuentaId) {
    throw new Error('Faltan variables de entorno');
  }

  console.log(`Mes: ${mes}  rango: ${r.start} -> ${r.end}\n`);

  // La API devuelve las facturas bajo data.transacciones (no data.facturas)
  const res = await apiCall('cuenta/consultarfacturas', {
    cuentaId, fechaConsultaInicio: r.start, fechaConsulta: r.end, posicionInicial: 0
  }, tokens);
  console.log('HTTP:', res.status);

  const lista = (res.data && res.data.data && res.data.data.transacciones) || [];
  console.log('Facturas encontradas:', lista.length, '\n');
  if (!lista.length) return;

  for (const f of lista) {
    const url = f.facturaUrl;
    if (!url) { console.log('  (sin facturaUrl)'); continue; }

    // Bajar el PDF y extraer SOLO los totales tributarios del RESUMEN.
    // No se imprime URL, RUT, direccion ni folios: el repo es publico.
    const pdfRes = await fetch(url);
    console.log('  PDF HTTP:', pdfRes.status, '| bytes:', pdfRes.headers.get('content-length') || '?');
    if (!pdfRes.ok) continue;

    const buf = Buffer.from(await pdfRes.arrayBuffer());
    const zlib = require('zlib');
    let raw = '';
    let i = 0;
    while (true) {
      const s = buf.indexOf('stream', i);
      if (s < 0) break;
      let a = s + 6;
      if (buf[a] === 13) a++;
      if (buf[a] === 10) a++;
      const e = buf.indexOf('endstream', a);
      if (e < 0) break;
      try { raw += zlib.inflateSync(buf.slice(a, e)).toString('latin1') + '\n'; } catch (_) {}
      i = e + 9;
    }
    const txt = [];
    const re = /\((?:\\.|[^()\\])*\)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      let s = m[0].slice(1, -1);
      s = s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
      s = s.replace(/\\([()\\])/g, '$1');
      if (s.trim()) txt.push(s);
    }
    const joined = txt.join(' ').replace(/\s+/g, ' ');

    // Detalle IEF/IEV por linea (cantidad + tasas) y el RESUMEN de totales
    const det = joined.match(/(PETROLEO DIESEL|GASOLINA)[^A-Z]{0,60}?([\d.]+,\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d{2}-\s?\w{3})/g);
    if (det) { console.log('  --- lineas IEF/IEV ---'); det.forEach(d => console.log('   ', d.replace(/\s+/g, ' '))); }

    const resu = /RESUMEN(.{0,220})/.exec(joined);
    if (resu) console.log('  --- RESUMEN ---\n   ', resu[1].trim());

    const ie = /IETotales Positivos:(.{0,220})/.exec(joined);
    if (ie) console.log('  --- IE TOTALES ---\n   ', ie[1].trim());
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
