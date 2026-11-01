import {useCallback, useEffect, useRef, useState} from 'react';
import {Wifi, Globe, Bluetooth, BluetoothConnected, Monitor, Volume2, VolumeX, Mic, MicOff, Zap, Palette, Info, Lock, SignalHigh, SignalMedium, SignalLow, Power, Sun, Moon, Plus, RefreshCw, Chrome, Settings as SettingsIcon, Cable, MonitorOff, Rocket, Scale, Leaf, AlertCircle, Check} from 'lucide-react';
import {api, post, formatBytes, WALLPAPERS} from './utils';

/* Estilos em src/index.css (classes .ss-*). O projeto NÃO usa Tailwind.
   Wi-Fi, Rede, Bluetooth, Monitores, Som e Energia usam dados e controles REAIS (rotas /api/sys/* em server/system.js). */

const TABS = [
  {id: 'wifi', icon: Wifi, label: 'Wi-Fi'},
  {id: 'network', icon: Globe, label: 'Rede'},
  {id: 'bluetooth', icon: Bluetooth, label: 'Bluetooth'},
  {id: 'monitors', icon: Monitor, label: 'Monitores'},
  {id: 'sound', icon: Volume2, label: 'Som'},
  {id: 'energy', icon: Zap, label: 'Energia'},
  {id: 'appearance', icon: Palette, label: 'Aparência'},
  {id: 'interface', icon: SettingsIcon, label: 'Interface'},
  {id: 'general', icon: Info, label: 'Geral'},
];
const SIGNAL = n => (n >= 70 ? SignalHigh : n >= 40 ? SignalMedium : SignalLow);

/* ---------- Infra compartilhada pelas abas ---------- */

/* Carrega uma rota; `every` (ms) atualiza periodicamente enquanto a aba está visível. */
function useLoad(url, every = 0) {
  const [s, setS] = useState({data: null, error: '', loading: true});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback((override, silent) => {
    if (!silent) setS(x => ({...x, loading: true}));
    return api(typeof override === 'string' ? override : url)
      .then(d => alive.current && setS({data: d, error: '', loading: false}))
      .catch(e => alive.current && setS(x => ({data: silent ? x.data : null, error: e.message, loading: false})));
  }, [url]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => { if (!document.hidden) reload(undefined, true); }, every);
    return () => clearInterval(t);
  }, [every, reload]);
  return {...s, reload, setData: d => setS(x => ({...x, data: d}))};
}

/* Executa uma ação; mostra erro amigável (comando ausente, sem permissão…) em vez de quebrar a aba. */
function useAction(reload) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const run = useCallback(async (key, fn, okText) => {
    setBusy(key); setMsg(null);
    try { const r = await fn(); await reload(undefined, true); if (okText) setMsg({ok: true, text: okText}); return r; } /* atualiza a lista antes de confirmar */
    catch (e) { setMsg({ok: false, text: e.message || 'Falha ao executar a ação.'}); return null; }
    finally { setBusy(''); }
  }, [reload]);
  return {busy, msg, run, clear: () => setMsg(null)};
}

