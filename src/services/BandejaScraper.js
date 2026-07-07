'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Extrae los trámites de la bandeja "TRÁMITES ASIGNADOS".
 *
 * Particularidades del aplicativo (edis / catastromonteria.com.co):
 *  - La cuadrícula NO está visible al cargar la página: aparece al pulsar la
 *    lupa del recuadro "Radicación". Los selectores candidatos de ese botón
 *    van en config.bandeja.accionesApertura y se prueban en orden.
 *  - La página tiene muchas tablas de diseño/menú: se examinan TODAS las
 *    tablas (incluidos iframes) y se elige la que mejor mapea a los campos
 *    conocidos.
 *  - Columnas que no mapean a un campo conocido (NPN, DIAS, etc.) se
 *    conservan íntegras en `datos_extra` (JSON).
 */
class BandejaScraper {
  /**
   * @param {object} config Configuración completa de la app
   * @param {import('../utils/logger').Logger} logger
   * @param {(mensaje: string) => void} [onProgreso] Avance legible para la UI
   */
  constructor(config, logger, onProgreso = null) {
    this.config = config;
    this.logger = logger;
    this.onProgreso = onProgreso || (() => {});

    const patron = config.bandeja.validacion && config.bandeja.validacion.patronNumeroTramite;
    // Filtra filas que no son trámites (paginador, totales, mensajes) cuando
    // el número de trámite tiene un formato conocido, p. ej. "2026-1330".
    this.patronNumero = patron ? new RegExp(patron) : null;
    this.descartadasPorPatron = 0;
  }

