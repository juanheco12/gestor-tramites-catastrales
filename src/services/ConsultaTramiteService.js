'use strict';

const { normalizarFecha } = require('../utils/fechas');

/**
 * Lee la pantalla "Consulta de Trámites" de edis (búsqueda por año + número
 * de radicado). Es la única fuente disponible para dos cosas que el
 * aplicativo no expone en ningún reporte:
 *
 *  1. La "Fecha envío a revisión" REAL de un trámite, cuando el robot
 *     detecta que salió de la bandeja tras una brecha larga sin sincronizar
 *     (asumir "hoy" sería incorrecto en ese caso).
 *  2. Quién radicó un número dado, para contar las radicaciones propias del
 *     personal de ventanilla recorriendo los números consecutivos.
 *
 * Cualquier usuario puede consultar cualquier radicado: basta con el número.
 */
class ConsultaTramiteService {
  /**
   * @param {object} config
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Consulta un radicado y devuelve sus datos.
   * @param {import('playwright').Page} page Página ya autenticada (misma sesión de la bandeja)
   * @param {string|{anio: string, numero: string|number}} radicado "2026-6431" o {anio, numero}
   * @returns {Promise<{existe: boolean, fechaRadicacion: string, usuarioRadica: string,
   *   clase: string, npn: string, interesado: string, fechaEnvioRevision: string}|null>}
   *   null si no se pudo consultar (error de red/página); `existe: false` si la
   *   consulta funcionó pero ese número todavía no está radicado.
   */
  async consultar(page, radicado, { navegar = true } = {}) {
    const cfg = this.config.consultaTramite;
    if (!cfg || !cfg.url) return null;

    const partes = this._partes(radicado);
    if (!partes) return null;
    const timeout = this.config.browser.timeoutMs;

    try {
      // Cuando se consultan muchos radicados seguidos (conteo de
      // radicaciones), recargar la página entera en cada uno multiplica el
      // tiempo por 3: el formulario sigue ahí después de buscar, así que
      // basta reescribir el número y volver a pulsar la lupa.
      if (navegar || !(await this._formularioListo(page))) {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout });
      }

      // Selectores "cerca de la etiqueta", igual que bandeja.accionesApertura:
      // sobreviven a que los IDs internos cambien entre cuentas o versiones.
      const campoAnio = page.locator("input:near(:text('AÑO'), 80)").first();
      const campoNumero = page.locator("input:near(:text('NÚMERO'), 80)").first();
      await campoAnio.waitFor({ state: 'visible', timeout: 10000 });
      await campoAnio.fill(partes.anio);
      await campoNumero.fill(partes.numero);

      const buscar = page.locator("input[type='image']:near(:text('NÚMERO'), 200)").first();
      await buscar.click({ timeout: 8000 });
      await page.waitForTimeout(1200);

      const datos = await page.evaluate(() => {
        const normalizar = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .replace(/\s+/g, ' ')
            .trim();

        // El valor de cada campo vive en un <input> de una celda vecina a la
        // que tiene la etiqueta; se mira un par de celdas a la derecha.
        const celdas = Array.from(document.querySelectorAll('td, th'));
        const leer = (etiqueta) => {
          const objetivo = normalizar(etiqueta);
          for (let i = 0; i < celdas.length; i++) {
            const texto = normalizar(celdas[i].textContent);
            if (texto !== objetivo && texto !== `${objetivo}:`) continue;
            for (let j = i + 1; j < celdas.length && j <= i + 3; j++) {
              const input = celdas[j].querySelector('input, textarea, select');
              const valor = (input ? input.value : celdas[j].textContent || '').trim();
              if (valor) return valor;
            }
          }
          return '';
        };

        return {
          fechaRadicacion: leer('Fecha Radicación'),
          usuarioRadica: leer('Usuario que radica'),
          clase: leer('Clase'),
          npn: leer('NPN'),
          interesado: leer('Nombre'),
          fechaEnvioRevision: leer('Fecha envío a revisión'),
          estado: leer('Estado del trámite'),
        };
      });

      const fechaRadicacion = this._fecha(datos.fechaRadicacion);
      // Sin fecha de radicación ni usuario, ese número todavía no existe.
      const existe = Boolean(fechaRadicacion || datos.usuarioRadica);

      return {
        existe,
        fechaRadicacion,
        usuarioRadica: datos.usuarioRadica || '',
        clase: datos.clase || '',
        npn: datos.npn || '',
        interesado: datos.interesado || '',
        fechaEnvioRevision: this._fecha(datos.fechaEnvioRevision),
      };
    } catch (error) {
      this.logger.warn(
        `No se pudo consultar el trámite ${partes.anio}-${partes.numero}: ${error.message.split('\n')[0]}`
      );
      return null;
    }
  }

  /**
   * Fecha REAL de envío a revisión de un trámite, o null si no se pudo leer
   * (el llamador debe caer de vuelta a la fecha de hoy en ese caso).
   * @returns {Promise<string|null>} ISO AAAA-MM-DD
   */
  async consultarFechaEnvio(page, numeroTramite) {
    const datos = await this.consultar(page, numeroTramite);
    return datos && datos.fechaEnvioRevision ? datos.fechaEnvioRevision : null;
  }

  /** ¿La página actual ya es el formulario de consulta (se puede reutilizar)? */
  async _formularioListo(page) {
    try {
      return (await page.locator("input:near(:text('AÑO'), 80)").count()) > 0;
    } catch {
      return false;
    }
  }

  /** "2026-6431" -> {anio:'2026', numero:'6431'} (tolera "26-..." y "026-..."). */
  _partes(radicado) {
    if (radicado && typeof radicado === 'object') {
      return { anio: String(radicado.anio), numero: String(radicado.numero) };
    }
    const m = String(radicado || '').match(/^(\d{2,4})-(\d+)/);
    if (!m) return null;
    const crudo = m[1];
    const anio =
      crudo.length <= 2 ? `20${crudo}` : crudo.length === 3 && crudo[0] === '0' ? `2${crudo}` : crudo;
    return { anio, numero: m[2] };
  }

  /** Devuelve la fecha en ISO solo si se reconoció con seguridad; si no, ''. */
  _fecha(texto) {
    const iso = normalizarFecha(String(texto || '').trim());
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
  }
}

module.exports = { ConsultaTramiteService };
