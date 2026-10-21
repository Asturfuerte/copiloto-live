# Matilde Sync (Windows)

Vigila la carpeta `Matilde` del PC y sube a Copiloto Live cualquier documento nuevo o modificado (pdf, docx, md, txt). Se deja el fichero en la carpeta y en unos segundos el copiloto ya lo puede consultar (si es un escaneo, el servidor le pasa OCR, ~8 s por página).

## Estructura

- `Matilde\` → solo los ficheros del usuario.
- `Matilde\no tocar\` → el programa (`matilde-sync.ps1`), el lanzador (`ARRANCAR MATILDE SYNC.bat`), la configuración (`matilde-sync.json`), el registro (`matilde-sync.log`) y el estado.

## Instalación

1. Crear `Escritorio\Matilde\no tocar` y copiar dentro `matilde-sync.ps1`, `ARRANCAR MATILDE SYNC.bat` y `matilde-sync.ejemplo.json` renombrado a `matilde-sync.json` con la `url` y el `pin` del cliente.
2. Doble clic en `ARRANCAR MATILDE SYNC.bat`. Se abre una ventana que vigila la carpeta; el lanzador se copia solo al Inicio de Windows, así que a partir del siguiente encendido arranca sin hacer nada.

## Detalles

- Al arrancar (y cada 5 minutos) ordena la carpeta: mueve sus propios ficheros a `no tocar`, elimina restos (textos OCR, antigua subcarpeta `subir`) y deja en la raíz solo lo del usuario.
- Guarda en `matilde-sync.estado.json` lo que ya subió; solo vuelve a subir un fichero si cambia.
- Espera a que un fichero deje de crecer antes de subirlo (descargas y copias en curso).
- Si un fichero falla, lo apunta en `matilde-sync.log` y no lo reintenta hasta que cambie.
- `borrarRemoto: true` hace que, al quitar un fichero de la carpeta, también se borre en Copiloto Live. Por defecto está desactivado.
- Las subcarpetas no se vigilan.
