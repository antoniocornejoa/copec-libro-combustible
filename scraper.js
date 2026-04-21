/**
 * Copec Empresa - Scraper de Transacciones (API directa)
 *
 * Llama directamente a la API de Copec Empresa usando tokens
 * de autenticacion almacenados en variables de entorno.
 * La firma HMAC-SHA256 se calcula dinamicamente por cada request.
 *
 * Uso:
 *   node scraper.js             -> Extrae el mes actual
 *   node scraper.js --month 2026-03  -> Extrae un mes especifico
 *   node scraper.js --all        -> Extrae todos los meses (ultimo ano)
 *h
 * Variables de entorno requeridas:
 *   COPEC_ACCESS_TOKEN  -> Token de acceso (header access_token)
 *   COPEC_EQUIPO_SECRET -> Clave secreta para firmar requests (HMAC-SHA256)
 *   COPEC_CUENTA_ID     -> ID de la cuenta empresa
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_BASE = 'https://api.copecempresas.com/EM1/PR/empresas';
const OUTPUT_DIR = path.join(__dirname, 'public', 'data');

// --- Utilidades ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function computeFirma(body, equipoSecret) {
  const bodyStr = JSON.stringify(body);
  return crypto.createHmac('sha256', equipoSecret).update(bodyStr).digest('hex');
}

async function apiCall(endpoint, body, tokens) {
  const url = API_BASE + '/' + endpoint;
  const firma = computeFirma(body, tokens.equipoSecret);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'access_token': tokens.access_token,
      'firma': firma
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    throw new Error('API error: ' + resp.status + ' ' + resp.statusText);
  }

  return resp.json();
}
// Extraer array de la respuesta de la API
// La API de Copec devuelve: { error: {...}, data: { transacciones: [...], posicionFinal: N } }
function extractArray(response, arrayKey) {
  if (response.data && response.data[arrayKey] && Array.isArray(response.data[arrayKey])) {
    return response.data[arrayKey];
  }
  if (response.data && Array.isArray(response.data)) return response.data;
  if (Array.isArray(response)) return response;
  if (response[arrayKey] && Array.isArray(response[arrayKey])) return response[arrayKey];
  if (response.resultado && Array.isArray(response.resultado)) return response.resultado;
  return [];
}

// Normalizar transaccion de la API al formato que espera el dashboard
function normalizeTransaction(tx, detailResponse) {
  const det = (detailResponse && detailResponse.data) ? detailResponse.data : {};
  const items = det.detalleTransaccion || [];
  const item = items[0] || {};

  const litros = parseFloat(tx.cantidad || item.cantidad || 0);
  const precioUnitario = parseFloat(item.precioUnitario || 0);
  const montoTotal = parseFloat(tx.ventaMontoTotal || tx.ventaPagoTotal || 0);
  const tipoCombustible = (item.productoNombre || '').trim();

  // Calcular montoNeto e IVA (19%)
  const montoNeto = Math.round(montoTotal / 1.19);
  const iva = montoTotal - montoNeto;

  // Tipo de documento
  let tipoDocumento = '';
  const tipoDocId = tx.tipoDocumentoId || '';
  if (tipoDocId === '52') tipoDocumento = 'Guia de despacho';
  else if (tipoDocId === '33') tipoDocumento = 'Factura electronica';
  else if (tipoDocId === '34') tipoDocumento = 'Factura exenta';
  else tipoDocumento = tipoDocId;

  return {
    fecha: tx.ventaFechaCreacion || tx.ventaTimestampDte || '',
    fechaTransaccion: tx.ventaTimestampDte || tx.ventaFechaCreacion || '',
    factura: tx.ventaDocumentoFolio || '',
    nroDocumento: tx.ventaDocumentoFolio || '',
    folioDocumento: tx.ventaDocumentoFolio || '',
    litros: litros,
    cantidad: litros,
    precio: precioUnitario,
    precioUnitario: precioUnitario,
    tipoCombustible: tipoCombustible,
    combustible: tipoCombustible,
    tipo: tipoCombustible,
    montoNeto: montoNeto,
    monto: montoTotal,
    montoTotal: montoTotal,
    iva: iva,
    impEsp: 0,
    destino: '',
    destinoEmp: '',
    tipoDocumento: tipoDocumento,
    conductor: tx.usuarioNombreApellido || '',
    nombreConductor: tx.usuarioNombreApellido || '',
    patente: tx.vehiculoPatente || '',
    estacion: tx.ventaSitioNombre || det.ventaEstacion || '',
    nombreEstacion: det.ventaEstacion || tx.ventaSitioNombre || '',
    sucursal: tx.ventaSitioNombre || '',
    direccion: det.ventaSitioDireccion || '',
    urlDocumento: tx.documentoUrl || '',
    urlAcepta: '',
    odometro: tx.vehiculoOdometro || det.vehiculoOdometro || 0,
    medioDePago: tx.medioDePago || '',
    ventaId: tx.ventaId,
    cuentaId: tx.cuentaId
  };
}
function getMonthRange(month) {
  const [year, m] = month.split('-').map(Number);
  const start = month + '-01';
  const endDate = new Date(year, m, 1);
  const end = endDate.toISOString().split('T')[0];
  return { start, end, label: month };
}

function getCurrentMonth() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

async function main() {
  const args = process.argv.slice(2);
  let targetMonths = [];

  if (args.includes('--all')) {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      targetMonths.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
  } else if (args.includes('--month')) {
    const idx = args.indexOf('--month');
    targetMonths = [args[idx + 1]];
  } else {
    targetMonths = [getCurrentMonth()];
  }

  console.log('Meses a extraer: ' + targetMonths.join(', '));

  // Validar tokens
  const tokens = {
    access_token: process.env.COPEC_ACCESS_TOKEN,
    equipoSecret: process.env.COPEC_EQUIPO_SECRET
  };

  const cuentaId = parseInt(process.env.COPEC_CUENTA_ID);

  if (!tokens.access_token || !tokens.equipoSecret || !cuentaId) {
    throw new Error('Variables COPEC_ACCESS_TOKEN, COPEC_EQUIPO_SECRET y COPEC_CUENTA_ID son requeridas');
  }

  console.log('Tokens configurados (cuentaId: ' + cuentaId + ')');

  // Crear directorio de salida
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  try {
    // --- Extraer datos por mes ---
    for (const month of targetMonths) {
      console.log('Extrayendo mes: ' + month);
      const range = getMonthRange(month);

      // 1. Obtener lista de transacciones
      const txResponse = await apiCall('cuenta/consultartransacciones', {
        cuentaId: cuentaId,
        fechaConsultaInicio: range.start,
        fechaConsulta: range.end,
        posicionInicial: 0
      }, tokens);

      const transactions = extractArray(txResponse, 'transacciones');
      console.log('  ' + transactions.length + ' transacciones encontradas');
      // 2. Para cada transaccion, obtener detalle y normalizar
      const normalizedTransactions = [];
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const txId = tx.idTransaccionCliente || tx.ventaId || tx.id || tx.transaccionId;
        console.log('    Detalle ' + (i + 1) + '/' + transactions.length + ': ' + txId);
        try {
          const detail = await apiCall('cuenta/consultardetalletransaccion', {
            cuentaId: cuentaId,
            idTransaccionCliente: txId
          }, tokens);
          normalizedTransactions.push(normalizeTransaction(tx, detail));
        } catch (e) {
          console.log('    Error en detalle: ' + e.message);
          normalizedTransactions.push(normalizeTransaction(tx, null));
        }
        await sleep(300);
      }

      // 3. Obtener facturas del mes
      let facturas = [];
      try {
        const facResponse = await apiCall('cuenta/consultarfacturas', {
          cuentaId: cuentaId,
          fechaConsultaInicio: range.start,
          fechaConsulta: range.end,
          posicionInicial: 0
        }, tokens);

        facturas = extractArray(facResponse, 'transacciones');
        console.log('  ' + facturas.length + ' facturas encontradas');
      } catch (e) {
        console.log('  Error obteniendo facturas: ' + e.message);
      }

      const monthData = {
        month: month,
        range: range,
        transactions: normalizedTransactions,
        facturas: facturas,
        extractedAt: new Date().toISOString()
      };

      // Guardar archivo individual por mes
      const monthFile = path.join(OUTPUT_DIR, month + '.json');
      fs.writeFileSync(monthFile, JSON.stringify(monthData, null, 2), 'utf-8');
      console.log('  Guardado: ' + monthFile);
    }

    // Guardar indice
    const existingFiles = fs.readdirSync(OUTPUT_DIR)
          .filter(f => f.match(/^\d{4}-\d{2}\.json$/))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();

    const index = {
      months: existingFiles,
      lastUpdated: new Date().toISOString(),
      empresa: 'Constructora Colbun'
    };

    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
    console.log('Extraccion completada exitosamente');
    console.log('  Meses disponibles: ' + existingFiles.join(', '));

  } catch (error) {
    console.error('Error en extraccion:', error.message);
    process.exit(1);
  }
}

main();
