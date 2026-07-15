/**
 * SII - Tasas de Impuesto Especifico a los Combustibles (Ley 18.502 / MEPCO Ley 20.493)
 *
 * Descarga desde el SII y genera public/data/tasas-sii.json:
 *   - mepco{ano}.htm -> Impuesto Especifico Resultante (UTM/m3) por semana de vigencia
 *   - utm{ano}.htm   -> valor de la UTM por mes ($)
 *
 * El impuesto de una compra se calcula con la tasa vigente a la FECHA de la compra:
 *   $/litro = resultante(semana) * UTM(mes) / 1000
 *
 * Uso: node sii-tasas.js            -> anos detectados en public/data + ano actual
 *      node sii-tasas.js 2025 2026  -> anos explicitos
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'public', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'tasas-sii.json');

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// --- Helpers ---
async function getLatin1(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondio ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

function toTokens(html) {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&oacute;/g, 'o').replace(/&eacute;/g, 'e').replace(/&aacute;/g, 'a')
    .replace(/&iacute;/g, 'i').replace(/&uacute;/g, 'u').replace(/&ntilde;/g, 'n')
    .replace(/<[^>]*>/g, '|')
    .replace(/\|+/g, '|')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length);
}

function num(s) {
  // "5,7351" -> 5.7351 ; "-0,4119" -> -0.4119
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
}

function isNum(s) {
  return /^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s);
}

function ddmmyyyyToIso(d) {
  const [dd, mm, yyyy] = d.split('-');
  return `${yyyy}-${mm}-${dd}`;
}

// --- MEPCO: tasas semanales ---
// Estructura por combustible: <nombre> | Impuesto | <base> | <variable> | <resultante> | UTM/m3
// El resultante negativo es un credito fiscal; se conserva con su signo.
function parseMepco(html) {
  const t = toTokens(html);
  const semanas = [];

  const FUELS = [
    { key: 'gas93', match: /^Gasolina Automotriz 93/ },
    { key: 'gas97', match: /^Gasolina Automotriz 97/ },
    { key: 'diesel', match: /^Petroleo Diesel/ },
  ];

  for (let i = 0; i < t.length; i++) {
    const m = /Vigencia desde:\s*\S+\s+(\d{2}-\d{2}-\d{4})/.exec(t[i]);
    if (!m) continue;

    const semana = { desde: ddmmyyyyToIso(m[1]) };
    const fin = Math.min(i + 90, t.length);

    for (const f of FUELS) {
      for (let j = i; j < fin; j++) {
        if (!f.match.test(t[j])) continue;
        // tras el nombre viene "Impuesto" y luego base, variable, resultante
        const nums = [];
        for (let k = j + 1; k < Math.min(j + 9, t.length) && nums.length < 3; k++) {
          if (isNum(t[k])) nums.push(t[k]);
        }
        if (nums.length === 3) {
          semana[f.key] = num(nums[2]); // resultante
        }
        break;
      }
    }
    if (semana.diesel !== undefined) semanas.push(semana);
  }

  // mas reciente primero
  semanas.sort((a, b) => b.desde.localeCompare(a.desde));
  return semanas;
}

// --- UTM mensual ---
function parseUtm(html, year) {
  const t = toTokens(html);
  const utm = {};
  for (let i = 0; i < t.length; i++) {
    const idx = MESES.indexOf(t[i]);
    if (idx < 0) continue;
    const v = t.slice(i + 1, i + 4).find(x => /^\d{1,3}\.\d{3}$/.test(x));
    if (v) {
      const mm = String(idx + 1).padStart(2, '0');
      utm[`${year}-${mm}`] = num(v);
    }
  }
  return utm;
}

// --- Main ---
async function main() {
  let years = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(Number);

  if (years.length === 0) {
    const found = new Set([new Date().getFullYear()]);
    if (fs.existsSync(OUTPUT_DIR)) {
      for (const f of fs.readdirSync(OUTPUT_DIR)) {
        const m = /^(\d{4})-\d{2}\.json$/.exec(f);
        if (m) found.add(Number(m[1]));
      }
    }
    years = [...found].sort();
  }

  console.log(`Anos a descargar: ${years.join(', ')}`);

  let semanas = [];
  let utm = {};

  for (const y of years) {
    try {
      const mepcoHtml = await getLatin1(`https://www.sii.cl/valores_y_fechas/mepco/mepco${y}.htm`);
      const s = parseMepco(mepcoHtml);
      semanas = semanas.concat(s);
      console.log(`  MEPCO ${y}: ${s.length} semanas`);
    } catch (e) {
      console.log(`  MEPCO ${y}: ERROR ${e.message}`);
    }

    try {
      const utmHtml = await getLatin1(`https://www.sii.cl/valores_y_fechas/utm/utm${y}.htm`);
      const u = parseUtm(utmHtml, y);
      utm = { ...utm, ...u };
      console.log(`  UTM   ${y}: ${Object.keys(u).length} meses`);
    } catch (e) {
      console.log(`  UTM   ${y}: ERROR ${e.message}`);
    }
  }

  if (semanas.length === 0 || Object.keys(utm).length === 0) {
    throw new Error('No se obtuvieron tasas del SII; se conserva el archivo anterior');
  }

  semanas.sort((a, b) => b.desde.localeCompare(a.desde));

  const out = {
    fuente: 'SII - Impuesto al petroleo (componentes base y variable) + UTM',
    unidad: 'UTM/m3 (resultante). $/litro = resultante * UTM(mes) / 1000',
    nota: 'Resultante negativo = credito fiscal. Bluemax es aditivo (AdBlue), no lleva impuesto.',
    generatedAt: new Date().toISOString(),
    utm,
    semanas,
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2), 'utf-8');

  console.log(`\nGuardado: ${OUTPUT_FILE}`);
  console.log(`  ${semanas.length} semanas | ${Object.keys(utm).length} meses de UTM`);
  console.log(`  Ultima vigencia: ${semanas[0].desde} -> diesel ${semanas[0].diesel} UTM/m3`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
