'use strict';

const { ipcMain, shell, dialog, app } = require('electron');
const { autoUpdater } = require('electron-updater');

const CANALES = {
  SINCRONIZAR: 'bandeja:sincronizar',
  LISTAR_TRAMITES: 'bandeja:listar-tramites',
  LISTAR_LOGS: 'bandeja:listar-logs',
  HISTORIAL: 'bandeja:historial-tramite',
  PROGRESO: 'bandeja:progreso',
  EXPORTAR_EXCEL: 'bandeja:exportar-excel',
  GESTION_LISTAR: 'gestion:listar',
  GESTION_RESUMEN: 'gestion:resumen',
  GESTION_ACTUALIZAR: 'gestion:actualizar',
  IMPORTAR_BITACORA: 'gestion:importar-bitacora',
  POS_LISTAR: 'gestion:pos-listar',
  AGREGAR_HISTORICO: 'gestion:agregar-historico',
  ELIMINAR_MANUAL: 'gestion:eliminar-manual',
  EXPORTAR_VISITAS: 'bandeja:exportar-visitas',
  SISTEMA_RESTABLECER: 'sistema:restablecer',
  CREDENCIALES_GUARDAR: 'credenciales:guardar',
  CREDENCIALES_ESTADO: 'credenciales:estado',
  CREDENCIALES_BORRAR: 'credenciales:borrar',
  RADICACIONES_LISTAR: 'radicaciones:listar',
  RADICACIONES_RESUMEN: 'radicaciones:resumen',
  RADICACIONES_CONFIG: 'radicaciones:config',
  RADICACIONES_GUARDAR_CONFIG: 'radicaciones:guardar-config',
  APP_VERSION: 'app:version',
  APP_BUSCAR_ACTUALIZACION: 'app:buscar-actualizacion',
  GENERAR_ACTA: 'bandeja:generar-acta',
};

/**
 * Registra los canales IPC que conectan la UI con los servicios.
 * La UI nunca toca Playwright ni SQLite: solo invoca estos canales.
 *
 * @param {ReturnType<import('./contenedor').crearContenedor>} contenedor
 * @param {() => Electron.BrowserWindow|null} obtenerVentana
 */
