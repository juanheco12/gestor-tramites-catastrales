'use strict';

const { EventEmitter } = require('events');
const { BrowserManager } = require('./BrowserManager');
const { BandejaScraper } = require('./BandejaScraper');
const { SyncEngine } = require('./SyncEngine');
const { withRetry } = require('../utils/retry');

/**
 * Servicio principal del Sincronizador de Bandeja. Orquesta:
 *   navegador (BrowserManager) -> extracción (BandejaScraper)
 *   -> persistencia (SyncEngine) -> registro (SyncLogRepository).
 *
 * Emite eventos de progreso para que la UI informe al usuario sin acoplarse:
 *   'progreso'  { fase, mensaje }
 *   'finalizado' { resumen }
 *   'fallo'     { mensaje }  (no se usa 'error' para evitar el throw implícito de EventEmitter)
 */
class BandejaSyncService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {import('../utils/logger').Logger} deps.logger
   * @param {import('../database/Database').Database} deps.database
   * @param {import('../database/repositories/TramiteRepository').TramiteRepository} deps.tramiteRepository
   * @param {import('../database/repositories/SyncLogRepository').SyncLogRepository} deps.syncLogRepository
   */
  constructor({
    config,
    logger,
    database,
    tramiteRepository,
    syncLogRepository,
    bitacoraService = null,
    gestionRepository = null,
    credencialesService = null,
  }) {
    super();
    this.config = config;
    this.logger = logger;
    this.syncLogs = syncLogRepository;
    this.bitacora = bitacoraService;
    this.gestionRepository = gestionRepository;

    this.browserManager = new BrowserManager(config, logger, credencialesService);
    this.scraper = new BandejaScraper(config, logger, (mensaje) =>
      this._progreso('extraccion', mensaje)
    );
    this.engine = new SyncEngine(tramiteRepository, database, logger, gestionRepository);

    this.enEjecucion = false;
  }

  _progreso(fase, mensaje) {
    this.logger.info(`[${fase}] ${mensaje}`);
    this.emit('progreso', { fase, mensaje });
  }

  /**
   * Ejecuta una sincronización completa. Idempotente y protegida contra
   * ejecuciones concurrentes (un solo navegador/escritura a la vez).
   * @param {{interactivo?: boolean}} [opciones] interactivo=false para las
   *   corridas automáticas: oculta el navegador y no pide login.
   * @returns {Promise<object>} Resumen de la sincronización
   */
  async sincronizar({ interactivo = true } = {}) {
    if (this.enEjecucion) {
      throw new Error('Ya hay una sincronización en curso.');
    }
    this.enEjecucion = true;

    const inicio = Date.now();
    const logId = this.syncLogs.iniciar();
    const errores = [];

    try {
      const tramitesWeb = await withRetry(
        async (intento) => {
          this._progreso(
            'navegacion',
            intento === 1
              ? 'Abriendo navegador y verificando sesión...'
              : `Reintento ${intento} de ${this.config.sync.reintentos}...`
          );
          const page = await this.browserManager.abrirBandejaAutenticada({ interactivo });

          this._progreso('extraccion', 'Leyendo la tabla de trámites...');
          return await this.scraper.extraerTramites(page);
        },
        {
          reintentos: this.config.sync.reintentos,
          backoffBaseMs: this.config.sync.backoffBaseMs,
          backoffFactor: this.config.sync.backoffFactor,
          onError: (error, intento) => {
            errores.push({
              fase: 'extraccion',
              intento,
              mensaje: error.message,
              fecha: new Date().toISOString(),
            });
            this.logger.error(`Intento ${intento} fallido: ${error.message}`);
          },
        }
      );

      if (tramitesWeb.length === 0) {
        // Una bandeja vacía es posible pero muy improbable: se marca como
        // parcial para que el usuario lo revise en lugar de confiar en un
        // "exitoso" engañoso.
        errores.push({
          fase: 'extraccion',
          mensaje: 'Se leyeron 0 trámites. Si su bandeja no está vacía, revise los logs.',
          fecha: new Date().toISOString(),
        });
      }

      this._progreso('persistencia', `Guardando ${tramitesWeb.length} trámites...`);
      const resumenPersistencia = this.engine.persistir(tramitesWeb);

      // El sistema queda "siempre sincronizado": además de guardar los datos
      // crudos, se reaplican las reglas de estado propias del ejecutor
      // (prioridad u observación mencionan "visita" => visita; con
      // observación y sin estudiar => estudiado) por si algo cambió en la
      // bandeja que las active.
      let reglasAplicadas = { aVisita: 0, aEstudiado: 0 };
      if (this.gestionRepository) {
        reglasAplicadas = this.gestionRepository.aplicarReglasDeEstado();
      }

      // Cruce con la bitácora Excel del usuario: agrega los trámites que
      // faltan respetando el orden de la bandeja. Un fallo aquí no invalida
      // la sincronización (los datos ya quedaron en la base de datos).
      let resultadoBitacora = null;
      const bitacoraActiva = this.config.bitacora && this.config.bitacora.activa !== false;
      if (bitacoraActiva && this.bitacora && this.bitacora.habilitada && tramitesWeb.length > 0) {
        this._progreso('bitacora', 'Cruzando con la bitácora Excel...');
        try {
          resultadoBitacora = await this.bitacora.actualizar();
          this._progreso('bitacora', resultadoBitacora.mensaje);
        } catch (error) {
          errores.push({
            fase: 'bitacora',
            mensaje: error.message,
            fecha: new Date().toISOString(),
          });
          this.logger.error(`Actualización de bitácora fallida: ${error.message}`);
        }
      }

      const resumen = {
        duracionMs: Date.now() - inicio,
        leidos: tramitesWeb.length,
        nuevos: resumenPersistencia.nuevos,
        actualizados: resumenPersistencia.actualizados,
        sinCambios: resumenPersistencia.sinCambios,
        marcadosAusentes: resumenPersistencia.marcadosAusentes,
        devueltos: resumenPersistencia.devueltos || 0,
        detalleCambios: resumenPersistencia.detalleCambios,
        reglasAplicadas,
        bitacora: resultadoBitacora,
        mensajeNuevos:
          resumenPersistencia.nuevos === 0
            ? 'No hay trámites asignados recientemente.'
            : `Trámites nuevos asignados: ${resumenPersistencia.detalleCambios
                .filter((c) => c.accion === 'insertado')
                .map((c) => c.numero_tramite)
                .join(', ')}.`,
        errores,
        estado: errores.length > 0 ? 'parcial' : 'exitoso',
      };

      this.syncLogs.finalizar(logId, resumen);
      this._progreso(
        'finalizado',
        `Sincronización ${resumen.estado}: ${resumen.nuevos} nuevos, ` +
        `${resumen.actualizados} actualizados, ${resumen.sinCambios} sin cambios, ` +
        `${resumen.devueltos} devueltos (${(resumen.duracionMs / 1000).toFixed(1)} s).`
      );
      this.emit('finalizado', { resumen });
      return resumen;
    } catch (error) {
      errores.push({
        fase: 'fatal',
        mensaje: error.message,
        fecha: new Date().toISOString(),
      });

      const resumen = {
        duracionMs: Date.now() - inicio,
        leidos: 0,
        nuevos: 0,
        actualizados: 0,
        sinCambios: 0,
        errores,
        estado: 'fallido',
      };
      this.syncLogs.finalizar(logId, resumen);

      this.logger.error(`Sincronización fallida: ${error.message}`);
      this.emit('fallo', { mensaje: error.message });
      throw error;
    } finally {
      this.enEjecucion = false;
      // El navegador headless se cierra siempre; si quedó visible tras un
      // login manual, también se cierra: la sesión ya está persistida en disco.
      await this.browserManager.cerrar();
    }
  }

  async destruir() {
    await this.browserManager.cerrar();
  }
}

module.exports = { BandejaSyncService };
