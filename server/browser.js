/* Abertura de URLs no navegador PADRÃO do sistema (janela/aba nativa, fora desta interface).
   A interface não carrega mais páginas externas em iframe (bloqueadas por X-Frame-Options/CSP em muitos sites).
   Ordem: xdg-open → gio open, sem shell, em segundo plano. (`gio launch` só serve para arquivos .desktop e é usado para abrir apps.) */
import {spawn} from 'node:child_process';

/* Inicia em segundo plano e espera um instante por falha imediata (comando ausente / código ≠ 0). */
export function startDetached(cmd, args = []) {
  return new Promise(resolve => {
    let done = false; const end = v => { if (!done) { done = true; resolve(v); } };
    let c; try { c = spawn(cmd, args, {detached: true, stdio: ['ignore', 'ignore', 'pipe']}); } catch (e) { return end({ok: false, missing: e.code === 'ENOENT', error: e.message}); }
    let err = ''; c.stderr?.on('data', d => { if (err.length < 400) err += d; });
    c.on('error', e => end({ok: false, missing: e.code === 'ENOENT', error: e.message}));
    c.on('exit', code => end(code === 0 ? {ok: true} : {ok: false, error: err.trim().split('\n')[0] || `código ${code}`}));
    setTimeout(() => { c.stderr?.destroy(); c.unref(); end({ok: true}); }, 1500).unref?.(); /* ainda rodando = o app abriu */
  });
}

export const parseHttpUrl = raw => {
  const s = String(raw || '');
  if (!s || s.length > 2048 || /[\s\0-\x1f]/.test(s)) return null;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname ? u : null; } catch { return null; }
};

export function registerBrowserRoutes(app, {findBin}) {
  app.post('/api/open-url', async (req, res) => {
    const u = parseHttpUrl(req.body?.url);
    if (!u) return res.status(400).json({error: 'bad_request', message: 'Informe uma URL http(s) válida.'});
    const tries = [['xdg-open', [u.href]], ['gio', ['open', u.href]]];
    let last = null;
    for (const [name, args] of tries) {
      const bin = findBin(name); if (!bin) continue;
      const r = await startDetached(bin, args);
      if (r.ok) return res.json({ok: true, via: name === 'gio' ? 'gio open' : name});
      last = r.error;
    }
    if (last) return res.status(500).json({error: 'command_failed', message: `Não foi possível abrir o navegador: ${last}`});
    res.status(501).json({error: 'not_installed', message: 'Nem xdg-open nem gio foram encontrados (sudo apt install xdg-utils libglib2.0-bin ou rode ./setup-environment.sh).'});
  });
}
