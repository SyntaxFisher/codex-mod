SHELL := /bin/bash

PYTHON ?= python3
# Node.js for the host; defaults to the one Codex ships.
NODE ?=
APP ?= /Applications/ChatGPT.app
ASAR ?= $(APP)/Contents/Resources/app.asar
ASAR_CLI := node_modules/@electron/asar/bin/asar.mjs
WATCHER := build/launch-watcher

.DEFAULT_GOAL := dry-run

.PHONY: dry-run install host uninstall watcher

define validate
	$(PYTHON) -m py_compile scripts/patch_codex.py scripts/manage_launch_agent.py
	node --check scripts/profile_switcher.cjs
	node --check scripts/codex_mod_host.mjs
endef

$(ASAR_CLI): package.json package-lock.json
	npm ci

$(WATCHER): scripts/launch_watcher.m
	mkdir -p build
	clang -fobjc-arc -framework AppKit -O2 -o $@ $<

watcher: $(WATCHER)

# Validates the patches against the installed Codex build without writing
# anything outside a temporary directory.
dry-run: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --dry-run

# Builds the renderer cache and the launch watcher, and installs the launch
# agent that runs the host from this checkout. The application itself is
# never modified.
install: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)"
	$(PYTHON) scripts/manage_launch_agent.py install$(if $(NODE), --node "$(NODE)")

# Runs the host in the foreground for development. Stop the launch agent
# first, otherwise two hosts compete for the same Codex instance.
host: $(ASAR_CLI) $(WATCHER)
	$(validate)
	node scripts/codex_mod_host.mjs

uninstall: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --uninstall
