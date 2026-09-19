'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Localiza los campos AÑO, NÚMERO y lupa de la sección "Radicación" en la
 * página de resolución.  Se busca específicamente dentro del contenedor que
 * tiene el texto "Radicación" para NO confundir con otros campos AÑO que
 * hay en otras secciones (ej. Construcciones).  Solo se marcan campos
 * VISIBLES.
 */
function UBICAR_BUSQUEDA() {
  const normalizar = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();

  document
    .querySelectorAll('[data-robot-campo]')
    .forEach((el) => el.removeAttribute('data-robot-campo'));

  for (const el of document.querySelectorAll('td, th, div, span, b, font, label, p')) {
    if (!normalizar(el.textContent).includes('RADICACION')) continue;
    if (el.textContent.length > 150) continue;

    let contenedor = el.parentElement;
    for (let nivel = 0; nivel < 8 && contenedor; nivel++) {
      const inputs = Array.from(
        contenedor.querySelectorAll('input[type="text"], input[type="number"]')
      ).filter((inp) => inp.offsetParent !== null);

      if (inputs.length >= 2) {
        inputs[0].setAttribute('data-robot-campo', 'anio');
        inputs[1].setAttribute('data-robot-campo', 'numero');

        const boton = Array.from(
          contenedor.querySelectorAll('input[type="image"]')
        ).find((b) => b.offsetParent !== null);
        if (boton) boton.setAttribute('data-robot-campo', 'buscar');

        return {
          anio: true,
          numero: true,
          buscar: Boolean(boton),
          estrategia: 'radicacion',
          ids: inputs.slice(0, 2).map((i) => i.id),
        };
      }
      contenedor = contenedor.parentElement;
    }
  }

  const visibles = Array.from(
    document.querySelectorAll('input[type="text"], input[type="number"]')
  ).filter((inp) => inp.offsetParent !== null && inp.maxLength <= 10);

  if (visibles.length >= 2) {
    visibles[0].setAttribute('data-robot-campo', 'anio');
    visibles[1].setAttribute('data-robot-campo', 'numero');
    const buscar = Array.from(document.querySelectorAll('input[type="image"]')).find(
      (b) => b.offsetParent !== null
    );
    if (buscar) buscar.setAttribute('data-robot-campo', 'buscar');
    return { anio: true, numero: true, buscar: Boolean(buscar), estrategia: 'fallback' };
  }

  return { anio: false, numero: false, buscar: false, estrategia: 'ninguna' };
}

/**
 * Encuentra y MARCA la pestaña cuyo rótulo coincide con `nombre` dentro del
 * documento actual (se ejecuta con page.evaluate en cada marco).  Devuelve si
 * se encontró y, si no, la lista de enlaces visibles para diagnóstico.
 *
 * Prioriza coincidencia EXACTA del texto propio (el <a>Predio</a> gana sobre
 * la barra que contiene todos los rótulos juntos) y, en su defecto, una
 * coincidencia por inclusión con un rótulo corto (para "Fte Administrativa"
 * dentro de "Fte Administrativa y Decretos").
 */
function MARCAR_PESTANA({ nombre }) {
  const norm = (t) =>
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  const objetivo = norm(nombre);

  document
    .querySelectorAll('[data-robot-pestana]')
    .forEach((el) => el.removeAttribute('data-robot-pestana'));

  const esVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;

  const candidatos = Array.from(
    document.querySelectorAll(
      'a, input[type="submit"], input[type="button"], span, td, div, li, b, font, label'
    )
  );

  let exacto = null;
  let contiene = null;
  for (const el of candidatos) {
    if (!esVisible(el)) continue;

    const textoPropio = norm(
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
    );
    const textoCompleto =
      el.tagName === 'INPUT' ? norm(el.value) : norm(el.textContent);

    if (textoPropio === objetivo || textoCompleto === objetivo) {
      exacto = el;
      break;
    }
    if (
      !contiene &&
      textoCompleto.includes(objetivo) &&
      textoCompleto.length <= objetivo.length + 25
    ) {
      contiene = el;
    }
  }

  const elegido = exacto || contiene;
  if (elegido) {
    const enlace = elegido.closest('a') || elegido;
    enlace.setAttribute('data-robot-pestana', '1');
    return {
      encontrado: true,
      tag: enlace.tagName,
      href: enlace.getAttribute('href') || '',
      texto: norm(enlace.textContent || enlace.value).slice(0, 40),
    };
  }

  const enlaces = [
    ...new Set(
      Array.from(document.querySelectorAll('a'))
        .filter((a) => esVisible(a))
        .map((a) => norm(a.textContent))
        .filter(Boolean)
    ),
  ].slice(0, 40);
  return { encontrado: false, enlaces };
}

