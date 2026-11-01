import {app, BrowserWindow, dialog, shell} from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork, spawn} from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const URL_APP = `http://127.0.0.1:${PORT}`;

let serverProcess = null;
let mainWindow = null;

/* O desktop precisa ser carregado pelo servidor local (http://127.0.0.1:PORT). Antes a janela usava loadFile(dist/index.html):
   em file:// as chamadas /api/* e o WebSocket do Terminal não têm servidor e tudo falhava. */
function startServer() {
  const serverPath = path.join(ROOT, 'server.js');
  const env = {...process.env, NODE_ENV: 'production', PORT: String(PORT)};
  /* Empacotado: usa o runtime do Electron (o electron-builder recompila o node-pty para ele).
     Em desenvolvimento: usa o Node do sistema, que é o ABI para o qual `npm run setup:terminal` compila o node-pty. */
  serverProcess = app.isPackaged
    ? fork(serverPath, [], {env, silent: false})
    : spawn(process.env.NODE_BIN || 'node', [serverPath], {env, stdio: 'inherit'});
  serverProcess.on('error', err => console.error('Erro ao iniciar o server.js:', err));
  serverProcess.on('exit', code => { serverProcess = null; if (code && !app.isQuitting) console.error(`server.js terminou com código ${code}`); });
}

/* Espera o servidor responder (e confirma que é o NOSSO servidor: se a porta já estiver ocupada por outro app, o server.js sai). */
async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!serverProcess) return false;
    try { const r = await fetch(`${URL_APP}/api/health`); if (r.ok && (await r.json()).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function stopServer() { if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; } }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 520, show: false, title: 'Interface', backgroundColor: '#17112f',
    /* A página só fala com o servidor local por HTTP/WebSocket: não precisa de Node no renderer.
       (Antes: nodeIntegration:true + contextIsolation:false — qualquer falha de XSS viraria execução de código na máquina.) */
    webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true},
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  /* Links externos abrem no navegador do sistema, nunca dentro da janela do desktop. */
  mainWindow.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return {action: 'deny'}; });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL_APP)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(URL_APP);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    startServer();
    if (!(await waitForServer())) {
      dialog.showErrorBox('Interface', `Não foi possível iniciar o servidor local em ${URL_APP}.\nVerifique se a porta ${PORT} está livre (ou defina PORT) e se rodou "npm install" e "npm run build".`);
      stopServer(); app.quit(); return;
    }
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('before-quit', () => { app.isQuitting = true; stopServer(); }); /* antes o servidor só era encerrado em window-all-closed */
  app.on('window-all-closed', () => app.quit());
}
