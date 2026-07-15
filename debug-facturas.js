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

  // Variantes de parametros a probar
  const intentos = [
    { nombre: 'A: params actuales del scraper',
      body: { cuentaId, fechaConsultaInicio: r.start, fechaConsulta: r.end, posicionInicial: 0 } },
    { nombre: 'B: sin posicionInicial',
      body: { cuentaId, fechaConsultaInicio: r.start, fechaConsulta: r.end } },
    { nombre: 'C: fechaInicio/fechaFin',
      body: { cuentaId, fechaInicio: r.start, fechaFin: r.end, posicionInicial: 0 } },
    { nombre: 'D: rango amplio (todo el ano)',
      body: { cuentaId, fechaConsultaInicio: '2026-01-01', fechaConsulta: '2026-12-31', posicionInicial: 0 } },
    { nombre: 'E: solo cuentaId',
      body: { cuentaId } },
  ];

  for (const it of intentos) {
    console.log('='.repeat(60));
    console.log(it.nombre);
    console.log('  params enviados:', Object.keys(it.body).join(', '));
    try {
      const res = await apiCall('cuenta/consultarfacturas', it.body, tokens);
      console.log('  HTTP:', res.status);
      console.log('  FORMA:', JSON.stringify(shape(res.data), null, 2).split('\n').join('\n  '));
    } catch (e) {
      console.log('  ERROR:', e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
