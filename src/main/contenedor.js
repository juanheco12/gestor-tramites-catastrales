'use strict';

const { cargarConfig } = require('../config/config');
const { obtenerLogger } = require('../utils/logger');
const { obtenerDatabase } = require('../database/Database');
const { TramiteRepository } = require('../database/repositories/TramiteRepository');
const { SyncLogRepository } = require('../database/repositories/SyncLogRepository');
const { GestionRepository } = require('../database/repositories/GestionRepository');
const { ImportService } = require('../services/ImportService');
const { CredencialesService } = require('../services/CredencialesService');
const { BandejaSyncService } = require('../services/BandejaSyncService');
const { ExportService } = require('../services/ExportService');
const { BitacoraService } = require('../services/BitacoraService');

/**
 * Contenedor de dependencias (composition root).
 * Único lugar donde se construye el grafo de objetos; el resto del código
 * recibe sus dependencias por constructor, lo que facilita pruebas y cambios.
 */
function crearContenedor() {
  const config = cargarConfig();
  const logger = obtenerLogger(config.app.logsDir);
  const database = obtenerDatabase(config.app.dbPath);

  const tramiteRepository = new TramiteRepository(database);
  const syncLogRepository = new SyncLogRepository(database);
  const gestionRepository = new GestionRepository(database);

  const bitacoraService = new BitacoraService(tramiteRepository, config, logger);
  const credencialesService = new CredencialesService(config, logger);

  const syncService = new BandejaSyncService({
    config,
    logger,
    database,
    tramiteRepository,
    syncLogRepository,
    bitacoraService,
    gestionRepository,
    credencialesService,
  });

  const exportService = new ExportService(tramiteRepository, config, logger, gestionRepository);
  const importService = new ImportService(database, tramiteRepository, gestionRepository, config, logger);

  return {
    bitacoraService,
    gestionRepository,
    importService,
    credencialesService,
    config,
    logger,
    database,
    tramiteRepository,
    syncLogRepository,
    syncService,
    exportService,
  };
}

module.exports = { crearContenedor };
