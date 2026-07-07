'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { ErrorNoReintentable, esperar } = require('../utils/retry');

/**
 * Administra el navegador Playwright con contexto persistente:
 * cookies y almacenamiento quedan en disco (userDataDir), por lo que la
 * sesión del aplicativo de catastro se reutiliza entre ejecuciones.
 *
 * Estrategia de login:
 *  1. Se navega a la bandeja en modo headless.
 *  2. Si aparece el indicador de login (sesión vencida), se relanza el
 *     navegador VISIBLE para que el usuario inicie sesión manualmente.
 *  3. Al detectar la tabla de la bandeja, la sesión queda persistida y
 *     las siguientes sincronizaciones vuelven a ser headless.
 */
class BrowserManager {
  /**
   * @param {object} config Configuración completa de la app
   * @param {import('../utils/logger').Logger} logger
   */
  constructor(config, logger, credencialesService = null) {
    this.config = config;
    this.logger = logger;
    this.credenciales = credencialesService;
    this.context = null;
    this.headlessActual = null;
    // true cuando el contexto actual ya tiene sesión iniciada: en ese caso
    // NUNCA se relanza el navegador (el aplicativo usa cookies de sesión que
    // mueren al cerrar el navegador; relanzar significaría pedir login otra vez).
    this.sesionValidada = false;
    // Copia de las cookies de la última sesión válida: el perfil persistente
    // no conserva cookies de sesión entre ejecuciones, así que se restauran
    // manualmente (si el servidor aún las acepta, se ahorra el login).
    this.rutaCookies = path.join(path.dirname(this.config.browser.userDataDir), 'session-cookies.json');
  }

  /**
   * @param {boolean} headless
   * @returns {Promise<import('playwright').BrowserContext>}
   */
  async _lanzar(headless) {
    if (this.context && (this.headlessActual === headless || this.sesionValidada)) {
      return this.context;
    }
    await this.cerrar();

    this.logger.info(`Lanzando navegador (headless=${headless})`);
    try {
      this.context = await chromium.launchPersistentContext(this.config.browser.userDataDir, {
        headless,
        viewport: { width: 1366, height: 768 },
      });
    } catch (error) {
      if (error.message.includes("Executable doesn't exist")) {
        throw new ErrorNoReintentable(
          'Falta el navegador de Playwright. Abra una terminal en la carpeta del ' +
          'proyecto y ejecute: npx playwright install chromium — luego vuelva a sincronizar.'
        );
      }
      throw error;
    }
    this.headlessActual = headless;

    try {
      if (fs.existsSync(this.rutaCookies)) {
        await this.context.addCookies(JSON.parse(fs.readFileSync(this.rutaCookies, 'utf8')));
      }
    } catch (error) {
      this.logger.warn(`No se pudieron restaurar las cookies de sesión: ${error.message}`);
    }

    return this.context;
  }

  /** Guarda las cookies actuales para intentar reutilizar la sesión en la próxima ejecución. */
  async _guardarCookies() {
    try {
      const cookies = await this.context.cookies();
      fs.writeFileSync(this.rutaCookies, JSON.stringify(cookies), 'utf8');
    } catch (error) {
      this.logger.warn(`No se pudieron guardar las cookies de sesión: ${error.message}`);
    }
  }