class MigracionTramiteService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /* ===================== API PÚBLICA ===================== */

  /**
   * edis pide confirmación con confirm()/alert() en varios botones (entre
   * ellos "Aplica Zonas Digitales").  Playwright, si nadie atiende el diálogo,
   * lo DESCARTA, que equivale a pulsar "Cancelar": la acción se anulaba en
   * silencio y el log decía que el botón sí se había pulsado.  Aceptándolos el
   * robot se comporta como la persona que da "Aceptar".
   */
  _atenderDialogos(page) {
    if (page.__robotDialogos) return;
    page.__robotDialogos = true;
    page.on('dialog', async (dialogo) => {
      this.logger.info(
        `Diálogo de edis aceptado: "${String(dialogo.message()).slice(0, 150)}"`
      );
      await dialogo.accept().catch(() => {});
    });
  }

  async leerOrigen(page, radicado, onProgreso = () => {}) {
    this._atenderDialogos(page);
    onProgreso('Abriendo trámite origen...');
    await this._abrirTramite(page, radicado);

    // Datos del solicitante (pestaña "Datos de la radicación"): de aquí sale el
    // número de documento y el nombre del propietario.
    const solicitante = await this._leerPorIds(page, {
      cedula: '_TxtCedula',
      nombre: '_TxtNombre',
    });

    onProgreso('Leyendo pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    const predio = await this._leerCamposVisibles(page);
    // Lectura precisa por id (los rótulos de la tabla no son fiables).
    const campos = await this._leerPorIds(page, {
      destino: '_CmbDestino',
      orip: '_TCodigoORIP',
      matricula: '_TMatricula',
      avaluo: '_TAvaluo',
    });
    campos.cedula = solicitante.cedula;
    campos.nombre = solicitante.nombre;
    campos.direccion = this._normalizarDireccion(await this._leerDireccionOrigen(page));

    onProgreso('Leyendo pestaña Terreno...');
    await this._irAPestana(page, 'Terreno');
    const terreno = await this._leerPorIds(page, { areaPrivada: '_TAreaTTPrivada' });
    campos.areaTerreno = terreno.areaPrivada;

    onProgreso('Leyendo pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    const propietarios = await this._leerCamposVisibles(page);

    // La Fte Administrativa del origen (cancelación) viene vacía: esos datos
    // salen siempre de los predeterminados que indica el usuario.
    const fuente = {};

    await this._guardarDiagnostico(page, `origen-${radicado}`);

    this.logger.info(
      `Origen ${radicado}: destino="${campos.destino}" matricula="${campos.orip}-${campos.matricula}" ` +
        `direccion="${campos.direccion}" area="${campos.areaTerreno}" ` +
        `cedula="${campos.cedula}" nombre="${campos.nombre}"`
    );

    return { predio, propietarios, fuente, campos };
  }

  /**
   * La dirección pasa al destino "limpia": la vía va como "C" (no "CL") y sin
   * el guion separador.  Ej.: "CL 129 5C - 36" -> "C 129 5C 36".  El prefijo
   * es lo único que cambia de letra: los "5C" internos quedan intactos.
   */
  _normalizarDireccion(direccion) {
    const limpia = String(direccion || '').trim();
    if (!limpia) return '';
    const ajustada = limpia
      .replace(/^CL\b\s*/i, 'C ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (ajustada !== limpia) {
      this.logger.info(`Dirección ajustada: "${limpia}" -> "${ajustada}"`);
    }
    return ajustada;
  }

  /** Lee varios campos por sufijo de id. Devuelve {clave: valor}. */
  async _leerPorIds(page, mapa) {
    return page
      .evaluate((mapa) => {
        const salida = {};
        for (const [clave, sufijo] of Object.entries(mapa)) {
          const el = document.querySelector(`[id$="${sufijo}"]`);
          if (!el) {
            salida[clave] = '';
            continue;
          }
          if (el.tagName === 'SELECT') {
            const op = el.options[el.selectedIndex];
            salida[clave] = op ? op.text.trim() : '';
          } else {
            salida[clave] = (el.value || el.textContent || '').trim();
          }
        }
        return salida;
      }, mapa)
      .catch(() => Object.fromEntries(Object.keys(mapa).map((k) => [k, ''])));
  }

  /**
   * Dirección del predio en el origen: primera fila de la grilla DIRECCIONES
   * DEL PREDIO (la columna DIRECCION, p. ej. "CL 129 5C - 36").
   */
  async _leerDireccionOrigen(page) {
    return page
      .evaluate(() => {
        const norm = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .trim();
        for (const tabla of document.querySelectorAll('table')) {
          const filas = Array.from(tabla.querySelectorAll('tr'));
          if (filas.length < 2) continue;
          const encabezados = Array.from(filas[0].children).map((c) => norm(c.textContent));
          const iDir = encabezados.findIndex((h) => h === 'DIRECCION');
          if (iDir < 0) continue;
          for (const fila of filas.slice(1)) {
            const celdas = Array.from(fila.children);
            const valor = ((celdas[iDir] && celdas[iDir].textContent) || '').trim();
            if (valor) return valor;
          }
        }
        return '';
      })
      .catch(() => '');
  }

  async escribirDestino(page, radicado, datos, extras, onProgreso = () => {}) {
    this._atenderDialogos(page);
    onProgreso('Abriendo trámite destino...');
    await this._abrirTramite(page, radicado);

    const campos = datos.campos || {};

    /* --- Predio: "Modifica" abre el modal PanelPopPredio con su propia copia
       de los campos (los de la pantalla de atrás son de solo lectura). --- */
    onProgreso('Navegando a pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    onProgreso('Abriendo modo edición (Modifica)...');
    await this._abrirModalConReintento(page, 'PanelPopPredio', '_BtnModPredio', 'Modifica');

    onProgreso('Llenando campos de Predio...');
    await this._llenarCamposPredio(page, campos, extras);
    onProgreso('Guardando Predio...');
    if (!(await this._clickPorIdSufijo(page, '_BtnGuardaPred'))) {
      await this._clickBotonAccion(page, 'Guardar');
    }
    await this._cerrarAviso(page);
    await this._cerrarModalAbierto(page);

    /* --- Dirección del predio: "+" abre PanelPopDireccion; la dirección del
       origen se pega en "Complemento dirección". --- */
    const direccion = extras.direccion || campos.direccion || '';
    if (direccion) {
      onProgreso('Agregando dirección del predio...');
      if (await this._abrirModalConReintento(page, 'PanelPopDireccion', '_BtnAgregaDir')) {
        await this._llenarInput(page, 'Complemento direccion', direccion, {
          idSufijo: '_TComplementoDir',
        });
        if (!(await this._clickPorIdSufijo(page, '_BtnGuardaDir'))) {
          await this._clickBotonAccion(page, 'Guardar');
        }
        await this._cerrarAviso(page);
        await this._cerrarModalAbierto(page);
      }
    }

    /* --- Propietarios --- */
    onProgreso('Navegando a pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    onProgreso('Agregando nuevo propietario...');
    if (await this._abrirModalConReintento(page, 'PanelPopPropietario', '_BtnAgregaProp')) {
      onProgreso('Llenando campos de Propietario...');
      await this._llenarCamposPropietarios(page, datos.propietarios, extras, campos);
      onProgreso('Guardando Propietario...');
      if (!(await this._clickPorIdSufijo(page, '_BtnGuardaProp'))) {
        await this._clickBotonAccion(page, 'Guardar');
      }
      await this._cerrarAviso(page);
      await this._cerrarModalAbierto(page);
    } else {
      this.logger.warn('No se pudo abrir el formulario de Propietario (+).');
    }

    /* --- Terreno: se copia el área del origen y se aplican zonas digitales.
       El botón tarda bastante (carga del servidor) y al terminar edis avisa
       "zona aplicada". --- */
    const areaTerreno = extras.areaTerreno || campos.areaTerreno || '';
    if (areaTerreno) {
      onProgreso('Navegando a pestaña Terreno...');
      await this._irAPestana(page, 'Terreno');
      onProgreso(`Copiando área de terreno (${areaTerreno})...`);
      await this._llenarInput(page, 'Area Terreno Privado', areaTerreno, {
        idSufijo: '_TAreaTTPrivada',
      });
      // Sacar el foco del campo para que el valor quede confirmado antes de
      // enviar el formulario.
      await page
        .locator('[id$="_TAreaTTPrivada"]')
        .first()
        .press('Tab', { timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(500);
      onProgreso('Aplicando zonas digitales...');
      await this._aplicarZonasDigitales(page);
    } else {
      this.logger.warn('Sin área de terreno del origen: se omite el paso de Terreno.');
    }

    /* --- Fte Administrativa (datos SIEMPRE de los predeterminados/extras) --- */
    onProgreso('Navegando a pestaña Fte Administrativa...');
    await this._irAPestana(page, 'Fte Administrativa');
    onProgreso('Abriendo modo edición...');
    await this._abrirModalConReintento(
      page,
      'PanelPopEscritura',
      '_BtnModEscritura',
      'Modifica'
    );
    await this._cerrarAviso(page);
    onProgreso('Llenando campos de Fuente Administrativa...');
    await this._llenarCamposFuente(page, datos.fuente, extras);
    onProgreso('Guardando Fuente Administrativa...');
    if (!(await this._clickPorIdSufijo(page, '_BtnGuardaEscritura'))) {
      await this._clickBotonAccion(page, 'Guardar');
    }
    await this._cerrarAviso(page);
    await this._cerrarModalAbierto(page);

    await this._guardarDiagnostico(page, `destino-${radicado}`);
    onProgreso('Migración completada. Revise en pantalla.');
  }

  /* ===================== NAVEGACIÓN ===================== */

  async _abrirTramite(page, radicado) {
    const timeout = this.config.browser.timeoutMs;
    const partes = this._partes(radicado);
    const num = `${partes.anio}-${partes.numero}`;

    await page.goto(this.config.bandeja.url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    // 1) Abrir el modal con la cuadrícula "TRÁMITES ASIGNADOS" (GridRad, dentro
    //    del PanelPopRad). No se llenan AÑO/NÚMERO: están disabled y la
    //    cuadrícula ya lista TODOS los trámites asignados.
    await this._clickBuscarRadicado(page);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 2) Clic en el radicado dentro de la cuadrícula. Cada fila trae el radicado
    //    como <input type="submit" value="2026-8728">; pulsarlo hace postback,
    //    carga el trámite y cierra el modal.
    const pulsado = await this._clickRadicadoEnGrid(page, num, 15000);
    if (!pulsado) {
      await this._guardarDiagnostico(page, `busqueda-${radicado}`);
      throw new Error(
        `No se encontró el radicado ${num} en la cuadrícula TRÁMITES ASIGNADOS. ` +
          `Se guardó el HTML en la carpeta 'diagnostico'.`
      );
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await this._cerrarAviso(page);

    // 3) Esperar a que el modal se cierre y el trámite quede realmente cargado
    //    (el campo Radicación NÚMERO debe pasar a ser el buscado).
    const cargado = await this._esperarTramiteCargado(page, partes.numero, 15000);

    await this._guardarDiagnostico(page, `busqueda-${radicado}`);
    this.logger.info(
      `Trámite ${radicado} abierto (cargado=${cargado ? 'sí' : 'NO'}). URL: ${page.url()}`
    );

    if (!cargado) {
      throw new Error(
        `Se pulsó el radicado ${num} pero el trámite no terminó de cargar ` +
          `(el modal no se cerró o el NÚMERO no coincidió). Ver 'diagnostico'.`
      );
    }
  }

  /**
   * Pulsa el radicado dentro de la cuadrícula GridRad (es un
   * <input type="submit" value="AAAA-NNNN">). Sondea hasta `limiteMs` porque la
   * cuadrícula se llena por postback tras abrir el modal.
   */
  async _clickRadicadoEnGrid(page, num, limiteMs) {
    const objetivo = String(num).replace(/\s+/g, '').trim();
    const fin = Date.now() + limiteMs;

    while (Date.now() < fin) {
      for (const frame of page.frames()) {
        const marcado = await frame
          .evaluate((objetivo) => {
            document
              .querySelectorAll('[data-robot-abrir]')
              .forEach((e) => e.removeAttribute('data-robot-abrir'));
            const norm = (t) => (t || '').replace(/\s+/g, '').trim();
            // El radicado es un botón submit con value="AAAA-NNNN"; se acepta
            // también un enlace por si en otra pantalla cambia.
            for (const el of document.querySelectorAll(
              'input[type="submit"], input[type="button"], a'
            )) {
              const txt = el.tagName === 'INPUT' ? norm(el.value) : norm(el.textContent);
              if (txt === objetivo) {
                el.setAttribute('data-robot-abrir', '1');
                return true;
              }
            }
            return false;
          }, objetivo)
          .catch(() => false);

        if (marcado) {
          await frame
            .locator('[data-robot-abrir="1"]')
            .click({ timeout: 6000 })
            .catch(() => {});
          this.logger.info(`Radicado ${num} pulsado en la cuadrícula.`);
          return true;
        }
      }
      await page.waitForTimeout(500);
    }
    this.logger.warn(`Radicado ${num} no apareció en la cuadrícula.`);
    return false;
  }

  /**
   * Espera a que el modal PanelPopRad se cierre y el trámite buscado quede
   * cargado (el input Radicación NÚMERO pasa a ser el número buscado).
   */
  async _esperarTramiteCargado(page, numero, limiteMs) {
    const fin = Date.now() + limiteMs;
    while (Date.now() < fin) {
      const estado = await page
        .evaluate((numero) => {
          const modal = document.getElementById('ctl00_ContentPlaceHolder1_PanelPopRad');
          // El modal es position:fixed, así que offsetParent no sirve; se mira
          // display/visibility computados.
          const est = modal ? getComputedStyle(modal) : null;
          const modalVisible = Boolean(
            modal && est && est.display !== 'none' && est.visibility !== 'hidden'
          );
          const tnum =
            document.getElementById('ctl00_ContentPlaceHolder1_TNumRad') ||
            document.querySelector('[id$="TNumRad"]');
          const cargadoNum = Boolean(tnum && String(tnum.value).trim() === String(numero));
          return { modalVisible, cargadoNum };
        }, numero)
        .catch(() => ({ modalVisible: true, cargadoNum: false }));

      if (!estado.modalVisible && estado.cargadoNum) return true;
      await this._cerrarAviso(page);
      await page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * Pulsa el botón que busca un radicado en la página de resolución.  Se
   * prueba primero el ID conocido (BtnBuscaRad) y los candidatos de config
   * (los mismos que usa el BandejaScraper), y por último la lupa marcada.
   */
  async _clickBuscarRadicado(page) {
    const candidatos = [
      '#ctl00_ContentPlaceHolder1_BtnBuscaRad',
      ...(this.config.bandeja.accionesApertura || []),
      '[data-robot-campo="buscar"]',
    ];
    for (const sel of candidatos) {
      for (const frame of page.frames()) {
        try {
          const el = frame.locator(sel).first();
          if ((await el.count().catch(() => 0)) === 0) continue;
          await el.click({ timeout: 6000 });
          this.logger.info(`Búsqueda de radicado con: ${sel}`);
          return sel;
        } catch {
          // No clicable en este marco; siguiente candidato.
        }
      }
    }
    this.logger.warn('No se pudo pulsar ningún botón de búsqueda de radicado.');
    return null;
  }

  /**
   * Pulsa un botón por el SUFIJO de su id (los controles de edis tienen ids
   * largos tipo ctl00_ContentPlaceHolder1_TabContainer1_TabPanel1_BtnModPredio;
   * el sufijo "_BtnModPredio" lo identifica sin ambigüedad). Busca en todos los
   * marcos y solo pulsa el que esté visible.  Devuelve true si pulsó alguno.
   */
  async _clickPorIdSufijo(page, sufijo, { timeout = 8000 } = {}) {
    for (const frame of page.frames()) {
      const candidatos = frame.locator(`[id$="${sufijo}"]`);
      const total = await candidatos.count().catch(() => 0);
      for (let i = 0; i < total; i++) {
        const el = candidatos.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        try {
          await el.click({ timeout });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          this.logger.info(`Botón *${sufijo} pulsado.`);
          return true;
        } catch {
          // Visible pero no clicable ahora; se prueba el siguiente.
        }
      }
    }
    this.logger.warn(`Botón *${sufijo} no encontrado/clicable.`);
    return false;
  }

  /**
   * Cierra el cartel emergente de edis (botón "Aceptar") si está en pantalla y
   * devuelve su texto. Dejarlo abierto tapa la página y bloquea todo lo demás.
   */
  async _cerrarAviso(page) {
    try {
      const boton = page
        .locator("button:has-text('Aceptar'), input[value='Aceptar'], a:has-text('Aceptar')")
        .first();
      if (!(await boton.isVisible({ timeout: 1500 }).catch(() => false))) return '';

      const texto = await page
        .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200))
        .catch(() => '');
      await boton.click({ timeout: 3000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      this.logger.info(`Aviso de edis cerrado: "${texto.slice(0, 120)}"`);
      return texto;
    } catch {
      return '';
    }
  }

  async _irAPestana(page, nombre) {
    // Se busca y MARCA la pestaña con JS dentro de la página (patrón probado en
    // el resto del código), en TODOS los marcos, y luego se hace clic con
    // Playwright sobre el elemento marcado. Es mucho más robusto que un
    // locator de texto: encuentra el enlace aunque el rótulo esté dentro de un
    // <span>, tolera acentos/espacios y funciona con los LinkButton de ASP.NET
    // (href="javascript:__doPostBack(...)").
    for (const frame of page.frames()) {
      const info = await frame
        .evaluate(MARCAR_PESTANA, { nombre })
        .catch(() => ({ encontrado: false }));
      if (!info.encontrado) continue;

      const tab = frame.locator('[data-robot-pestana="1"]');
      await tab.click({ timeout: 8000 }).catch(async () => {
        // Respaldo: disparar el postback directamente si el click no navega.
        await frame.evaluate(() => {
          const el = document.querySelector('[data-robot-pestana="1"]');
          if (el) el.click();
        });
      });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(2000);
      this.logger.info(
        `Pestaña "${nombre}" activa (${info.tag}, texto="${info.texto}", href="${info.href}").`
      );
      return;
    }

    // No se encontró en ningún marco: guardar diagnóstico y reportar qué había.
    const diag = await page.evaluate(MARCAR_PESTANA, { nombre }).catch(() => ({ enlaces: [] }));
    const frames = page.frames().map((f) => f.url());
    this.logger.warn(
      `Pestaña "${nombre}" no encontrada.\n` +
        `  URL: ${page.url()}\n` +
        `  Enlaces en página: ${(diag.enlaces || []).join(' | ')}\n` +
        `  Marcos: ${frames.join(', ')}`
    );
    await this._guardarDiagnostico(page, `pestana-no-encontrada-${nombre}`);
    throw new Error(
      `No se encontró la pestaña "${nombre}". ` +
        `Enlaces vistos: ${(diag.enlaces || []).slice(0, 15).join(', ') || '(ninguno)'}.`
    );
  }

  async _clickBotonAccion(page, texto) {
    for (const selector of [
      `a:has-text("${texto}")`,
      `input[value="${texto}"]`,
      `button:has-text("${texto}")`,
    ]) {
      const boton = page.locator(selector).first();
      if (await boton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await boton.click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
        this.logger.info(`Botón "${texto}" pulsado.`);
        return true;
      }
    }
    this.logger.warn(`Botón "${texto}" no encontrado.`);
    return false;
  }

  /**
   * Pulsa "Aplica Zonas Digitales".  El clic ya espera a que termine el
   * postback, así que después solo se confirma el resultado con un sondeo
   * CORTO: aplicar zonas es cuestión de segundos.  Si no se puede confirmar,
   * se sigue adelante en vez de bloquear la migración.
   */
  async _aplicarZonasDigitales(page) {
    // Comprobar que el área sigue escrita justo antes de pulsar: si un postback
    // anterior la borró, aplicar zonas no haría nada y quedaría sin explicación.
    const antes = await this._leerPorIds(page, { area: '_TAreaTTPrivada' });
    this.logger.info(`Área de terreno antes de aplicar zonas: "${antes.area}"`);

    const boton = page.locator('[id$="_BtnGetZonasD"]').first();
    if (!(await boton.isVisible({ timeout: 8000 }).catch(() => false))) {
      this.logger.warn('No se encontró el botón "Aplica Zonas Digitales".');
      return false;
    }

    // Es un <input type="submit">: el clic provoca una navegación completa que
    // tarda. Se espera la navegación en sí (no networkidle, que resolvía a los
    // 0,2 s dejando el envío a medias).
    const inicio = Date.now();
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: 'load', timeout: 120000 })
        .catch(() => null),
      boton.click({ timeout: 15000 }).catch((e) => {
        this.logger.warn(`No se pudo pulsar zonas digitales: ${e.message.split('\n')[0]}`);
      }),
    ]);
    this.logger.info(`Zonas digitales: respuesta en ${Date.now() - inicio} ms.`);
    await this._cerrarAviso(page);

    // Tras el postback la pestaña activa puede volver al inicio.
    await this._irAPestana(page, 'Terreno').catch(() => {});

    const estado = await this._leerEstadoTerreno(page);
    await this._guardarDiagnostico(page, 'zonas-digitales');
    this.logger.info(
      `Terreno tras aplicar zonas: area="${estado.area}" total="${estado.total}" ` +
        `filasZonas=${estado.filasZonas} mensaje="${estado.mensaje}"`
    );

    if (estado.filasZonas > 0 || parseFloat(String(estado.total).replace(',', '.')) > 0) {
      this.logger.info('Zonas digitales aplicadas.');
      return true;
    }
    this.logger.warn('Las zonas no quedaron aplicadas; ver diagnostico/zonas-digitales.');
    return false;
  }

  /** Estado de la pestaña Terreno: área, suma, filas de zonas y avisos. */
  async _leerEstadoTerreno(page) {
    return page
      .evaluate(() => {
        const val = (s) => {
          const el = document.querySelector(`[id$="${s}"]`);
          if (!el) return '';
          return (el.value !== undefined ? el.value : el.textContent || '').trim();
        };
        // Filas con datos de la grilla de ZONAS (encabezado IdCIZona).
        let filasZonas = 0;
        for (const tabla of document.querySelectorAll('table')) {
          const filas = Array.from(tabla.querySelectorAll('tr'));
          if (filas.length < 2) continue;
          const cab = (filas[0].textContent || '').toUpperCase();
          if (!cab.includes('IDCIZONA')) continue;
          filasZonas = filas.slice(1).filter((f) => (f.textContent || '').trim()).length;
          break;
        }
        const texto = (document.body.innerText || '').replace(/\s+/g, ' ');
        const m = texto.match(/[^.]*(ZONA[^.]{0,80}|no se encontr[^.]{0,80})/i);
        return {
          area: val('_TAreaTTPrivada'),
          total: val('_LblAreaTotalTerreno'),
          filasZonas,
          mensaje: m ? m[0].trim().slice(0, 150) : '',
        };
      })
      .catch(() => ({ area: '', total: '', filasZonas: 0, mensaje: '' }));
  }

  /**
   * Abre un modal pulsando su botón y verifica que quedó visible; si no,
   * reintenta (por id y luego por texto).  Sin esta comprobación se escribía
   * dentro de un modal cerrado y los datos nunca llegaban a edis.
   */
  async _abrirModalConReintento(page, idModal, sufijoBoton, textoBoton) {
    for (let intento = 1; intento <= 2; intento++) {
      const pulsado =
        (await this._clickPorIdSufijo(page, sufijoBoton)) ||
        (textoBoton ? await this._clickBotonAccion(page, textoBoton) : false);
      if (pulsado && (await this._esperarModal(page, idModal))) return true;
      this.logger.warn(`No se abrió ${idModal} (intento ${intento}).`);
      await this._cerrarAviso(page);
      await page.waitForTimeout(800);
    }
    this.logger.warn(`El modal ${idModal} no se pudo abrir; su sección no se llenará.`);
    return false;
  }

  /**
   * Espera a que el modal indicado quede visible (edis los abre por postback).
   * Devuelve true si apareció.
   */
  async _esperarModal(page, idParcial, limiteMs = 10000) {
    const fin = Date.now() + limiteMs;
    while (Date.now() < fin) {
      const visible = await page
        .evaluate((id) => {
          const el = document.querySelector(`[id$="${id}"]`);
          if (!el) return false;
          const est = getComputedStyle(el);
          return est.display !== 'none' && est.visibility !== 'hidden';
        }, idParcial)
        .catch(() => false);
      if (visible) {
        await page.waitForTimeout(600);
        this.logger.info(`Modal ${idParcial} visible.`);
        return true;
      }
      await page.waitForTimeout(400);
    }
    this.logger.warn(`El modal ${idParcial} no apareció.`);
    return false;
  }

  /**
   * Cierra cualquier modal PanelPop* que haya quedado abierto.  Son overlays a
   * pantalla completa (bg-black bg-opacity-75): si uno queda abierto, TODOS los
   * clics posteriores chocan contra él.  Se pulsa su botón "Salir".
   * @returns {Promise<string>} id del modal cerrado, o '' si no había ninguno
   */
  async _cerrarModalAbierto(page) {
    const abierto = await page
      .evaluate(() => {
        for (const el of document.querySelectorAll(
          '[id^="ctl00_ContentPlaceHolder1_PanelPop"]'
        )) {
          const est = getComputedStyle(el);
          if (est.display !== 'none' && est.visibility !== 'hidden') return el.id;
        }
        return '';
      })
      .catch(() => '');
    if (!abierto) return '';

    const marcado = await page
      .evaluate((id) => {
        document
          .querySelectorAll('[data-robot-cerrar]')
          .forEach((e) => e.removeAttribute('data-robot-cerrar'));
        const modal = document.getElementById(id);
        if (!modal) return false;
        const salir = Array.from(
          modal.querySelectorAll('input[type="submit"], input[type="button"], button, a')
        ).find((b) => /salir|cerrar|cancelar/i.test(b.value || b.textContent || ''));
        if (!salir) return false;
        salir.setAttribute('data-robot-cerrar', '1');
        return true;
      }, abierto)
      .catch(() => false);

    if (marcado) {
      await page
        .locator('[data-robot-cerrar="1"]')
        .click({ timeout: 5000 })
        .catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    this.logger.warn(`Modal ${abierto} quedó abierto; se cerró antes de seguir.`);
    return abierto;
  }

  /* ===================== LECTURA ===================== */

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

        for (let i = 0; i < celdas.length - 1; i++) {
          const celda = celdas[i];
          const tieneCampoVisible = Array.from(
            celda.querySelectorAll('select, input, textarea')
          ).some((c) => {
            const tipo = (c.getAttribute('type') || '').toLowerCase();
            return !['hidden', 'image', 'submit', 'button'].includes(tipo) && c.offsetParent;
          });
          if (tieneCampoVisible) continue;

          const etiqueta = normalizar(celda.innerText || celda.textContent);
          if (!etiqueta || etiqueta.length > 60 || etiqueta in resultado) continue;

          const siguiente = celdas[i + 1];
          for (const campo of siguiente.querySelectorAll('select, input, textarea')) {
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
          if (resultado[etiqueta]) continue;

          for (const span of celdas[i + 1].querySelectorAll('span')) {
            if (span.children.length > 0) continue;
            const t = (span.textContent || '').trim();
            if (t && t !== 'Label') {
              resultado[etiqueta] = { valor: t, id: span.id || '', tipo: 'readonly' };
              break;
            }
          }
        }
      }
      return resultado;
    });
  }

  /* ===================== MARCADO + LLENADO ===================== */

  async _marcarCampo(page, etiqueta, tag, { indice = 0 } = {}) {
    await page
      .evaluate((t) => {
        const prev = document.querySelector(`[data-robot-campo="${t}"]`);
        if (prev) prev.removeAttribute('data-robot-campo');
      }, tag)
      .catch(() => {});

    return page.evaluate(
      ({ etiqueta, tag, indice }) => {
        const normalizar = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toUpperCase()
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/:$/, '');
        const objetivo = normalizar(etiqueta);

        const esEditable = (campo) => {
          const tipo = (campo.getAttribute('type') || '').toLowerCase();
          if (['hidden', 'submit', 'image', 'button'].includes(tipo)) return false;
          return campo.offsetParent !== null;
        };

        for (const fila of document.querySelectorAll('tr')) {
          const celdas = Array.from(fila.querySelectorAll('td, th'));
          if (celdas.length < 2) continue;

          for (let i = 0; i < celdas.length - 1; i++) {
            const celda = celdas[i];
            const tieneCampoVisible = Array.from(
              celda.querySelectorAll('select, input, textarea')
            ).some((c) => esEditable(c));
            if (tieneCampoVisible) continue;

            const textoEtiqueta = normalizar(celda.innerText || celda.textContent);
            if (!textoEtiqueta.includes(objetivo)) continue;

            let encontrados = 0;
            const siguiente = celdas[i + 1];
            for (const campo of siguiente.querySelectorAll('select, input, textarea')) {
              if (!esEditable(campo)) continue;

              if (encontrados === indice) {
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
              encontrados++;
            }
          }
        }
        return { encontrado: false };
      },
      { etiqueta, tag, indice }
    );
  }

  /**
   * Marca un campo por el SUFIJO de su id.  Es la vía preferida: los ids de
   * edis son estables (p. ej. "_CmbDestino", "_TMatricula") mientras que las
   * etiquetas dependen del armado de la tabla.
   */
  async _marcarPorId(page, sufijo, tag) {
    return page
      .evaluate(
        ({ s, t }) => {
          const prev = document.querySelector(`[data-robot-campo="${t}"]`);
          if (prev) prev.removeAttribute('data-robot-campo');

          // Se exige que el campo esté VISIBLE: los modales de edis existen en
          // el DOM aunque estén cerrados, y escribir en uno cerrado no surte
          // efecto y además lo oculta como si hubiera funcionado.
          const els = Array.from(document.querySelectorAll(`[id$="${s}"]`));
          const el = els.find(
            (e) => e.offsetParent !== null || e.getClientRects().length > 0
          );
          if (!el) return { encontrado: false, oculto: els.length > 0 };
          el.setAttribute('data-robot-campo', t);

          if (el.tagName === 'SELECT') {
            const normalizar = (x) =>
              (x || '')
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .toUpperCase()
                .replace(/\s+/g, ' ')
                .trim();
            return {
              encontrado: true,
              tipo: 'select',
              id: el.id || '',
              opciones: Array.from(el.options).map((o) => ({
                value: o.value,
                text: o.text.trim(),
                textNorm: normalizar(o.text),
              })),
            };
          }
          return { encontrado: true, tipo: 'input', id: el.id || '' };
        },
        { s: sufijo, t: tag }
      )
      .catch(() => ({ encontrado: false }));
  }

  async _llenarInput(page, etiqueta, valor, { indice = 0, idSufijo = null } = {}) {
    if (!valor) return;
    const tag = `migrar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Primero por id (estable); si no está, se cae a la búsqueda por etiqueta.
    let info = idSufijo ? await this._marcarPorId(page, idSufijo, tag) : null;
    if (!info || !info.encontrado) {
      info = await this._marcarCampo(page, etiqueta, tag, { indice });
    }
    if (!info.encontrado) {
      this.logger.warn(
        `Campo "${etiqueta}"${idSufijo ? ` (${idSufijo})` : ''} no encontrado` +
          `${info.oculto ? ' (existe pero está oculto: su modal no se abrió)' : ''}.`
      );
      return;
    }

    const locator = page.locator(`[data-robot-campo="${tag}"]`);

    // edis deja los campos deshabilitados hasta pulsar "Modifica". Si el botón
    // no los habilitó, se quita el disabled para poder escribir igualmente: al
    // guardar, el valor sí se envía porque el control ya no va deshabilitado.
    await page
      .evaluate((t) => {
        const el = document.querySelector(`[data-robot-campo="${t}"]`);
        if (!el) return;
        el.removeAttribute('disabled');
        el.removeAttribute('readonly');
        el.disabled = false;
        if ('readOnly' in el) el.readOnly = false;
      }, tag)
      .catch(() => {});

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
        if (!mejor && (textoOp.includes(objetivo) || objetivo.includes(textoOp))) mejor = op;
        if (!mejor && (valorOp.includes(objetivo) || objetivo.includes(valorOp))) mejor = op;
      }

      if (!mejor) {
        this.logger.warn(
          `Opción "${valor}" no encontrada en "${etiqueta}". ` +
            `Opciones: ${info.opciones.map((o) => o.text).join(', ')}`
        );
        return;
      }

      const puesto = await locator
        .selectOption(mejor.value, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!puesto) {
        // Respaldo: fijar el valor por JS y avisar del cambio, por si el
        // control sigue bloqueado para la interacción normal.
        await page
          .evaluate(
            ({ t, v }) => {
              const el = document.querySelector(`[data-robot-campo="${t}"]`);
              if (!el) return;
              el.value = v;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            { t: tag, v: mejor.value }
          )
          .catch(() => {});
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      this.logger.info(`Select "${etiqueta}" = "${mejor.text}"${puesto ? '' : ' (por JS)'}`);
    } else {
      const puesto = await locator
        .fill(String(valor), { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!puesto) {
        await page
          .evaluate(
            ({ t, v }) => {
              const el = document.querySelector(`[data-robot-campo="${t}"]`);
              if (!el) return;
              el.value = v;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            { t: tag, v: String(valor) }
          )
          .catch(() => {});
      }
      this.logger.info(`Input "${etiqueta}" = "${valor}"${puesto ? '' : ' (por JS)'}`);
    }
  }

  /* ===================== LLENADO POR SECCIÓN ===================== */

  /**
   * Campos del MODAL "DATOS DEL PREDIO" (PanelPopPredio).  Sus ids terminan en
   * "M" (CmbDestinoM, TMatriculaM...); los de la pantalla de atrás son de solo
   * lectura y escribir en ellos no surte efecto.
   */
  async _llenarCamposPredio(page, campos, extras) {
    await this._llenarInput(page, 'Destino', extras.destino || campos.destino, {
      idSufijo: '_CmbDestinoM',
    });

    // Matrícula partida: ORIP (círculo, p. ej. 140) + número (p. ej. 152987).
    let circulo = extras.matriculaCirculo || campos.orip || '';
    let numero = extras.matriculaNumero || campos.matricula || '';
    if (!circulo && numero && numero.includes('-')) {
      [circulo, numero] = numero.split('-', 2);
    }
    if (circulo) {
      await this._llenarInput(page, 'ORIP', circulo, { idSufijo: '_TCodigoORIPM' });
    }
    if (numero) {
      await this._llenarInput(page, 'Matricula', numero, { idSufijo: '_TMatriculaM' });
    }

    // El tipo de predio no viene del origen: siempre Predio.Privado.
    await this._llenarInput(page, 'Tipo Predio', extras.tipoPredio || 'Predio.Privado', {
      idSufijo: '_CmbTipoPredioM',
    });
  }

  /** Campos del modal PROPIETARIO (PanelPopPropietario), por id real. */
  async _llenarCamposPropietarios(page, datosOrigen, extras, campos = {}) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(
      page,
      'Tipo Dcto',
      extras.tipoDocumento || buscar('TIPO DOC', 'TIPO DCTO'),
      { idSufijo: '_CmbTipoDoc' }
    );
    // El número de documento sale de la cédula del solicitante del trámite.
    await this._llenarInput(
      page,
      'Documento',
      extras.documento || campos.cedula || buscar('DOCUMENTO', 'CEDULA'),
      { idSufijo: '_TDcto' }
    );
    await this._llenarInput(page, 'Tipo Derecho', extras.tipoDerecho || 'Dominio', {
      idSufijo: '_CmbTipoDerecho',
    });
    await this._llenarInput(
      page,
      'Fraccion de Derecho',
      extras.porcentaje || buscar('PORCENTAJE', 'FRACCION') || '1',
      { idSufijo: '_TPorcProp' }
    );

    // La fecha de inicio de tenencia es la de la escritura salvo que se indique.
    const fechaTenencia = extras.fechaTenencia || extras.fechaFuente || '';
    if (fechaTenencia) {
      await this._llenarInput(page, 'Fecha inicio tenencia', fechaTenencia, {
        idSufijo: '_TFechaTenencia',
      });
    }

    await this._llenarInput(page, 'Autoreconocimiento Etnico', extras.etnico || 'Ninguno', {
      idSufijo: '_CmbGrupoEtnico',
    });

    const nombreCompleto = extras.nombre || campos.nombre || buscar('NOMBRE');
    if (nombreCompleto) {
      const n = this._separarNombre(nombreCompleto);
      await this._llenarInput(page, '1er Nombre', n.primerNombre, { idSufijo: '_TNombre1' });
      await this._llenarInput(page, '2do Nombre', n.segundoNombre, { idSufijo: '_TNombre2' });
      await this._llenarInput(page, '1er Apellido', n.primerApellido, {
        idSufijo: '_TApellido1',
      });
      await this._llenarInput(page, '2do Apellido', n.segundoApellido, {
        idSufijo: '_TApellido2',
      });
    }

    await this._llenarInput(page, 'Sexo', extras.sexo || 'Masculino', { idSufijo: '_CmbSexo' });
  }

  /** Campos del modal ESCRITURA / fuente administrativa (PanelPopEscritura). */
  async _llenarCamposFuente(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(page, 'Tipo Fuente', extras.tipoFuente || 'Escritura', {
      idSufijo: '_CmbTipoFuente',
    });
    await this._llenarInput(page, 'Numero', extras.numeroFuente || buscar('NUMERO'), {
      idSufijo: '_TEscrituraM',
    });
    await this._llenarInput(page, 'Fecha', extras.fechaFuente || buscar('FECHA'), {
      idSufijo: '_TFechaEscrituraM',
    });
    await this._llenarInput(
      page,
      'Ente Emisor',
      extras.enteEmisor || buscar('ENTE EMISOR', 'ENTE', 'NOTARIA'),
      { idSufijo: '_TNotariaM' }
    );
    await this._llenarInput(
      page,
      'Fecha Inscripcion Catastral',
      extras.fechaInscripcion || buscar('INSCRIPCION'),
      { idSufijo: '_TFechaICM' }
    );
  }

  /* ===================== UTILIDADES ===================== */

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

  _buscarEn(datos, ...patrones) {
    return this._crearBuscador(datos)(...patrones);
  }

  _separarNombre(nombreCompleto) {
    const partes = String(nombreCompleto).trim().split(/\s+/);
    if (partes.length >= 4) {
      return {
        primerNombre: partes[0],
        segundoNombre: partes[1],
        primerApellido: partes[2],
        segundoApellido: partes.slice(3).join(' '),
      };
    }
    if (partes.length === 3) {
      return {
        primerNombre: partes[0],
        segundoNombre: '',
        primerApellido: partes[1],
        segundoApellido: partes[2],
      };
    }
    if (partes.length === 2) {
      return {
        primerNombre: partes[0],
        segundoNombre: '',
        primerApellido: partes[1],
        segundoApellido: '',
      };
    }
    return { primerNombre: nombreCompleto, segundoNombre: '', primerApellido: '', segundoApellido: '' };
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
    const carpeta = path.join(path.dirname(this.config.app.dbPath), 'diagnostico');
    const base = path.join(carpeta, String(nombre).replace(/[\\/:*?"<>|]/g, '-'));
    try {
      fs.mkdirSync(carpeta, { recursive: true });
    } catch (error) {
      this.logger.warn(`No se pudo crear carpeta de diagnóstico: ${error.message}`);
      return '';
    }

    // El HTML es lo más importante (trae el DOM real): se guarda por separado
    // para que un fallo al tomar la foto no impida capturarlo.
    try {
      const html = await page.content();
      fs.writeFileSync(`${base}.html`, html, 'utf8');
      this.logger.info(`Diagnóstico HTML guardado: ${base}.html`);
    } catch (error) {
      this.logger.warn(`No se pudo guardar HTML de diagnóstico: ${error.message}`);
    }

    try {
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      return `${base}.png`;
    } catch (error) {
      this.logger.warn(`No se pudo guardar foto de diagnóstico: ${error.message}`);
      return '';
    }
  }
}

module.exports = { MigracionTramiteService };
