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

      const idsAusentes = this.tramites.marcarAusentes(lote.map((t) => t.numero_tramite));
      resumen.marcadosAusentes = idsAusentes.length;

      // Automatismo de bitácora: lo que sale de la bandeja pasa a "enviado"
      // con fecha de envío de hoy (salvo estados finales puestos por el usuario).
      if (this.gestion && idsAusentes.length > 0) {
        this.gestion.marcarEnviados(idsAusentes);
      }

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
