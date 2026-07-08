'use strict';

/** Campos de gestión que el usuario puede editar desde la interfaz. */
const CAMPOS_EDITABLES = [
  'mi_estado',
  'observacion',
  'prioridad',
  'sector',
  'fmi',
  'fecha_realizacion',
  'fecha_envio',
  'analisis',
  'estado_seguimiento',
];

const ESTADOS_VALIDOS = ['por_estudiar', 'estudiado', 'visita', 'enviado', 'devuelto', 'finalizado'];

/**
 * Acceso a los campos de gestión PROPIOS del ejecutor (tramites_gestion).
 * El robot de sincronización nunca pisa estos datos; solo automatiza dos
 * transiciones seguras: crear la fila al aparecer un trámite y marcar
 * "enviado" cuando el trámite sale de la bandeja.
 */
class GestionRepository {
  /** @param {import('../Database').Database} database */
  constructor(database) {
    this.db = database.conexion;

    this.stmtAsegurar = this.db.prepare(
      'INSERT OR IGNORE INTO tramites_gestion (tramite_id) VALUES (?)'
    );
  }

  /** Garantiza que el trámite tenga fila de gestión. */
  asegurar(tramiteId) {
    this.stmtAsegurar.run(tramiteId);
  }

  /**
   * Actualiza campos editables de un trámite. Solo acepta campos conocidos.
   * @param {number} tramiteId
   * @param {object} campos p. ej. { observacion: '...', mi_estado: 'visita' }
   */
  actualizar(tramiteId, campos) {
    const aActualizar = Object.entries(campos).filter(([campo]) =>
      CAMPOS_EDITABLES.includes(campo)
    );
    if (aActualizar.length === 0) return;

    const estado = campos.mi_estado;
    if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) {
      throw new Error(`Estado de gestión inválido: ${estado}`);
    }

    this.asegurar(tramiteId);
    const sets = aActualizar.map(([campo]) => `${campo} = @${campo}`);
    sets.push("actualizado_en = datetime('now', 'localtime')");

    this.db
      .prepare(`UPDATE tramites_gestion SET ${sets.join(', ')} WHERE tramite_id = @tramite_id`)
      .run({ tramite_id: tramiteId, ...Object.fromEntries(aActualizar) });

