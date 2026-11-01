/* Apps de sistema delegados ao Linux. A interface é só um Shell/Launcher: Dock e Atividades disparam os aplicativos NATIVOS
   (Nautilus, Terminal, GNOME Software, Configurações, Monitor, navegador padrão), cada um em sua própria janela do sistema. */
import path from 'node:path';
import {sh} from './system.js';
import {startDetached} from './browser.js';

export const SYSTEM_APPS = {
  files: {title: 'Nautilus', pkg: 'nautilus', icon: 'org.gnome.Nautilus',
    desktops: ['org.gnome.Nautilus.desktop', 'nautilus.desktop'], bins: ['nautilus']},
  terminal: {title: 'Terminal', pkg: 'gnome-terminal', icon: 'org.gnome.Terminal',
    desktops: ['org.gnome.Terminal.desktop', 'org.gnome.Console.desktop', 'org.kde.konsole.desktop', 'xfce4-terminal.desktop', 'xterm.desktop'],
    bins: ['gnome-terminal', 'kgx', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']},
  software: {title: 'Software', pkg: 'gnome-software', icon: 'org.gnome.Software', /* loja oficial do GNOME; no Ubuntu pode ser a Snap Store */
    desktops: ['org.gnome.Software.desktop', 'gnome-software.desktop', 'io.gnome.Software.desktop', 'snap-store_snap-store.desktop', 'ubuntu-software.desktop'],
    bins: ['gnome-software', 'snap-store']},
  settings: {title: 'Configurações', pkg: 'gnome-control-center', icon: 'org.gnome.Settings',
    desktops: ['org.gnome.Settings.desktop', 'gnome-control-center.desktop'], bins: ['gnome-control-center']},
  monitor: {title: 'Monitor do Sistema', pkg: 'gnome-system-monitor', icon: 'org.gnome.SystemMonitor',
    desktops: ['gnome-system-monitor.desktop', 'org.gnome.SystemMonitor.desktop'], bins: ['gnome-system-monitor']},
  browser: {title: 'Navegador', pkg: 'xdg-utils', icon: 'web-browser', /* o navegador PADRÃO do usuário (xdg-settings) */
    desktops: [], bins: ['x-www-browser', 'sensible-browser', 'firefox', 'chromium', 'chromium-browser', 'google-chrome']},
};

export function registerSystemAppRoutes(app, {findBin, findDesktopFile}) {
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({error: 'internal', message: e.message}); } };

  async function defaultBrowserDesktop() {
    const r = await sh('xdg-settings', ['get', 'default-web-browser'], {timeout: 3000});
    const id = r.ok ? r.stdout.trim() : '';
    return id && findDesktopFile(id) ? id : null;
  }
  /* Descobre COMO abrir: arquivo .desktop (preferido) ou executável. winId é o id usado para casar a janela real (Dock) e o ícone. */
  async function resolve(id) {
    const def = SYSTEM_APPS[id]; if (!def) return null;
    let desktop = id === 'browser' ? await defaultBrowserDesktop() : null;
    desktop = desktop || def.desktops.find(d => findDesktopFile(d)) || null;
    let bin = null;
    if (!desktop) for (const b of def.bins) { const p = findBin(b); if (p) { bin = p; break; } }
    return {id, def, desktop, bin, available: !!(desktop || bin), winId: desktop || (bin ? path.basename(bin) + '.desktop' : def.desktops[0] || `${id}.desktop`)};
  }
  const view = r => ({id: r.id, title: r.def.title, available: r.available, desktop: r.desktop, winId: r.winId, iconId: r.desktop, iconName: r.def.icon, pkg: r.def.pkg});

  app.get('/api/system-apps', wrap(async (_req, res) => {
    res.json(await Promise.all(Object.keys(SYSTEM_APPS).map(async id => view(await resolve(id)))));
  }));

  app.post('/api/system-apps/launch', wrap(async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (!r) return res.status(400).json({error: 'bad_request', message: 'Aplicativo de sistema desconhecido.'});
    if (!r.available) return res.status(501).json({error: 'not_installed', pkg: r.def.pkg, message: `${r.def.title} não está instalado. Instale com: sudo apt install ${r.def.pkg} (ou rode ./setup-environment.sh).`});
    const attempts = [];
    if (r.desktop) {
      const f = findDesktopFile(r.desktop), gio = findBin('gio'), gtk = findBin('gtk-launch');
      if (gio) attempts.push(['gio launch', gio, ['launch', f]]);
      if (gtk) attempts.push(['gtk-launch', gtk, [r.desktop.replace(/\.desktop$/, '')]]);
      if (!attempts.length) return res.status(501).json({error: 'no_launcher', message: 'Instale libglib2.0-bin (gio) ou libgtk-3-bin (gtk-launch), ou rode ./setup-environment.sh.'});
    }
    const fallbackBin = r.bin || r.def.bins.map(findBin).find(Boolean);
    if (fallbackBin) attempts.push(['executável', fallbackBin, []]);
    let last = '';
    for (const [via, cmd, args] of attempts) {
      const o = await startDetached(cmd, args);
      if (o.ok) return res.json({ok: true, via, winId: r.winId});
      last = o.error || last;
    }
    res.status(500).json({error: 'command_failed', message: `Falha ao abrir ${r.def.title}: ${last || 'erro desconhecido'}`});
  }));
}
