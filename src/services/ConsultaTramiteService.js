'use strict';

const { normalizarFecha } = require('../utils/fechas');

/**
 * Consulta la pantalla "Consulta de Trámites" de edis (búsqueda por
 * año + número de radicado) y lee su "Fecha envío a revisión" REAL.
 *
 * Se usa cuando el robot detecta que un trámite salió de la bandeja
 * después de una brecha larga sin sincronizar: en ese caso asumir "hoy"
 * como fecha de envío está mal — pudo haberse enviado cualquier día de
 * esa brecha. En el uso normal (sincronizaciones cada pocos minutos) esta
 * consulta NO se usa, porque "hoy" ya es correcto y consultar la web por
 * cada trámite sería lento sin necesidad (ver BandejaSyncService).
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
   * @param {import('playwright').Page} page Página ya autenticada (misma sesión de la bandeja)
   * @param {string} numeroTramite p. ej. "2026-6431"
   * @returns {Promise<string|null>} Fecha ISO (AAAA-MM-DD), o null si no se pudo leer
   *   (el llamador debe caer de vuelta a la fecha de hoy en ese caso).
   */
  async consultarFechaEnvio(page, numeroTramite) {
    const cfg = this.config.consultaTramite;
    if (!cfg || !cfg.url) return null;

    const m = String(numeroTramite || '').match(/^(\d{2,4})-(\d+)/);
    if (!m) return null;
    const anio = m[1].length <= 2 ? `20${m[1]}` : m[1].length === 3 ? `2${m[1]}` : m[1];
    const numero = m[2];
    const timeout = this.config.browser.timeoutMs;

    try {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout });

      // Mismo patrón de selector "cerca de la etiqueta de texto" que ya usa
      // bandeja.accionesApertura para este mismo aplicativo, en vez de un
      // ID fijo que podría no existir en la cuenta de otro ejecutor.
      const campoAnio = page.locator("input:near(:text('AÑO'), 80)").first();
      const campoNumero = page.locator("input:near(:text('NÚMERO'), 80)").first();
      await campoAnio.waitFor({ state: 'visible', timeout: 10000 });
      await campoAnio.fill('');
      await campoAnio.fill(anio);
      await campoNumero.fill('');
      await campoNumero.fill(numero);

      const buscar = page.locator("input[type='image']:near(:text('NÚMERO'), 200)").first();
      await buscar.click({ timeout: 5000 });
      await page.waitForTimeout(1500);

      const valor = await page.evaluate(() => {
        function normalizar(t) {
          return (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .trim();
        }
        const objetivo = 'FECHA ENVIO A REVISION';
        const celdas = Array.from(document.querySelectorAll('td, th'));
        for (let i = 0; i < celdas.length; i++) {
          if (!normalizar(celdas[i].textContent).startsWith(objetivo)) continue;
          for (let j = i + 1; j < celdas.length && j < i + 4; j++) {
            const input = celdas[j].querySelector('input');
            const texto = (input ? input.value : celdas[j].textContent || '').trim();
            if (texto) return texto;
          }
        }
        return null;
      });

      if (!valor) {
        this.logger.warn(
          `Consulta trámite ${numeroTramite}: no se encontró "Fecha envío a revisión" en la página.`
        );
        return null;
      }

      const iso = normalizarFecha(valor);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        this.logger.warn(`Consulta trámite ${numeroTramite}: fecha "${valor}" no reconocida.`);
        return null;
      }
      return iso;
    } catch (error) {
      this.logger.warn(
        `No se pudo consultar la fecha real de envío de ${numeroTramite}: ${error.message.split('\n')[0]}`
      );
      return null;
    }
  }
}

module.exports = { ConsultaTramiteService };
