'use strict';

/**
 * Genera los recursos de ícono de la aplicación a partir del vector
 * build/logo.svg, usando el propio Electron para rasterizar (sin depender
 * del conversor interno de electron-builder, que falla con algunos PNG):
 *
 *   build/icon.png  (512x512, por si algún recurso lo necesita)
 *   build/icon.ico  (multi-tamaño 256..16, el que usa el .exe de Windows)
 *
 * Uso:  npx electron scripts/generar-icono.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const RUTA_SVG = path.join(RAIZ, 'build', 'logo.svg');
const RENDER = 1024;                       // captura de alta calidad
const TAMANOS_ICO = [256, 128, 64, 48, 32, 16];

const SVG = fs
  .readFileSync(RUTA_SVG, 'utf8')
  .replace(/width="512"/, `width="${RENDER}"`)
  .replace(/height="512"/, `height="${RENDER}"`);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: RENDER,
    height: RENDER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });

  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;width:' + RENDER + 'px;height:' + RENDER + 'px;background:transparent;overflow:hidden}</style>' +
    '</head><body>' + SVG + '</body></html>';

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 900));

  const base = await win.webContents.capturePage();

  const dirBuild = path.join(RAIZ, 'build');
  fs.mkdirSync(dirBuild, { recursive: true });

  // PNG grande (512) para usos generales.
  const png512 = base.resize({ width: 512, height: 512, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(dirBuild, 'icon.png'), png512);

  // Set de PNG a los tamaños de un .ico de Windows (máx. 256).
  const buffers = TAMANOS_ICO.map((n) =>
    base.resize({ width: n, height: n, quality: 'best' }).toPNG()
  );
  const pngToIco = (await import('png-to-ico')).default;
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(dirBuild, 'icon.ico'), ico);

  console.log('Generado build/icon.png (512x512):', png512.length, 'bytes');
  console.log('Generado build/icon.ico (' + TAMANOS_ICO.join('/') + '):', ico.length, 'bytes');
  app.exit(0);
}).catch((e) => {
  console.error('Error generando el ícono:', e);
  app.exit(1);
});