  /**
   * Devuelve una página posicionada en la bandeja, con sesión iniciada.
   * Lanza ErrorNoReintentable si el usuario no completa el login manual.
   *
   * @param {{interactivo?: boolean}} [opciones] interactivo=false para
   *   sincronizaciones automáticas: corre oculto y NUNCA abre ventanas;
   *   si la sesión venció, falla con un mensaje claro.
   * @returns {Promise<import('playwright').Page>}
   */
  async abrirBandejaAutenticada({ interactivo = true } = {}) {
    const { url, selectors, loginManualTimeoutMs } = this.config.bandeja;
    const timeout = this.config.browser.timeoutMs;

    const headlessInicial = interactivo ? this.config.browser.headless : true;
    let context = await this._lanzar(headlessInicial);
    let page = context.pages()[0] || (await context.newPage());

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    if (!(await this._requiereLogin(page))) {
      this.sesionValidada = true;
      await this._guardarCookies();
      return page;
    }

    // Sesión vencida: primero intentar el login AUTOMÁTICO con las
    // credenciales guardadas (cifradas), sin mostrar ninguna ventana.
    const credencialesGuardadas = this.credenciales ? this.credenciales.obtener() : null;
    if (credencialesGuardadas) {
      this.logger.info('Sesión vencida: iniciando sesión automáticamente...');
      const exito = await this._loginAutomatico(page, credencialesGuardadas);
      if (exito) {
        this.logger.info('Login automático exitoso.');
        this.sesionValidada = true;
        await this._guardarCookies();
        return page;
      }
      this.logger.warn('El login automático falló (¿clave cambiada?); se requiere login manual.');
    }

    {
      if (!interactivo) {
        throw new ErrorNoReintentable(
          credencialesGuardadas
            ? 'El login automático falló: verifique sus credenciales guardadas con el botón Acceso edis.'
            : 'La sesión expiró y no hay credenciales guardadas. Use el botón Acceso edis para guardarlas y no volver a iniciar sesión a mano.'
        );
      }
      if (!this.config.browser.navegadorVisibleParaLogin) {
        throw new ErrorNoReintentable(
          'La sesión expiró y el login visible está deshabilitado en la configuración.'
        );
      }

      this.logger.warn('Sesión no iniciada. Abriendo navegador visible para login manual.');
      context = await this._lanzar(false);
      page = context.pages()[0] || (await context.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

      const exito = await this._esperarLoginManual(page);
      if (!exito) {
        throw new ErrorNoReintentable(
          `Login manual no completado en ${Math.round(loginManualTimeoutMs / 60000)} minutos. ` +
          'Vuelva a sincronizar e inicie sesión en la ventana del navegador.'
        );
      }
      this.logger.info('Login manual completado. La sesión quedó persistida.');
    }

    this.sesionValidada = true;
    await this._guardarCookies();
    return page;
  }

  /**
   * Espera a que el usuario inicie sesión en el navegador visible SIN tocar
   * su pestaña mientras lo hace. Cada ciclo sondea la bandeja con una
   * petición HTTP que comparte las cookies del navegador pero no recarga
   * ninguna página: mientras el servidor siga redirigiendo (302) o sirviendo
   * la pantalla de login, se sigue esperando. Solo cuando el servidor entrega
   * la bandeja de verdad se navega la pestaña del usuario.
   *
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>} true si la bandeja quedó visible
   */
  async _esperarLoginManual(page) {
    const { url, selectors, loginManualTimeoutMs } = this.config.bandeja;
    const timeout = this.config.browser.timeoutMs;
    const rutaEsperada = new URL(url).pathname.toLowerCase();
    const limite = Date.now() + loginManualTimeoutMs;

    while (Date.now() < limite) {
      await esperar(3000);

      // ¿El usuario llegó por su cuenta hasta la bandeja?
      try {
        const rutaActual = new URL(page.url()).pathname.toLowerCase();
        if (rutaActual === rutaEsperada) {
          await page.waitForSelector(selectors.tabla, { timeout, state: 'visible' });
          return true;
        }
      } catch {
        continue; // página en plena navegación; reintentar en el próximo ciclo
      }

      // Sondeo silencioso: pide la bandeja por HTTP con las cookies actuales.
      try {
        const respuesta = await page
          .context()
          .request.get(url, { maxRedirects: 0, timeout });
        if (respuesta.status() !== 200) continue; // 302 => aún sin sesión

        // Algunos aplicativos sirven la pantalla de login con 200 en la
        // misma URL: si el cuerpo trae el indicador de login, no hay sesión.
        const cuerpo = await respuesta.text();
        if (cuerpo.includes('ImgIniciarSesion') || cuerpo.includes("type='password'") || cuerpo.includes('type="password"')) {
          continue;
        }
      } catch {
        continue;
      }

      // Sesión confirmada por el servidor: recién ahora se navega la pestaña.
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        if (new URL(page.url()).pathname.toLowerCase() === rutaEsperada) {
          await page.waitForSelector(selectors.tabla, { timeout, state: 'visible' });
          return true;
        }
      } catch (error) {
        this.logger.debug(`Aún sin sesión válida: ${error.message}`);
      }
    }

    return false;
  }