const Msg = ({msg}) => msg ? <p className={`ss-demo ${msg.ok ? 'ss-okmsg' : 'ss-err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.ok ? <Check size={13}/> : <AlertCircle size={13}/>} {msg.text}</p> : null;
const Notice = ({text}) => <p className="ss-demo">{text}</p>;
const Unavailable = ({icon: Icon, data, error}) => (
  <div className="ss-placeholder"><Icon size={56}/><p>{error || data?.message || 'Indisponível neste sistema.'}</p></div>
);
const Head = ({title, sub, children}) => <div className="ss-head"><div><h1>{title}</h1><p className="ss-sub">{sub}</p></div>{children}</div>;
const Switch = ({on, onChange, label, disabled}) => <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className="ss-switch" onClick={() => onChange(!on)}/>;
const Loading = () => <p className="ss-empty">Carregando…</p>;

/* Cada aba: carrega → trata erro/indisponível → mostra controles. As abas ficam FORA do componente principal. */
function Frame({state, icon, title, sub, children, extra}) {
  const {data, error, loading} = state;
  return (
    <>
      <Head title={title} sub={sub}>{extra}</Head>
      {loading && !data ? <Loading/> : (!data || data.available === false) ? <Unavailable icon={icon} data={data} error={error}/> : children}
    </>
  );
}

/* ---------- Wi-Fi (nmcli) ---------- */
function WifiTab() {
  const st = useLoad('/api/sys/wifi', 15000), {data, reload} = st;
  const act = useAction(reload);
  const [open, setOpen] = useState(null), [pw, setPw] = useState('');
  const connect = (n, password) => act.run('c:' + n.ssid, () => post('/api/sys/wifi/connect', {ssid: n.ssid, password}), `Conectado a ${n.ssid}.`).then(r => { if (r) { setOpen(null); setPw(''); } });
  const power = on => act.run('power', () => post('/api/sys/wifi/power', {on}), on ? 'Wi-Fi ativado.' : 'Wi-Fi desativado.');
  return (
    <Frame state={st} icon={Wifi} title="Wi-Fi" sub="Gerencie suas conexões sem fio."
      extra={data?.available && (
        <div className="ss-toggle">
          <span className={data.enabled ? 'ok' : ''}>{data.enabled ? 'ATIVO' : 'DESATIVADO'}</span>
          <Switch on={data.enabled} label="Ativar Wi-Fi" disabled={act.busy === 'power'} onChange={power}/>
        </div>)}>
      <Msg msg={act.msg}/>
      {data?.warning && <Notice text={data.warning}/>}
      {!data?.enabled ? <p className="ss-empty">O Wi-Fi está desativado.</p> : (
        <>
          <div className="ss-head ss-sec"><h2>Redes disponíveis</h2>
            <button className="ss-btn" disabled={!!act.busy} onClick={() => act.run('scan', () => api('/api/sys/wifi?rescan=1').then(d => st.setData(d)))}><RefreshCw size={14}/> {act.busy === 'scan' ? 'Procurando…' : 'Procurar'}</button>
          </div>
          <div className="ss-list">
            {data.networks.length === 0 && <p className="ss-empty">Nenhuma rede encontrada.</p>}
            {data.networks.map(n => { const S = SIGNAL(n.signal); return (
              <div key={n.ssid}>
                <div className="ss-row">
                  <div className="ss-ico"><S size={20}/></div>
                  <div className="ss-grow"><b>{n.ssid}{n.active && <em className="ss-badge">Conectado</em>}</b><small>{n.secured ? <><Lock size={10}/> {n.security}</> : 'Aberta'} · {n.signal}%</small></div>
                  {n.active
                    ? <button className="ss-btn" disabled={!!act.busy} onClick={() => act.run('d', () => post('/api/sys/wifi/disconnect', {}), 'Desconectado.')}>Desconectar</button>
                    : <button className="ss-btn primary" disabled={!!act.busy} onClick={() => n.secured ? (setOpen(open === n.ssid ? null : n.ssid), setPw('')) : connect(n)}>{act.busy === 'c:' + n.ssid ? 'Conectando…' : 'Conectar'}</button>}
                </div>
                {open === n.ssid && !n.active && (
                  <div className="ss-row ss-sub-row">
                    <input className="ss-input" type="password" autoFocus placeholder="Senha da rede" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && pw && connect(n, pw)}/>
                    <button className="ss-btn primary" disabled={!pw || !!act.busy} onClick={() => connect(n, pw)}>{act.busy === 'c:' + n.ssid ? 'Conectando…' : 'Entrar'}</button>
                  </div>)}
              </div>); })}
          </div>
        </>)}
    </Frame>
  );
}

/* ---------- Rede (ip -j addr / route) ---------- */
function NetworkTab() {
  const st = useLoad('/api/sys/network', 10000), {data} = st;
  return (
    <Frame state={st} icon={Globe} title="Rede" sub="Interfaces de rede ativas, endereço IP, máscara e gateway."
      extra={<button className="ss-btn" onClick={() => st.reload()}><RefreshCw size={14}/> Atualizar</button>}>
      {data?.interfaces?.length === 0 && <p className="ss-empty">Nenhuma interface Ethernet ou Wi-Fi encontrada.</p>}
      {data?.interfaces?.map(i => (
        <div key={i.name}>
          <h2>{i.type === 'ethernet' ? 'Cabeada (Ethernet)' : 'Sem fio'} · {i.name}</h2>
          <div className="ss-list">
            <div className="ss-row"><div className="ss-ico">{i.type === 'ethernet' ? <Cable size={20}/> : <Wifi size={20}/>}</div>
              <div className="ss-grow"><b>{i.connection || i.name}</b><small>{i.state === 'up' ? 'Conectada' : `Sem conexão (${i.state || 'desconhecido'})`}</small></div></div>
            {[['Endereço IPv4', i.ipv4], ['Máscara', i.mask], ['Gateway', i.gateway], ['IPv6', i.ipv6], ['MAC', i.mac]].map(([k, v]) =>
              <div className="ss-row" key={k}><b className="ss-key">{k}</b><span className="ss-grow ss-val">{v || '—'}</span></div>)}
          </div>
        </div>))}
    </Frame>
  );
}

/* ---------- Bluetooth (bluetoothctl) ---------- */
function BluetoothTab() {
  const st = useLoad('/api/sys/bluetooth', 12000), {data, reload} = st;
  const act = useAction(reload);
  const dev = (d, action, ok) => act.run(action + d.mac, () => post('/api/sys/bluetooth/device', {mac: d.mac, action}), ok);
  const paired = (data?.devices || []).filter(d => d.paired), nearby = (data?.devices || []).filter(d => !d.paired);
  const Row = d => (
    <div className="ss-row" key={d.mac}>
      <div className="ss-ico">{d.connected ? <BluetoothConnected size={20}/> : <Bluetooth size={20}/>}</div>
      <div className="ss-grow"><b>{d.name}{d.connected && <em className="ss-badge">Conectado</em>}</b><small>{d.mac}</small></div>
      {d.paired
        ? <button className={`ss-btn${d.connected ? '' : ' primary'}`} disabled={!!act.busy} onClick={() => dev(d, d.connected ? 'disconnect' : 'connect', d.connected ? 'Desconectado.' : `Conectado a ${d.name}.`)}>{act.busy.endsWith(d.mac) ? 'Aguarde…' : d.connected ? 'Desconectar' : 'Conectar'}</button>
        : <button className="ss-btn primary" disabled={!!act.busy} onClick={() => dev(d, 'pair', `Pareado com ${d.name}.`)}>{act.busy.endsWith(d.mac) ? 'Pareando…' : 'Parear'}</button>}
    </div>);
  return (
    <Frame state={st} icon={Bluetooth} title="Bluetooth" sub="Adaptador, dispositivos pareados e próximos."
      extra={data?.available && (
        <div className="ss-toggle"><span className={data.powered ? 'ok' : ''}>{data.powered ? 'ATIVO' : 'DESATIVADO'}</span>
          <Switch on={data.powered} label="Ativar Bluetooth" disabled={act.busy === 'power'} onChange={on => act.run('power', () => post('/api/sys/bluetooth/power', {on}), on ? 'Bluetooth ativado.' : 'Bluetooth desativado.')}/></div>)}>
      <Msg msg={act.msg}/>
      {!data?.powered ? <p className="ss-empty">O Bluetooth está desativado.</p> : (
        <>
          <h2>Dispositivos pareados</h2>
          <div className="ss-list">{paired.length ? paired.map(Row) : <p className="ss-empty">Nenhum dispositivo pareado.</p>}</div>
          <div className="ss-head ss-sec"><h2>Dispositivos próximos</h2>
            <button className="ss-btn" disabled={!!act.busy} onClick={() => act.run('scan', () => post('/api/sys/bluetooth/scan', {}).then(d => st.setData({...data, devices: d.devices})), 'Busca concluída.')}><RefreshCw size={14}/> {act.busy === 'scan' ? 'Procurando (6 s)…' : 'Procurar'}</button></div>
          <div className="ss-list">{nearby.length ? nearby.map(Row) : <p className="ss-empty">Clique em Procurar para encontrar dispositivos.</p>}</div>
        </>)}
    </Frame>
  );
}

/* ---------- Monitores (xrandr) ---------- */
function MonitorCard({o, busy, onApply}) {
  const [mode, setMode] = useState(o.current?.mode || o.modes[0]?.mode);
  const [hz, setHz] = useState(o.current?.hz ?? null);
  const rates = o.modes.find(m => m.mode === mode)?.rates || [];
  useEffect(() => { if (o.current) { setMode(o.current.mode); setHz(o.current.hz); } }, [o.current?.mode, o.current?.hz]); // eslint-disable-line
  const changeMode = m => { setMode(m); const r = o.modes.find(x => x.mode === m)?.rates || []; setHz(r.includes(hz) ? hz : r[0] ?? null); };
  const dirty = !o.current || mode !== o.current.mode || hz !== o.current.hz;
  return (
    <div className="ss-row ss-col">
      <div className="ss-line"><div className="ss-ico"><Monitor size={20}/></div>
        <div className="ss-grow"><b>{o.name}{o.primary && <em className="ss-badge">Principal</em>}</b><small>Atual: {o.current ? `${o.current.mode} · ${o.current.hz} Hz` : 'desligado'}</small></div></div>
      <div className="ss-line">
        <label className="ss-field">Resolução<select className="ss-select" value={mode} onChange={e => changeMode(e.target.value)}>{o.modes.map(m => <option key={m.mode} value={m.mode}>{m.mode}</option>)}</select></label>
        <label className="ss-field">Atualização<select className="ss-select" value={hz ?? ''} onChange={e => setHz(Number(e.target.value))}>{rates.map(r => <option key={r} value={r}>{r} Hz</option>)}</select></label>
        <button className="ss-btn primary" disabled={!dirty || !!busy} onClick={() => onApply(o, mode, hz)}>{busy === 'a' + o.name ? 'Aplicando…' : 'Aplicar'}</button>
      </div>
    </div>
  );
}
function MonitorsTab() {
  const st = useLoad('/api/sys/displays'), {data, reload} = st;
  const act = useAction(reload);
  const [pending, setPending] = useState(null); /* {output, previous, left}: o xrandr pode deixar a tela preta; sem confirmação, reverte */
  useEffect(() => {
    if (!pending) return;
    if (pending.left <= 0) { const p = pending; setPending(null); act.run('rv', () => post('/api/sys/displays/apply', {output: p.output, mode: p.previous.mode, hz: p.previous.hz}), 'Configuração anterior restaurada.'); return; }
    const t = setTimeout(() => setPending(p => p && {...p, left: p.left - 1}), 1000);
    return () => clearTimeout(t);
  }, [pending]); // eslint-disable-line
  const apply = (o, mode, hz) => act.run('a' + o.name, () => post('/api/sys/displays/apply', {output: o.name, mode, hz}).then(r => { if (r.previous) setPending({output: o.name, previous: r.previous, left: 15}); return r; }));
  return (
    <Frame state={st} icon={MonitorOff} title="Monitores" sub="Monitores conectados, resolução e taxa de atualização."
      extra={<button className="ss-btn" onClick={() => st.reload()}><RefreshCw size={14}/> Atualizar</button>}>
      {data?.session === 'wayland' && <Notice text="Sessão Wayland: o xrandr só enxerga/controla monitores via XWayland e pode ter efeito limitado. Em X11 funciona por completo."/>}
      <Msg msg={act.msg}/>
      {pending && <div className="ss-demo ss-banner"><span>Manter estas configurações? Voltando em {pending.left} s…</span><button className="ss-btn primary" onClick={() => setPending(null)}>Manter</button></div>}
      <div className="ss-list">
        {data?.outputs?.length === 0 && <p className="ss-empty">Nenhum monitor conectado detectado.</p>}
        {data?.outputs?.map(o => <MonitorCard key={o.name} o={o} busy={act.busy} onApply={apply}/>)}
      </div>
    </Frame>
  );
}

/* ---------- Som (wpctl / amixer) ---------- */
function DeviceList({items, kind, onPick, busy}) {
  return (
    <div className="ss-list">
      {items.length === 0 && <p className="ss-empty">Nenhum dispositivo.</p>}
      {items.map(d => (
        <button key={d.name} className={`ss-row ss-pick${d.default ? ' on' : ''}`} disabled={!!busy} aria-pressed={d.default} onClick={() => !d.default && onPick(kind, d.name)}>
          <div className="ss-ico">{kind === 'input' ? <Mic size={18}/> : <Volume2 size={18}/>}</div>
          <div className="ss-grow"><b>{d.description}</b><small>{d.volume != null ? `${d.volume}%` : ''}{d.mute ? ' · mudo' : ''}</small></div>
          {d.default && <em className="ss-badge">Padrão</em>}
        </button>))}
    </div>);
}
function SoundTab() {
  const st = useLoad('/api/sys/sound', 6000), {data, reload} = st;
  const act = useAction(reload);
  const out = data?.outputs?.find(d => d.default), inp = data?.inputs?.find(d => d.default);
  const [vol, setVol] = useState(null); const timer = useRef(null);
  useEffect(() => { if (out && timer.current == null) setVol(out.volume); }, [out?.volume]); // eslint-disable-line
  const commit = v => { clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; act.run('vol', () => post('/api/sys/sound/volume', {value: v})); }, 250); };
  const change = v => { setVol(v); commit(v); };
  return (
    <Frame state={st} icon={VolumeX} title="Som" sub="Volume, mudo e dispositivos de entrada e saída.">
      <Msg msg={act.msg}/>
      <h2>Volume principal</h2>
      <div className="ss-row">
        <button className="ss-btn" aria-label={out?.mute ? 'Ativar som' : 'Silenciar'} disabled={!!act.busy && act.busy !== 'vol'} onClick={() => act.run('mute', () => post('/api/sys/sound/mute', {kind: 'output'}))}>{out?.mute ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>
        <input className="ss-range ss-grow" type="range" min="0" max="100" step="1" aria-label="Volume" value={vol ?? out?.volume ?? 0} onChange={e => change(Number(e.target.value))}/>
        <b className="ss-pct">{vol ?? out?.volume ?? 0}%</b>
      </div>
      <h2>Saída</h2>
      <DeviceList items={data?.outputs || []} kind="output" busy={act.busy} onPick={(kind, name) => act.run('def', () => post('/api/sys/sound/default', {kind, name}), 'Dispositivo de saída alterado.')}/>
      <div className="ss-head ss-sec"><h2>Entrada</h2>
        {inp && <button className="ss-btn" disabled={!!act.busy} onClick={() => act.run('mic', () => post('/api/sys/sound/mute', {kind: 'input'}))}>{inp.mute ? <><MicOff size={14}/> Ativar microfone</> : <><Mic size={14}/> Silenciar microfone</>}</button>}</div>
      <DeviceList items={data?.inputs || []} kind="input" busy={act.busy} onPick={(kind, name) => act.run('def', () => post('/api/sys/sound/default', {kind, name}), 'Dispositivo de entrada alterado.')}/>
    </Frame>
  );
}

/* ---------- Energia (powerprofilesctl / xset) ---------- */
const PROFILES = [
  {id: 'performance', label: 'Desempenho', icon: Rocket}, {id: 'balanced', label: 'Equilibrado', icon: Scale}, {id: 'power-saver', label: 'Economia', icon: Leaf},
];
const IDLE = [[0, 'Nunca'], [1, '1 minuto'], [2, '2 minutos'], [5, '5 minutos'], [10, '10 minutos'], [15, '15 minutos'], [30, '30 minutos'], [60, '1 hora']];
function EnergyTab() {
  const st = useLoad('/api/sys/energy', 10000), {data, reload} = st;
  const act = useAction(reload);
  const p = data?.profile, sc = data?.screen;
  return (
    <Frame state={st} icon={Zap} title="Energia" sub="Perfil de energia e comportamento da tela.">
      <Msg msg={act.msg}/>
      <h2>Modo de energia</h2>
      {p?.current == null && <Notice text={p?.message || 'powerprofilesctl indisponível (instale power-profiles-daemon).'}/>}
      <div className="ss-choices ss-three">
        {PROFILES.map(({id, label, icon: I}) => (
          <button key={id} className={`ss-choice${p?.current === id ? ' on' : ''}`} aria-pressed={p?.current === id} disabled={!!act.busy || !p?.available?.includes(id)}
            title={p?.available?.includes(id) ? '' : 'Não disponível neste hardware'} onClick={() => act.run('p', () => post('/api/sys/energy/profile', {profile: id}), `Perfil: ${label}.`)}><I size={26}/><span>{label}</span></button>))}
      </div>
      <h2>Tela</h2>
      {data?.session === 'wayland' && <Notice text="Sessão Wayland: xset só funciona via XWayland e pode não ter efeito sobre a tela."/>}
      {!sc?.supported ? <Notice text={sc?.message || 'xset indisponível.'}/> : (
        <div className="ss-list">
          <div className="ss-row"><div className="ss-grow"><b>Desligar o monitor agora</b><small>Mova o mouse ou pressione uma tecla para acordar.</small></div>
            <button className="ss-btn primary" disabled={!!act.busy} onClick={() => act.run('off', () => post('/api/sys/energy/screen-off', {}))}><MonitorOff size={14}/> Desligar</button></div>
          <div className="ss-row"><div className="ss-grow"><b>Apagar a tela por inatividade</b><small>{sc.idleMinutes ? `Atual: ${sc.idleMinutes} min` : 'Atual: nunca'}</small></div>
            <select className="ss-select" aria-label="Tempo de inatividade" value={IDLE.some(([m]) => m === sc.idleMinutes) ? sc.idleMinutes : ''} disabled={!!act.busy}
              onChange={e => act.run('idle', () => post('/api/sys/energy/idle', {minutes: Number(e.target.value)}), 'Tempo de inatividade atualizado.')}>
              {!IDLE.some(([m]) => m === sc.idleMinutes) && <option value="" disabled>{sc.idleMinutes} min</option>}
              {IDLE.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></div>
        </div>)}
    </Frame>
  );
}

function InterfaceTab() {
  const DEFAULTS = {animations: true, dynamicDock: true, notifications: true, desktopIcons: true, visualEffects: true};
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/api/interface-settings').then(x => {
      if (alive) setSettings({...DEFAULTS, ...(x || {})});
    }).catch(e => {
      if (alive) setMsg({ok: false, text: e.message || 'Não foi possível carregar as configurações.'});
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const change = async (key, value) => {
    const next = {...settings, [key]: value};
    setSettings(next);
    setSaving(key);
    setMsg(null);
    try {
      const result = await post('/api/interface-settings', next);
      setSettings({...DEFAULTS, ...(result.settings || next)});
      setMsg({ok: true, text: 'Configuração salva.'});
    } catch (e) {
      setSettings(settings);
      setMsg({ok: false, text: e.message || 'Não foi possível salvar a configuração.'});
    } finally {
      setSaving('');
    }
  };

  const rows = [
    ['animations', 'Animações da interface', 'Ativa transições suaves ao abrir, fechar, minimizar e restaurar janelas.'],
    ['dynamicDock', 'Dock dinâmica', 'Permite que aplicativos Linux iniciados apareçam automaticamente na Dock.'],
    ['notifications', 'Notificações', 'Permite avisos e mensagens temporárias da Interface.'],
    ['desktopIcons', 'Ícones da área de trabalho', 'Mostra os atalhos Nautilus e Software no desktop da Interface.'],
    ['visualEffects', 'Efeitos visuais', 'Mantém blur, sombras e outros efeitos visuais da interface.'],
  ];

  return (
    <>
      <div className="ss-head">
        <div><h1>Interface</h1><p className="ss-sub">Preferências da própria Interface Linux Desktop. As alterações são salvas em JSON no seu usuário.</p></div>
      </div>
      <div className="ss-panel-note">Estas opções pertencem somente à interface web. Elas não alteram o GNOME, KDE, XFCE ou outras configurações globais do sistema.</div>
      {loading ? <Loading/> : (
        <div className="ss-settings-list">
          {rows.map(([key, title, desc]) => (
            <div className="ss-setting" key={key}>
              <div className="ss-grow"><b>{title}</b><small>{desc}</small></div>
              <Switch on={!!settings[key]} label={title} disabled={saving === key} onChange={value => change(key, value)}/>
            </div>
          ))}
        </div>
      )}
      {saving && <p className="ss-demo">Salvando…</p>}
      {msg && <Msg msg={msg}/>}
    </>
  );
}

function AppearanceTab({dark, setDark, wallpaper, setWallpaper, customWallpaper, onPickImage}) {
  const fileRef = useRef(null);
  const onFile = e => {
    const f = e.target.files?.[0];
    e.target.value = ''; /* permite escolher o mesmo arquivo de novo */
    if (f) onPickImage(f);
  };
  return (
    <>
      <h1>Aparência</h1>
      <p className="ss-sub">Personalize o tema visual e o plano de fundo do sistema.</p>
      <h2>Estilo visual</h2>
      <div className="ss-choices">
        <button className={`ss-choice${!dark ? ' on' : ''}`} aria-pressed={!dark} onClick={() => setDark(false)}><Sun size={28}/><span>Claro</span></button>
        <button className={`ss-choice${dark ? ' on' : ''}`} aria-pressed={dark} onClick={() => setDark(true)}><Moon size={28}/><span>Escuro</span></button>
      </div>
      <div className="ss-head ss-sec">
        <h2>Plano de fundo</h2>
        <button className="ss-btn" onClick={() => fileRef.current?.click()}><Plus size={14}/> Adicionar imagem…</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile}/>
      </div>
      <div className="ss-wps">
        {WALLPAPERS.map(w => (
          <button key={w.id} className={`ss-wp wp-${w.id}${wallpaper === w.id ? ' on' : ''}`} aria-pressed={wallpaper === w.id} onClick={() => setWallpaper(w.id)}>
            <span>{w.name}</span>
          </button>
        ))}
        {customWallpaper && (
          <button className={`ss-wp wp-custom${wallpaper === 'custom' ? ' on' : ''}`} aria-pressed={wallpaper === 'custom'} onClick={() => setWallpaper('custom')}
            style={{backgroundImage: `url("${customWallpaper.url}")`, backgroundSize: 'cover', backgroundPosition: 'center'}}>
            <span>{customWallpaper.name}</span>
          </button>
        )}
      </div>
    </>
  );
}

/* Aba "Geral": dados reais do servidor. Também recupera o que a nova janela de Configurações tinha tirado
   da 0.0.1.5 (status do node-pty/Terminal, versão e navegador padrão). */
function GeneralTab() {
  const [sys, setSys] = useState(null);
  const [health, setHealth] = useState(null);
  const [def, setDef] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);
  const [hw, setHw] = useState(null);          /* dados reais de /api/hardware-info (systeminformation) */
  const [hwLoading, setHwLoading] = useState(true);
  const [hwErr, setHwErr] = useState(false);

  useEffect(() => {
    let alive = true; setErr(false); setHwLoading(true); setHwErr(false);
    api('/api/hardware-info').then(x => { if (alive) { setHw(x); setHwLoading(false); } }).catch(() => { if (alive) { setHwErr(true); setHwLoading(false); } });
    api('/api/system').then(x => alive && setSys(x)).catch(() => alive && setErr(true));
    api('/api/health').then(x => alive && setHealth(x || {})).catch(() => alive && setHealth({}));
    api('/api/browser-default').then(x => alive && setDef(x?.ok ? (x.value || '') : '')).catch(() => alive && setDef(''));
    return () => { alive = false; };
  }, [tick]);

  const makeChromeDefault = async () => {
    try {
      const r = await post('/api/browser-default', {desktop: 'google-chrome.desktop'});
      if (r?.ok) { setDef('google-chrome.desktop'); setMsg('Chrome definido como navegador padrão.'); }
      else setMsg(r?.stderr || 'Não foi possível definir automaticamente.');
    } catch (e) { setMsg(e.message); }
  };

  const row = (k, v) => <div className="ss-row" key={k}><b className="ss-key">{k}</b><span className="ss-grow ss-val">{v}</span></div>;

  /* Prefere o hardware real; se a API falhar ou o campo vier vazio, cai para /api/system; sem nada, mostra "Indisponível". */
  const wait = hwLoading ? '…' : 'Indisponível';
  const cpuTxt = hw?.cpu?.model ? `${hw.cpu.model} · ${hw.cpu.physicalCores ? `${hw.cpu.physicalCores} núcleos / ${hw.cpu.cores} threads` : `${hw.cpu.cores} núcleos`}`
    : sys ? `${sys.cpu} · ${sys.cores} núcleos` : wait;
  const ramTxt = hw?.ram ? `${formatBytes(hw.ram.used)} em uso de ${formatBytes(hw.ram.total)} (${hw.ram.percent}%)`
    : sys ? `${formatBytes(sys.ram.used)} em uso de ${formatBytes(sys.ram.total)}` : wait;
  const gpuList = hw?.gpus?.length ? hw.gpus.map(g => `${g.model || g.vendor || 'GPU'}${g.vramBytes ? ` · ${formatBytes(g.vramBytes)} VRAM` : ''}`) : null;
  const gpuTxt = gpuList ? gpuList.join(' · ')
    : sys?.gpus?.length ? sys.gpus.join(' · ') : (hw || sys) ? 'Nenhuma GPU reportada' : wait;
  const osTxt = hw?.os?.distro ? `${hw.os.distro} ${hw.os.release || ''} · kernel ${hw.os.kernel || '—'} · ${hw.os.arch || ''}`.replace(/\s+/g, ' ').trim()
    : sys ? `${sys.platform} ${sys.release} · ${sys.arch}` : wait;
  return (
    <>
      <div className="ss-head">
        <div><h1>Geral</h1><p className="ss-sub">Informações do sistema e do desktop.</p></div>
        <button className="ss-btn" onClick={() => setTick(t => t + 1)}><RefreshCw size={14}/> Atualizar</button>
      </div>
      {err && <p className="ss-demo">Sem resposta do servidor.</p>}
      {hwErr && !err && <p className="ss-demo">Não foi possível ler o hardware em tempo real; exibindo dados básicos do sistema.</p>}
      <h2>Sistema</h2>
      <div className="ss-list">
        {row('Host', sys ? sys.hostname : '…')}
        {row('Sistema', osTxt)}
        {row('Processador', cpuTxt)}
        {row('Memória', ramTxt)}
        {row('Carga média', sys ? sys.load.map(n => n.toFixed(2)).join(' / ') : '…')}
        {row('GPU', gpuTxt)}
        {hw?.disk
          ? <div className="ss-row"><b className="ss-key">Armazenamento</b>
              <div className="ss-grow ss-val">
                <div>{formatBytes(hw.disk.used)} em uso de {formatBytes(hw.disk.size)} ({hw.disk.percent}%)</div>
                <div className="ss-bar" role="progressbar" aria-label="Uso do disco principal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={hw.disk.percent}><i style={{width: `${Math.min(100, Math.max(0, hw.disk.percent))}%`}}/></div>
              </div>
            </div>
          : row('Armazenamento', wait)}
      </div>
      <h2>Desktop</h2>
      <div className="ss-list">
        {row('Versão', health ? (health.version || '—') : '…')}
        {row('Servidor local', location.host)}
        {row('Terminal (node-pty)', health === null ? 'verificando…' : health.terminal ? 'ativo' : 'INDISPONÍVEL — rode: npm run setup:terminal')}
      </div>
      <h2>Navegador padrão</h2>
      <div className="ss-list">
        <div className="ss-row">
          <span className="ss-grow">Atual: {def === null ? 'consultando…' : def || 'não definido / indisponível'}</span>
          <button className="ss-btn" onClick={makeChromeDefault}><Chrome size={14}/> Usar Google Chrome</button>
        </div>
      </div>
      {msg && <p className="ss-demo">{msg}</p>}
    </>
  );
}

export default function SystemSettings({dark, setDark, wallpaper, setWallpaper, customWallpaper, onPickImage}) {
  const [tab, setTab] = useState('wifi');
  return (
    <div className="ss">
      <aside className="ss-side">
        <div className="ss-brand"><i><SettingsIcon size={15}/></i>Configurações</div>
        <nav className="ss-nav">
          {TABS.map(({id, icon: Icon, label}) => (
            <button key={id} className={`ss-item${tab === id ? ' active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={17}/><span>{label}</span></button>
          ))}
        </nav>
        <button className="ss-item ss-logout" disabled title="Indisponível: o desktop roda no seu usuário local"><Power size={16}/><span>Encerrar sessão</span></button>
      </aside>
      <main className="ss-main">
        {tab === 'wifi' ? <WifiTab/>
          : tab === 'network' ? <NetworkTab/>
          : tab === 'bluetooth' ? <BluetoothTab/>
          : tab === 'monitors' ? <MonitorsTab/>
          : tab === 'sound' ? <SoundTab/>
          : tab === 'energy' ? <EnergyTab/>
          : tab === 'appearance' ? <AppearanceTab dark={dark} setDark={setDark} wallpaper={wallpaper} setWallpaper={setWallpaper} customWallpaper={customWallpaper} onPickImage={onPickImage}/>
          : tab === 'interface' ? <InterfaceTab/>
          : <GeneralTab/>}
      </main>
    </div>
  );
}
