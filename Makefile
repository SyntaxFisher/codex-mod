SHELL := /bin/bash

PYTHON ?= python3
APP ?= /Applications/ChatGPT.app
ASAR ?= $(APP)/Contents/Resources/app.asar
# The Codex home the mod works in. Unset, it is the one the installed agent
# runs with, so later targets stay in the home `make install CODEX_HOME=...`
# chose; without either, Codex's default ~/.codex.
ifeq ($(origin CODEX_HOME),undefined)
CODEX_HOME := $(shell $(PYTHON) scripts/manage_launch_agent.py codex-home 2>/dev/null)
endif
ifneq ($(strip $(CODEX_HOME)),)
export CODEX_HOME
endif
# Node.js for the host and the source checks; defaults to the one Codex ships.
NODE ?= $(firstword $(wildcard $(APP)/Contents/Resources/cua_node/bin/node /Applications/Codex.app/Contents/Resources/cua_node/bin/node) node)

.DEFAULT_GOAL := dry-run

.PHONY: dry-run install host uninstall on off status repair-rollouts

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

# Turns the mod off and on without uninstalling it, for example to compare
# with stock Codex during development. Off keeps the agent installed but
# disabled, also across logins, and restarts a running Codex without the mod;
# on lets the host relaunch it with the mod. Saved logins and the renderer
# cache stay in place.
off:
	$(PYTHON) scripts/manage_launch_agent.py disable --app "$(APP)"

on:
	$(PYTHON) scripts/manage_launch_agent.py enable

status:
	$(PYTHON) scripts/manage_launch_agent.py status

uninstall:
	$(validate)
	$(PYTHON) scripts/patch_codex.py --asar "$(ASAR)" --uninstall

# Renumbers rollout segments whose ordinals stopped increasing so Codex shows
# their hidden turns again. Quit Codex first; the host runs the same scan on
# its own whenever Codex is not running. REPAIR_ARGS=--dry-run only reports.
repair-rollouts:
	"$(NODE)" --check scripts/rollout_repair.cjs
	"$(NODE)" scripts/rollout_repair.cjs --all $(REPAIR_ARGS)