  /**
   * Inicia sesión en el aplicativo escribiendo las credenciales guardadas
   * en el formulario de login (todo oculto, sin ventanas).
   *
   * @param {import('playwright').Page} page
   * @param {{usuario: string, clave: string}} credenciales
   * @returns {Promise<boolean>} true si la bandeja quedó accesible
   */
  async _loginAutomatico(page, credenciales) {
    const { url, selectors } = this.config.bandeja;
    const login = selectors.login || {};
    const timeout = this.config.browser.timeoutMs;

    try {
      const urlLogin = login.url || new URL('/login.aspx', url).toString();
      await page.goto(urlLogin, { waitUntil: 'domcontentloaded', timeout });

      const campoUsuario = page.locator(login.usuario || "input[type='text']").first();
      const campoClave = page.locator(login.clave || "input[type='password']").first();
      await campoUsuario.waitFor({ state: 'visible', timeout: 10000 });
      await campoUsuario.fill(credenciales.usuario);
      await campoClave.fill(credenciales.clave);
      await page.locator(login.entrar || "input[type='submit'][value*='NTRAR']").first().click();

      // Esperar el postback y verificar contra el servidor que hay sesión.
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
      await esperar(1500);

      const respuesta = await page
        .context()
        .request.get(url, { maxRedirects: 0, timeout })
        .catch(() => null);
      if (!respuesta || respuesta.status() !== 200) return false;

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return new URL(page.url()).pathname.toLowerCase() === new URL(url).pathname.toLowerCase();
    } catch (error) {
      this.logger.warn(`Login automático interrumpido: ${error.message.split('\n')[0]}`);
      return false;
    }
  }

  /** @param {import('playwright').Page} page */
  async _requiereLogin(page) {
    const { selectors } = this.config.bandeja;

    // Señal más confiable en aplicativos ASP.NET: si al pedir la bandeja el
    // servidor redirige a otra página (p. ej. Default.aspx), no hay sesión.
    const rutaEsperada = new URL(this.config.bandeja.url).pathname.toLowerCase();
    const rutaActual = new URL(page.url()).pathname.toLowerCase();
    if (rutaActual !== rutaEsperada) {
      this.logger.info(`Redirigido de ${rutaEsperada} a ${rutaActual}: se requiere login.`);
      return true;
    }
    // Carrera: lo que aparezca primero decide (tabla => sesión válida).
    // Cada promesa captura su propio timeout para que la perdedora no
    // genere un unhandled rejection cuando expire después de la carrera.
    const esperarSelector = (selector, etiqueta) =>
      page
        .waitForSelector(selector, { timeout: this.config.browser.timeoutMs, state: 'visible' })
        .then(() => etiqueta)
        .catch(() => null);

    const resultado = await Promise.race([
      esperarSelector(selectors.tabla, 'bandeja'),
      esperarSelector(selectors.indicadorLogin, 'login'),
    ]);

    if (resultado === null) {
      // Ninguno apareció: tratarlo como sesión inválida para forzar login visible.
      this.logger.warn('No se detectó ni la bandeja ni el formulario de login; se asume sesión vencida.');
      return true;
    }

    return resultado === 'login';
  }

  async cerrar() {
    if (this.context) {
      try {
        await this.context.close();
      } catch (error) {
        this.logger.warn(`Error al cerrar el navegador: ${error.message}`);
      }
      this.context = null;
      this.headlessActual = null;
      this.sesionValidada = false;
    }
  }
}

module.exports = { BrowserManager };
