#!/bin/bash

# Encerra o script imediatamente se algum comando falhar
set -e

echo ""
echo "    Instalação das Dependências da Interface Linux Desktop "
echo ""

# Mensagem de pausa aguardando o seu comando para iniciar
echo "[!] Aguardando confirmação para iniciar..."
read -r -p "Pressione [ENTER] para continuar com a instalação dos pacotes..."

echo ""
echo "[*] Atualizando repositórios de pacotes..."
sudo apt update

echo ""
echo "[*] Instalando utilitários essenciais do sistema e Terminal..."
sudo apt install -y \
libglib2.0-bin \
desktop-file-utils \
xdg-utils \
nautilus \
gnome-terminal \
zenity \
polkit-gnome

echo ""
echo "[*] Instalando componentes de Rede, Wi-Fi e Drivers..."
sudo apt install -y \
network-manager \
network-manager-gnome \
wireless-tools \
wpasupplicant \
broadcom-sta-dkms

echo ""
echo "[*] Configurando e carregando módulos do driver Broadcom Wi-Fi..."
sudo modprobe -r b43 bcma ssb brcmfmac brcmsmac || true
sudo modprobe wl || true

echo ""
echo "[*] Instalando Central de Configurações e Loja Oficial do GNOME..."
sudo apt install -y \
gnome-control-center \
gnome-software \
gnome-software-plugin-flatpak \
flatpak

echo ""
echo "[*] Instalando componentes de Áudio (PipeWire/ALSA)..."
sudo apt install -y \
alsa-utils \
wireplumber \
pavucontrol

echo ""
echo "[*] Instalando temas de ícones e suporte gráfico..."
sudo apt install -y \
adwaita-icon-theme \
gnome-themes-extra \
hicolor-icon-theme

echo ""
echo "[*] Verificando dependências do ambiente Node.js..."
if ! command -v node &> /dev/null; then
echo "[!] Node.js não encontrado. Instalando Node.js e NPM..."
sudo apt install -y nodejs npm
else
echo "[+] Node.js já está instalado: $(node -v)"
fi

echo ""
echo ""
echo " [+] Instalação e configuração concluídas com sucesso!    "
echo " [+] O sistema e as ferramentas nativas estão prontas.   "
echo ""
echo ""
