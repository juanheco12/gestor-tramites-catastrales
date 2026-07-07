@echo off
rem Sincronizacion diaria de la bandeja de tramites (tarea programada 8:00 am).
rem Registra la salida en logs\tarea-programada.log
cd /d "C:\Users\Laptop HP 0100\Desktop\Proyectos\BandejaSyncService"
echo ============================================== >> "logs\tarea-programada.log"
echo Inicio: %date% %time% >> "logs\tarea-programada.log"
call npm run sync:cli >> "logs\tarea-programada.log" 2>&1
echo Fin: %date% %time% (codigo %errorlevel%) >> "logs\tarea-programada.log"
