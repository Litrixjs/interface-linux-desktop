# Interface 0.0.2.6

Desktop Linux web shell local, com filesystem Linux real, Terminal PTY real, Nautilus nativo, Window Manager, Launcher/busca, Store Linux/.desktop, Chrome, Settings, Monitor, notificações e workspaces.

## Instalação
```bash
sudo apt install build-essential python3 make g++   # o node-pty (Terminal) é compilado no npm install
npm install
npm run setup:terminal   # compila o node-pty (npm novo bloqueia scripts de instalação; veja o aviso "allow-scripts")
npm run dev
```
Confirme em Configurações → "Terminal (node-pty): ativo".

O servidor abre em `http://127.0.0.1:3000` (use `PORT=3001 npm run dev` para outra porta).

## Produção
```bash
npm install
npm run build
npm start
```

## Correções desta entrega
Veja `ANALISE-E-CORRECOES.md` para a lista completa (segurança, Terminal, Nautilus, Store, Launcher, janelas, CSS).

## 0.0.1.6
- Configurações → Geral: hardware real via `systeminformation` (`/api/hardware-info`) — CPU, RAM, GPU/VRAM, SO e armazenamento.
- Armazenamento mostra apenas o disco principal (`/`), com uso/total e barra de progresso.

## 0.0.1.7
- Configurações → Aparência: botão "Adicionar imagem…" abre o seletor de arquivos e aplica a imagem como papel de parede na hora (URL local via `URL.createObjectURL`; vale só nesta sessão, nada é enviado ou gravado em disco).

## 0.0.1.9
- Correções de segurança, Terminal, Electron, hardware e janelas — lista completa em `ANALISE-E-CORRECOES.md` (Rodada 3).
- Novo: app desktop via Electron (`npm install` e depois `npm run electron`; `npm run pack` gera AppImage/.deb). O servidor local é iniciado e a janela carrega `http://127.0.0.1:3000`.
- Terminal: depois que o shell termina ou a conexão cai, **Enter** abre uma nova sessão.
- A versão exibida vem do `package.json` (fonte única).

## 0.0.2.1 — Configurações com dados e controles reais
Rotas em `server/system.js` (`/api/sys/*`), consumidas por `src/SystemSettings.jsx`:

| Aba | Comandos | Rotas |
|-----|----------|-------|
| Wi-Fi | `nmcli` | `GET /api/sys/wifi[?rescan=1]`, `POST …/wifi/power`, `…/wifi/connect`, `…/wifi/disconnect` |
| Rede | `ip -j addr`, `ip -j route`, `nmcli` | `GET /api/sys/network` |
| Bluetooth | `bluetoothctl` | `GET /api/sys/bluetooth`, `POST …/bluetooth/power`, `…/scan`, `…/device` (connect/disconnect/pair/remove) |
| Monitores | `xrandr` | `GET /api/sys/displays`, `POST …/displays/apply` (com confirmação de 15 s e reversão automática) |
| Som | `wpctl` (fallback `amixer`) | `GET /api/sys/sound`, `POST …/sound/volume`, `…/mute`, `…/default` |
| Energia | `powerprofilesctl`, `xset` | `GET /api/sys/energy`, `POST …/energy/profile`, `…/screen-off`, `…/idle` |

Pacotes úteis no Ubuntu/Debian: `network-manager`, `bluez`, `x11-xserver-utils` (xrandr/xset), `pulseaudio-utils` ou `pipewire-pulse` (wpctl (fallback amixer)), `power-profiles-daemon`, `iproute2`.
Se um comando não existir ou faltar permissão, a aba mostra uma mensagem explicando o motivo (nada quebra).
Em sessão **Wayland**, `xrandr`/`xset` só alcançam o XWayland; em **X11** funcionam por completo.


## 0.0.2.1
- Nautilus é o gerenciador de arquivos padrão da interface e é aberto pelo Nautilus nativo do sistema via `POST /api/system/open-nautilus`.
- Configurações → Som usa `wpctl`/PipeWire, com fallback para `amixer`/ALSA.
- O pacote de código-fonte não inclui `node_modules`; execute `npm install` e `npm run build` para gerar `dist/`.

