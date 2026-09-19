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
      `Origen ${radicado}: predio=${Object.keys(predio).length}, ` +
        `propietarios=${Object.keys(propietarios).length}, fuente=${Object.keys(fuente).length}`
    );

    return { predio, propietarios, fuente };
  }

  async escribirDestino(page, radicado, datos, extras, onProgreso = () => {}) {
    onProgreso('Abriendo trámite destino...');
    await this._abrirTramite(page, radicado);

    /* --- Predio --- */
    onProgreso('Navegando a pestaña Predio...');
    await this._irAPestana(page, 'Predio');
    onProgreso('Abriendo modo edición (Modifica)...');
    await this._clickBotonAccion(page, 'Modifica');
    onProgreso('Llenando campos de Predio...');
    await this._llenarCamposPredio(page, datos.predio, extras);
    onProgreso('Guardando Predio...');
    await this._clickBotonAccion(page, 'Guardar');

    /* Dirección del predio */
    const direccion = extras.direccion || this._buscarEn(datos.predio, 'DIRECCION', 'DIRECC');
    if (direccion) {
      onProgreso('Agregando dirección del predio...');
      await this._clickBotonAgregar(page);
      await this._llenarDireccion(page, direccion);
      await this._clickBotonAccion(page, 'Guardar');
    }

    /* --- Propietarios --- */
    onProgreso('Navegando a pestaña Propietarios...');
    await this._irAPestana(page, 'Propietarios');
    onProgreso('Agregando nuevo propietario...');
    await this._clickBotonAgregar(page);
    onProgreso('Llenando campos de Propietario...');
    await this._llenarCamposPropietarios(page, datos.propietarios, extras);
    onProgreso('Guardando Propietario...');
    await this._clickBotonAccion(page, 'Guardar');

    /* --- Fte Administrativa --- */
    onProgreso('Navegando a pestaña Fte Administrativa...');
    await this._irAPestana(page, 'Fte Administrativa');
    onProgreso('Abriendo modo edición...');
    const fteOk = await this._clickBotonAccion(page, 'Modifica');
    if (!fteOk) await this._clickBotonAgregar(page);
    onProgreso('Llenando campos de Fuente Administrativa...');
    await this._llenarCamposFuente(page, datos.fuente, extras);
    onProgreso('Guardando Fuente Administrativa...');
    await this._clickBotonAccion(page, 'Guardar');

    await this._guardarDiagnostico(page, `destino-${radicado}`);
    onProgreso('Migración completada. Revise en pantalla.');
  }

  /* ===================== NAVEGACIÓN ===================== */

  async _abrirTramite(page, radicado) {
    const timeout = this.config.browser.timeoutMs;
    const partes = this._partes(radicado);

    await page.goto(this.config.bandeja.url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    const ubicados = await page.evaluate(UBICAR_BUSQUEDA);
    if (!ubicados.anio || !ubicados.numero) {
      throw new Error(
        `No se ubicó el formulario de Radicación ` +
          `(año=${ubicados.anio}, número=${ubicados.numero}, ` +
          `estrategia=${ubicados.estrategia}).`
      );
    }
    this.logger.info(
      `Formulario ubicado (${ubicados.estrategia}): ids=${(ubicados.ids || []).join(', ')}`
    );

    // Poner valores directamente con JS (funciona incluso con campos disabled).
    await page.evaluate(({ anio, numero }) => {
      for (const campo of document.querySelectorAll('[data-robot-campo]')) {
        campo.removeAttribute('disabled');
        campo.removeAttribute('readonly');
      }
      const a = document.querySelector('[data-robot-campo="anio"]');
      const n = document.querySelector('[data-robot-campo="numero"]');
      if (a) { a.value = ''; a.value = anio; }
      if (n) { n.value = ''; n.value = numero; }
    }, partes);

    const campoAnio = page.locator('[data-robot-campo="anio"]');
    const campoNumero = page.locator('[data-robot-campo="numero"]');
    const puestos = {
      anio: await campoAnio.inputValue(),
      numero: await campoNumero.inputValue(),
    };
    if (puestos.anio !== partes.anio || puestos.numero !== partes.numero) {
      throw new Error(
        `Los datos no quedaron en su campo (AÑO="${puestos.anio}", NÚMERO="${puestos.numero}").`
      );
    }

    // Pulsar el botón de búsqueda de radicado (ID conocido y respaldos).
    await this._clickBuscarRadicado(page);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await this._cerrarAviso(page);

    // La búsqueda puede: (a) cargar el trámite directo -> aparecen pestañas; o
    // (b) mostrar una CUADRÍCULA de trámites donde hay que clicar el radicado
    // para abrir su formulario (el BandejaScraper trabaja igual sobre esta
    // misma página). Se cubren ambos casos.
    let cargado = await this._esperarPestanas(page, 8000);
    if (!cargado) {
      const abierto = await this._abrirDesdeCuadricula(page, radicado);
      if (abierto) {
        await this._cerrarAviso(page);
        cargado = await this._esperarPestanas(page, 10000);
      }
    }

    await this._guardarDiagnostico(page, `busqueda-${radicado}`);
    this.logger.info(
      `Trámite ${radicado} buscado (pestañas=${cargado ? 'sí' : 'NO'}). URL: ${page.url()}`
    );

    if (!cargado) {
      throw new Error(
        `La búsqueda de ${radicado} no cargó el trámite (no aparecieron las ` +
          `pestañas ni una cuadrícula con el radicado). ` +
          `Se guardó el HTML en la carpeta 'diagnostico'.`
      );
    }
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
   * Si la búsqueda mostró una cuadrícula de trámites, localiza la celda/enlace
   * cuyo texto (o value de botón) es exactamente el radicado y lo pulsa para
   * abrir su formulario.  Devuelve true si logró clicarlo.
   */
  async _abrirDesdeCuadricula(page, radicado) {
    const num = String(
      radicado && typeof radicado === 'object' ? `${radicado.anio}-${radicado.numero}` : radicado
    ).trim();

    for (const frame of page.frames()) {
      const marcado = await frame
        .evaluate((num) => {
          document
            .querySelectorAll('[data-robot-abrir]')
            .forEach((e) => e.removeAttribute('data-robot-abrir'));
          const norm = (t) => (t || '').replace(/\s+/g, '').trim();
          const objetivo = norm(num);
          const cands = Array.from(
            document.querySelectorAll(
              'a, input[type="submit"], input[type="button"], td, span, font, b'
            )
          );
          for (const el of cands) {
            const txt = el.tagName === 'INPUT' ? norm(el.value) : norm(el.textContent);
            if (txt === objetivo) {
              const click = el.closest('a') || el;
              click.setAttribute('data-robot-abrir', '1');
              return true;
            }
          }
          return false;
        }, num)
        .catch(() => false);

      if (marcado) {
        await frame
          .locator('[data-robot-abrir="1"]')
          .click({ timeout: 6000 })
          .catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        this.logger.info(`Radicado ${num} abierto desde la cuadrícula.`);
        return true;
      }
    }
    this.logger.warn(`No se encontró el radicado ${num} en una cuadrícula.`);
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

  /**
   * Sondea hasta `limiteMs` a que aparezca alguna pestaña del trámite (Predio,
   * Propietarios, ...). Devuelve true en cuanto encuentra una.
   */
  async _esperarPestanas(page, limiteMs) {
    const fin = Date.now() + limiteMs;
    while (Date.now() < fin) {
      for (const frame of page.frames()) {
        const hay = await frame
          .evaluate(MARCAR_PESTANA, { nombre: 'Predio' })
          .then((r) => r.encontrado)
          .catch(() => false);
        if (hay) return true;
      }
      await this._cerrarAviso(page);
      await page.waitForTimeout(600);
    }
    return false;
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

  async _clickBotonAgregar(page) {
    const botones = page.locator(
      'input[type="image"]:not([data-robot-campo="buscar"])'
    );
    const count = await botones.count();
    for (let i = 0; i < count; i++) {
      const btn = botones.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
        this.logger.info('Botón "+" (agregar) pulsado.');
        return true;
      }
    }
    this.logger.warn('Botón "+" no encontrado.');
    return false;
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

  async _llenarInput(page, etiqueta, valor, { indice = 0 } = {}) {
    if (!valor) return;
    const tag = `migrar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const info = await this._marcarCampo(page, etiqueta, tag, { indice });
    if (!info.encontrado) {
      this.logger.warn(`Campo "${etiqueta}" no encontrado.`);
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

      await locator.selectOption(mejor.value);
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      this.logger.info(`Select "${etiqueta}" = "${mejor.text}"`);
    } else {
      await locator.fill(String(valor));
      this.logger.info(`Input "${etiqueta}" = "${valor}"`);
    }
  }

  /* ===================== LLENADO POR SECCIÓN ===================== */

  async _llenarCamposPredio(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(page, 'Destino', extras.destino || buscar('DESTINO'));

    const matriculaRaw = extras.matriculaNumero || buscar('MATRICULA');
    if (extras.matriculaCirculo) {
      await this._llenarInput(page, 'Matricula', extras.matriculaCirculo, { indice: 0 });
      await this._llenarInput(page, 'Matricula', matriculaRaw, { indice: 1 });
    } else if (matriculaRaw && matriculaRaw.includes('-')) {
      const [circulo, numero] = matriculaRaw.split('-', 2);
      await this._llenarInput(page, 'Matricula', circulo, { indice: 0 });
      await this._llenarInput(page, 'Matricula', numero, { indice: 1 });
    } else if (matriculaRaw) {
      await this._llenarInput(page, 'Matricula', matriculaRaw);
    }

    await this._llenarInput(
      page,
      'Tipo Predio',
      extras.tipoPredio || buscar('TIPO PREDIO', 'TIPO DE PREDIO')
    );
  }

  async _llenarCamposPropietarios(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(
      page,
      'Tipo Dcto',
      extras.tipoDocumento || buscar('TIPO DOC', 'TIPO DCTO')
    );
    await this._llenarInput(page, 'Documento', extras.documento || buscar('DOCUMENTO'));
    await this._llenarInput(page, 'Tipo Derecho', extras.tipoDerecho || 'Dominio');
    await this._llenarInput(
      page,
      'Fraccion',
      extras.porcentaje || buscar('PORCENTAJE', 'FRACCION') || '1'
    );
    await this._llenarInput(page, 'Autoreconocimiento Etnico', 'Ninguno');

    const nombreCompleto = extras.nombre || buscar('NOMBRE');
    if (nombreCompleto) {
      const n = this._separarNombre(nombreCompleto);
      await this._llenarInput(page, '1er Nombre', n.primerNombre);
      await this._llenarInput(page, '2do Nombre', n.segundoNombre);
      await this._llenarInput(page, '1er Apellido', n.primerApellido);
      await this._llenarInput(page, '2do Apellido', n.segundoApellido);
    }

    await this._llenarInput(page, 'Sexo', extras.sexo || 'Masculino');
  }

  async _llenarCamposFuente(page, datosOrigen, extras) {
    const buscar = this._crearBuscador(datosOrigen);

    await this._llenarInput(page, 'Tipo Fuente', extras.tipoFuente || buscar('TIPO'));
    await this._llenarInput(page, 'Numero', extras.numeroFuente || buscar('NUMERO'));
    await this._llenarInput(page, 'Fecha', extras.fechaFuente || buscar('FECHA'));
    await this._llenarInput(
      page,
      'Ente Emisor',
      extras.enteEmisor || buscar('ENTE EMISOR', 'ENTE')
    );
    await this._llenarInput(
      page,
      'Fecha Inscripci',
      extras.fechaInscripcion || buscar('INSCRIPCION')
    );
  }

  async _llenarDireccion(page, direccion) {
    await this._llenarInput(page, 'Complemento', direccion);
    if (!(await this._tieneValor(page, 'Complemento'))) {
      await this._llenarInput(page, 'Nombre Predio', direccion);
    }
  }

  async _tieneValor(page, etiqueta) {
    const tag = `check-${Date.now()}`;
    const info = await this._marcarCampo(page, etiqueta, tag);
    if (!info.encontrado) return false;
    const val = await page.locator(`[data-robot-campo="${tag}"]`).inputValue().catch(() => '');
    return Boolean(val);
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
