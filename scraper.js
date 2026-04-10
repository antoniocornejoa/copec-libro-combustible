/**
 * Copec Empresa - Scraper de Transacciones
 *
 * Extrae transacciones del portal admin.appcopecempresa.cl,
 * obtiene detalles de cada una (tipo combustible, precio, documento),
 * y genera un archivo JSON para la web de visualización.
 *
 * Uso:
 *   node scraper.js                    → Extrae el mes actual
 *   node scraper.js --month 2026-03    → Extrae un mes específico
 *   node scraper.js --all              → Extrae todos los meses disponibles (último año)
 *
 * Variables de entorno requeridas:
 *   COPEC_USER     → Usuario de login
 *   COPEC_PASSWORD → Contraseña de login
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Configuración ──────────────────────────────────────────────────────────
const BASE_URL = 'https://admin.appcopecempresa.cl';
const API_URL = 'https://api.copecempresas.com/EM1/PR/empresas';
const OUTPUT_DIR = path.join(__dirname, 'public', 'data');

// ─── Helpers ────────────────────────────────────────────────────────────────
function getMonthRange(yearMonth) {
  // yearMonth = "2026-04"
  const [year, month] = yearMonth.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0); // último día del mes
  return {
    start: formatDate(start),
    end: formatDate(end),
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

// ─── Main Scraper ───────────────────────────────────────────────────────────
async function main() {
  // Parsear argumentos
  const args = process.argv.slice(2);
  let targetMonths = [];

  if (args.includes('--all')) {
    // Últimos 12 meses
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

  console.log(`🔧 Meses a extraer: ${targetMonths.join(', ')}`);

  // Crear directorio de salida
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Lanzar navegador
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  const page = await context.newPage();

  // Variables para capturar tokens de autenticación
  let authTokens = {};
  let cuentaId = null;

  // Interceptar requests para capturar tokens
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('api.copecempresas.com')) {
      const headers = request.headers();
      if (headers['access_token']) {
        authTokens.access_token = headers['access_token'];
      }
      if (headers['firma']) {
        authTokens.firma = headers['firma'];
      }

      // Capturar cuentaId del body
      try {
        const postData = request.postData();
        if (postData) {
          const body = JSON.parse(postData);
          if (body.cuentaId) {
            cuentaId = body.cuentaId;
          }
        }
      } catch (e) { /* ignorar */ }
    }
  });

  try {
    // ─── Login ────────────────────────────────────────────────────────────
    console.log('🔐 Iniciando sesión...');
    await page.goto(`${BASE_URL}/Ingreso/Login`, { waitUntil: 'networkidle' });

    const user = process.env.COPEC_USER;
    const pass = process.env.COPEC_PASSWORD;

    if (!user || !pass) {
      throw new Error('Variables COPEC_USER y COPEC_PASSWORD son requeridas');
    }

    // Completar formulario de login
    await page.waitForSelector('input[type="text"], input[name="user"], input[placeholder*="usuario"], input[placeholder*="Usuario"], input[placeholder*="RUT"], input[placeholder*="rut"]', { timeout: 15000 });

    // Intentar diferentes selectores para el campo de usuario
    const userSelectors = [
      'input[type="text"]',
      'input[name="user"]',
      'input[placeholder*="usuario"]',
      'input[placeholder*="RUT"]',
      'input[formcontrolname="username"]',
      'input[formcontrolname="rut"]'
    ];

    let userInput = null;
    for (const sel of userSelectors) {
      userInput = await page.$(sel);
      if (userInput) break;
    }

    const passSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[formcontrolname="password"]'
    ];

    let passInput = null;
    for (const sel of passSelectors) {
      passInput = await page.$(sel);
      if (passInput) break;
    }

    if (!userInput || !passInput) {
      // Tomar screenshot para debug
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'debug-login.png') });
      throw new Error('No se encontraron campos de login. Ver debug-login.png');
    }

    await userInput.fill(user);
    await passInput.fill(pass);

    // Buscar botón de login
    const loginBtn = await page.$('button[type="submit"], button:has-text("Ingresar"), button:has-text("Iniciar")');
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await passInput.press('Enter');
    }

    // Esperar a que cargue el dashboard
    console.log('⏳ Esperando dashboard...');
    await page.waitForURL('**/Dashboard**', { timeout: 30000 });
    await sleep(3000);

    // Verificar que capturamos los tokens
    if (!authTokens.access_token) {
      // Navegar a historial para forzar una API call
      await page.goto(`${BASE_URL}/HomeCopecEmpresa/MisTransacciones`, { waitUntil: 'networkidle' });
      await sleep(3000);
    }

    if (!authTokens.access_token || !authTokens.firma) {
      throw new Error('No se pudieron capturar los tokens de autenticación');
    }

    console.log('✅ Autenticado correctamente');
    console.log(`   cuentaId: ${cuentaId}`);

    // ─── Extraer datos por mes ──────────────────────────────────────────
    const allData = {};

    for (const month of targetMonths) {
      console.log(`\n📅 Extrayendo mes: ${month}`);
      const range = getMonthRange(month);

      // 1. Obtener lista de transacciones
      const transactions = await fetchTransactions(page, range, authTokens, cuentaId);
      console.log(`   📦 ${transactions.length} transacciones encontradas`);

      // 2. Para cada transacción, obtener detalle
      const detailedTransactions = [];
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        console.log(`   🔍 Detalle ${i + 1}/${transactions.length}: ${tx.idTransaccionCliente || tx.id}`);

        try {
          const detail = await fetchTransactionDetail(page, tx, authTokens, cuentaId);
          detailedTransactions.push({
            ...tx,
            detail
          });
        } catch (e) {
          console.log(`   ⚠️ Error en detalle: ${e.message}`);
          detailedTransactions.push(tx);
        }

        // Pequeña pausa para no saturar la API
        await sleep(500);
      }

      // 3. Obtener facturas del mes
      const facturas = await fetchFacturas(page, range, authTokens, cuentaId);
      console.log(`   🧾 ${facturas.length} facturas encontradas`);

      allData[month] = {
        month: month,
        range: range,
        transactions: detailedTransactions,
        facturas: facturas,
        extractedAt: new Date().toISOString()
      };

      // Guardar archivo individual por mes
      const monthFile = path.join(OUTPUT_DIR, `${month}.json`);
      fs.writeFileSync(monthFile, JSON.stringify(allData[month], null, 2), 'utf-8');
      console.log(`   💾 Guardado: ${monthFile}`);
    }

    // Guardar índice con todos los meses disponibles
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

    console.log('\n✅ Extracción completada exitosamente');
    console.log(`   Meses disponibles: ${existingFiles.join(', ')}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'debug-error.png') });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── API Functions ──────────────────────────────────────────────────────────

async function fetchTransactions(page, range, tokens, cuentaId) {
  const response = await page.evaluate(
    async ({ apiUrl, tokens, cuentaId, start, end }) => {
      const res = await fetch(`${apiUrl}/cuenta/consultartransacciones`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'access_token': tokens.access_token,
          'firma': tokens.firma
        },
        body: JSON.stringify({
          cuentaId: cuentaId,
          fechaInicio: start,
          fechaFin: end
        })
      });
      return await res.json();
    },
    { apiUrl: API_URL, tokens, cuentaId, start: range.start, end: range.end }
  );

  // La respuesta puede variar en estructura, intentar extraer el array
  if (Array.isArray(response)) return response;
  if (response.data && Array.isArray(response.data)) return response.data;
  if (response.transacciones && Array.isArray(response.transacciones)) return response.transacciones;
  if (response.resultado && Array.isArray(response.resultado)) return response.resultado;

  console.log('   ⚠️ Estructura de respuesta inesperada:', JSON.stringify(response).substring(0, 200));
  return [];
}

async function fetchTransactionDetail(page, tx, tokens, cuentaId) {
  const txId = tx.idTransaccionCliente || tx.id || tx.transaccionId;

  const response = await page.evaluate(
    async ({ apiUrl, tokens, cuentaId, txId }) => {
      const res = await fetch(`${apiUrl}/cuenta/consultardetalletransaccion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'access_token': tokens.access_token,
          'firma': tokens.firma
        },
        body: JSON.stringify({
          cuentaId: cuentaId,
          idTransaccionCliente: txId
        })
      });
      return await res.json();
    },
    { apiUrl: API_URL, tokens, cuentaId, txId }
  );

  return response;
}

async function fetchFacturas(page, range, tokens, cuentaId) {
  const response = await page.evaluate(
    async ({ apiUrl, tokens, cuentaId, start, end }) => {
      const res = await fetch(`${apiUrl}/cuenta/consultarfacturas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'access_token': tokens.access_token,
          'firma': tokens.firma
        },
        body: JSON.stringify({
          cuentaId: cuentaId,
          fechaInicio: start,
          fechaFin: end
        })
      });
      return await res.json();
    },
    { apiUrl: API_URL, tokens, cuentaId, start: range.start, end: range.end }
  );

  if (Array.isArray(response)) return response;
  if (response.data && Array.isArray(response.data)) return response.data;
  if (response.facturas && Array.isArray(response.facturas)) return response.facturas;
  if (response.resultado && Array.isArray(response.resultado)) return response.resultado;

  return [];
}

// ─── Run ────────────────────────────────────────────────────────────────────
main();
