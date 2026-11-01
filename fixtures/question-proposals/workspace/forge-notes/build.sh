#!/bin/sh
# Writes docs/playground.js from docs/src; the release pipeline runs it.
node tools/build-playground.mjs docs/src > docs/playground.js
