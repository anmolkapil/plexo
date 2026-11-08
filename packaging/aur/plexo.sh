#!/bin/bash
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

PLEXO_USER_FLAGS=""
if [[ -f "$XDG_CONFIG_HOME/plexo-flags.conf" ]]; then
    PLEXO_USER_FLAGS="$(sed 's/#.*//' "$XDG_CONFIG_HOME/plexo-flags.conf" | tr '\n' ' ')"
fi

exec /opt/Plexo/plexo "$@" $PLEXO_USER_FLAGS
