#!/usr/bin/env zsh

set -eu

script_directory=${0:A:h}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  exec node --import tsx "$script_directory/probe-gemini-files.ts" --help
fi

if [[ -n ${GEMINI_API_KEY:-} ]]; then
  api_key=$GEMINI_API_KEY
else
  read -rs "api_key?Gemini API key: "
  print
fi

if [[ -z $api_key ]]; then
  print -u2 "Gemini API key is required."
  exit 2
fi

exec env GEMINI_API_KEY="$api_key" \
  node --import tsx "$script_directory/probe-gemini-files.ts"