  /** Normaliza texto para comparar encabezados: minúsculas, sin tildes ni signos. */
  static normalizar(texto) {
    return (texto || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Intenta mapear encabezados a campos conocidos. No lanza: devuelve null
   * si los encabezados no contienen la columna del número de trámite.
   * @param {string[]} encabezados
   * @returns {{mapa: Map<number, string>, extras: Map<number, string>, puntaje: number}|null}
   */
  _intentarMapeo(encabezados) {
    const alias = this.config.bandeja.columnas;
    const mapa = new Map();
    const extras = new Map();
    const camposAsignados = new Set();

    encabezados.forEach((encabezado, indice) => {
      const normalizado = BandejaScraper.normalizar(encabezado);
      if (!normalizado) return;

      const campo = Object.keys(alias).find(
        (nombre) =>
          !camposAsignados.has(nombre) &&
          alias[nombre].some((a) => BandejaScraper.normalizar(a) === normalizado)
      );

      if (campo) {
        mapa.set(indice, campo);
        camposAsignados.add(campo);
      } else {
        extras.set(indice, normalizado.replace(/ /g, '_'));
      }
    });

    if (!camposAsignados.has('numero_tramite')) return null;
    return { mapa, extras, puntaje: mapa.size };
  }

  /**
   * Versión estricta usada por las pruebas: lanza si no aparece la columna
   * del número de trámite.
   */
  _mapearColumnas(encabezados) {
    const resultado = this._intentarMapeo(encabezados);
    if (!resultado) {
      throw new Error(
        'No se encontró la columna del número de trámite. Encabezados detectados: ' +
        `[${encabezados.join(' | ')}]. Ajuste bandeja.columnas.numero_tramite en config/app.config.json.`
      );
    }
    return resultado;
  }

  /**
   * Lee los encabezados de una tabla: primero <thead th>; si no hay,
   * la primera fila (GridView de ASP.NET pone los encabezados ahí).
   * @param {import('playwright').Locator} tabla
   * @returns {Promise<string[]>}
   */
  async _leerEncabezados(tabla) {
    let encabezados = await tabla.locator(this.config.bandeja.selectors.encabezados)
      .allInnerTexts()
      .catch(() => []);
    if (encabezados.length === 0) {
      encabezados = await tabla.locator('tr').first().locator('th, td')
        .allInnerTexts()
        .catch(() => []);
    }
    return encabezados;
  }

  /**
   * Todos los marcos alcanzables: los de la página principal Y los de
   * cualquier ventana emergente del mismo contexto (la bandeja de edis
   * podría abrirse como popup con window.open).
   * @param {import('playwright').Page} page
   * @returns {import('playwright').Frame[]}
   */
  _todosLosMarcos(page) {
    const marcos = [];
    for (const p of page.context().pages()) {
      if (!p.isClosed()) marcos.push(...p.frames());
    }
    return marcos;
  }

  /**
   * Busca la tabla de trámites en todos los marcos (página principal,
   * iframes y popups), eligiendo la de mejor puntaje de mapeo. Reintenta
   * hasta agotar la espera: la cuadrícula puede tardar en aparecer tras un
   * postback.
   *
   * @param {import('playwright').Page} page
   * @param {number} esperaMaxMs
   * @returns {Promise<{marco: import('playwright').Frame, tabla: import('playwright').Locator, mapa: Map, extras: Map}|null>}
   */
  async _buscarTabla(page, esperaMaxMs) {
    const { selectors } = this.config.bandeja;
    const limite = Date.now() + esperaMaxMs;

    while (true) {
      this.ultimoDiagnostico = [];
      let mejor = null;

      for (const marco of this._todosLosMarcos(page)) {
        const candidatas = marco.locator(selectors.tabla);
        const total = await candidatas.count().catch(() => 0);

        for (let i = 0; i < total; i++) {
          const tabla = candidatas.nth(i);
          if (!(await tabla.isVisible().catch(() => false))) continue;

          const encabezados = await this._leerEncabezados(tabla);
          const limpios = encabezados.map((e) => e.trim()).filter(Boolean);
          if (limpios.length === 0) continue;
          this.ultimoDiagnostico.push(`[${limpios.slice(0, 12).join(' | ')}]`);

          const resultado = this._intentarMapeo(encabezados);
          // Se exigen al menos 2 campos conocidos (número + otro) para no
          // confundir la cuadrícula con formularios que mencionan "número".
          if (resultado && resultado.puntaje >= 2 && (!mejor || resultado.puntaje > mejor.puntaje)) {
            mejor = { marco, tabla, mapa: resultado.mapa, extras: resultado.extras };
          }
        }
      }

      if (mejor) return mejor;
      if (Date.now() > limite) return null;
      await page.waitForTimeout(1500);
    }
  }

  /**
   * Ejecuta las acciones configuradas para abrir la bandeja (p. ej. pulsar
   * la lupa de "Radicación"). Prueba cada selector candidato en cada marco.
   * @param {import('playwright').Page} page
   * @returns {Promise<string|null>} Selector que se pulsó, o null
   */
  async _abrirBandeja(page) {
    const candidatos = this.config.bandeja.accionesApertura || [];

    for (const selector of candidatos) {
      for (const marco of this._todosLosMarcos(page)) {
        try {
          const elemento = marco.locator(selector).first();
          if (!(await elemento.isVisible().catch(() => false))) continue;
          this.logger.info(`Abriendo la bandeja con la acción: ${selector}`);
          await elemento.click({ timeout: 5000 });
          return selector;
        } catch {
          // Candidato no clicable en este marco; se prueba el siguiente.
        }
      }
    }
    return null;
  }

  /**
   * Inventario de botones/imagenes clicables de la página para diagnóstico
   * cuando no se logra abrir la bandeja.
   * @param {import('playwright').Page} page
   */
  async _inventarioClicables(page) {
    const items = [];
    for (const marco of this._todosLosMarcos(page)) {
      const encontrados = await marco
        .evaluate(() =>
          Array.from(
            document.querySelectorAll("input[type='image'], input[type='submit'], button, img[onclick]")
          )
            .slice(0, 25)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              src: (el.getAttribute('src') || '').split('/').pop() || null,
              value: el.getAttribute('value') || null,
            }))
        )
        .catch(() => []);
      items.push(...encontrados);
    }
    return items
      .filter((i) => i.id || i.src || i.value)
      .slice(0, 30)
      .map((i) => `${i.tag}#${i.id || '?'}${i.src ? ` (${i.src})` : ''}${i.value ? ` [${i.value}]` : ''}`);
  }

  /**
   * Lee todas las páginas de la bandeja y devuelve los trámites normalizados.
   * @param {import('playwright').Page} page Página ya posicionada en la bandeja
   * @returns {Promise<Array<object>>}
   */
  async extraerTramites(page) {
    const { selectors, paginacion } = this.config.bandeja;
    const timeout = this.config.browser.timeoutMs;

    await page.waitForLoadState('networkidle', { timeout }).catch(() => {
      // Algunas apps mantienen conexiones abiertas; no es bloqueante.
    });

    // 1) ¿La cuadrícula ya está visible? (espera corta)
    this.onProgreso('Buscando la cuadrícula de trámites en la página...');
    let encontrada = await this._buscarTabla(page, 4000);

    // 2) Si no, abrir la bandeja (lupa de "Radicación") y volver a buscar.
    if (!encontrada) {
      this.onProgreso('Pulsando la lupa de Radicación para abrir TRÁMITES ASIGNADOS...');
      const accion = await this._abrirBandeja(page);
      if (accion) {
        this.onProgreso('Esperando que cargue la cuadrícula TRÁMITES ASIGNADOS...');
        encontrada = await this._buscarTabla(page, timeout);
      }
    }

    if (!encontrada) {
      const clicables = await this._inventarioClicables(page);
      throw new Error(
        'No se encontró la cuadrícula de trámites, ni siquiera tras intentar abrir la bandeja. ' +
        (this.ultimoDiagnostico.length > 0
          ? `Tablas visibles: ${this.ultimoDiagnostico.join(' ')}. `
          : 'No hay tablas con contenido. ') +
        (clicables.length > 0
          ? `Botones detectados en la página: ${clicables.join(', ')}. `
          : '') +
        'Ajuste bandeja.accionesApertura o bandeja.columnas en config/app.config.json.'
      );
    }

    const { mapa, extras } = encontrada;
    this.logger.info('Columnas mapeadas', {
      campos: [...mapa.values()],
      extras: [...extras.values()],
    });
    this.onProgreso('Cuadrícula encontrada. Leyendo los trámites fila por fila...');

    // Las cuadrículas de edis cargan las filas DESPUÉS de los encabezados
    // (postback/AJAX) y a veces en una tabla separada de la del encabezado
    // (patrón de encabezado fijo con cuerpo desplazable). Se reintenta hasta
    // obtener filas o agotar el timeout.
    let tramites = await this._extraerTodasLasFilas(page, encontrada);
    const limiteDatos = Date.now() + timeout;

    while (tramites.length === 0 && Date.now() < limiteDatos) {
      await page.waitForTimeout(2000);

      tramites = await this._extraerTodasLasFilas(page, encontrada);
      if (tramites.length > 0) break;

      const cuerpo = await this._buscarCuerpoSeparado(page, encontrada.mapa);
      if (cuerpo) {
        this.logger.info('Filas encontradas en una tabla de cuerpo separada del encabezado.');
        tramites = await this._extraerTodasLasFilas(page, { ...encontrada, ...cuerpo });
      }
    }

    if (tramites.length === 0) {
      const dirDiag = await this._volcarDiagnostico(page);
      this.logger.warn(
        'Se encontró la cuadrícula de trámites pero no se pudo leer ninguna fila. ' +
        (dirDiag ? `Se guardó un diagnóstico completo en: ${dirDiag}` : '')
      );
    }

    if (this.descartadasPorPatron > 0) {
      this.logger.warn(
        `${this.descartadasPorPatron} fila(s) descartadas por no coincidir con el patrón ` +
        'de número de trámite (bandeja.validacion.patronNumeroTramite). Si faltan trámites, revise ese patrón.'
      );
      this.descartadasPorPatron = 0;
    }
    this.logger.info(`Extracción completada: ${tramites.length} trámites`);
    return tramites;
  }

  /**
   * Guarda una radiografía de la página cuando la extracción falla:
   * captura de pantalla de cada ventana + inventario JSON de todas las
   * tablas (encabezados y primeras filas). Permite diagnosticar la
   * estructura real sin acceso al aplicativo.
   *
   * @param {import('playwright').Page} page
   * @returns {Promise<string|null>} Carpeta del diagnóstico
   */
  async _volcarDiagnostico(page) {
    try {
      const marca = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.join(this.config.app.logsDir, `diagnostico-${marca}`);
      fs.mkdirSync(dir, { recursive: true });

      const inventario = [];
      let numeroPagina = 0;

      for (const p of page.context().pages()) {
        if (p.isClosed()) continue;
        numeroPagina++;

        const marcos = [];
        for (const marco of p.frames()) {
          const tablas = await marco
            .evaluate(() =>
              Array.from(document.querySelectorAll('table'))
                .slice(0, 50)
                .map((t, i) => {
                  const filas = Array.from(t.querySelectorAll('tr'));
                  return {
                    indice: i,
                    id: t.id || null,
                    totalFilas: filas.length,
                    visible: !!(t.offsetWidth || t.offsetHeight),
                    primerasFilas: filas.slice(0, 4).map((tr) =>
                      Array.from(tr.children).slice(0, 12).map((c) => c.innerText.trim().slice(0, 50))
                    ),
                  };
                })
            )
            .catch(() => []);
          marcos.push({ url: marco.url(), tablas });
        }

        inventario.push({ url: p.url(), marcos });
        await p
          .screenshot({ path: path.join(dir, `pantalla-${numeroPagina}.png`), fullPage: true })
          .catch(() => {});
      }

      fs.writeFileSync(path.join(dir, 'tablas.json'), JSON.stringify(inventario, null, 2), 'utf8');
      return dir;
    } catch (error) {
      this.logger.warn(`No se pudo guardar el diagnóstico: ${error.message}`);
      return null;
    }
  }

  /**
   * Extrae los trámites de la tabla dada recorriendo la paginación.
   * Si el selector de filas configurado no produce trámites válidos, prueba
   * con 'tr' directo: las cuadrículas construidas por JavaScript pueden no
   * tener <tbody>.
   *
   * @param {import('playwright').Page} page
   * @param {{marco: import('playwright').Frame, tabla: import('playwright').Locator, mapa: Map, extras: Map}} objetivo
   * @returns {Promise<Array<object>>}
   */
  async _extraerTodasLasFilas(page, objetivo) {
    const { selectors, paginacion } = this.config.bandeja;
    const { marco, tabla, mapa, extras } = objetivo;
    const tramites = [];
    const numerosVistos = new Set();
    let pagina = 1;

    // Se leen th Y td en orden de documento. Si la celda no tiene texto,
    // se toma el value de un input/button interno: en la cuadrícula real de
    // edis el radicado es un botón (<input type="submit" value="2026-1330">)
    // y los inputs no exponen su valor por innerText. Además se detecta si
    // ALGÚN nodo de la fila (celda, enlace, span...) está en letra ROJA:
    // edis no siempre pinta el <tr> completo, a veces solo el enlace del
    // radicado o una celda puntual, así que revisar solo tr.style.color
    // dejaba pasar devueltos reales.
    const leerFilas = async (selectorFilas) =>
      tabla
        .locator(selectorFilas)
        .evaluateAll((trs) => {
          const esRojo = (color) => {
            if (!color) return false;
            const rgb = String(color).match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
            if (!rgb) return false;
            const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
            return r >= 140 && g <= 100 && b <= 100 && r - Math.max(g, b) >= 35;
          };
          return trs.map((tr) => {
            let filaRoja = false;
            for (const nodo of tr.querySelectorAll('td, th, a, span, font, div, b, strong')) {
              if (esRojo(getComputedStyle(nodo).color)) { filaRoja = true; break; }
            }
            return {
              filaRoja,
              celdas: Array.from(tr.querySelectorAll(':scope > th, :scope > td')).map((c) => {
                const texto = c.innerText.trim();
                if (texto) return texto;
                const control = c.querySelector('input, button');
                return control ? (control.value || control.textContent || '').trim() : '';
              }),
            };
          });
        })
        .catch(() => []);

    while (true) {
      // Algunas cuadrículas cargan más filas al hacer scroll: desplazar el
      // contenedor hasta que el número de filas deje de crecer.
      await this._cargarFilasConScroll(page, tabla);

      let filas = await leerFilas(selectors.filas);
      let nuevos = this._filtrarTramites(filas, mapa, extras, numerosVistos);

      if (nuevos.length === 0) {
        filas = await leerFilas('tr');
        nuevos = this._filtrarTramites(filas, mapa, extras, numerosVistos);
      }

      tramites.push(...nuevos);
      this.logger.info(`Página ${pagina}: ${filas.length} filas, ${nuevos.length} trámites válidos`);
      if (nuevos.length > 0) {
        this.onProgreso(`Leídos ${tramites.length} trámites hasta ahora...`);
      }

      if (nuevos.length === 0) break; // página sin datos: no seguir paginando
      if (!paginacion.habilitada || pagina >= paginacion.maxPaginas) break;

      const siguiente = marco.locator(selectors.paginadorSiguiente).first();
      if (!(await siguiente.isVisible().catch(() => false))) break;

      await siguiente.click();
      await page.waitForTimeout(paginacion.esperaTrasPaginaMs);
      pagina++;
    }

    return tramites;
  }

  /**
   * Desplaza la cuadrícula hasta el final repetidamente para forzar la carga
   * de filas diferidas (scroll infinito / virtualización).
   */
  async _cargarFilasConScroll(page, tabla) {
    let previo = -1;
    for (let intento = 0; intento < 30; intento++) {
      const actual = await tabla.locator('tr').count().catch(() => 0);
      if (actual === previo) break;
      previo = actual;

      await tabla
        .evaluate((t) => {
          const filas = t.querySelectorAll('tr');
          if (filas.length > 0) filas[filas.length - 1].scrollIntoView({ block: 'end' });
          let nodo = t.parentElement;
          while (nodo) {
            if (nodo.scrollHeight > nodo.clientHeight + 4) nodo.scrollTop = nodo.scrollHeight;
            nodo = nodo.parentElement;
          }
          window.scrollTo(0, document.body.scrollHeight);
        })
        .catch(() => {});
      await page.waitForTimeout(700);
    }
    if (previo > 0) this.logger.debug(`Scroll de cuadrícula: ${previo} filas cargadas.`);
  }

  /** ¿El color CSS es rojizo? (los devueltos van en letra roja). */
  static esColorRojo(color) {
    if (!color) return false;
    const hex = color.match(/^#?([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return r >= 140 && g <= 100 && b <= 100 && r - Math.max(g, b) >= 35;
    }
    const rgb = color.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
    if (rgb) {
      const r = Number(rgb[1]), g = Number(rgb[2]), b = Number(rgb[3]);
      return r >= 140 && g <= 100 && b <= 100 && r - Math.max(g, b) >= 35;
    }
    return /^red$/i.test(color.trim());
  }

  /**
   * ¿El texto de una columna de correcciones/observaciones indica que el
   * trámite fue devuelto? Se descartan valores vacíos y placeholders como
   * "...", "-" o "N/A": la mayoría de trámites al día los traen así.
   */
  static tieneContenidoReal(texto) {
    if (!texto) return false;
    const limpio = String(texto).trim();
    if (limpio === '') return false;
    return !/^[.\-–—_\s]*$|^n\s*\/?\s*a$/i.test(limpio);
  }

  /** Convierte filas crudas en trámites, descartando duplicados. */
  _filtrarTramites(filas, mapa, extras, numerosVistos) {
    const resultado = [];
    for (const fila of filas) {
      const celdas = Array.isArray(fila) ? fila : fila.celdas;
      const tramite = this._filaATramite(celdas, mapa, extras);
      if (!tramite) continue;
      if (numerosVistos.has(tramite.numero_tramite)) continue;
      numerosVistos.add(tramite.numero_tramite);

      // Señal 1: alguna celda de la fila está en letra roja (marcador visual
      // de edis para "devuelto para corrección").
      const filaRoja = !Array.isArray(fila) && Boolean(fila.filaRoja);
      // Señal 2: la columna CORRECCIONES (u OBSERVACIONES) trae contenido
      // real en vez del placeholder "...": suele significar que alguien
      // (jurídica) devolvió el trámite con una anotación.
      let correccionReal = false;
      if (tramite.datos_extra) {
        try {
          const extra = JSON.parse(tramite.datos_extra);
          correccionReal = BandejaScraper.tieneContenidoReal(extra.correcciones);
        } catch {
          // datos_extra no debería fallar aquí; si pasa, se ignora la señal.
        }
      }

      tramite.devueltoWeb = filaRoja || correccionReal;
      resultado.push(tramite);
    }
    return resultado;
  }

  /**
   * Busca una tabla "cuerpo" separada de la tabla de encabezados: aquella
   * cuyas filas tienen, en la columna del número de trámite, valores que
   * cumplen el patrón configurado (p. ej. "2026-1330").
   *
   * @param {import('playwright').Page} page
   * @param {Map<number, string>} mapa Mapa de columnas de la tabla de encabezados
   * @returns {Promise<{marco: import('playwright').Frame, tabla: import('playwright').Locator}|null>}
   */
  async _buscarCuerpoSeparado(page, mapa) {
    if (!this.patronNumero) return null; // sin patrón no hay forma segura de reconocer el cuerpo
    const patron = this.patronNumero.source;

    for (const marco of this._todosLosMarcos(page)) {
      const mejor = await marco
        .evaluate(({ patron }) => {
          // Cuenta, por tabla, las filas donde ALGUNA celda cumple el patrón
          // del radicado (la posición exacta puede variar por celdas de iconos).
          const re = new RegExp(patron);
          let resultado = { indice: -1, filas: 0 };
          document.querySelectorAll('table').forEach((tabla, i) => {
            let filas = 0;
            tabla.querySelectorAll('tr').forEach((tr) => {
              const celdas = Array.from(tr.querySelectorAll(':scope > th, :scope > td'));
              const textoDe = (c) => {
                const t = c.innerText.trim();
                if (t) return t;
                const control = c.querySelector('input, button');
                return control ? (control.value || control.textContent || '').trim() : '';
              };
              if (celdas.some((c) => re.test(textoDe(c)))) filas++;
            });
            if (filas > resultado.filas) resultado = { indice: i, filas };
          });
          return resultado;
        }, { patron })
        .catch(() => ({ indice: -1, filas: 0 }));

      if (mejor.filas > 0) {
        return { marco, tabla: marco.locator('table').nth(mejor.indice) };
      }
    }
    return null;
  }

  /**
   * Convierte las celdas de una fila en un objeto trámite.
   *
   * Si las celdas de datos vienen desplazadas respecto a los encabezados
   * (p. ej. una celda extra de icono/selección al inicio de cada fila), se
   * detecta la posición real del radicado con el patrón configurado y se
   * corrige el desplazamiento.
   *
   * @returns {object|null} null si la fila no tiene número de trámite (fila vacía o de mensaje)
   */
  _filaATramite(celdas, mapa, extras) {
    if (celdas.length === 0) return null;

    let tramite = this._mapearFila(celdas, mapa, extras, 0);

    const numeroValido = (t) =>
      t.numero_tramite && (!this.patronNumero || this.patronNumero.test(t.numero_tramite));

    if (!numeroValido(tramite) && this.patronNumero) {
      const idxEsperado = [...mapa.entries()].find(([, campo]) => campo === 'numero_tramite')[0];
      const idxReal = celdas.findIndex((c) => this.patronNumero.test((c || '').trim()));
      if (idxReal >= 0 && idxReal !== idxEsperado) {
        tramite = this._mapearFila(celdas, mapa, extras, idxReal - idxEsperado);
      }
    }

    if (!tramite.numero_tramite) return null;
    if (!numeroValido(tramite)) {
      this.descartadasPorPatron++;
      return null;
    }

    return tramite;
  }

  /** Mapea una fila aplicando un desplazamiento de columnas. */
  _mapearFila(celdas, mapa, extras, desplazamiento) {
    const tramite = {
      numero_tramite: null,
      tipo: null,
      estado: null,
      fecha: null,
      solicitante: null,
    };
    const datosExtra = {};

    celdas.forEach((valor, indice) => {
      const texto = valor || null;
      const indiceEncabezado = indice - desplazamiento;
      if (mapa.has(indiceEncabezado)) {
        tramite[mapa.get(indiceEncabezado)] = texto;
      } else if (extras.has(indiceEncabezado) && texto) {
        datosExtra[extras.get(indiceEncabezado)] = texto;
      }
    });

    // Claves ordenadas para que el JSON sea estable y comparable entre corridas.
    const clavesOrdenadas = Object.keys(datosExtra).sort();
    tramite.datos_extra =
      clavesOrdenadas.length > 0
        ? JSON.stringify(Object.fromEntries(clavesOrdenadas.map((k) => [k, datosExtra[k]])))
        : null;

    return tramite;
  }
}

module.exports = { BandejaScraper };
