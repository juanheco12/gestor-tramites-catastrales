'use strict';

/**
 * Radicaciones propias del usuario (rol de ventanilla) y el estado interno
 * del recorrido que las detecta.
 *
 * edis no ofrece ningún reporte de "qué radiqué hoy": lo único disponible es
 * consultar un radicado puntual. Como los números son consecutivos y suben
 * con la fecha, el robot los recorre hacia arriba y guarda acá los que le
 * pertenecen al usuario logueado.
 */
class RadicacionRepository {
  /** @param {import('../Database').Database} database */
  constructor(database) {
    this.db = database.conexion;
  }

  /* ------------------------- estado del recorrido ------------------------- */

  obtenerEstado(clave, porDefecto = null) {
    const fila = this.db.prepare('SELECT valor FROM app_estado WHERE clave = ?').get(clave);
    return fila ? fila.valor : porDefecto;
  }

  guardarEstado(clave, valor) {
    this.db
      .prepare('INSERT INTO app_estado (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
      .run(clave, String(valor));
  }

  /** ¿El usuario activó el conteo de radicaciones (solo ventanilla lo necesita)? */
  activo() {
    return this.obtenerEstado('radicaciones.activo') === '1';
  }

  activar(valor) {
    this.guardarEstado('radicaciones.activo', valor ? '1' : '0');
  }

  /**
   * Último número de radicado ya explorado para un año dado (o null si nunca
   * se exploró: primer arranque).
   */
  ultimoExplorado(anio) {
    const v = this.obtenerEstado(`radicaciones.ultimoExplorado.${anio}`);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  guardarUltimoExplorado(anio, numero) {
    this.guardarEstado(`radicaciones.ultimoExplorado.${anio}`, numero);
  }

  /* ------------------------- radicaciones ------------------------- */

  /**
   * Guarda una radicación. Si el número ya existe no hace nada: recorrer dos
   * veces el mismo rango nunca duplica ni pisa lo ya detectado.
   * @returns {boolean} true si era nueva
   */
  registrar({ numero_radicado, fecha_radicacion, usuario_radica, clase, npn, interesado }) {
    const r = this.db
      .prepare(`
        INSERT OR IGNORE INTO radicaciones
          (numero_radicado, fecha_radicacion, usuario_radica, clase, npn, interesado)
        VALUES (@numero_radicado, @fecha_radicacion, @usuario_radica, @clase, @npn, @interesado)
      `)
      .run({
        numero_radicado,
        fecha_radicacion: fecha_radicacion || null,
        usuario_radica: usuario_radica || null,
        clase: clase || null,
        npn: npn || null,
        interesado: interesado || null,
      });
    return r.changes > 0;
  }

  listar({ limite = 2000 } = {}) {
    return this.db
      .prepare('SELECT * FROM radicaciones ORDER BY fecha_radicacion DESC, numero_radicado DESC LIMIT ?')
      .all(limite);
  }

  /** Conteos para las tarjetas del panel (hoy / semana / mes / total). */
  resumen() {
    return this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN fecha_radicacion = date('now', 'localtime') THEN 1 ELSE 0 END) AS hoy,
          SUM(CASE WHEN fecha_radicacion >= date('now', 'localtime', '-6 days') THEN 1 ELSE 0 END) AS semana,
          SUM(CASE WHEN strftime('%Y-%m', fecha_radicacion) = strftime('%Y-%m', 'now', 'localtime') THEN 1 ELSE 0 END) AS mes
        FROM radicaciones
      `)
      .get();
  }
}

module.exports = { RadicacionRepository };