function registrarIpc(contenedor, obtenerVentana) {
  const {
    syncService,
    tramiteRepository,
    syncLogRepository,
    exportService,
    gestionRepository,
    radicacionRepository,
    importService,
    credencialesService,
    actaService,
    logger,
  } = contenedor;

  const notificar = (evento, datos) => {
    const ventana = obtenerVentana();
    if (ventana && !ventana.isDestroyed()) {
      ventana.webContents.send(CANALES.PROGRESO, { evento, ...datos });
    }
  };

  syncService.on('progreso', (datos) => notificar('progreso', datos));
  syncService.on('finalizado', (datos) => notificar('finalizado', datos));
  syncService.on('fallo', (datos) => notificar('fallo', datos));

  ipcMain.handle(CANALES.SINCRONIZAR, async () => {
    try {
      const resumen = await syncService.sincronizar();

      // Si la bitácora cambió, se abre el Excel para que el usuario vea
      // las modificaciones de inmediato (solo en sincronización manual).
      const bitacora = resumen.bitacora;
      const config = contenedor.config;
      if (
        bitacora &&
        config.bitacora &&
        config.bitacora.abrirTrasActualizar &&
        (bitacora.agregados.length > 0 || (bitacora.salieron || []).length > 0)
      ) {
        shell.openPath(bitacora.ruta).catch(() => {});
      }

      return { ok: true, resumen };
    } catch (error) {
      logger.error(`IPC sincronizar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.LISTAR_TRAMITES, (_evento, opciones = {}) => {
    return tramiteRepository.listar(opciones);
  });

  ipcMain.handle(CANALES.LISTAR_LOGS, (_evento, opciones = {}) => {
    return syncLogRepository.listar(opciones);
  });

  ipcMain.handle(CANALES.HISTORIAL, (_evento, tramiteId) => {
    return tramiteRepository.historial(tramiteId);
  });

  ipcMain.handle(CANALES.GESTION_LISTAR, () => {
    return gestionRepository.listarConGestion();
  });

  ipcMain.handle(CANALES.GESTION_RESUMEN, () => {
    return gestionRepository.resumen();
  });

  ipcMain.handle(CANALES.GESTION_ACTUALIZAR, (_evento, { tramiteId, campos }) => {
    try {
      gestionRepository.actualizar(tramiteId, campos);
      return { ok: true };
    } catch (error) {
      logger.error(`IPC gestión actualizar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.IMPORTAR_BITACORA, async () => {
    try {
      // El usuario elige el archivo: sirve para su bitácora o la de otro ejecutor.
      const seleccion = await dialog.showOpenDialog(obtenerVentana(), {
        title: 'Seleccione la bitácora Excel a importar',
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }],
        properties: ['openFile'],
      });
      if (seleccion.canceled || seleccion.filePaths.length === 0) {
        return { ok: false, cancelado: true };
      }

      const resumen = await importService.importar(seleccion.filePaths[0]);
      // Aplicar las reglas de estado a lo que quedó en bandeja.
      const reglas = gestionRepository.aplicarReglasDeEstado();
      return { ok: true, resumen, reglas };
    } catch (error) {
      logger.error(`IPC importar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.POS_LISTAR, () => {
    return gestionRepository.listarPosTramite();
  });

  ipcMain.handle(CANALES.ELIMINAR_MANUAL, async (_evento, tramiteId) => {
    try {
      const respuesta = await dialog.showMessageBox(obtenerVentana(), {
        type: 'warning',
        title: 'Eliminar trámite',
        message: '¿Eliminar este trámite por completo?',
        detail:
          'Se borra el trámite, su gestión y su historial. Úselo para quitar duplicados o ' +
          'trámites marcados como enviados por error (p. ej. si desapareció de la bandeja sin ' +
          'haberse enviado en realidad). No se puede deshacer.',
        buttons: ['Cancelar', 'Sí, eliminar'],
        defaultId: 0,
        cancelId: 0,
      });
      if (respuesta.response !== 1) return { ok: false, cancelado: true };

      const eliminado = gestionRepository.eliminar(tramiteId);
      return { ok: eliminado, error: eliminado ? undefined : 'El trámite no existe.' };
    } catch (error) {
      logger.error(`IPC eliminar trámite: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.AGREGAR_HISTORICO, (_evento, datos) => {
    try {
      const radicado = String(datos.radicado || '').trim();
      if (!radicado) throw new Error('El radicado es obligatorio.');

      // Igual que en la bitácora de Excel: si el radicado ya existe (p. ej.
      // sigue vivo en la bandeja), se usa el MISMO registro en vez de crear
      // uno nuevo, para que al enviarlo más tarde sea la misma fila la que
      // se cierre con fecha de envío y "EN REVISION".
      let tramite = tramiteRepository.buscarPorNumero(radicado);
      let esNuevo = false;
      if (!tramite) {
        const id = tramiteRepository.insertar(
          { numero_tramite: radicado, tipo: datos.tramite || null, estado: null, fecha: null },
          null,
          { origen: 'manual', presenteEnBandeja: 0 }
        );
        gestionRepository.asegurar(id);
        tramite = { id };
        esNuevo = true;
      }

      const actual = gestionRepository.obtener(tramite.id);
      const campos = {
        fmi: datos.fmi || '',
        // NULL, no "": si queda vacío, el respaldo automático de
        // marcarEnviados (COALESCE) debe poder completarlo al enviarse.
        fecha_realizacion: datos.fecha_realizacion || null,
        estado_seguimiento: datos.estado_seguimiento || 'EN ESPERA',
        observacion: datos.observacion || '',
      };
      // No se retrocede un estado ya avanzado (visita/enviado/devuelto/finalizado);
      // en cualquier otro caso, registrar la nota "en espera" implica Estudiado.
      if (esNuevo || actual.mi_estado === 'por_estudiar') {
        campos.mi_estado = 'estudiado';
      }

      gestionRepository.actualizar(tramite.id, campos);
      return { ok: true, creado: esNuevo };
    } catch (error) {
      logger.error(`IPC agregar histórico: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.EXPORTAR_VISITAS, async () => {
    try {
      const ruta = await exportService.exportarVisitas();
      shell.showItemInFolder(ruta);
      return { ok: true, ruta };
    } catch (error) {
      logger.error(`IPC exportar visitas: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.SISTEMA_RESTABLECER, async () => {
    const respuesta = await dialog.showMessageBox(obtenerVentana(), {
      type: 'warning',
      title: 'Restablecer el sistema',
      message: '¿Borrar TODOS los trámites, estados, observaciones y el historial de sincronizaciones?',
      detail:
        'El sistema quedará en cero, como recién instalado. Las credenciales de acceso ' +
        'guardadas se conservan. Esta acción NO se puede deshacer.',
      buttons: ['Cancelar', 'Sí, borrar todo'],
      defaultId: 0,
      cancelId: 0,
    });
    if (respuesta.response !== 1) return { ok: false, cancelado: true };

    try {
      contenedor.database.conexion.exec(`
        DELETE FROM tramites_historial;
        DELETE FROM tramites_gestion;
        DELETE FROM pos_tramite;
        DELETE FROM tramites;
        DELETE FROM sync_logs;
      `);
      logger.warn('Sistema restablecido a cero por el usuario.');
      return { ok: true };
    } catch (error) {
      logger.error(`IPC restablecer: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.CREDENCIALES_ESTADO, () => ({
    disponible: credencialesService.disponible(),
    guardadas: credencialesService.existe(),
  }));

  ipcMain.handle(CANALES.CREDENCIALES_GUARDAR, (_evento, { usuario, clave }) => {
    try {
      if (!usuario || !clave) throw new Error('Usuario y clave son obligatorios.');
      credencialesService.guardar(usuario, clave);
      return { ok: true };
    } catch (error) {
      logger.error(`IPC credenciales: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(CANALES.CREDENCIALES_BORRAR, () => {
    credencialesService.borrar();
    return { ok: true };
  });

  ipcMain.handle(CANALES.EXPORTAR_EXCEL, async () => {
    try {
      const ruta = await exportService.exportar();
      shell.showItemInFolder(ruta); // abre el Explorador con el archivo seleccionado
      return { ok: true, ruta };
    } catch (error) {
      logger.error(`IPC exportar: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  /* ------------------------- acta de visita ------------------------- */

  ipcMain.handle(CANALES.GENERAR_ACTA, async (_evento, tramiteId) => {
    try {
      const tramite = gestionRepository
        .listarConGestion()
        .find((t) => t.id === tramiteId);
      if (!tramite) throw new Error('No se encontró el trámite.');

      // Si una sincronización (manual o automática) está usando el navegador
      // en este momento, NO se puede abrir otra página a la vez: comparten el
      // mismo browserManager y la misma pestaña, y una le pisaría la consulta
      // a la otra sin dar ningún error, dejando el acta con los datos vacíos
      // sin explicación. Se avisa y se genera el acta sin esos datos.
      let interesado = {};
      let motivoSinDatos = '';
      if (syncService.enEjecucion) {
        motivoSinDatos = 'hay una sincronización en curso; espere a que termine e intente de nuevo';
        logger.warn(`Acta ${tramite.numero_tramite}: ${motivoSinDatos}.`);
      } else {
        // Se toma el mismo candado que usa sincronizar(): así ninguna
        // sincronización automática puede arrancar (y arrebatar la página)
        // mientras se consulta el trámite para el acta.
        syncService.enEjecucion = true;
        try {
          const page = await syncService.browserManager.abrirBandejaAutenticada({
            interactivo: false,
          });
          const datos = await syncService.consultaTramite.consultar(page, tramite.numero_tramite);
          // No se exige datos.existe: ese indicador se apoya en los campos de
          // la izquierda de la ficha (estado, fecha, clase), y si esos no se
          // leen se descartaban los datos del interesado AUNQUE hubieran
          // llegado bien. Alcanza con que venga cualquiera de los cuatro.
          if (datos && (datos.interesado || datos.telefono || datos.email || datos.direccion)) {
            interesado = {
              nombre: datos.interesado,
              telefono: datos.telefono,
              email: datos.email,
              direccion: datos.direccion,
            };
            logger.info(
              `Acta ${tramite.numero_tramite}: interesado="${datos.interesado}" ` +
              `tel="${datos.telefono}" email="${datos.email}" dir="${datos.direccion}"`
            );
          } else if (datos) {
            motivoSinDatos = 'edis no devolvió esos datos para este radicado';
            logger.warn(
              `Acta ${tramite.numero_tramite}: ${motivoSinDatos}. ` +
              `etiquetas=${(syncService.consultaTramite.ultimasEtiquetas || []).join(' / ')}`
            );
          } else {
            motivoSinDatos = syncService.consultaTramite.ultimoProblema || 'no se pudo consultar edis';
            logger.warn(`Acta ${tramite.numero_tramite}: ${motivoSinDatos}.`);
          }
        } catch (error) {
          motivoSinDatos = error.message.split('\n')[0];
          logger.warn(`Acta ${tramite.numero_tramite}: sin datos del interesado (${motivoSinDatos}).`);
        } finally {
          syncService.enEjecucion = false;
          await syncService.browserManager.cerrar().catch(() => {});
        }
      }

      const faltantes = actaService.camposFaltantes(tramite, interesado);
      const ruta = await actaService.generar(tramite, interesado);
      shell.openPath(ruta);
      return { ok: true, ruta, faltantes, motivoSinDatos };
    } catch (error) {
      logger.error(`IPC generar acta: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  /* ------------------------- versión y actualizaciones ------------------------- */

  ipcMain.handle(CANALES.APP_VERSION, () => ({
    version: app.getVersion(),
    instalada: app.isPackaged,
  }));

  // Sin esto solo quedaba esperar al ciclo abrir → esperar → cerrar → abrir,
  // sin forma de saber si la versión nueva ya había llegado.
  ipcMain.handle(CANALES.APP_BUSCAR_ACTUALIZACION, async () => {
    if (!app.isPackaged) {
      return { ok: true, mensaje: 'En modo desarrollo no se buscan actualizaciones.' };
    }
    try {
      const resultado = await autoUpdater.checkForUpdates();
      const disponible = resultado && resultado.updateInfo ? resultado.updateInfo.version : null;
      if (!disponible || disponible === app.getVersion()) {
        return { ok: true, mensaje: `Ya tiene la última versión (${app.getVersion()}).` };
      }
      return {
        ok: true,
        mensaje:
          `Descargando la versión ${disponible} en segundo plano. ` +
          'Puede seguir trabajando: se instalará sola al cerrar el programa.',
      };
    } catch (error) {
      logger.error(`IPC buscar actualización: ${error.message}`);
      return { ok: false, error: `No se pudo consultar: ${error.message.split('\n')[0]}` };
    }
  });

  /* ------------------------- radicaciones (ventanilla) ------------------------- */

  ipcMain.handle(CANALES.RADICACIONES_LISTAR, () => radicacionRepository.listar());

  ipcMain.handle(CANALES.RADICACIONES_RESUMEN, () => radicacionRepository.resumen());

  ipcMain.handle(CANALES.RADICACIONES_CONFIG, () => {
    const anio = String(new Date().getFullYear());
    const hasta = radicacionRepository.ultimoExplorado(anio);
    return {
      activo: radicacionRepository.activo(),
      usuario: radicacionRepository.obtenerEstado('radicaciones.usuario') || '',
      desde: radicacionRepository.desde(),
      diagnostico: radicacionRepository.diagnostico(),
      // Hasta qué radicado llegó el recorrido: verlo evita el caso en que
      // el puntero quedó por encima de las radicaciones propias y todo
      // parecía "no encuentra nada" sin explicación.
      revisadoHasta: hasta === null ? '' : `${anio}-${hasta}`,
      traza: radicacionRepository.obtenerEstado('radicaciones.traza') || '',
    };
  });

  ipcMain.handle(CANALES.RADICACIONES_GUARDAR_CONFIG, (_evento, { activo, usuario, desde }) => {
    try {
      const nombre = String(usuario || '').trim();
      if (activo && !nombre) {
        throw new Error(
          'Escriba su nombre tal como aparece en edis (campo "Usuario que radica"): es lo que ' +
          'permite distinguir sus radicaciones de las de sus compañeros.'
        );
      }
      const inicio = String(desde || '').trim();
      if (inicio && !/^\d{4}-\d+$/.test(inicio)) {
        throw new Error('El radicado de inicio debe tener la forma AÑO-NÚMERO, por ejemplo 2026-7272.');
      }

      radicacionRepository.guardarEstado('radicaciones.usuario', nombre);
      radicacionRepository.guardarEstado('radicaciones.desde', inicio);
      radicacionRepository.activar(activo);

      // Guardar con un radicado de inicio significa "volvé a recorrer desde
      // ahí", siempre. Antes solo se reiniciaba si el valor cambiaba, así que
      // si el recorrido ya se había pasado de largo no había forma de
      // volverlo atrás: se guardaba y no pasaba nada.
      if (inicio) {
        const anio = inicio.split('-')[0];
        radicacionRepository.guardarEstado(`radicaciones.ultimoExplorado.${anio}`, '');
      }
      return { ok: true };
    } catch (error) {
      logger.error(`IPC radicaciones config: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });
}

module.exports = { registrarIpc, CANALES };