## 0.0.2.2 — Atividades (estilo GNOME) e Dock dinâmica
- **Atividades:** tela cheia com blur sobre o desktop, busca instantânea, grade com os apps internos + aplicativos `.desktop` de `/usr/share/applications`, `/usr/local/share/applications` e `~/.local/share/applications`. Abre com o botão ☰ da barra, a lupa ou a tecla **Super/Meta** (sozinha; Super+outra tecla é ignorado). **Esc** fecha. Arquivos e pastas aparecem numa seção abaixo (abrem no Nautilus).
- **Dock dinâmica:** apps iniciados pela grade ou pela App Store (`.desktop`, Flatpak, Snap) entram na Dock, sem duplicar, com o ícone real; clique relança; **botão direito remove**. A lista é guardada no navegador (até 12 apps). O indicador ● vale para o que foi iniciado nesta sessão — o servidor não acompanha o fim do processo.
- **`GET /api/app-icon?id=<arquivo.desktop>` ou `?name=<ícone>`:** resolve o ícone nos temas de `/usr/share/icons`, `~/.local/share/icons`, exports do Flatpak e `/usr/share/pixmaps`. Só serve `.png`/`.svg` ≤ 2 MB; `name` aceita apenas `[\w.+-]`; caminho absoluto só é aceito vindo do campo `Icon` de um `.desktop` real. SVG sai com `CSP: sandbox`.
- A execução dos `.desktop` continua por `gio launch` (ou `gtk-launch`), sem shell.
- Observação: em sessão GNOME o próprio shell costuma capturar a tecla Super antes do navegador; nesse caso use o botão da barra.

## 0.0.2.3 — Navegador embutido, minimizar/maximizar e Dock que controla janelas

**Navegador embutido**
- Ao navegar, o servidor lê só os **cabeçalhos** do site (`POST /api/browser/probe`) e vê se ele permite iframe (`X-Frame-Options`, CSP `frame-ancestors`). Permitido → exibe aqui; bloqueado (Google, GitHub, DuckDuckGo…) → painel explicando o motivo com **Abrir no navegador nativo**, **Copiar link** e (em falha de rede) **Tentar exibir aqui mesmo assim**.
- **Abrir no navegador nativo** (`POST /api/open-url`): `xdg-open` e, se falhar, `gio open`; sem shell, em segundo plano, só `http(s)`. (`gio launch` só serve para `.desktop` e continua sendo usado para abrir apps.)
- Segurança da verificação (SSRF): o servidor **nunca** consulta endereços locais/privados (localhost, 10.x, 192.168.x, 169.254.x, `.local`…); o IP é validado no momento da conexão e a cada redirecionamento. Endereços locais carregam direto no iframe. A rota é POST (passa pela checagem de Origin).
- Limite: não detecta sites que se "libertam" de iframes por JavaScript.

**Janelas e Dock (apps internos)**
- Clique no ícone: abre → (focado) **minimiza** → (minimizado) **restaura**; app aberto mas sem foco apenas foca; janela de outro workspace é trazida. Ícone mostra ● (aberto) / ○ (minimizado) e anel de foco.
- Minimizar anima a janela em direção ao ícone dela na Dock; restaurar volta suavemente; maximizar/restaurar também animam (respeita `prefers-reduced-motion`). Botões da barra de título com rótulos e dica; duplo clique maximiza/restaura.

**Dock dinâmica (apps nativos Linux)** — `POST /api/windows/state` e `/api/windows/control`
- Em sessão **X11** com `wmctrl`, `xdotool` e `xprop` (`sudo apt install wmctrl xdotool x11-utils`): a Dock mostra se o app está aberto/ativo/minimizado **de verdade** (atualiza a cada 2,5 s) e o clique alterna foco/minimizar/restaurar; app fechado é iniciado. Vale também para o Nautilus nativo.
- Em **Wayland** (padrão do Ubuntu atual) o sistema não permite que um app controle janelas de outros: a interface avisa uma vez e o clique **relança** o app (apps de instância única vêm para a frente). Para controle completo, entre numa sessão "Ubuntu on Xorg".

## 0.0.2.6 — Configurações próprias da Interface (Opção 1)

