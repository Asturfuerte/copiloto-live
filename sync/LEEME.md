# Matilde Sync (Windows)

Vigila una carpeta del PC y sube a Copiloto Live cualquier documento nuevo o modificado (pdf, docx, md, txt). No hace falta abrir la web ni pedírselo a nadie: se deja el fichero en la carpeta y en unos segundos el copiloto ya lo puede consultar (si es un escaneo, el servidor le pasa OCR y tarda ~1 s por página).

## Instalación

1. Copiar `matilde-sync.ps1`, `matilde-sync.bat` y `matilde-sync.ejemplo.json` a una carpeta del PC (por ejemplo `Escritorio\Matilde`).
2. Renombrar `matilde-sync.ejemplo.json` a `matilde-sync.json` y poner la `url` del cliente, su `pin` y la `carpeta` a vigilar.
3. Doble clic en `matilde-sync.bat`. La ventana muestra lo que va subiendo; se cierra con Ctrl+C o cerrando la ventana.

## Arranque automático con Windows

Win+R → `shell:startup` → Enter → crear ahí un acceso directo a `matilde-sync.bat`. A partir de entonces arranca solo al iniciar sesión.

## Detalles

- Guarda en `matilde-sync.estado.json` lo que ya subió; solo vuelve a subir un fichero si cambia.
- Espera a que un fichero deje de crecer antes de subirlo (descargas y copias en curso).
- Si un fichero falla (p. ej. PDF ilegible), lo apunta en `matilde-sync.log` y no lo reintenta hasta que cambie.
- `borrarRemoto: true` hace que, al quitar un fichero de la carpeta, también se borre en Copiloto Live. Por defecto está desactivado.
- Las subcarpetas no se vigilan.
