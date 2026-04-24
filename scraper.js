/**
 * Copec Empresa - Scraper de Transacciones (API directa)
 *
 * Llama directamente a la API de Copec Empresa usando tokens
 * de autenticacion almacenados en variables de entorno.
 * La firma HMAC-SHA256 se calcula dinamicamente por cada request.
 *
 * Uso:
 *   node scraper.js                    -> Extrae el mes actual
 *   node scraper.js --month 2026-03    -> Extrae un mes especifico
 *   node scraper.js --all              -> Extrae todos los meses (ultimo ano)
 *
 * Variables de entorno requeridas:
 *   COPEC_ACCESS_TOKEN  -> Token de acceso (header access_token)
 *   COPEC_EQUIPO_SECRET -> Clave secreta para firmar requests (HMAC-SHA256)
 *   COPEC_CUENTA_ID     -> ID de la cuenta empresa
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Configuracion ---
const API_URL = 'https://api.copecempresas.com/EM1/PR/empresas';
const OUTPUT_DIR = path.join(__dirname, 'public', 'data');

// --- Helpers ---
function getMonthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const endNextMonth = new Date(year, month, 1);
  return {
    start: formatDate(start),
    end: formatDate(endNextMonth),
    label: `${year}-${String(month).padStart(2, '0')}`
  };
}

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${yyyy}-${mm}-${dd}`;
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Firma HMAC-SHA256 ---
function computeFirma(bodyString, equipoSecret) {
  return crypto
    .createHmac('sha256', equipoSecret)
    .update(bodyString)
    .digest('hex');
}

// --- API Call Helper ---
async function apiCall(endpoint, body, tokens) {
  const bodyString = JSON.stringify(body);
  const firma = computeFirma(bodyString, tokens.equipoSecret);
  const res = await fetch(`${API_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'access_token': tokens.access_token,
      'firma': firma
    },
    body: bodyString
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${endpoint} respondio ${res.status}: ${text.substring(0, 200)}`);
  }
  return await res.json();
}

// --- Extraer detalle de transaccion ---
function extractDetail(detailResponse) {
  if (!detailResponse) return {};

  let det = detailResponse;

  // Unwrap data wrapper: { error:{}, data:{...} }
  if (det.data && typeof det.data === 'object') {
    det = det.data;
  }

  // Handle transaccion wrapper (singular): { transaccion: {...} }
  if (det.transaccion && typeof det.transaccion === 'object') {
    if (Array.isArray(det.transaccion)) {
      det = det.transaccion[0] || {};
    } else {
      det = det.transaccion;
    }
  }

  // Handle detalleTransaccion wrapper (plural): { detalleTransaccion: [{...}] }
  if (det.detalleTransaccion && Array.isArray(det.detalleTransaccion) && det.detalleTransaccion.length > 0) {
    const item = det.detalleTransaccion[0];
    return {
      combustible: item.productoNombre || item.combustible || det.combustible || '',
      cantidad: parseFloat(item.cantidad || det.cantidad || 0),
      valorPorLitro: parseFloat(item.precioUnitario || item.valorPorLitro || det.valorPorLitro || 0),
      estacion: det.ventaEstacion || det.estacion || '',
      nombreEstacion: det.ventaSitioDireccion || det.nombreEstacion || '',
      direccion: det.ventaSitioDireccion || det.direccion || '',
      tipoDocumento: item.tipoDocumento || det.tipoDocumento || '',
      folioDocumento: item.folioDocumento || det.folioDocumento || '',
      documentoUrl: det.documentoUrl || ''
    };
  }

  // Formato plano directo (puede venir de transaccion unwrap o directo)
  return {
    combustible: det.combustible || det.productoNombre || det.tipoCombustible || '',
    cantidad: parseFloat(det.cantidad || 0),
    valorPorLitro: parseFloat(det.valorPorLitro || det.precioUnitario || 0),
    estacion: det.estacion || det.ventaEstacion || det.ventaSitioNombre || '',
    nombreEstacion: det.nombreEstacion || det.ventaSitioDireccion || '',
    direccion: det.direccion || det.ventaSitioDireccion || '',
    tipoDocumento: det.tipoDocumento || '',
    folioDocumento: det.folioDocumento || '',
    documentoUrl: det.documentoUrl || ''
  };
}

// --- Normalizar transaccion ---
function normalizeTransaction(tx, detailResponse) {
  const det = extractDetail(detailResponse);
  const litros = parseFloat(tx.cantidad || det.cantidad || 0);
  const precioUnitario = parseFloat(det.valorPorLitro || 0);
  const montoTotal = parseFloat(tx.ventaMontoTotal || tx.ventaPagoTotal || tx.monto || 0);
  const tipoCombustible = (det.combustible || '').trim();
  const montoNeto = Math.round(montoTotal / 1.19);
  const iva = montoTotal - montoNeto;
  let tipoDocumento = det.tipoDocumento || '';
  if (!tipoDocumento) {
    const tipoDocId = tx.tipoDocumentoId || '';
    if (tipoDocId === '52') tipoDocumento = 'Guia de despacho';
    else if (tipoDocId === '33') tipoDocumento = 'Factura electronica';
    else if (tipoDocId === '34') tipoDocumento = 'Factura exenta';
    else tipoDocumento = tipoDocId;
  }
  return {
    fecha: tx.ventaFechaCreacion || tx.ventaTimestampDte || tx.fecha || '',
    fechaTransaccion: tx.ventaTimestampDte || tx.ventaFechaCreacion || tx.fecha || '',
    factura: tx.ventaDocumentoFolio || det.folioDocumento || '',
    nroDocumento: tx.ventaDocumentoFolio || det.folioDocumento || '',
    folioDocumento: tx.ventaDocumentoFolio || det.folioDocumento || '',
    litros: litros, cantidad: litros,
    precio: precioUnitario, precioUnitario: precioUnitario,
    tipoCombustible: tipoCombustible, combustible: tipoCombustible, tipo: tipoCombustible,
    montoNeto: montoNeto, monto: montoTotal, montoTotal: montoTotal,
    iva: iva, impEsp: 0, destino: '', destinoEmp: '',
    tipoDocumento: tipoDocumento,
    conductor: tx.usuarioNombreApellido || tx.conductor || '',
    nombreConductor: tx.usuarioNombreApellido || tx.conductor || '',
    patente: tx.vehiculoPatente || tx.patente || '',
    estacion: tx.ventaSitioNombre || det.estacion || det.nombreEstacion || '',
    nombreEstacion: det.nombreEstacion || tx.ventaSitioNombre || '',
    sucursal: tx.ventaSitioNombre || '',
    direccion: det.direccion || '',
    urlDocumento: tx.documentoUrl || det.documentoUrl || '', urlAcepta: '',
    odometro: tx.vehiculoOdometro || 0,
    medioDePago: tx.medioDePago || tx.formaDePago || '',
    ventaId: tx.ventaId, cuentaId: tx.cuentaId
  };
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  let targetMonths = [];
  if (args.includes('--all')) {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      targetMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
  } else if (args.includes('--month')) {
    const idx = args.indexOf('--month');
    targetMonths = [args[idx + 1]];
  } else {
    targetMonths = [getCurrentMonth()];
  }
  console.log(`Meses a extraer: ${targetMonths.join(', ')}`);
  const tokens = {
    access_token: process.env.COPEC_ACCESS_TOKEN,
    equipoSecret: process.env.COPEC_EQUIPO_SECRET
  };
  const cuentaId = parseInt(process.env.COPEC_CUENTA_ID);
  if (!tokens.access_token || !tokens.equipoSecret || !cuentaId) {
    throw new Error('Variables COPEC_ACCESS_TOKEN, COPEC_EQUIPO_SECRET y COPEC_CUENTA_ID son requeridas');
  }
  console.log(`Tokens configurados (cuentaId: ${cuentaId})`);
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  try {
    for (const month of targetMonths) {
      console.log(`\nExtrayendo mes: ${month}`);
      const range = getMonthRange(month);
      const txResponse = await apiCall('cuenta/consultartransacciones', {
        cuentaId: cuentaId,
        fechaConsultaInicio: range.start,
        fechaConsulta: range.end,
        posicionInicial: 0
      }, tokens);
      let transactions = [];
      if (txResponse.data && txResponse.data.transacciones) transactions = txResponse.data.transacciones;
      else if (Array.isArray(txResponse)) transactions = txResponse;
      else if (txResponse.data && Array.isArray(txResponse.data)) transactions = txResponse.data;
      else if (txResponse.transacciones) transactions = txResponse.transacciones;
      else if (txResponse.resultado) transactions = txResponse.resultado;
      console.log(`  ${transactions.length} transacciones encontradas`);
      const normalizedTransactions = [];
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const txId = tx.idTransaccionCliente || tx.ventaId || tx.id || tx.transaccionId;
        console.log(`  Detalle ${i + 1}/${transactions.length}: ${txId}`);
        try {
          const detail = await apiCall('cuenta/consultardetalletransaccion', {
            cuentaId: cuentaId,
            idTransaccionCliente: txId
          }, tokens);
          if (i === 0) {
            console.log('  DEBUG detail keys:', JSON.stringify(Object.keys(detail)));
            if (detail.data) {
              console.log('  DEBUG detail.data keys:', JSON.stringify(Object.keys(detail.data)));
              if (detail.data.transaccion) {
                const t = detail.data.transaccion;
                console.log('  DEBUG transaccion type:', typeof t, Array.isArray(t) ? 'array' : '');
                if (typeof t === 'object' && !Array.isArray(t)) {
                  console.log('  DEBUG transaccion keys:', JSON.stringify(Object.keys(t)));
                  console.log('  DEBUG transaccion.combustible:', t.combustible);
                  console.log('  DEBUG transaccion.productoNombre:', t.productoNombre);
                  console.log('  DEBUG transaccion.tipoCombustible:', t.tipoCombustible);
                  console.log('  DEBUG transaccion.cantidad:', t.cantidad);
                  console.log('  DEBUG transaccion.valorPorLitro:', t.valorPorLitro);
                }
              }
            }
            const extracted = extractDetail(detail);
            console.log('  DEBUG extracted:', JSON.stringify(extracted));
          }
          normalizedTransactions.push(normalizeTransaction(tx, detail));
        } catch (e) {
          console.log(`  Error en detalle: ${e.message}`);
          normalizedTransactions.push(normalizeTransaction(tx, null));
        }
        await sleep(300);
      }
      let facturas = [];
      try {
        const facResponse = await apiCall('cuenta/consultarfacturas', {
          cuentaId: cuentaId,
          fechaConsultaInicio: range.start,
          fechaConsulta: range.end,
          posicionInicial: 0
        }, tokens);
        if (facResponse.data && facResponse.data.facturas) facturas = facResponse.data.facturas;
        else if (Array.isArray(facResponse)) facturas = facResponse;
        else if (facResponse.data && Array.isArray(facResponse.data)) facturas = facResponse.data;
        else if (facResponse.facturas) facturas = facResponse.facturas;
        else if (facResponse.resultado) facturas = facResponse.resultado;
      } catch (e) {
        console.log(`  Error en facturas: ${e.message}`);
      }
      console.log(`  ${facturas.length} facturas encontradas`);
      const monthData = {
        month: month, range: range,
        transactions: normalizedTransactions,
        facturas: facturas,
        extractedAt: new Date().toISOString()
      };
      const monthFile = path.join(OUTPUT_DIR, `${month}.json`);
      fs.writeFileSync(monthFile, JSON.stringify(monthData, null, 2), 'utf-8');
      console.log(`  Guardado: ${monthFile}`);
    }
    const existingFiles = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}\.json$/))
      .map(f => f.replace('.json', ''))
      .sort().reverse();
    const index = {
      months: existingFiles,
      lastUpdated: new Date().toISOString(),
      empresa: 'Constructora Colbun'
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
    console.log('\nExtraccion completada exitosamente');
    console.log(`  Meses disponibles: ${existingFiles.join(', ')}`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
