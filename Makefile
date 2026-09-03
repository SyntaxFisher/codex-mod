SHELL := /bin/bash

PYTHON ?= python3
APP ?= /Applications/ChatGPT.app
ASAR ?= $(APP)/Contents/Resources/app.asar
ASAR_CLI := node_modules/@electron/asar/bin/asar.mjs

.DEFAULT_GOAL := dry-run

.PHONY: dry-run install patch uninstall

define validate
	$(PYTHON) -m py_compile scripts/patch_codex.py scripts/manage_launch_agent.py
	node --check scripts/profile_switcher.cjs
endef

$(ASAR_CLI): package.json package-lock.json
	npm ci

dry-run: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --dry-run

install: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)"$(if $(VERSION), --version "$(VERSION)")

patch: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --version head$(if $(AGENT),, --no-agent)

uninstall: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --uninstall

# Proof of concept: run the mod from outside the application over the
# DevTools protocol, leaving the installed bundle untouched.
build/launch-watcher: scripts/launch_watcher.m
	mkdir -p build
	clang -fobjc-arc -framework AppKit -O2 -o $@ $<

.PHONY: watcher host
watcher: build/launch-watcher

host: $(ASAR_CLI) build/launch-watcher
	$(validate)
	node --check scripts/codex_mod_host.mjs
	node scripts/codex_mod_host.mjs
