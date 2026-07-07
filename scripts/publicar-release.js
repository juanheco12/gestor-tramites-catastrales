'use strict';

/**
 * electron-builder publica en GitHub como release "draft" (releaseType:
 * draft en package.json), porque pedirle que publique un release real
 * de una vez falla cuando hay dos targets de Windows (nsis + portable):
 * ambos intentan crear el release al mismo tiempo y GitHub rechaza el
 * segundo intento. Con "draft" GitHub tolera ese choque (a veces quedan
 * dos borradores para la misma version), así que este script:
 *  1. busca los releases en borrador con el tag de la version actual,
 *  2. si hay más de uno, se queda con el que tiene más archivos y borra
 *     los demás,
 *  3. publica el que quedó (draft: false) para que quede visible como
 *     "latest" y electron-updater lo detecte.
 *
 * Requiere GH_TOKEN (mismo token con el que se corrió "npm run release").
 */
const https = require('https');
const { version } = require('../package.json');

const OWNER = 'juanheco12';
const REPO = 'gestor-tramites-catastrales';
const TAG = `v${version}`;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('Falta GH_TOKEN en el entorno: no se puede publicar el release.');
  process.exit(1);
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          Authorization: `token ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'gestor-tramites-catastrales-release-script',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let cuerpo = '';
        res.on('data', (chunk) => (cuerpo += chunk));
        res.on('end', () => {
          const status = res.statusCode;
          const json = cuerpo ? JSON.parse(cuerpo) : null;
          if (status >= 200 && status < 300) resolve(json);
          else reject(new Error(`${method} ${path} -> ${status}: ${cuerpo}`));
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const releases = await apiRequest('GET', `/repos/${OWNER}/${REPO}/releases`);
  const candidatos = releases.filter((r) => r.tag_name === TAG && r.draft);

  if (candidatos.length === 0) {
    console.log(`No hay ningún borrador de release para ${TAG} (¿ya estaba publicado?).`);
    return;
  }

  candidatos.sort((a, b) => b.assets.length - a.assets.length);
  const [bueno, ...duplicados] = candidatos;

  for (const dup of duplicados) {
    console.log(`Borrando borrador duplicado de ${TAG} (id ${dup.id}, ${dup.assets.length} archivo(s))...`);
    await apiRequest('DELETE', `/repos/${OWNER}/${REPO}/releases/${dup.id}`);
  }

  console.log(`Publicando release ${TAG} (id ${bueno.id}, ${bueno.assets.length} archivo(s))...`);
  await apiRequest('PATCH', `/repos/${OWNER}/${REPO}/releases/${bueno.id}`, { draft: false });
  console.log(`Listo: ${TAG} publicado.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
