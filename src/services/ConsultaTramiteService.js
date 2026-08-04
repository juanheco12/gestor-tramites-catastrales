'use strict';

const { normalizarFecha } = require('../utils/fechas');

/**
 * Cuánto se espera, tras pulsar la lupa, a que aparezcan los datos de la
 * ficha. No puede ser un tiempo fijo corto: en una red lenta la ficha aún no
 * cargó y se leería el formulario en blanco, o sea "no existe" para TODOS los
 * radicados. Se sondea hasta este límite; agotarlo sí significa que el
 * radicado no existe.
 */
const ESPERA_RESULTADO_MS = 8000;

/**
 * Lee los campos de la ficha del trámite. Corre DENTRO del navegador.
 *
 * Se recorre la página en orden de lectura armando una secuencia de
 * etiquetas y campos. Buscar "la celda de al lado" no sirve: la página anida
 * tablas, así que el textContent de una celda de afuera se traga el bloque
 * entero y nunca coincide con la etiqueta exacta.
 */
function LECTOR_FICHA() {
  const normalizar = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:$/, '');

  const secuencia = [];
  const recorrer = (nodo) => {
    for (const hijo of nodo.children) {
      const tag = hijo.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        const tipo = (hijo.getAttribute('type') || '').toLowerCase();
        if (tipo !== 'image' && tipo !== 'submit' && tipo !== 'button') {
          secuencia.push({ campo: true, valor: (hijo.value || '').trim() });
        }
        continue;
      }
      // Texto PROPIO del elemento (sin lo que aportan sus hijos): es lo que
      // distingue una etiqueta real de un contenedor.
      const propio = Array.from(hijo.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
        .trim();
      if (propio) secuencia.push({ campo: false, texto: normalizar(propio) });
      recorrer(hijo);
    }
  };
  recorrer(document.body);

  const leer = (etiqueta) => {
    const objetivo = normalizar(etiqueta);
    for (let i = 0; i < secuencia.length; i++) {
      if (secuencia[i].campo || secuencia[i].texto !== objetivo) continue;
      // El valor es el primer campo que aparece después de la etiqueta.
      for (let j = i + 1; j < secuencia.length && j <= i + 4; j++) {
        if (secuencia[j].campo) return secuencia[j].valor;
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
    // Para diagnosticar si la lectura falla: qué etiquetas se vieron.
    etiquetas: secuencia.filter((s) => !s.campo).map((s) => s.texto).slice(0, 60),
  };
}

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
    this.diagnosticoDado = false;
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
  async consultar(page, radicado) {
    const cfg = this.config.consultaTramite;
    if (!cfg || !cfg.url) return null;

    const partes = this._partes(radicado);
    if (!partes) return null;
    const timeout = this.config.browser.timeoutMs;

    try {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout });

      // Selectores "cerca de la etiqueta", igual que bandeja.accionesApertura:
      // sobreviven a que los IDs internos cambien entre cuentas o versiones.
      const campoAnio = page.locator("input:near(:text('AÑO'), 80)").first();
      const campoNumero = page.locator("input:near(:text('NÚMERO'), 80)").first();
      await campoAnio.waitFor({ state: 'visible', timeout: 10000 });
      await campoAnio.fill(partes.anio);
      await campoNumero.fill(partes.numero);

      const buscar = page.locator("input[type='image']:near(:text('NÚMERO'), 200)").first();
      await buscar.click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});

      // Sondeo hasta que la ficha traiga algo (ver ESPERA_RESULTADO_MS).
      const limite = Date.now() + ESPERA_RESULTADO_MS;
      let datos = await page.evaluate(LECTOR_FICHA);
      while (!this._tieneAlgo(datos) && Date.now() < limite) {
        await page.waitForTimeout(400);
        datos = await page.evaluate(LECTOR_FICHA);
      }

      const fechaRadicacion = this._fecha(datos.fechaRadicacion);
      const existe = this._tieneAlgo(datos);

      // La PRIMERA consulta de cada corrida deja rastro de lo que vio: si algo
      // cambia en edis, el log dice qué había en pantalla en vez de dejarnos
      // adivinando por qué no se detectó nada.
      if (!this.diagnosticoDado) {
        this.diagnosticoDado = true;
        this.logger.info(
          `Consulta ${partes.anio}-${partes.numero}: existe=${existe} ` +
          `fechaRad="${datos.fechaRadicacion}" usuarioRadica="${datos.usuarioRadica}" ` +
          `clase="${datos.clase}" estado="${datos.estado}" | url=${page.url()} | ` +
          `etiquetas: ${(datos.etiquetas || []).join(' / ')}`
        );
      }

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

  /**
   * Un radicado inexistente deja TODOS los campos en blanco; basta con que
   * uno traiga algo (incluido el estado, p. ej. "SIN TRAMITAR") para saber
   * que la ficha ya cargó y el radicado existe.
   */
  _tieneAlgo(datos) {
    if (!datos) return false;
    return Boolean(
      this._fecha(datos.fechaRadicacion) || datos.usuarioRadica || datos.clase || datos.estado
    );
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

// LECTOR_FICHA se exporta para poder verificarlo contra una réplica de la
// pantalla real sin tener que duplicar su código en la prueba.
module.exports = { ConsultaTramiteService, LECTOR_FICHA };
