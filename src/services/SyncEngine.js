'use strict';

/**
 * Motor de persistencia de la sincronización.
 *
 * Reglas:
 *  - Trámite nuevo  -> INSERT.
 *  - Trámite existente -> UPDATE solo de los campos modificados (con historial).
 *  - Trámite ausente de la bandeja -> se marca presente_en_bandeja = 0.
 *  - NUNCA se elimina un registro.
 *
 * Todo el lote se aplica en UNA transacción: o se persiste la sincronización
 * completa o la base de datos queda intacta.
 *
 * Marcar "enviado" a lo que sale de la bandeja NO ocurre acá: requiere
 * decidir qué fecha usar (hoy, o la real si hubo una brecha larga sin
 * sincronizar), lo que a veces implica consultar la web — algo que no cabe
 * dentro de esta transacción síncrona. Esa decisión la toma quien orquesta
 * la sincronización (BandejaSyncService), usando `resumen.ausentes`.
 */
class SyncEngine {
  /**
   * @param {import('../database/repositories/TramiteRepository').TramiteRepository} tramiteRepository
   * @param {import('../database/Database').Database} database
   * @param {import('../utils/logger').Logger} logger
   * @param {import('../database/repositories/GestionRepository').GestionRepository} [gestionRepository]
   */
  constructor(tramiteRepository, database, logger, gestionRepository = null) {
    this.tramites = tramiteRepository;
    this.database = database;
    this.logger = logger;
    this.gestion = gestionRepository;
  }

  /**
   * Persiste los trámites extraídos de la web.
   * @param {Array<object>} tramitesWeb
   * @returns {{nuevos: number, actualizados: number, sinCambios: number, marcadosAusentes: number, detalleCambios: Array<object>}}
   */
  persistir(tramitesWeb) {
    const aplicarLote = this.database.transaccion((lote) => {
      const resumen = {
        nuevos: 0,
        actualizados: 0,
        sinCambios: 0,
        marcadosAusentes: 0,
        ausentes: [],
        devueltos: 0,
        detalleCambios: [],
      };
      const devueltosPorColor = [];
      const reaparecidos = [];

      for (let indice = 0; indice < lote.length; indice++) {
        const tramite = lote[indice];
        const existente = this.tramites.buscarPorNumero(tramite.numero_tramite);

        if (!existente) {
          const idNuevo = this.tramites.insertar(tramite, indice);
          if (this.gestion) this.gestion.asegurar(idNuevo);
          if (tramite.devueltoWeb) devueltosPorColor.push(idNuevo);
          resumen.nuevos++;
          resumen.detalleCambios.push({
            numero_tramite: tramite.numero_tramite,
            accion: 'insertado',
          });
          continue;
        }

        if (tramite.devueltoWeb) devueltosPorColor.push(existente.id);
        // Un trámite que ya había salido de la bandeja (enviado) y vuelve a
        // aparecer, fue devuelto para corrección.
        if (existente.presente_en_bandeja === 0) reaparecidos.push(existente.id);

        const camposModificados = this.tramites.actualizarSiCambio(existente, tramite, indice);
        if (camposModificados.length > 0) {
          resumen.actualizados++;
          resumen.detalleCambios.push({
            numero_tramite: tramite.numero_tramite,
            accion: 'actualizado',
            campos: camposModificados,
          });
        } else {
          resumen.sinCambios++;
        }
      }

      const ausentes = this.tramites.marcarAusentes(lote.map((t) => t.numero_tramite));
      resumen.marcadosAusentes = ausentes.length;
      // Se guarda con numero_tramite (no solo el id) para que quien orquesta
      // la sincronización pueda, si hace falta, consultar en la web la
      // fecha REAL de envío de cada uno antes de marcarlos "enviado" (ver
      // BandejaSyncService): asumir "hoy" es correcto casi siempre, pero no
      // cuando pasó una brecha larga sin sincronizar.
      resumen.ausentes = ausentes;

      // Devueltos: filas en rojo en la cuadrícula, o trámites enviados que
      // reaparecieron en la bandeja.
      if (this.gestion) {
        resumen.devueltos += this.gestion.marcarDevueltos(devueltosPorColor);
        resumen.devueltos += this.gestion.marcarDevueltos(reaparecidos, { soloSiEnviado: true });
      }

      return resumen;
    });

    const resumen = aplicarLote(tramitesWeb);

    this.logger.info('Persistencia completada', {
      nuevos: resumen.nuevos,
      actualizados: resumen.actualizados,
      sinCambios: resumen.sinCambios,
      marcadosAusentes: resumen.marcadosAusentes,
    });

    return resumen;
  }
}

module.exports = { SyncEngine };
