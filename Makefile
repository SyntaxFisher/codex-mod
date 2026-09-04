SHELL := /bin/bash

PYTHON ?= python3
APP ?= /Applications/ChatGPT.app
ASAR ?= $(APP)/Contents/Resources/app.asar
# Node.js for the host and the source checks; defaults to the one Codex ships.
NODE ?= $(firstword $(wildcard $(APP)/Contents/Resources/cua_node/bin/node /Applications/Codex.app/Contents/Resources/cua_node/bin/node) node)

.DEFAULT_GOAL := dry-run

.PHONY: dry-run install host uninstall

define validate
	$(PYTHON) -m py_compile scripts/patch_codex.py scripts/manage_launch_agent.py
	"$(NODE)" --check scripts/profile_switcher.cjs
	"$(NODE)" --check scripts/codex_mod_host.mjs
endef

# Validates the patches against the installed Codex build without writing
# anything outside a temporary directory.
dry-run:
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --dry-run

# Restores an app.asar that an earlier release patched in place, builds the
# renderer cache and the launch watcher, and installs the launch agent that
# runs the host from this checkout.
install:
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)"
	$(PYTHON) scripts/manage_launch_agent.py install --node "$(NODE)"

# Runs the host in the foreground for development. Stop the launch agent
# first, otherwise two hosts compete for the same Codex instance.
host:
	$(validate)
	"$(NODE)" scripts/codex_mod_host.mjs

uninstall:
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --uninstall
