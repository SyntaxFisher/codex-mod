SHELL := /bin/bash

PYTHON ?= python3
APP ?= /Applications/ChatGPT.app
ASAR ?= $(APP)/Contents/Resources/app.asar
ASAR_CLI := node_modules/@electron/asar/bin/asar.mjs

.DEFAULT_GOAL := dry-run

.PHONY: dry-run patch uninstall

define validate
	$(PYTHON) -m py_compile scripts/patch_codex.py scripts/manage_launch_agent.py
	node --check scripts/profile_switcher.cjs
endef

$(ASAR_CLI): package.json package-lock.json
	npm ci

dry-run: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --dry-run

patch: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)"$(if $(VERSION), --version "$(VERSION)")

uninstall: $(ASAR_CLI)
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --uninstall
