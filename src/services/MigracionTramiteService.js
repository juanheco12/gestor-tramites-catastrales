'use strict';

const fs = require('fs');
const path = require('path');
const { UBICAR_FORMULARIO } = require('./ConsultaTramiteService');

class MigracionTramiteService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async leerOrigen(page, radicado, onProgreso = () => {}) {
    onProgreso('Abriendo trámite origen...');
    await this._abrirTramite(page, radicado);

    onProgreso('Leyendo pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    const predio = await this._leerCamposVisibles(page);

    onProgreso('Leyendo pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    const propietarios = await this._leerCamposVisibles(page);

    onProgreso('Leyendo pestaña Fte Administrativa...');
    await this._irAPestana(page, 'Fte Administrativa');
    const fuente = await this._leerCamposVisibles(page);

    await this._guardarDiagnostico(page, `origen-${radicado}`);

    this.logger.info(
      `Origen ${radicado}: predio=${Object.keys(predio).length} campos, ` +
      `propietarios=${Object.keys(propietarios).length}, fuente=${Object.keys(fuente).length}`
    );

    return { predio, propietarios, fuente };
  }

  async escribirDestino(page, radicado, datos, extras, onProgreso = () => {}) {
    onProgreso('Abriendo trámite destino...');
    await this._abrirTramite(page, radicado);

    onProgreso('Llenando pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    await this._llenarCamposPredio(page, datos.predio, extras);

    onProgreso('Llenando pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    await this._llenarCamposPropietarios(page, datos.propietarios, extras);

    onProgreso('Llenando pestaña Fte Administrativa...');
    await this._irAPestana(page, 'Fte Administrativa');
    await this._llenarCamposFuente(page, datos.fuente, extras);

    await this._guardarDiagnostico(page, `destino-${radicado}`);
    onProgreso('Datos migrados. Revise en pantalla y guarde manualmente.');
  }

  async _abrirTramite(page, radicado) {
    const timeout = this.config.browser.timeoutMs;
    const partes = this._partes(radicado);

    await page.goto(this.config.bandeja.url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    const ubicados = await page.evaluate(UBICAR_FORMULARIO);
    if (!ubicados.anio || !ubicados.numero || !ubicados.buscar) {
      throw new Error(
        `No se ubicó el formulario de búsqueda ` +
        `(año=${ubicados.anio}, número=${ubicados.numero}, lupa=${ubicados.buscar}). ` +
        `Etiquetas: ${(ubicados.etiquetas || []).slice(0, 15).join(', ')}`
      );
    }

    const campoAnio = page.locator('[data-robot-campo="anio"]');
    const campoNumero = page.locator('[data-robot-campo="numero"]');
    await campoAnio.fill(partes.anio);
    await campoNumero.fill(partes.numero);

    const puestos = {
      anio: await campoAnio.inputValue(),
      numero: await campoNumero.inputValue(),
    };
    if (puestos.anio !== partes.anio || puestos.numero !== partes.numero) {
      throw new Error(
        `Los datos no quedaron en su campo (AÑO="${puestos.anio}", NÚMERO="${puestos.numero}").`
      );
    }

    await page.locator('[data-robot-campo="buscar"]').click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    await page.waitForTimeout(2500);

    this.logger.info(`Trámite ${radicado} abierto en resolución.`);
  }

  async _irAPestana(page, nombre) {
    const tab = page.locator('a').filter({ hasText: nombre }).first();

    if (!(await tab.isVisible({ timeout: 3000 }).catch(() => false))) {
      const enlaces = await page.locator('a').allTextContents();
      const tabs = enlaces.filter((t) => t.trim()).slice(0, 20);
      this.logger.warn(`Pestaña "${nombre}" no visible. Enlaces: ${tabs.join(' | ')}`);
      throw new Error(`No se encontró la pestaña "${nombre}" en la página.`);
    }

    await tab.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);

    this.logger.info(`Pestaña "${nombre}" activa.`);
  }

  async _leerCamposVisibles(page) {
    return page.evaluate(() => {
      const resultado = {};
      const normalizar = (t) =>
        (t || '')
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toUpperCase()
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/:$/, '');

      for (const fila of document.querySelectorAll('tr')) {
        const celdas = Array.from(fila.querySelectorAll('td, th'));
        if (celdas.length < 2) continue;

        const etiqueta = normalizar(celdas[0].innerText || celdas[0].textContent);
        if (!etiqueta || etiqueta.length > 60) continue;
        if (etiqueta in resultado) continue;

        for (let j = 1; j < celdas.length; j++) {
          const celda = celdas[j];
          for (const campo of celda.querySelectorAll('select, input, textarea')) {
            const tipo = (campo.getAttribute('type') || '').toLowerCase();
            if (['hidden', 'submit', 'image', 'button'].includes(tipo)) continue;
            if (!campo.offsetParent) continue;

            let valor;
            if (campo.tagName === 'SELECT') {
              const op = campo.options[campo.selectedIndex];
              valor = op ? op.text.trim() : '';
            } else {
              valor = (campo.value || '').trim();
            }
            if (valor && valor !== 'Label') {
              resultado[etiqueta] = {
                valor,
                id: campo.id || '',
                tipo: campo.tagName === 'SELECT' ? 'select' : 'text',
              };
            }
            break;
          }
          if (resultado[etiqueta]) break;

          for (const span of celda.querySelectorAll('span')) {
            if (span.children.length > 0) continue;
            const t = (span.textContent || '').trim();
            if (t && t !== 'Label') {
              resultado[etiqueta] = { valor: t, id: span.id || '', tipo: 'readonly' };
              break;
            }
          }
          if (resultado[etiqueta]) break;
        }
      }
      return resultado;
    });
  }

  async _marcarCampo(page, etiqueta, tag) {
    await page
      .evaluate((t) => {
        const prev = document.querySelector(`[data-robot-campo="${t}"]`);
        if (prev) prev.removeAttribute('data-robot-campo');
      }, tag)
      .catch(() => {});

    return page.evaluate(
      ({ etiqueta, tag }) => {
        const normalizar = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/:$/, '');
        const objetivo = normalizar(etiqueta);

        for (const fila of document.querySelectorAll('tr')) {
          const celdas = Array.from(fila.querySelectorAll('td, th'));
          if (celdas.length < 2) continue;
          const textoEtiqueta = normalizar(celdas[0].innerText || celdas[0].textContent);
          if (!textoEtiqueta.includes(objetivo)) continue;

          for (let j = 1; j < celdas.length; j++) {
            for (const campo of celdas[j].querySelectorAll('select, input, textarea')) {
              const tipo = (campo.getAttribute('type') || '').toLowerCase();
              if (['hidden', 'submit', 'image', 'button'].includes(tipo)) continue;
              if (!campo.offsetParent) continue;

              campo.setAttribute('data-robot-campo', tag);

              if (campo.tagName === 'SELECT') {
                const opciones = Array.from(campo.options).map((o) => ({
                  value: o.value,
                  text: o.text.trim(),
                  textNorm: normalizar(o.text),
                }));
                return { encontrado: true, tipo: 'select', id: campo.id || '', opciones };
              }
              return { encontrado: true, tipo: 'input', id: campo.id || '' };
            }
          }
        }
        return { encontrado: false };
      },
      { etiqueta, tag }
    );
  }

  async _llenarInput(page, etiqueta, valor) {
    if (!valor) return;
    const tag = `migrar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const info = await this._marcarCampo(page, etiqueta, tag);
    if (!info.encontrado) {
      this.logger.warn(`Campo "${etiqueta}" no encontrado en la página.`);
      return;
    }

    const locator = page.locator(`[data-robot-campo="${tag}"]`);

    if (info.tipo === 'select') {
      const norm = (t) =>
        (t || '')
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toUpperCase()
          .replace(/[_\s]+/g, ' ')
          .trim();
      const objetivo = norm(valor);

      let mejor = null;
      for (const op of info.opciones) {
        const textoOp = norm(op.text);
        const valorOp = norm(op.value);
        if (textoOp === objetivo || valorOp === objetivo) {
          mejor = op;
          break;
        }
        if (!mejor && (textoOp.includes(objetivo) || objetivo.includes(textoOp))) {
          mejor = op;
        }
        if (!mejor && (valorOp.includes(objetivo) || objetivo.includes(valorOp))) {
          mejor = op;
        }
      }

      if (!mejor) {
        this.logger.warn(
          `No se encontró opción "${valor}" en "${etiqueta}". ` +
          `Opciones: ${info.opciones.map((o) => o.text).join(', ')}`
        );
        return;
      }

      await locator.selectOption(mejor.value);
      this.logger.info(`Select "${etiqueta}" = "${mejor.text}"`);
    } else {
      await locator.fill(String(valor));
      this.logger.info(`Input "${etiqueta}" = "${valor}"`);
    }
  }

  async _llenarCamposPredio(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(page, 'Destino', extras.destino || buscar('DESTINO'));
    await this._llenarInput(page, 'Circulo', extras.matriculaCirculo || buscar('CIRCULO'));
    await this._llenarInput(page, 'Matricula', extras.matriculaNumero || buscar('MATRICULA'));
    await this._llenarInput(
      page,
      'Tipo de Predio',
      extras.tipoPredio || buscar('TIPO PREDIO', 'TIPO DE PREDIO')
    );
    await this._llenarInput(page, 'Direcc', extras.direccion || buscar('DIRECCION', 'DIRECC'));
    await this._llenarInput(
      page,
      'Tipo Direcc',
      extras.tipoDireccion || buscar('TIPO DIRECC', 'TIPO DIR')
    );
  }

  async _llenarCamposPropietarios(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(page, 'Nombre', extras.nombre || buscar('NOMBRE'));
    await this._llenarInput(
      page,
      'Tipo Documento',
      extras.tipoDocumento || buscar('TIPO DOCUMENTO', 'TIPO DOC')
    );
    await this._llenarInput(page, 'Documento', extras.documento || buscar('DOCUMENTO', 'CEDULA'));
    await this._llenarInput(page, 'Porcentaje', extras.porcentaje || buscar('PORCENTAJE'));
  }

  async _llenarCamposFuente(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(page, 'Tipo', extras.tipoFuente || buscar('TIPO'));
    await this._llenarInput(page, 'Numero', extras.numeroFuente || buscar('NUMERO'));
    await this._llenarInput(page, 'Fecha', extras.fechaFuente || buscar('FECHA'));
    await this._llenarInput(page, 'Ente Emisor', extras.enteEmisor || buscar('ENTE EMISOR', 'ENTE'));
    await this._llenarInput(
      page,
      'Fecha Inscripci',
      extras.fechaInscripcion || buscar('INSCRIPCION')
    );
  }

  _crearBuscador(datos) {
    return (...patrones) => {
      if (!datos) return '';
      for (const patron of patrones) {
        const norm = patron.toUpperCase();
        for (const [k, v] of Object.entries(datos)) {
          if (k.toUpperCase().includes(norm) && v.valor) return v.valor;
        }
      }
      return '';
    };
  }

  _partes(radicado) {
    if (radicado && typeof radicado === 'object') {
      return { anio: String(radicado.anio), numero: String(radicado.numero) };
    }
    const m = String(radicado || '').match(/^(\d{2,4})-(\d+)/);
    if (!m) throw new Error(`Formato de radicado inválido: "${radicado}". Use AAAA-NNNN.`);
    const crudo = m[1];
    const anio = crudo.length <= 2 ? `20${crudo}` : crudo;
    return { anio, numero: m[2] };
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
      this.logger.warn(`No se pudo guardar diagnóstico: ${error.message}`);
      return '';
    }
  }
}

module.exports = { MigracionTramiteService };
