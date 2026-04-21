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
  const endNextMonth = new Date(year, month, 1); // primer dia del mes siguiente
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

// --- Main ---
async function main() {
  // Parsear argumentos
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

      let transactions = [];
      if (Array.isArray(txResponse)) transactions = txResponse;
      else if (txResponse.data && Array.isArray(txResponse.data)) transactions = txResponse.data;
      else if (txResponse.transacciones && Array.isArray(txResponse.transacciones)) transactions = txResponse.transacciones;
      else if (txResponse.resultado && Array.isArray(txResponse.resultado)) transactions = txResponse.resultado;

      console.log('  ' + transactions.length + ' transacciones encontradas');

      // 2. Para cada transaccion, obtener detalle
      const detailedTransactions = [];
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const txId = tx.idTransaccionCliente || tx.id || tx.transaccionId;
        console.log('  Detalle ' + (i + 1) + '/' + transactions.length + ': ' + txId);

        try {
          const detail = await apiCall('cuenta/consultardetalletransaccion', {
            cuentaId: cuentaId,
            idTransaccionCliente: txId
          }, tokens);

          detailedTransactions.push({ ...tx, detail });
        } catch (e) {
          console.log('  Error en detalle: ' + e.message);
          detailedTransactions.push(tx);
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

        if (Array.isArray(facResponse)) facturas = facResponse;
        else if (facResponse.data && Array.isArray(facResponse.data)) facturas = facResponse.data;
        else if (facResponse.facturas && Array.isArray(facResponse.facturas)) facturas = facResponse.facturas;
        else if (facResponse.resultado && Array.isArray(facResponse.resultado)) facturas = facResponse.resultado;
      } catch (e) {
        console.log('  Error en facturas: ' + e.message);
      }

      console.log('  ' + facturas.length + ' facturas encontradas');

      const monthData = {
        month: month,
        range: range,
        transactions: detailedTransactions,
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
    console.error('Error: ' + error.message);
    process.exit(1);
  }
}

main();
