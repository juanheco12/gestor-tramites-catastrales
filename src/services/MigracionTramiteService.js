'use strict';

const fs = require('fs');
const path = require('path');

const ESPERA_FICHA_MS = 12000;
const ESPERA_TAB_MS = 5000;

/**
 * Navega la página de resolución de edis, lee los datos de un trámite
 * (origen) y los escribe en otro (destino).
 *
 * Los campos que se migran son: Predio (destino económico, matrícula,
 * tipo de predio, dirección), Propietarios, Fuente Administrativa e
 * Inscripción Catastral. Terreno y Construcciones NO se tocan.
 */
class MigracionTramiteService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Lee los datos del trámite origen en edis.
   *
   * @param {import('playwright').Page} page Página autenticada en resolucion2ND
   * @param {string} radicado  "2026-8712"
   * @param {(msg: string) => void} onProgreso
   * @returns {Promise<object>} Datos leídos por pestaña
   */
  async leerOrigen(page, radicado, onProgreso = () => {}) {
    onProgreso('Abriendo trámite origen en la bandeja...');
    await this._abrirTramiteEnBandeja(page, radicado);

    onProgreso('Leyendo pestaña Predio...');
    const predio = await this._leerPestana(page, 'Predio');

    onProgreso('Leyendo pestaña Propietarios...');
    const propietarios = await this._leerPestana(page, 'Propietarios');

    onProgreso('Leyendo pestaña Fuente Administrativa...');
    const fuente = await this._leerPestana(page, 'Fte Administrativa');

    await this._guardarDiagnostico(page, `origen-${radicado}`);

    return { predio, propietarios, fuente };
  }

  /**
   * Escribe los datos en el trámite destino.
   *
   * @param {import('playwright').Page} page
   * @param {string} radicado "2026-8743"
   * @param {object} datos  Lo que devolvió leerOrigen()
   * @param {object} extras Datos adicionales que el usuario indicó aparte
   * @param {(msg: string) => void} onProgreso
   */
  async escribirDestino(page, radicado, datos, extras, onProgreso = () => {}) {
    onProgreso('Volviendo a la bandeja...');
    await page.goto(this.config.bandeja.url, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.browser.timeoutMs,
    });

    onProgreso('Abriendo trámite destino en la bandeja...');
    await this._abrirTramiteEnBandeja(page, radicado);

    // Predio
    onProgreso('Llenando pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    await this._llenarCamposPredio(page, datos.predio, extras);

    // Propietarios
    onProgreso('Llenando pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    await this._llenarCamposPropietarios(page, datos.propietarios, extras);

    // Fuente Administrativa + Inscripción Catastral
    onProgreso('Llenando pestaña Fuente Administrativa...');
    await this._irAPestana(page, 'Fte Administrativa');
    await this._llenarCamposFuente(page, datos.fuente, extras);

    await this._guardarDiagnostico(page, `destino-${radicado}`);
    onProgreso('Datos migrados. Revise en pantalla y guarde manualmente.');
  }

  /**
   * Busca un radicado en la bandeja de la página de resolución y lo abre.
   * El radicado aparece como enlace en la tabla; se hace clic en él.
   */
  async _abrirTramiteEnBandeja(page, radicado) {
    const timeout = this.config.browser.timeoutMs;

    // Primero asegurar que estamos en la página de resolución
    const url = page.url();
    if (!url.includes('resolucion')) {
      await page.goto(this.config.bandeja.url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
    }

    // Abrir la bandeja (hacer clic en la lupa, igual que BandejaScraper)
    const acciones = this.config.bandeja.accionesApertura || [];
    for (const selector of acciones) {
      try {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
          break;
        }
      } catch {
        continue;
      }
    }

    // Buscar el enlace del radicado en la tabla y hacer clic
    await page.waitForTimeout(2000);
    const enlace = await this._buscarRadicadoEnTabla(page, radicado);
    if (!enlace) {
      throw new Error(
        `No se encontró el radicado ${radicado} en la bandeja. ` +
        'Asegúrese de que está asignado a usted y visible en la tabla.'
      );
    }

    await enlace.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  async _buscarRadicadoEnTabla(page, radicado) {
    // El radicado aparece como enlace o texto en la tabla de la bandeja.
    // Probar varias estrategias.
    const partes = radicado.match(/^(\d{2,4})-(\d+)$/);
    const textos = [radicado];
    if (partes) {
      textos.push(partes[2]); // solo el número sin año
    }

    for (const texto of textos) {
      // Enlace exacto
      const enlace = page.locator(`a:text-is("${texto}")`).first();
      if (await enlace.isVisible({ timeout: 1000 }).catch(() => false)) {
        return enlace;
      }
      // Enlace que contiene
      const enlace2 = page.locator(`a:has-text("${texto}")`).first();
      if (await enlace2.isVisible({ timeout: 1000 }).catch(() => false)) {
        return enlace2;
      }
    }

    // Último recurso: buscar en cualquier celda de tabla
    const celda = page.locator(`td:has-text("${radicado}")`).first();
    if (await celda.isVisible({ timeout: 1000 }).catch(() => false)) {
      const enlaceEnCelda = celda.locator('a').first();
      if (await enlaceEnCelda.count()) return enlaceEnCelda;
      return celda;
    }

    return null;
  }

  /**
   * Navega a una pestaña por su nombre dentro de la vista del trámite.
   * edis usa tabs ASP.NET: busca un enlace/tab cuyo texto contenga el nombre.
   */
  async _irAPestana(page, nombrePestana) {
    const tab = await page.evaluate((nombre) => {
      const normalizar = (t) =>
        (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
      const objetivo = normalizar(nombre);

      // Buscar en enlaces de pestañas (tabs de ASP.NET o Bootstrap)
      for (const el of document.querySelectorAll('a, .tab, [role="tab"], li')) {
        const texto = normalizar(el.textContent);
        if (texto.includes(objetivo)) {
          el.click();
          return { encontrada: true, texto: el.textContent.trim() };
        }
      }
      // Buscar en inputs tipo button
      for (const el of document.querySelectorAll('input[type="button"], input[type="submit"]')) {
        const texto = normalizar(el.value);
        if (texto.includes(objetivo)) {
          el.click();
          return { encontrada: true, texto: el.value.trim() };
        }
      }
      return { encontrada: false };
    }, nombrePestana);

    if (!tab.encontrada) {
      this.logger.warn(`No se encontró la pestaña "${nombrePestana}".`);
    }

    await page.waitForTimeout(ESPERA_TAB_MS);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  }

  /**
   * Lee todos los campos visibles de la pestaña actual.
   * Devuelve un mapa { etiqueta -> valor } leyendo las filas de tabla
   * y los controles de formulario.
   */
  async _leerPestana(page, nombrePestana) {
    await this._irAPestana(page, nombrePestana);

    const campos = await page.evaluate(() => {
      const resultado = {};
      const normalizar = (t) =>
        (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
          .replace(/\s+/g, ' ').trim().replace(/:$/, '');

      // Leer dropdowns (select), inputs y textareas
      for (const campo of document.querySelectorAll('select, input, textarea')) {
        if (campo.type === 'hidden' || campo.type === 'submit' || campo.type === 'image') continue;
        if (!campo.offsetParent) continue; // oculto

        // Buscar la etiqueta más cercana
        let etiqueta = '';
        const label = campo.closest('label') || document.querySelector(`label[for="${campo.id}"]`);
        if (label) {
          etiqueta = normalizar(label.textContent.replace(campo.value || '', ''));
        }
        if (!etiqueta) {
          const fila = campo.closest('tr');
          if (fila) {
            const celdas = fila.querySelectorAll('td, th');
            if (celdas.length >= 2) {
              etiqueta = normalizar(celdas[0].textContent);
            }
          }
        }
        if (!etiqueta && campo.id) {
          etiqueta = campo.id;
        }
        if (!etiqueta) continue;

        let valor;
        if (campo.tagName === 'SELECT') {
          const opcion = campo.options[campo.selectedIndex];
          valor = opcion ? opcion.text.trim() : '';
        } else {
          valor = (campo.value || '').trim();
        }

        resultado[etiqueta] = {
          valor,
          id: campo.id || '',
          tipo: campo.tagName === 'SELECT' ? 'select' : campo.type || 'text',
          name: campo.name || '',
        };
      }

      // Leer spans con borde (campos de solo lectura de edis)
      for (const span of document.querySelectorAll('span.border, span[class*="border"]')) {
        if (!span.offsetParent) continue;
        const texto = (span.textContent || '').trim();
        if (!texto || texto === 'Label') continue;
        const fila = span.closest('tr');
        if (!fila) continue;
        const celdas = fila.querySelectorAll('td, th');
        if (celdas.length < 1) continue;
        let etiqueta = normalizar(celdas[0].textContent);
        if (!etiqueta && span.id) etiqueta = span.id;
        if (!etiqueta) continue;
        resultado[etiqueta] = {
          valor: texto,
          id: span.id || '',
          tipo: 'readonly',
          name: '',
        };
      }

      return resultado;
    });

    this.logger.info(
      `Pestaña "${nombrePestana}": ${Object.keys(campos).length} campo(s) leídos ` +
      `— ${Object.entries(campos).filter(([, v]) => v.valor).map(([k, v]) => `${k}=${String(v.valor).slice(0, 30)}`).slice(0, 10).join(', ')}`
    );

    return campos;
  }

  /**
   * Rellena los campos de la pestaña Predio en el destino.
   */
  async _llenarCamposPredio(page, datosOrigen, extras) {
    await page.evaluate(({ datos, ext }) => {
      const poner = (id, valor) => {
        if (!id || !valor) return;
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'SELECT') {
          for (const op of el.options) {
            if (op.text.toUpperCase().includes(valor.toUpperCase()) ||
                op.value.toUpperCase().includes(valor.toUpperCase())) {
              el.value = op.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return;
            }
          }
        } else {
          el.value = valor;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      const ponerPorEtiqueta = (etiqueta, valor) => {
        if (!valor) return;
        const normalizar = (t) =>
          (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
            .replace(/\s+/g, ' ').trim();
        const objetivo = normalizar(etiqueta);

        for (const fila of document.querySelectorAll('tr')) {
          const celdas = fila.querySelectorAll('td, th');
          if (celdas.length < 2) continue;
          const textoEtiqueta = normalizar(celdas[0].textContent);
          if (!textoEtiqueta.includes(objetivo)) continue;

          for (const campo of celdas[1].querySelectorAll('select, input, textarea')) {
            if (campo.type === 'hidden' || campo.type === 'submit' || campo.type === 'image') continue;
            if (campo.tagName === 'SELECT') {
              for (const op of campo.options) {
                if (normalizar(op.text).includes(normalizar(valor)) ||
                    normalizar(op.value).includes(normalizar(valor))) {
                  campo.value = op.value;
                  campo.dispatchEvent(new Event('change', { bubbles: true }));
                  return;
                }
              }
            } else {
              campo.value = valor;
              campo.dispatchEvent(new Event('change', { bubbles: true }));
              campo.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
          }
        }
      };

      // Buscar en los datos leídos del origen los campos por etiqueta
      const buscar = (patron) => {
        const norm = patron.toUpperCase();
        for (const [k, v] of Object.entries(datos)) {
          if (k.toUpperCase().includes(norm) && v.valor) return v.valor;
        }
        return '';
      };

      // Destino económico
      ponerPorEtiqueta('Destino', ext.destino || buscar('DESTINO'));
      // Matrícula inmobiliaria
      ponerPorEtiqueta('Matric', ext.matriculaCirculo || buscar('CIRCULO'));
      ponerPorEtiqueta('Numero matric', ext.matriculaNumero || buscar('MATRICULA'));
      // Tipo de predio
      ponerPorEtiqueta('Tipo de Predio', ext.tipoPredio || buscar('TIPO DE PREDIO') || buscar('TIPO PREDIO'));
      // Dirección
      ponerPorEtiqueta('Direcc', ext.direccion || buscar('DIRECCION'));
      ponerPorEtiqueta('Tipo Direcc', ext.tipoDireccion || buscar('TIPO DIREC'));
    }, { datos: datosOrigen || {}, ext: extras || {} });
  }

  async _llenarCamposPropietarios(page, datosOrigen, extras) {
    await page.evaluate(({ datos, ext }) => {
      const ponerPorEtiqueta = (etiqueta, valor) => {
        if (!valor) return;
        const normalizar = (t) =>
          (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
            .replace(/\s+/g, ' ').trim();
        const objetivo = normalizar(etiqueta);

        for (const fila of document.querySelectorAll('tr')) {
          const celdas = fila.querySelectorAll('td, th');
          if (celdas.length < 2) continue;
          if (!normalizar(celdas[0].textContent).includes(objetivo)) continue;

          for (const campo of celdas[1].querySelectorAll('select, input, textarea')) {
            if (campo.type === 'hidden' || campo.type === 'submit' || campo.type === 'image') continue;
            if (campo.tagName === 'SELECT') {
              for (const op of campo.options) {
                if (normalizar(op.text).includes(normalizar(valor)) ||
                    normalizar(op.value).includes(normalizar(valor))) {
                  campo.value = op.value;
                  campo.dispatchEvent(new Event('change', { bubbles: true }));
                  return;
                }
              }
            } else {
              campo.value = valor;
              campo.dispatchEvent(new Event('change', { bubbles: true }));
              campo.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
          }
        }
      };

      const buscar = (patron) => {
        const norm = patron.toUpperCase();
        for (const [k, v] of Object.entries(datos)) {
          if (k.toUpperCase().includes(norm) && v.valor) return v.valor;
        }
        return '';
      };

      ponerPorEtiqueta('Nombre', ext.nombre || buscar('NOMBRE'));
      ponerPorEtiqueta('Tipo Documento', ext.tipoDocumento || buscar('TIPO DOCUMENTO') || buscar('TIPO DOC'));
      ponerPorEtiqueta('Documento', ext.documento || buscar('DOCUMENTO') || buscar('CEDULA'));
      ponerPorEtiqueta('Porcentaje', ext.porcentaje || buscar('PORCENTAJE'));
    }, { datos: datosOrigen || {}, ext: extras || {} });
  }

  async _llenarCamposFuente(page, datosOrigen, extras) {
    await page.evaluate(({ datos, ext }) => {
      const ponerPorEtiqueta = (etiqueta, valor) => {
        if (!valor) return;
        const normalizar = (t) =>
          (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
            .replace(/\s+/g, ' ').trim();
        const objetivo = normalizar(etiqueta);

        for (const fila of document.querySelectorAll('tr')) {
          const celdas = fila.querySelectorAll('td, th');
          if (celdas.length < 2) continue;
          if (!normalizar(celdas[0].textContent).includes(objetivo)) continue;

          for (const campo of celdas[1].querySelectorAll('select, input, textarea')) {
            if (campo.type === 'hidden' || campo.type === 'submit' || campo.type === 'image') continue;
            if (campo.tagName === 'SELECT') {
              for (const op of campo.options) {
                if (normalizar(op.text).includes(normalizar(valor)) ||
                    normalizar(op.value).includes(normalizar(valor))) {
                  campo.value = op.value;
                  campo.dispatchEvent(new Event('change', { bubbles: true }));
                  return;
                }
              }
            } else {
              campo.value = valor;
              campo.dispatchEvent(new Event('change', { bubbles: true }));
              campo.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
          }
        }
      };

      const buscar = (patron) => {
        const norm = patron.toUpperCase();
        for (const [k, v] of Object.entries(datos)) {
          if (k.toUpperCase().includes(norm) && v.valor) return v.valor;
        }
        return '';
      };

      // Fuente Administrativa
      ponerPorEtiqueta('Tipo Fuente', ext.tipoFuente || buscar('TIPO FUENTE') || buscar('TIPO FTE'));
      ponerPorEtiqueta('Numero', ext.numeroFuente || buscar('NUMERO'));
      ponerPorEtiqueta('Fecha', ext.fechaFuente || buscar('FECHA'));
      ponerPorEtiqueta('Ente Emisor', ext.enteEmisor || buscar('ENTE EMISOR') || buscar('ENTE'));
      // Inscripción Catastral
      ponerPorEtiqueta('Fecha Inscripci', ext.fechaInscripcion || buscar('INSCRIPCION'));
    }, { datos: datosOrigen || {}, ext: extras || {} });
  }

  async _guardarDiagnostico(page, nombre) {
    try {
      const carpeta = path.join(path.dirname(this.config.app.dbPath), 'diagnostico');
      fs.mkdirSync(carpeta, { recursive: true });
      const base = path.join(carpeta, String(nombre).replace(/[\\/:*?"<>|]/g, '-'));
      fs.writeFileSync(`${base}.html`, await page.content(), 'utf8');
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      this.logger.info(`Diagnóstico migración guardado: ${base}`);
      return `${base}.png`;
    } catch (error) {
      this.logger.warn(`No se pudo guardar diagnóstico de migración: ${error.message}`);
      return '';
    }
  }
}

module.exports = { MigracionTramiteService };