- Incluída a seção **Configurações → Interface**, construída diretamente em HTML/CSS/JS (React), sem depender do GNOME Control Center para essas preferências.
- Toggles disponíveis: **Animações da interface**, **Dock dinâmica**, **Notificações**, **Ícones da área de trabalho** e **Efeitos visuais**.
- As preferências são salvas pelo backend em JSON no perfil do usuário, em `~/.config/interface-linux-desktop/settings.json`.
- API: `GET /api/interface-settings` e `POST /api/interface-settings`.
- As alterações são aplicadas à interface imediatamente; não modificam configurações globais do GNOME/KDE/XFCE.
- `setup-environment.sh` fica na raiz, usa `#!/bin/bash`, LF e permissão de execução.

Para preparar o ambiente:
```bash
./setup-environment.sh
```

## 0.0.2.4 — Shell/Launcher: a Interface delega ao Linux
A Interface passa a ser um **shell leve**: Dock e Atividades disparam os aplicativos **nativos**, cada um na sua própria janela do sistema. Esta seção substitui o que as seções 0.0.2.2/0.0.2.3 diziam sobre App Store e navegador embutido (ambos removidos).

| Ícone da Dock | O que abre (nativo) | Como é resolvido |
|---|---|---|
| Nautilus | `org.gnome.Nautilus` | `.desktop` → `gio launch`; senão executável `nautilus` |
| Terminal | GNOME Terminal (ou Console, Konsole, Xfce Terminal, xterm) | idem |
| **Software** | **GNOME Software** (`org.gnome.Software` / `gnome-software`; no Ubuntu pode cair na Snap Store) | idem |
| Configurações | `gnome-control-center` | idem |
| Monitor do Sistema | `gnome-system-monitor` | idem |
| Navegador | o **navegador padrão** (`xdg-settings get default-web-browser`) | `.desktop` do navegador; senão `x-www-browser`/`sensible-browser`/`firefox`… |

- **API:** `GET /api/system-apps` (o que está instalado, `.desktop` real, ícone) e `POST /api/system-apps/launch {id}`. Ordem de tentativa: `gio launch` → `gtk-launch` → executável. Só aceita ids da lista fixa (sem shell, sem entrada livre).
- **Ícones:** `/api/app-icon?id=<arquivo.desktop>` mapeia o ícone real do app (ex.: o do GNOME Software) nos temas do sistema; sem ícone, a Dock usa um genérico.
- **Não instalado?** O ícone fica esmaecido com a dica `sudo apt install <pacote>`; ao clicar: Terminal, Configurações e Monitor abrem a **versão embutida de reserva**; Software, Nautilus e Navegador mostram como instalar (não existe reserva).
- **Navegador:** nada é carregado em `iframe`. URLs e pesquisas abrem o navegador padrão do sistema (`xdg-open` → `gio open`), inclusive a opção "Pesquisar na web" das Atividades (DuckDuckGo). As rotas `/api/browser/probe` e `/api/store*` foram removidas.
- **Janelas e foco (Dock):** o estado vem da janela real em X11 (`wmctrl`/`xdotool`/`xprop`): ● aberto, ○ minimizado, anel = em foco; clique alterna abrir → focar → minimizar → restaurar. Em Wayland o sistema não permite isso: a Dock avisa uma vez, mostra ● dos apps iniciados na sessão e o clique reabre/foca.
- **Aparência e ajustes da própria Interface** (papel de parede, tema, Wi-Fi/Bluetooth/Monitores/Som/Energia): janela embutida acessível pelo botão ⚙ da barra superior ou por "Aparência da Interface" nas Atividades.
- **`setup-environment.sh`:** instala o que falta (`gio`, `gtk-launch`, `nautilus`, `gnome-software`, `gnome-control-center`, `gnome-terminal`, `gnome-system-monitor`, `adwaita-icon-theme`, `wmctrl`, `xdotool`, rede/Bluetooth/som/energia). Opções: `--dry-run`, `--yes`, `--minimal`, `--npm` (roda `npm install` e `npm run build`), `--help`.

```bash
./setup-environment.sh --dry-run   # só mostra o que faria
./setup-environment.sh --yes --npm # instala tudo e compila (dist/)
npm run dev
```
