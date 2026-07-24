import { Printer } from "lucide-react";

/**
 * Botón flotante "Imprimir / PDF" — abre una nueva ventana con el análisis
 * completo y dispara el diálogo de impresión (AirPrint / Guardar PDF en iPhone).
 *
 * Abre una ventana independiente para funcionar también cuando el frontend se
 * publica dentro de un iframe, donde window.print() puede estar restringido.
 */
export function PrintFab({ label = "Imprimir / PDF" }: { label?: string }) {
  const handlePrint = () => {
    try {
      // Capturar el HTML del análisis (todo el body de la página predictor)
      const main = document.querySelector("main") || document.body;
      const cloned = main.cloneNode(true) as HTMLElement;

      // Quitar elementos no imprimibles del clon
      cloned.querySelectorAll(".no-print, .print-fab, button, [data-sidebar], header").forEach((el) => el.remove());

      // Capturar los <style> del documento (Tailwind compilado + variables CSS)
      const styles = Array.from(document.querySelectorAll("style, link[rel=stylesheet]"))
        .map((el) => el.outerHTML)
        .join("\n");

      const html = `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>CourtEdge — Análisis de Partido</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
${styles}
<style>
  /* Forzar tema claro para impresión */
  html, body {
    background: white !important;
    color: black !important;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 12px;
    margin: 0;
  }
  * { color: black !important; border-color: #999 !important; box-shadow: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .text-green-400,.text-green-500,.text-emerald-400,.text-emerald-500{color:#15803d !important}
  .text-yellow-400,.text-yellow-500,.text-amber-400,.text-amber-500{color:#b45309 !important}
  .text-red-400,.text-red-500{color:#b91c1c !important}
  .text-blue-400,.text-blue-500{color:#1d4ed8 !important}
  .text-purple-400,.text-purple-500{color:#6d28d9 !important}
  [class*="rounded-"], .card { break-inside: avoid; page-break-inside: avoid; border: 1px solid #999 !important; margin-bottom: 8px; padding: 8px !important; background: white !important; }
  button { display: none !important; }
  input, textarea, select { border: 1px solid #999 !important; background: white !important; color: black !important; }
  .print-toolbar { display: flex; gap: 8px; padding: 8px 0; border-bottom: 2px solid #333; margin-bottom: 12px; position: sticky; top: 0; background: white; z-index: 10; }
  .print-toolbar button { display: inline-flex !important; padding: 10px 16px; background: #1d4ed8; color: white !important; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; }
  .print-toolbar button.secondary { background: #6b7280; }
  @media print {
    .print-toolbar { display: none !important; }
    @page { margin: 12mm; }
  }
</style>
</head>
<body>
  <div class="print-toolbar">
    <button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
    <button class="secondary" onclick="window.close()">Cerrar</button>
  </div>
  ${cloned.innerHTML}
  <script>
    // Auto-disparar print después de cargar (con pequeño delay para que el iPhone renderice)
    window.addEventListener('load', () => {
      setTimeout(() => { try { window.print(); } catch(e) {} }, 600);
    });
  </script>
</body>
</html>`;

      // Abrir en nueva ventana/pestaña de nivel superior
      const w = window.open("", "_blank");
      if (!w) {
        alert("El navegador bloqueó la ventana. Permite pop-ups para este sitio e intenta de nuevo.");
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } catch (err: any) {
      alert("Error al preparar la impresión: " + (err?.message || err));
    }
  };

  return (
    <button
      className="print-fab"
      onClick={handlePrint}
      data-testid="btn-print-fab"
      title="Imprime o guarda como PDF el análisis completo de este partido"
    >
      <Printer className="w-4 h-4" /> {label}
    </button>
  );
}
