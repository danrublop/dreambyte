// Pure (no electron import) so vitest can load it in CI, where the Electron binary is absent.
/** Standalone page for the direct link and iframe embed: loads player.js + manifest.json from the same folder. */
export function buildPublishedIndexHtml(title: string): string {
  const safeTitle = title.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>html,body,#dreambyte-player{margin:0;width:100%;height:100%;background:#000}</style>
</head>
<body>
<div id="dreambyte-player"></div>
<script src="player.js"></script>
<script>
  new DreambyteStudioPlayer(document.getElementById('dreambyte-player'), { autoplay: true }).load('manifest.json');
</script>
</body>
</html>
`
}
