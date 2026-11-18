#!/usr/bin/env bash
# git credential helper backed by the persistent token file (.git/gh-sec/token).
# Responds to git's credential protocol; never prints the token to stdout logs.
case "$1" in
  get)
    echo "username=ebinj-dev"
    printf "password=%s\n" "$(cat /home/z/my-project/.git/gh-sec/token)"
    ;;
  store|erase)
    # The token is persisted separately — nothing to do here.
    ;;
esac
exit 0
