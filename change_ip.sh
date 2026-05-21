#!/bin/bash

# Asegurar que arrancamos limpios
sudo warp-cli --accept-tos tunnel endpoint reset >/dev/null 2>&1
sleep 1

while true; do
    # 1. Desconectar y borrar registro actual de forma segura
    sudo warp-cli --accept-tos disconnect >/dev/null 2>&1
    sudo warp-cli --accept-tos registration delete >/dev/null 2>&1
    sleep 3  # Pausa para que el motor asimile el borrado                           
    # 2. Generar nueva cuenta en Cloudflare (IP nueva)
    sudo warp-cli --accept-tos registration new >/dev/null 2>&1
    sleep 3  # Pausa para que el registro se complete

    # 3. Conectar
    sudo warp-cli --accept-tos connect >/dev/null 2>&1
    sleep 4  # Pausa para que se establezca la red

    # 4. Mostrar la nueva IP
    NEW_IP=$(curl -s --connect-timeout 5 ifconfig.me)
    echo "Nueva IP WARP asignada: $NEW_IP"
    echo "--------------------------------------------------"

    # Espera 15 segundos antes de repetir el ciclo
    sleep 15
done