    // Reglas del flujo del ejecutor (solo si él no fijó el estado a mano):
    //  - prioridad VISITA, O la observación menciona "visita" (aunque no
    //    exista columna de prioridad) => estado "visita".
    //  - trámite sin estudiar que ya tiene observación => "estudiado".
    // Se leen los valores YA GUARDADOS (tras el UPDATE de arriba) para que
    // la regla aplique sin importar cuál campo se haya editado en esta llamada.
    //
    // IMPORTANTE: "Estudiado"/"Visita" son solo estado interno de trabajo
    // sobre la BANDEJA; NO implican fecha_realizacion ni que el trámite
    // deba aparecer en el Histórico. Esa fecha la pone el usuario a mano
    // (en la ficha o con "Agregar trámite"), igual que en su bitácora Excel:
    // "Histórico" ≠ "todo lo que está en la bandeja".
    if (campos.mi_estado === undefined) {
      const actual = this.db
        .prepare('SELECT mi_estado, prioridad, observacion FROM tramites_gestion WHERE tramite_id = ?')
        .get(tramiteId);

      const esVisita = /VISITA/i.test(actual.prioridad || '') || /VISITA/i.test(actual.observacion || '');
      const yaEstadoFinal = ['visita', 'finalizado'].includes(actual.mi_estado);

      let derivado = null;
      if (esVisita && !yaEstadoFinal) {
        derivado = 'visita';
      } else if (actual.mi_estado === 'por_estudiar' && (actual.observacion || '').trim() !== '') {
        derivado = 'estudiado';
      }

      if (derivado) {
        this.db
          .prepare("UPDATE tramites_gestion SET mi_estado = ?, actualizado_en = datetime('now', 'localtime') WHERE tramite_id = ?")
          .run(derivado, tramiteId);
      }
    }
  }

  /**
   * Aplica las reglas de estado a los trámites en bandeja (corrección masiva
   * tras una importación o sincronización): prioridad VISITA o la
   * observación menciona "visita" => visita; con observación => estudiado.
   * @returns {{aVisita: number, aEstudiado: number}}
   */
  aplicarReglasDeEstado() {
    const aVisita = this.db
      .prepare(`
        UPDATE tramites_gestion
        SET mi_estado = 'visita', actualizado_en = datetime('now', 'localtime')
        WHERE (UPPER(COALESCE(prioridad, '')) LIKE '%VISITA%'
               OR UPPER(COALESCE(observacion, '')) LIKE '%VISITA%')
          AND mi_estado IN ('por_estudiar', 'estudiado')
          AND tramite_id IN (SELECT id FROM tramites WHERE presente_en_bandeja = 1)
      `)
      .run().changes;

    const aEstudiado = this.db
      .prepare(`
        UPDATE tramites_gestion
        SET mi_estado = 'estudiado',
            actualizado_en = datetime('now', 'localtime')
        WHERE mi_estado = 'por_estudiar'
          AND TRIM(COALESCE(observacion, '')) <> ''
          AND tramite_id IN (SELECT id FROM tramites WHERE presente_en_bandeja = 1)
      `)
      .run().changes;

    return { aVisita, aEstudiado };
  }

  /**
   * Automatismo: los trámites que salieron de la bandeja (porque ya se
   * enviaron) pasan a "enviado" con fecha de envío de hoy. Replica
   * exactamente lo que el usuario hacía a mano en su bitácora: la nota de
   * seguimiento ("EN ESPERA - PARTE GRAFICA"...) es una etiqueta TEMPORAL
   * de mientras el trámite seguía pendiente; al enviarlo, esa etiqueta se
   * cierra y se reemplaza por "EN REVISION" / observación "OK" — el mismo
   * registro que ya estaba "en espera" pasa a ser el de "enviado", sin
   * crear uno nuevo. El análisis jurídico (motivación) NUNCA se toca.
   *
   * Si el trámite nunca tuvo fecha de realización (nunca se agregó a mano
   * al histórico mientras estaba en espera), se estampa también con la
   * fecha de hoy: en la bitácora del usuario TODO trámite enviado queda
   * con ambas fechas, aunque se haya estudiado y enviado el mismo día.
   * Esto es lo único que hace que el trámite entre al Histórico si nunca
   * se agregó a mano.
   * @param {number[]} tramiteIds
   * @returns {number} filas afectadas
   */
  marcarEnviados(tramiteIds) {
    if (tramiteIds.length === 0) return 0;
    return this.db
      .prepare(`
        UPDATE tramites_gestion
        SET mi_estado = 'enviado',
            fecha_realizacion = COALESCE(fecha_realizacion, date('now', 'localtime')),
            fecha_envio = COALESCE(fecha_envio, date('now', 'localtime')),
            observacion = 'OK',
            analisis = COALESCE(NULLIF(analisis, ''), 'OK'),
            estado_seguimiento = 'EN REVISION',
            actualizado_en = datetime('now', 'localtime')
        WHERE mi_estado NOT IN ('enviado', 'finalizado')
          AND tramite_id IN (SELECT value FROM json_each(?))
      `)
      .run(JSON.stringify(tramiteIds)).changes;
  }

  /** Fila de gestión cruda de un trámite (o undefined si no existe). */
  obtener(tramiteId) {
    return this.db.prepare('SELECT * FROM tramites_gestion WHERE tramite_id = ?').get(tramiteId);
  }

  /**
   * Elimina por completo un trámite agregado a MANO por error (botón
   * "Agregar trámite"). Solo borra si origen='manual': un trámite real,
   * sincronizado desde el aplicativo o importado de un Excel, NUNCA se
   * elimina (regla de negocio del sistema completo).
   * @param {number} tramiteId
   * @returns {boolean} true si se eliminó
   */
  eliminarManual(tramiteId) {
    const tramite = this.db.prepare('SELECT id, origen FROM tramites WHERE id = ?').get(tramiteId);
    if (!tramite) return false;
    if (tramite.origen !== 'manual') {
      throw new Error('Solo se pueden eliminar trámites agregados a mano; los reales nunca se borran.');
    }

    const borrar = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tramites_historial WHERE tramite_id = ?').run(tramiteId);
      this.db.prepare('DELETE FROM tramites_gestion WHERE tramite_id = ?').run(tramiteId);
      this.db.prepare('DELETE FROM tramites WHERE id = ?').run(tramiteId);
    });
    borrar();
    return true;
  }

  /**
   * Listado unificado para la interfaz: trámite + gestión en una sola fila.
   * El filtrado fino (texto, estado, sector) lo hace la interfaz.
   */
  listarConGestion({ limite = 5000 } = {}) {
    return this.db
      .prepare(`
        SELECT
          t.id, t.numero_tramite, t.tipo, t.estado, t.fecha, t.solicitante,
          t.datos_extra, t.presente_en_bandeja, t.orden_bandeja, t.origen,
          t.estado_anterior, t.fecha_cambio_estado, t.actualizado_en,
          g.mi_estado, g.observacion, g.prioridad, g.sector, g.fmi,
          g.fecha_realizacion, g.fecha_envio, g.analisis, g.estado_seguimiento
        FROM tramites t
        LEFT JOIN tramites_gestion g ON g.tramite_id = t.id
        ORDER BY
          t.presente_en_bandeja DESC,
          CASE WHEN t.orden_bandeja IS NULL THEN 1 ELSE 0 END,
          t.orden_bandeja ASC,
          t.numero_tramite DESC
        LIMIT ?
      `)
      .all(limite);
  }

  /**
   * Automatismo: marca trámites como DEVUELTOS.
   * @param {number[]} tramiteIds
   * @param {{soloSiEnviado?: boolean}} [opciones] true = solo los que el
   *   usuario ya había enviado/finalizado (caso reaparición en bandeja)
   * @returns {number} filas afectadas
   */
  marcarDevueltos(tramiteIds, { soloSiEnviado = false } = {}) {
    if (tramiteIds.length === 0) return 0;
    const condicion = soloSiEnviado
      ? "AND mi_estado IN ('enviado', 'finalizado')"
      : "AND mi_estado <> 'devuelto'";
    return this.db
      .prepare(`
        UPDATE tramites_gestion
        SET mi_estado = 'devuelto',
            actualizado_en = datetime('now', 'localtime')
        WHERE tramite_id IN (SELECT value FROM json_each(?))
          ${condicion}
      `)
      .run(JSON.stringify(tramiteIds)).changes;
  }

  /** Trámites en bandeja que requieren visita, en orden de bandeja. */
  listarVisitas() {
    return this.db
      .prepare(`
        SELECT t.numero_tramite, t.tipo, t.datos_extra, g.sector, g.observacion, g.prioridad
        FROM tramites t
        JOIN tramites_gestion g ON g.tramite_id = t.id
        WHERE g.mi_estado = 'visita' AND t.presente_en_bandeja = 1
        ORDER BY t.orden_bandeja ASC
      `)
      .all();
  }

  /** Seguimientos importados de la hoja POS TRAMITE. */
  listarPosTramite() {
    return this.db
      .prepare('SELECT categoria, radicado, detalle FROM pos_tramite ORDER BY categoria, radicado')
      .all();
  }

  /** Conteos para las tarjetas del tablero. */
  resumen() {
    return this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN t.presente_en_bandeja = 1 THEN 1 ELSE 0 END) AS en_bandeja,
          SUM(CASE WHEN t.presente_en_bandeja = 1 AND g.mi_estado = 'por_estudiar' THEN 1 ELSE 0 END) AS por_estudiar,
          SUM(CASE WHEN t.presente_en_bandeja = 1 AND g.mi_estado = 'visita' THEN 1 ELSE 0 END) AS visita,
          SUM(CASE WHEN t.presente_en_bandeja = 1 AND g.mi_estado = 'devuelto' THEN 1 ELSE 0 END) AS devueltos
        FROM tramites t
        LEFT JOIN tramites_gestion g ON g.tramite_id = t.id
      `)
      .get();
  }
}

module.exports = { GestionRepository, CAMPOS_EDITABLES, ESTADOS_VALIDOS };
