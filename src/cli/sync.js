'use strict';

/**
 * Punto de entrada por consola: `npm run sync:cli`
 * Ejecuta una sincronización completa sin abrir la interfaz gráfica.
 * Útil para el Programador de tareas de Windows o pruebas manuales.
 * Demuestra además que la lógica es 100 % independiente de Electron.
 */
const { crearContenedor } = require('../main/contenedor');

async function main() {
  const contenedor = crearContenedor();
  const { syncService, database, logger } = contenedor;

  syncService.on('progreso', ({ fase, mensaje }) => {
    console.log(`  [${fase}] ${mensaje}`);
  });

  try {
    const resumen = await syncService.sincronizar();
    console.log('\nResumen:');
    console.log(`  Estado:        ${resumen.estado}`);
    console.log(`  Leídos:        ${resumen.leidos}`);
    console.log(`  Nuevos:        ${resumen.nuevos}`);
    console.log(`  Actualizados:  ${resumen.actualizados}`);
    console.log(`  Sin cambios:   ${resumen.sinCambios}`);
    console.log(`  Duración:      ${(resumen.duracionMs / 1000).toFixed(1)} s`);
    if (resumen.bitacora) {
      console.log(`  Bitácora:      ${resumen.bitacora.mensaje}`);
    }
    process.exitCode = 0;
  } catch (error) {
    logger.error(`Sincronización fallida: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await syncService.destruir();
    database.cerrar();
  }
}

main();
