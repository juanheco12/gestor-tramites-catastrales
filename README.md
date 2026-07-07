# Sincronizador de Bandeja

Módulo de sincronización automática de trámites catastrales. Lee la bandeja de
trámites del aplicativo web de catastro con Playwright y la persiste en SQLite,
detectando registros nuevos y cambios campo a campo.

## Arquitectura

```
src/
├── main/                  Proceso principal de Electron
│   ├── main.js            Ciclo de vida de la app y ventana
│   ├── contenedor.js      Composition root (inyección de dependencias)
│   ├── ipc.js             Canales IPC (única frontera UI <-> servicios)
│   └── preload.js         Puente seguro (contextIsolation + sandbox)
├── renderer/              Interfaz gráfica (sin acceso a Node)
├── services/
│   ├── BandejaSyncService.js  Orquestador (eventos de progreso, reintentos, log)
│   ├── BrowserManager.js      Playwright con sesión persistente y login manual
│   ├── BandejaScraper.js      Extracción de la tabla (mapeo dinámico de columnas)
│   └── SyncEngine.js          Diff insert/update en una transacción
├── database/
│   ├── Database.js            Conexión SQLite (better-sqlite3, WAL)
│   ├── schema.sql             Esquema (tramites, historial, sync_logs)
│   └── repositories/          Todo el SQL vive aquí
├── utils/                 Logger a archivo y reintentos con backoff
└── cli/sync.js            Sincronización por consola (sin UI)
```

**Separación estricta:** la UI solo conoce `window.bandejaApi` (preload). Los
servicios no conocen Electron: la CLI (`npm run sync:cli`) usa exactamente la
misma lógica sin interfaz gráfica.

## Reglas de sincronización

- Trámite **nuevo** → se inserta.
- Trámite **existente** → se actualizan *solo* los campos modificados y cada
  cambio queda en `tramites_historial`. Si cambia el estado, se guardan
  `estado_anterior` y `fecha_cambio_estado`.
- Trámite que **desaparece de la bandeja** → se marca `presente_en_bandeja = 0`.
  **Nunca se elimina un registro.**
- Columnas de la web que no mapean a un campo conocido se conservan en
  `datos_extra` (JSON).
- Todo el lote se aplica en **una transacción**: o entra completo o no entra.
- Cada corrida queda registrada en `sync_logs` (fecha, duración, nuevos,
  actualizados, errores) y en archivos `logs/sync-AAAA-MM-DD.log`.

## Sesión del navegador

Playwright usa un **contexto persistente** (`data/browser-session`): las
cookies sobreviven entre ejecuciones. Flujo:

1. La sincronización corre headless (sin ventana de navegador).
2. Si la sesión expiró, se abre un navegador **visible** para que usted inicie
   sesión manualmente (hasta 5 minutos, configurable).
3. Al detectar la bandeja, la sesión queda guardada y las siguientes corridas
   vuelven a ser headless.

## Instalación

```bash
npm install          # instala dependencias y recompila better-sqlite3 para Electron
npx playwright install chromium
```

## Configuración obligatoria

Edite `config/app.config.json`:

- `bandeja.url` — URL de la bandeja de trámites de su aplicativo.
- `bandeja.selectors` — selectores CSS de la tabla, filas, encabezados,
  indicador de login y botón "siguiente" del paginador.
- `bandeja.columnas` — alias de los encabezados reales de la tabla web para
  cada campo (`numero_tramite` es obligatorio; la comparación ignora tildes y
  mayúsculas).

## Uso

```bash
npm start            # abre la app; botón "Sincronizar Bandeja"
npm run sync:cli     # sincroniza por consola (para tareas programadas)
```

## Manejo de errores

- La fase navegación+extracción se reintenta (3 intentos, backoff exponencial
  2 s → 4 s → 8 s, configurable en `sync`).
- Errores no reintentables (login cancelado, configuración inválida) abortan de
  inmediato con mensaje claro.
- Toda corrida, exitosa o fallida, queda en `sync_logs` con el detalle de
  errores en JSON.

## Instalación para otro ejecutor

Cada ejecutor usa su propia copia del módulo, con su propia sesión del
aplicativo y su propia bitácora. En el equipo del nuevo ejecutor:

1. Copiar la carpeta completa `BandejaSyncService` (sin `data/` ni `logs/`,
   que son personales) a su equipo, p. ej. `C:\BandejaSyncService`.
2. Instalar Node.js (LTS) si no lo tiene: https://nodejs.org
3. En una terminal dentro de la carpeta:
   ```bash
   npm install
   npx playwright install chromium
   ```
4. Editar `config/app.config.json`:
   - `bitacora.xlsxPath` → la ruta de la bitácora Excel de ESE ejecutor
     (o eliminar la sección `bitacora` si no usa bitácora).
5. Ajustar la ruta del proyecto en `scripts/sync-diario.cmd` y registrar la
   tarea de las 8:00 con PowerShell (ver más abajo) si quiere sincronización
   automática.
6. `npm start` → **Sincronizar Bandeja** → iniciar sesión con SU usuario del
   aplicativo. La sesión queda guardada para ese equipo.

La primera sincronización llenará su base de datos con los trámites de SU
bandeja (el aplicativo muestra a cada usuario solo lo suyo).

**Varios perfiles en un mismo equipo:** la variable de entorno
`BANDEJA_CONFIG` permite usar archivos de configuración distintos (uno por
ejecutor, cada uno con su `dbPath`, `userDataDir` y `bitacora.xlsxPath`
propios):

```powershell
$env:BANDEJA_CONFIG = "C:\configs\maria.config.json"; npm start
```

## Integración con otro proyecto

Para usar la base de datos de su sistema de gestión catastral en lugar de la
propia, cambie `app.dbPath` en la configuración: el esquema se crea con
`CREATE TABLE IF NOT EXISTS` y no toca tablas existentes.
